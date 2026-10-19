# screen-beaver-mcp-relay

Cloudflare Worker + Durable Object that brands Remote MCP as `https://mcp.screenbeaver.com`.

Use the **same Cloudflare account** that already hosts `screenbeaver.com`.

See [docs/MCP_RELAY.md](../../docs/MCP_RELAY.md) for the API contract.

## Deploy (first time)

```powershell
cd workers/mcp-relay
npm install
npx wrangler login
# Browser opens — pick the account that owns screenbeaver.com
npx wrangler whoami
npx wrangler deploy
```

`wrangler.toml` uses a **Worker custom domain** for `mcp.screenbeaver.com` (do not point `mcp` at Vercel — that breaks TLS). Redeploy with `npx wrangler deploy` if the host goes offline.

## Verify

```powershell
curl https://mcp.screenbeaver.com/health
```

Should return `{"ok":true,"service":"screen-beaver-mcp-relay"}`.

Restart Screen Beaver — Remote MCP should show badge **Relay** and a Claude URL on `mcp.screenbeaver.com`.
