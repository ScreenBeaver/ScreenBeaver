# Screen Beaver MCP

Drive Screen Beaver from Cursor, Cursor Cloud, or Claude Desktop — **directly via MCP tools**. No PowerShell scripts, no JSON files on disk.

**Default UX:** open Screen Beaver desktop → open URL/app → native capture (no OS Share picker) → short demo (~10–12s) with clicks + key-by-key typing → **auto** captions/zooms in one recipe → **user clicks Export**.

## Install (published)

```bash
npx -y screen-beaver-mcp
```

Cursor / Claude MCP config:

```json
{
  "mcpServers": {
    "screen-beaver": {
      "command": "npx",
      "args": ["-y", "screen-beaver-mcp"]
    }
  }
}
```

Requires Screen Beaver desktop open (bridge `http://127.0.0.1:17355`).

## Remote agents (BetterClaw / Streamable HTTP)

Remote platforms like [BetterClaw](https://www.betterclaw.io/mcp) only speak **HTTPS Streamable HTTP** — they cannot run `npx` stdio on your PC. Keep Screen Beaver on Windows (PC awake, app open, browser logged into the product you want to demo).

### In-app (Pro / Team) — preferred

On **Pro** or **Team**, Screen Beaver **auto-starts** Remote MCP when you sign in (no toggle). Free plans never get this.

1. Open Screen Beaver → MCP tab.
2. **Claude.ai:** copy **Claude / cloud URL** (prefer `https://mcp.screenbeaver.com/mcp?token=…`). Add custom connector → **No sign-in** → Streamable HTTP.
3. **BetterClaw:** URL + **Authorization** (`Bearer …`).
4. Short ask is enough, e.g. “Sheets division and power formulas” — agent uses `make_product_tutorial` → `record_and_build` → `verify_take` (scout includes a screenshot).

Auth: `Authorization: Bearer <token>` **or** `?token=<token>`.

The desktop app bundles the MCP script and **auto-downloads a portable Node runtime** on first Remote MCP start (no separate Node install). Branded host needs the relay Worker deployed ([docs/MCP_RELAY.md](../docs/MCP_RELAY.md)).

### Manual CLI (dev / Free workaround)

```powershell
npx -y screen-beaver-mcp --http --token your-long-random-secret
# default: http://127.0.0.1:17356/mcp
cloudflared tunnel --url http://127.0.0.1:17356
```

Optional: `--port 17356`.

**Notes**
- Never expose the desktop bridge `:17355` publicly — only the token-gated MCP port.
- Quick-tunnel hostnames change every restart. For a stable URL, use a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/).
- The VPS only hosts the agent brain; capture/mouse/keyboard stay on your Windows machine.
- Health check (no auth): `GET http://127.0.0.1:17356/health`

## Quick start (monorepo)

```bash
npm run mcp:install
npm run mcp:build
npm run desktop:dev
```

Cursor loads the server from `.cursor/mcp.json` (stdio via `npm.cmd` + `${workspaceFolder}/mcp`). After install or config changes: enable **screen-beaver** under **Customize → MCPs**, then reload Cursor / open a new agent chat.

Skill: `.cursor/skills/screen-weaver-demo/SKILL.md`

## Prompt example (keep it short)

> Using Screen Beaver MCP, make a short tutorial of Google Sheets division and power formulas.

The agent should `make_product_tutorial` → `record_and_build` (scout first, Auto zooms from the cursor track). You click Export.

## Capture tools

| Tool | Purpose |
|------|---------|
| `list_capture_targets` | Windows + monitors |
| `open_url` / `open_path` | Launch browser or safe app/document |
| `start_capture` | Native record by id/title (**no picker**) |
| `stop_capture` | Stop + import take (window **or** Android) |
| `android_ensure_runtime` | Download portable ADB/scrcpy if needed |
| `android_list_devices` | USB/network Android devices |
| `android_start` / `android_stop` | Mirror + record phone / import take |
| `record_and_build` | Open → short record → auto edit |
| `record_android_and_build` | Phone: start → demo → stop → auto edit |

Phone needs USB debugging + **Allow** on the device. First Android run may download ~11 MB into app data.

## Direct demo control (no scripts)

| Tool | Purpose |
|------|---------|
| `demo_move` | Smooth cursor in captured window |
| `demo_click` | Click (optional move-to) |
| `demo_type` | Type key-by-key (not paste) |
| `demo_scroll` | Wheel |
| `demo_focus` | Foreground capture window |
| `demo_wait` | Pause between beats (max 8s) |
| `run_demo` | Batch steps **inline** in the tool call |

## Edit tools

`live_build_demo` (autoMode default), `add_caption`, `add_zoom`, `add_effect`, `ready_for_export`

## Reliability notes

- Tools use hard HTTP timeouts so the agent does not hang forever.
- Prefer short `demoSteps` and `maxCaptureSec: 12`.
- `autoMode` applies captions/zooms via one `apply_recipe` (plus auto-zooms from clicks).

## Publish

See [`docs/PUBLISHING.md`](../docs/PUBLISHING.md). Build with `npm run build` in this folder before publish.

**Security / Socket:** the published tarball has **no runtime dependencies** (SDK + zod are bundled). Local installs use Socket Registry overrides for leaf packages.
