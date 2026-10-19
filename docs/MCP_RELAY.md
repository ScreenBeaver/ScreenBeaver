# Remote MCP relay (`mcp.screenbeaver.com`)

Branded Streamable HTTP endpoint for online AI / remote agents. The desktop app dials **out** to the relay; users never paste `*.trycloudflare.com` URLs when the relay is up.

## Architecture

```
Online AI / remote agent
    → HTTPS POST https://mcp.screenbeaver.com/mcp?token=<sb_…>
    → Cloudflare Worker + Durable Object (session keyed by token)
    → long-poll to Screen Beaver desktop
    → localhost:17356/mcp (bundled screen-beaver-mcp --http)
    → bridge :17355
```

## Deploy Worker

```bash
cd workers/mcp-relay
npm install
npx wrangler login
npx wrangler deploy   # attaches custom domain mcp.screenbeaver.com (not Vercel)
```

If Remote MCP shows a TLS error, `mcp` DNS was likely pointed at Vercel. Redeploy the Worker so the custom domain is restored, then click **Retry start**.

Default relay host is `https://mcp.screenbeaver.com`.

## Session API (desktop ↔ relay)

### `POST /v1/session/register`

Body: `{ "token": "sb_…", "localPort": 17356 }`

Response: `{ "ok": true, "sessionId": "…", "publicUrl": "https://mcp.screenbeaver.com/mcp?token=…" }`

### `GET /v1/session/poll?token=…&wait=20000`

Long-poll. Response: `{ "ok": true, "requests": [ { "id", "method", "path", "headers", "bodyBase64" } ] }`

### `POST /v1/session/respond`

Body: `{ "token", "id", "status", "headers", "bodyBase64" }`

## Public MCP

- `POST /mcp?token=…` or `Authorization: Bearer …`
- Same Streamable HTTP as local `screen-beaver-mcp --http`

## Stable URL

Online AI URL:

`https://mcp.screenbeaver.com/mcp?token=<persisted-sb-token>`

The token is stored in app data and reused across restarts. Reopening Screen Beaver re-registers the desktop with the same token.

**Regenerate token** creates a new secret and URL. Use that only if the old token leaked.

Quick-tunnel fallback is **off** by default (dev-only emergency path).

## Auth

Online AI: full URL with `?token=` and **No sign-in**. Remote agent: `https://mcp.screenbeaver.com/mcp` plus `Authorization: Bearer sb_…`.
