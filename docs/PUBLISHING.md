# Publishing Screen Beaver MCP (npm)

Structured guide for publishing the **Screen Beaver MCP** package to npm so Cursor / Claude Desktop can run it with `npx`.

**Last updated:** August 2026

---

## What you publish vs what ships in the app

| Artifact | Where it lives | How users get it |
|----------|----------------|------------------|
| `screen-beaver-mcp` | npm (`mcp/`) | `npx -y screen-beaver-mcp` in Cursor / Claude |
| Screen Beaver desktop | Microsoft Store / local install | `npm run desktop:build:store` / Tauri — **separate** from npm publish |

The MCP talks to the **local desktop bridge** only (`http://127.0.0.1:17355` by default). Publishing MCP does **not** ship the desktop app.

---

## Package inventory (current)

| # | Package | npm name | Version | Scoped? | Notes |
|---|---------|----------|---------|---------|-------|
| 1 | Screen Beaver MCP | `screen-beaver-mcp` | `0.1.1` | No | Lives in `mcp/` — **zero runtime deps** (bundled) |

Bump `version` in `mcp/package.json` before re-publishing. Follow semver.

**Publish order:** single package — no dependency chain.

---

## Phase 0 — Pre-flight checklist

Complete before any `npm publish`:

- [x] **Not private:** `"private": true` removed from `mcp/package.json`
- [x] **Publishable entry:** `bin` → `./dist/index.js` (shebang on entry)
- [x] **`files` field:** `dist/` + `README.md`
- [x] **`mcp/tsconfig.json`:** ESM emit to `dist/`
- [ ] **npm account:** `npm whoami` returns your username
- [ ] **Version bumped** if re-releasing
- [x] **Clean build:** `npm run build` in `mcp/` exits 0
- [x] **Dry-run:** `npm pack --dry-run` — only `dist/` + `README.md`
- [ ] **Desktop smoke:** Screen Beaver open; bridge on `127.0.0.1:17355`
- [ ] **MCP smoke:** `ping_studio` works from Cursor after config update

### Current `mcp/package.json` shape

```json
{
  "name": "screen-beaver-mcp",
  "version": "0.1.1",
  "license": "MIT",
  "type": "module",
  "bin": { "screen-beaver-mcp": "./dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "dependencies": {},
  "devDependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "esbuild": "^0.28.1",
    "zod": "^3.25.76"
  }
}
```

Notes:

- **Published package has no runtime dependencies** — `npm run build` bundles MCP SDK + zod into `dist/index.js` so Socket/npm consumers do not inherit express/cors/cross-spawn transitive alerts.
- Local monorepo uses Socket Registry **overrides** for small leaf packages (`object-assign`, `side-channel`, …).
- Monorepo `npm run start` still uses `tsx` for fast iteration.
- Bridge env: `SCREEN_BEAVER_BRIDGE` (preferred) or legacy `SCREEN_WEAVER_BRIDGE`.

---

## Phase 1 — Build

From the MCP folder:

```powershell
cd mcp
npm install
npm run build
```

Or from repo root:

```powershell
npm run mcp:install
npm run mcp:build
```

### Inspect tarball contents

```powershell
cd mcp
npm pack --dry-run
```

Confirm you see `dist/` + `README.md` only (no secrets, no huge fixtures).

---

## Phase 2 — Publish to npm

```powershell
cd mcp
npm publish
```

Wait for success before telling users to upgrade / reinstall.

### Re-publish (patch / minor)

1. Bump `version` in `mcp/package.json`
2. `npm run build`
3. `npm publish`

You cannot overwrite an existing version — bump first.

---

## Phase 3 — Verify on npm

| Package | URL |
|---------|-----|
| `screen-beaver-mcp` | https://www.npmjs.com/package/screen-beaver-mcp |

### Quick install test (clean folder)

```powershell
mkdir $env:TEMP\screen-beaver-mcp-test
cd $env:TEMP\screen-beaver-mcp-test
npx -y screen-beaver-mcp
```

Leave Screen Beaver desktop running. From Cursor (with production MCP config below), call `ping_studio`.

---

## Phase 4 — MCP config (for you and users)

### Production (after npm publish)

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

**Requirements:**

1. Screen Beaver desktop running (Store, installed build, or `npm run desktop:dev`)
2. Bridge reachable at `http://127.0.0.1:17355` (default)

Optional override:

```json
"env": {
  "SCREEN_BEAVER_BRIDGE": "http://127.0.0.1:17355"
}
```

### Monorepo / unpublished local (dev)

```json
{
  "mcpServers": {
    "screen-beaver": {
      "type": "stdio",
      "command": "npm.cmd",
      "args": [
        "--prefix",
        "${workspaceFolder}/mcp",
        "run",
        "start"
      ]
    }
  }
}
```

Or point at the built entry after `npm run build`:

```json
{
  "mcpServers": {
    "screen-beaver": {
      "command": "node",
      "args": ["D:/Screen Weaver/screen-weaver/mcp/dist/index.js"]
    }
  }
}
```

After install or config changes: enable **screen-beaver** under **Customize → MCPs**, then reload Cursor / open a new agent chat.

Skill (local): `.cursor/skills/screen-weaver-demo/SKILL.md`

### MCP smoke test

1. Start desktop: `npm run desktop:dev` (or installed Screen Beaver)
2. Ensure MCP is enabled in Cursor
3. In a new agent chat, call `ping_studio`
4. Optionally run a short `list_capture_targets`

---

## Phase 5 — User-facing install notes

After publish, point users at:

### Cursor

Add the production `mcpServers` block above to Cursor MCP settings (or project `.cursor/mcp.json`).

### Claude Desktop

Same stdio shape — `command` + `args` for `npx -y screen-beaver-mcp`.

### One-liner check

```powershell
npx -y screen-beaver-mcp
```

(Process will wait on stdio — that is expected for an MCP server.)

---

## Phase 6 — Microsoft Store (optional, separate track)

npm publish does **not** update the Store app. Ship desktop separately when you need a new Screen Beaver build.

### 1. Bump app version

- Root `package.json` → `version`
- `src-tauri/tauri.conf.json` / Store package identity version if required

### 2. Build Store payload

```powershell
cd .
npm run desktop:build:store
```

Then package / upload via your MSIX / Partner Center flow (`packaging/msix/` and the Visual Studio WAP project).

### What each channel includes

| Included in Store / desktop build | Published separately on npm |
|-----------------------------------|-----------------------------|
| Recorder, editor, export | `screen-beaver-mcp` |
| Local HTTP bridge on `:17355` | Cursor / Claude MCP entry via `npx` |
| Native capture + demo automation APIs | — |

---

## Version bumps (next release)

| Package | File | Current |
|---------|------|---------|
| `screen-beaver-mcp` | `mcp/package.json` | `0.1.1` |
| Screen Beaver desktop | root `package.json` / Tauri | (app version) |

**Rules:**

- **Patch** (`0.1.0` → `0.1.1`): bug fixes, docs in package
- **Minor** (`0.1.x` → `0.2.0`): new MCP tools / options (backward compatible)
- **Major**: breaking tool renames or required env / bridge protocol changes

---

## Local monorepo dev (without republishing)

```powershell
cd .
npm run mcp:install
npm run mcp:build
npm run desktop:dev
```

Cursor continues to use `.cursor/mcp.json` → `npm --prefix mcp run start`.

Only switch project/user MCP config to `npx -y screen-beaver-mcp` when validating the **published** artifact.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `This package has been marked as private` | Remove `"private": true` from `mcp/package.json` |
| Version already published | Bump `version`, rebuild, publish again |
| `npx` runs but tools hang | Is Screen Beaver open? Bridge on `127.0.0.1:17355`? |
| Works in monorepo, fails via `npx` | Published tarball missing `dist/` or `bin` wrong — check `npm pack --dry-run` |
| `tsx` / TypeScript errors for end users | Do not ship `.ts` as `bin`; publish compiled JS |
| MCP missing in Cursor | Enable **screen-beaver** under **Customize → MCPs**, reload / new chat |
| Wrong bridge | Set `SCREEN_BEAVER_BRIDGE` when overriding the default |

---

## Architecture reference

### Bridge

| Mode | URL |
|------|-----|
| Desktop (default) | `http://127.0.0.1:17355` |
| Override | `SCREEN_BEAVER_BRIDGE` (or legacy `SCREEN_WEAVER_BRIDGE`) |

### Flow

```
Cursor / Claude  →  screen-beaver-mcp (stdio)
                         ↓ HTTP
              Screen Beaver desktop bridge :17355
                         ↓
              capture / demo / recipe / export APIs
```

| Concern | Answer |
|---------|--------|
| Cloud MCP host required? | **No** — local stdio + local bridge |
| Desktop must be open? | **Yes** for tool calls |
| npm publish updates Store app? | **No** |

---

## Links

- Product: https://screenbeaver.com
- MCP spec: https://modelcontextprotocol.io
- Package (after publish): https://www.npmjs.com/package/screen-beaver-mcp
- Local skill: `.cursor/skills/screen-weaver-demo/SKILL.md`
- MCP readme: `mcp/README.md`
