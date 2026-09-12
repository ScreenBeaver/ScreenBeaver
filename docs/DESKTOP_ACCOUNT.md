# Optional cloud account (desktop ↔ website)

Sign-in is **optional** in this open-source desktop build. All studio features
(MCP, effects, 4K export, captions, voiceover, Android USB, no watermark) work offline.

Set in `.env` / Vite env when pointing at a non-production API:

```
VITE_SCREENBEAVER_API_URL=http://localhost:3000
```

Default is `https://screenbeaver.com`.

## Handshake (optional)

1. Account menu → **Sign in with browser**
2. Browser opens `/auth/desktop?challenge&state`
3. After website login, redirects to `screenbeaver://auth?code&state`
4. App exchanges code for a device token via `POST /api/desktop/token`
5. Profile / share quotas from `GET /api/desktop/me` — Billing opens `/dashboard/billing` (no in-app payments)

## Share (optional cloud)

Export → **Share to Screen Beaver** requires sign-in and a compatible API that accepts uploads.

Local **Download** export always works without an account.

## MCP

Agent / MCP tools talk to the local desktop bridge (`127.0.0.1:17355`). Successful tool
events may enqueue to `/api/desktop/mcp-events` when signed in (telemetry for the website dashboard).
