import { isTauri } from "@/lib/studio/nativeBridge";

/** Screen Beaver website API base (no trailing slash). */
export const ACCOUNT_API_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as ImportMeta & { env?: Record<string, string> }).env
      ?.VITE_SCREENBEAVER_API_URL) ||
  "https://screenbeaver.com";

export const BILLING_URL = `${ACCOUNT_API_BASE}/dashboard/billing`;
export const DASHBOARD_URL = `${ACCOUNT_API_BASE}/dashboard`;
export const DESKTOP_SCHEME = "screenbeaver";

export type PlanFeatures = {
  mcp: boolean;
  androidUsb: boolean;
  export4k: boolean;
  effects: boolean;
  watermarkFree: boolean;
  seats: number;
  customDomains: boolean;
  shareLinks: boolean;
  maxShares: number;
  voiceover: boolean;
  autoCaptions: boolean;
  translation: boolean;
};

export type AccountMe = {
  user: {
    id: string;
    email: string;
    name: string;
    username: string | null;
    channelUrl: string | null;
  };
  deviceId: string;
  plan: {
    id: string;
    slug: string;
    name: string;
    features: PlanFeatures;
  };
  billingUrl: string;
  dashboardUrl: string;
};

const TOKEN_KEY = "screenbeaver.deviceToken";
const PKCE_VERIFIER_KEY = "screenbeaver.pkceVerifier";
const PKCE_STATE_KEY = "screenbeaver.pkceState";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function randomUrlSafe(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function networkErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|error sending request/i.test(msg)) {
    return `Can't reach ${ACCOUNT_API_BASE}. Check your connection and try again.`;
  }
  return msg || "Network error";
}

/** Prefer Tauri HTTP (no CORS) in the desktop app; fall back to window.fetch. */
async function accountFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    if (isTauri()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return await tauriFetch(input, init);
    }
  } catch {
    /* fall through to browser fetch */
  }
  try {
    return await fetch(input, init);
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
}

export async function startDesktopLogin(): Promise<void> {
  const verifier = randomUrlSafe(32);
  const state = randomUrlSafe(16);
  const challenge = await pkceChallenge(verifier);
  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  localStorage.setItem(PKCE_STATE_KEY, state);

  const url = `${ACCOUNT_API_BASE}/auth/desktop?challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}`;
  await openExternalUrl(url);
}

async function openExternalUrl(url: string) {
  try {
    const { openCaptureUrl } = await import("@/lib/studio/nativeTake");
    await openCaptureUrl(url);
    return;
  } catch {
    /* fall through */
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openBillingPage() {
  await openExternalUrl(BILLING_URL);
}

export async function openDashboard() {
  await openExternalUrl(DASHBOARD_URL);
}

/** Handle `screenbeaver://auth?code=&state=` deep link. */
export async function completeDesktopLoginFromUrl(
  url: string,
): Promise<AccountMe> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid auth callback URL");
  }
  if (parsed.protocol !== `${DESKTOP_SCHEME}:`) {
    throw new Error("Unexpected auth scheme");
  }
  const code = parsed.searchParams.get("code") || "";
  const state = parsed.searchParams.get("state") || "";
  const expectedState = localStorage.getItem(PKCE_STATE_KEY) || "";
  const verifier = localStorage.getItem(PKCE_VERIFIER_KEY) || "";
  if (!code || !state || !verifier) {
    throw new Error("Missing auth code — start Sign in again.");
  }
  if (state !== expectedState) {
    throw new Error("Auth state mismatch — try Sign in again.");
  }

  let res: Response;
  try {
    res = await accountFetch(`${ACCOUNT_API_BASE}/api/desktop/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        verifier,
        state,
        deviceName: "Screen Beaver Desktop",
      }),
    });
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    token?: string;
  };
  if (!res.ok || !data.token) {
    if (res.status === 404) {
      throw new Error("Sign-in is temporarily unavailable. Try again later.");
    }
    throw new Error(data.error || "Could not complete sign-in.");
  }
  setStoredToken(data.token);
  localStorage.removeItem(PKCE_VERIFIER_KEY);
  localStorage.removeItem(PKCE_STATE_KEY);
  return fetchMe();
}

export async function fetchMe(): Promise<AccountMe> {
  const token = getStoredToken();
  if (!token) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await accountFetch(`${ACCOUNT_API_BASE}/api/desktop/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
  if (res.status === 401) {
    setStoredToken(null);
    throw new Error("Session expired — sign in again.");
  }
  const data = (await res.json().catch(() => ({}))) as AccountMe & {
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || "Could not load account.");
  return data;
}

export async function signOutDesktop(): Promise<void> {
  const token = getStoredToken();
  if (token) {
    try {
      await accountFetch(`${ACCOUNT_API_BASE}/api/desktop/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* ignore */
    }
  }
  setStoredToken(null);
}

export async function shareVideoToChannel(opts: {
  blob: Blob;
  title: string;
  slug?: string;
  description?: string;
}): Promise<{ channelUrl: string; shareId: string }> {
  const token = getStoredToken();
  if (!token) throw new Error("Sign in to share to Screen Beaver.");

  let start: Response;
  try {
    start = await accountFetch(`${ACCOUNT_API_BASE}/api/desktop/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title,
        slug: opts.slug,
        description: opts.description,
        contentType: "video/mp4",
      }),
    });
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
  const startData = (await start.json().catch(() => ({}))) as {
    error?: string;
    shareId?: string;
    uploadUrl?: string;
    publicUrl?: string;
    channelUrl?: string;
    requiredHeaders?: Record<string, string>;
  };
  if (!start.ok || !startData.uploadUrl || !startData.shareId) {
    throw new Error(startData.error || "Could not start upload.");
  }

  const putHeaders = {
    "Content-Type": "video/mp4",
    "x-amz-acl": "public-read",
    ...(startData.requiredHeaders || {}),
  };

  const put = await (async () => {
    try {
      return await accountFetch(startData.uploadUrl!, {
        method: "PUT",
        headers: putHeaders,
        body: opts.blob,
      });
    } catch (err) {
      throw new Error(
        `Couldn't upload video to storage. ${networkErrorMessage(err)}`,
      );
    }
  })();
  if (!put.ok) {
    const bodyText = await put.text().catch(() => "");
    throw new Error(
      `Upload failed (${put.status}).${bodyText ? ` ${bodyText.slice(0, 200)}` : ""}`,
    );
  }

  let done: Response;
  try {
    done = await accountFetch(
      `${ACCOUNT_API_BASE}/api/desktop/shares/${startData.shareId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ videoUrl: startData.publicUrl }),
      },
    );
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
  const doneData = (await done.json().catch(() => ({}))) as {
    error?: string;
    channelUrl?: string;
  };
  if (!done.ok) {
    throw new Error(doneData.error || "Could not finalize share.");
  }

  return {
    shareId: startData.shareId,
    channelUrl: doneData.channelUrl || startData.channelUrl || "",
  };
}

type McpEvent = {
  tool: string;
  summary?: Record<string, unknown>;
  projectTitle?: string;
  createdAt?: string;
};

const mcpQueue: McpEvent[] = [];
let mcpFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function enqueueMcpEvent(event: McpEvent) {
  if (!getStoredToken()) return;
  mcpQueue.push({
    ...event,
    createdAt: event.createdAt || new Date().toISOString(),
  });
  if (mcpFlushTimer) return;
  mcpFlushTimer = setTimeout(() => {
    mcpFlushTimer = null;
    void flushMcpEvents();
  }, 2500);
}

export async function flushMcpEvents() {
  const token = getStoredToken();
  if (!token || mcpQueue.length === 0) return;
  const batch = mcpQueue.splice(0, 50);
  try {
    await accountFetch(`${ACCOUNT_API_BASE}/api/desktop/mcp-events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events: batch }),
    });
  } catch {
    mcpQueue.unshift(...batch);
  }
}
