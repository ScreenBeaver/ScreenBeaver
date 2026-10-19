/**
 * Screen Beaver Remote MCP relay.
 * Claude/BetterClaw → https://mcp.screenbeaver.com/mcp?token=…
 * Desktop dials out: register + long-poll + respond → local 127.0.0.1:17356
 */

export interface Env {
  SESSIONS: DurableObjectNamespace;
}

type PendingReq = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string | null;
  createdAt: number;
};

type PendingRes = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

export class McpSession implements DurableObject {
  state: DurableObjectState;
  token = "";
  /** Updated on every desktop poll — used so Claude gets a fast 503 instead of a proxy 502. */
  lastPollAt = 0;
  queue: PendingReq[] = [];
  waiters: Map<
    string,
    { resolve: (r: PendingRes) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map();
  pollWaiters: Array<{
    resolve: (reqs: PendingReq[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  desktopOnline(): boolean {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt < 45_000;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/register")) {
      const body = (await request.json()) as { token?: string };
      const token = String(body.token || "").trim();
      if (token.length < 16) {
        return json({ ok: false, error: "token required" }, 400);
      }
      this.token = token;
      await this.state.storage.put("token", token);
      return json({
        ok: true,
        sessionId: this.state.id.toString(),
        publicUrl: `https://mcp.screenbeaver.com/mcp?token=${encodeURIComponent(token)}`,
      });
    }

    if (request.method === "GET" && path.endsWith("/poll")) {
      const stored = this.token || (await this.state.storage.get<string>("token")) || "";
      const qToken = url.searchParams.get("token") || "";
      if (!stored || qToken !== stored) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      this.lastPollAt = Date.now();
      const waitMs = Math.min(25_000, Math.max(1_000, Number(url.searchParams.get("wait") || 20_000)));
      if (this.queue.length) {
        const batch = this.queue.splice(0, 8);
        return json({ ok: true, requests: batch });
      }
      const batch = await new Promise<PendingReq[]>((resolve) => {
        const timer = setTimeout(() => {
          this.pollWaiters = this.pollWaiters.filter((w) => w.resolve !== resolve);
          resolve([]);
        }, waitMs);
        this.pollWaiters.push({ resolve, timer });
      });
      this.lastPollAt = Date.now();
      return json({ ok: true, requests: batch });
    }

    if (request.method === "POST" && path.endsWith("/respond")) {
      const body = (await request.json()) as {
        token?: string;
        id?: string;
        status?: number;
        headers?: Record<string, string>;
        bodyBase64?: string;
      };
      const stored = this.token || (await this.state.storage.get<string>("token")) || "";
      if (!stored || body.token !== stored) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const id = String(body.id || "");
      const waiter = this.waiters.get(id);
      if (!waiter) {
        return json({ ok: false, error: "unknown request id" }, 404);
      }
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({
        status: Number(body.status) || 500,
        headers: body.headers || {},
        bodyBase64: body.bodyBase64 || "",
      });
      return json({ ok: true });
    }

    // Inbound MCP from Claude — path /mcp on the DO stub URL is not used;
    // public /mcp is handled by the Worker and forwarded here as /inbound.
    if (request.method === "POST" && path.endsWith("/inbound")) {
      const stored = this.token || (await this.state.storage.get<string>("token")) || "";
      const qToken = url.searchParams.get("token") || "";
      if (!stored || qToken !== stored) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      // Fail fast when Screen Beaver isn't polling — Anthropic's proxy otherwise
      // times out and surfaces a generic 502 to the connector UI.
      if (!this.desktopOnline() && this.pollWaiters.length === 0) {
        return json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Screen Beaver is offline. Open the app on your PC, wait until Remote MCP shows Online, then retry.",
            },
            id: null,
          },
          503,
        );
      }
      const id = crypto.randomUUID();
      const raw = new Uint8Array(await request.arrayBuffer());
      const headers: Record<string, string> = {
        // Local MCP requires auth; Claude often only has ?token= on the public URL.
        authorization: `Bearer ${stored}`,
        accept: "application/json, text/event-stream",
        "content-type": request.headers.get("content-type") || "application/json",
      };
      const mcpSession = request.headers.get("mcp-session-id");
      if (mcpSession) headers["mcp-session-id"] = mcpSession;
      const req: PendingReq = {
        id,
        method: request.method,
        path: `/mcp?token=${encodeURIComponent(stored)}`,
        headers,
        bodyBase64: raw.length ? bytesToBase64(raw) : null,
        createdAt: Date.now(),
      };

      const responsePromise = new Promise<PendingRes>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(id);
          resolve({
            status: 504,
            headers: { "content-type": "application/json" },
            bodyBase64: btoa(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Desktop relay timeout — keep Screen Beaver open." },
                id: null,
              }),
            ),
          });
        }, 180_000);
        this.waiters.set(id, { resolve, timer });
      });

      if (this.pollWaiters.length) {
        const w = this.pollWaiters.shift()!;
        clearTimeout(w.timer);
        w.resolve([req]);
      } else {
        this.queue.push(req);
        if (this.queue.length > 32) this.queue.shift();
      }

      const res = await responsePromise;
      const bytes = Uint8Array.from(atob(res.bodyBase64), (c) => c.charCodeAt(0));
      const outHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        try {
          outHeaders.set(k, v);
        } catch {
          /* ignore invalid */
        }
      }
      if (!outHeaders.has("content-type")) {
        outHeaders.set("content-type", "application/json");
      }
      return new Response(bytes, { status: res.status, headers: outHeaders });
    }

    if (request.method === "GET" && path.endsWith("/health")) {
      return json({ ok: true, service: "screen-beaver-mcp-relay-session" });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function sessionStub(env: Env, token: string): DurableObjectStub {
  const id = env.SESSIONS.idFromName(token);
  return env.SESSIONS.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, service: "screen-beaver-mcp-relay" });
    }

    // Claude probes these for OAuth; we use token-in-URL / No sign-in — answer clearly.
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return json({ error: "no_oauth", message: "Use No sign-in with ?token= on the MCP URL." }, 404);
    }

    // Desktop register
    if (path === "/v1/session/register" && request.method === "POST") {
      const body = (await request.json()) as { token?: string };
      const token = String(body.token || "").trim();
      if (token.length < 16) return json({ ok: false, error: "token required" }, 400);
      const stub = sessionStub(env, token);
      return stub.fetch("https://do/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
    }

    // Desktop poll / respond
    if (path === "/v1/session/poll" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (token.length < 16) return json({ ok: false, error: "token required" }, 400);
      const stub = sessionStub(env, token);
      const wait = url.searchParams.get("wait") || "20000";
      return stub.fetch(`https://do/poll?token=${encodeURIComponent(token)}&wait=${wait}`);
    }

    if (path === "/v1/session/respond" && request.method === "POST") {
      const body = await request.text();
      let token = "";
      try {
        token = String((JSON.parse(body) as { token?: string }).token || "");
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      if (token.length < 16) return json({ ok: false, error: "token required" }, 400);
      const stub = sessionStub(env, token);
      return stub.fetch("https://do/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    }

    // Public MCP endpoint for Claude / BetterClaw
    if (path === "/mcp" || path.startsWith("/mcp?")) {
      const token =
        url.searchParams.get("token") ||
        bearerToken(request.headers.get("authorization")) ||
        "";
      if (token.length < 16) {
        return json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Unauthorized — pass ?token= or Authorization: Bearer",
            },
            id: null,
          },
          401,
        );
      }
      if (request.method === "GET" || request.method === "DELETE") {
        return json(
          { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
          405,
        );
      }
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      const stub = sessionStub(env, token);
      // Buffer body — streaming request.body into a DO fetch can throw → CF 502.
      const body = await request.arrayBuffer();
      const inbound = new Request(`https://do/inbound?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: {
          "content-type": request.headers.get("content-type") || "application/json",
          accept: request.headers.get("accept") || "application/json, text/event-stream",
          ...(request.headers.get("mcp-session-id")
            ? { "mcp-session-id": request.headers.get("mcp-session-id")! }
            : {}),
        },
        body,
      });
      return stub.fetch(inbound);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

function bearerToken(header: string | null): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || "";
}

function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
