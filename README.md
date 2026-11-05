<p align="center">
  <img src="docs/assets/logo.png" alt="Screen Beaver logo" width="96" />
</p>

<h1 align="center">Screen Beaver</h1>

<p align="center">
  <strong>Screen recorder for product demos that auto-polishes zooms, captions, and export — locally on Windows.</strong>
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="Screen Beaver demo — record, zoom, caption, export" width="100%" />
</p>

<p align="center">
  <a href="#screenshots">Screenshots</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#mcp--ai-agents">MCP</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://github.com/ScreenBeaver/ScreenBeaver/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ScreenBeaver/ScreenBeaver/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0a0c10?style=flat-square" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square" />
  <img alt="Stack" src="https://img.shields.io/badge/stack-Tauri%20%2B%20React-9ef0d2?style=flat-square&labelColor=0a0c10" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-agent%20ready-7c5cff?style=flat-square" />
</p>

### Install (one step)

```text
Microsoft Store → search “Screen Beaver” → Get
```

Or open the Store listing directly: **[apps.microsoft.com/detail/9P89CCNBVMVV](https://apps.microsoft.com/detail/9P89CCNBVMVV)**

<p align="center">
  <a href="https://apps.microsoft.com/detail/9P89CCNBVMVV">
    <img
      src="https://get.microsoft.com/images/en-us%20dark.svg"
      alt="Get it from Microsoft Store"
      height="52"
    />
  </a>
</p>

**Try without installing from source:** [screenbeaver.com](https://screenbeaver.com) · [Microsoft Store](https://apps.microsoft.com/detail/9P89CCNBVMVV) · short demo above.

---

## Screenshots

<p align="center">
  <img src="docs/assets/screenshots/ProductDemos_1_Store.png" alt="Screen Beaver home — create a product demo" width="100%" />
</p>

<p align="center"><em>Home — create demos, see weekly activity, and jump back into recent projects.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/Windows_ScreenBeaver_4.png" alt="Studio with camera overlay and background gallery" width="100%" />
</p>

<p align="center"><em>Studio — backgrounds, camera PiP, timeline, and local export.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/Windows_ScreenBeaver_2.png" alt="Camera inspector and timeline" width="48%" />
  &nbsp;
  <img src="docs/assets/screenshots/Windows_ScreenBeaver_3.png" alt="AI voiceover panel" width="48%" />
</p>

<p align="center"><em>Left: camera &amp; timeline · Right: AI voiceover (translate + Edge TTS).</em></p>

<p align="center">
  <img src="docs/assets/screenshots/Product_Demo_3.png" alt="Agent-driven demos and MCP workflow" width="48%" />
  &nbsp;
  <img src="docs/assets/screenshots/Product_Shoot_2.png" alt="Keyboard shortcut overlays" width="48%" />
</p>

<p align="center"><em>Left: MCP / agent-driven demos · Right: keyboard shortcut overlays in the video.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/ProductDemo_6.png" alt="Android USB capture with motion backgrounds" width="72%" />
</p>

<p align="center"><em>Android USB takes — vertical 9:16, motion backgrounds, full timeline polish.</em></p>

---

## Why Screen Beaver?

Most “screen recorders” stop at a raw take. Screen Beaver is a **studio for product stories**:

| Without Screen Beaver | With Screen Beaver |
| --- | --- |
| Jumpy cursor, no focus | Smoothed cursor + cinematic zooms |
| Manual caption grind | Live captions + AI voiceover |
| Flat full-screen dump | Device frames, chrome, motion backgrounds |
| Separate tools for polish | One timeline: zooms · FX · SFX · captions |
| Cloud-only editors | **Local** H.264 export — nothing uploaded to encode |

All studio features in this open-source build are **free offline**. Optional cloud sign-in is only for share links.

---

## Features

### Capture

| Feature | Details |
| --- | --- |
| **Screen / window / tab** | Full display, app window, or browser tab |
| **Native desktop capture** | Record without the OS share picker (Tauri) |
| **System-wide cursor hook** | Track pointer + hotkeys even inside Excel / native apps |
| **Camera + mic + system audio** | Optional selfie PiP and narration tracks |
| **Android USB** | Mirror + record phones via portable ADB/scrcpy |
| **Companion extension** | Sharper tab-relative cursor & zooms in Chrome/Edge |

### Edit & polish

| Feature | Details |
| --- | --- |
| **Auto zooms** | Derived from clicks, typing, and interaction density |
| **Manual zooms** | Place, scale, follow-cursor, vertical reframe for 9:16 |
| **Scene effects** | Hero zoom, 3D tilt/spin, glare, mockup reveal, and more |
| **Cursor polish** | Smoothing, click ripples, real OS cursor shapes |
| **Captions** | Live ASR while recording, edit cues, export `.srt` |
| **AI voiceover** | Translate captions + Edge TTS neural voices |
| **SFX bed** | Click, whoosh, shimmer, typing — auto or manual |
| **Keyboard overlays** | Shortcut callouts burned into the frame |
| **Backgrounds** | Wallpapers, gradients, motion fields, custom images |
| **Device / window frames** | Phone shells, browser/macOS/Windows chrome |
| **Timeline** | Multi-lane edit with cut, trim, speed, undo/redo |

### Export & agents

| Feature | Details |
| --- | --- |
| **Local MP4** | 720p → 4K, 24/30/60 fps, Web/High/Max quality |
| **No watermark** | Open-source build ships watermark-free |
| **MCP bridge** | Let Cursor / Claude drive demos while you watch |
| **Projects** | Save / open `.yasharka` project files |

Full product surface: **[docs/FEATURES.md](./docs/FEATURES.md)**.

---

## Quick start

### Install from Microsoft Store (recommended)

The easiest way to run Screen Beaver on Windows 10 / 11:

**[Get it from Microsoft Store →](https://apps.microsoft.com/detail/9P89CCNBVMVV)**

Updates come through the Store. Use the build-from-source steps below if you are developing or contributing.

### Prerequisites (from source)

| Tool | Notes |
| --- | --- |
| **Node.js 20+** | `npm` included |
| **Rust (rustup)** | Required for Tauri |
| **WebView2** | Windows desktop runtime |
| **Chrome or Edge** | Recommended for WebCodecs export |

### Build & run from source

```bash
git clone https://github.com/ScreenBeaver/ScreenBeaver.git
cd ScreenBeaver
npm install
npm run desktop:dev
```

### Web UI only

```bash
npm run dev
```

Web mode still records via the browser picker, but loses system-wide cursor tracking and Android USB.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run desktop:dev` | Tauri desktop app (hot reload) |
| `npm run desktop:build` | Release EXE (no nested installer) |
| `npm run desktop:build:store` | Store-oriented build + MSIX payload stage |
| `npm run dev` | Web studio only |
| `npm run build` | Frontend production build |
| `npm run mcp` | Start the local MCP server |
| `npm run mcp:build` | Bundle MCP for publish / `npx` |

---

## MCP / AI agents

Screen Beaver exposes a local bridge (`127.0.0.1:17355`) and an MCP server so agents can:

- open apps / URLs
- move, click, type, and scroll during a capture
- add captions, zooms, effects, and music
- run `record_and_build` / live demo flows while you watch

```bash
npm run mcp:install
npm run mcp:build
npm run mcp
```

See [`mcp/README.md`](./mcp/README.md) and [`docs/PUBLISHING.md`](./docs/PUBLISHING.md).

---

## Project layout

```text
ScreenBeaver/
├── src/                 # React studio (TanStack Start)
├── src-tauri/           # Tauri / Rust desktop shell + native capture
├── mcp/                 # MCP server (agent tools)
├── extension/           # Chrome/Edge companion
├── packaging/msix/      # Microsoft Store packaging helpers
├── public/              # Runtime assets (sounds, wallpapers, official logo)
├── docs/                # Documentation + README media
│   ├── FEATURES.md
│   ├── DESKTOP.md
│   ├── DESKTOP_ACCOUNT.md
│   ├── PUBLISHING.md
│   └── assets/
│       ├── logo.png           # Official Screen Beaver logo
│       └── screenshots/       # Product screenshots for GitHub
├── recipes/             # Example polish recipes
└── LICENSE
```

---

## Configuration

Copy `.env.example` → `.env` only if you need overrides. **Never commit a real `.env`.**

| Variable | Purpose |
| --- | --- |
| `VITE_SCREENBEAVER_API_URL` | Optional cloud API (sign-in / share). Default `https://screenbeaver.com` |

Studio features work fully **offline** without an account.

---

## Microsoft Store packaging

Tauri does not emit MSIX. Build the release binary, stage the payload, then package with Visual Studio / MakeAppx:

```bash
npm run desktop:build:store
```

Details: [`packaging/msix/README.md`](./packaging/msix/README.md) · replace placeholder Partner Center identity before Store submission.

---

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/FEATURES.md](./docs/FEATURES.md) | Complete feature guide (recording → export → MCP) |
| [docs/DESKTOP.md](./docs/DESKTOP.md) | Desktop architecture, build, extension bridge |
| [docs/DESKTOP_ACCOUNT.md](./docs/DESKTOP_ACCOUNT.md) | Optional cloud account handshake |
| [docs/PUBLISHING.md](./docs/PUBLISHING.md) | Publishing the MCP package to npm |
| [mcp/README.md](./mcp/README.md) | MCP tools & agent setup |
| [packaging/msix/README.md](./packaging/msix/README.md) | Store / MSIX notes |

---

## Stack

| Layer | Tech |
| --- | --- |
| UI | React 19, TanStack Start / Router, Tailwind CSS |
| Desktop | Tauri 2, Rust |
| Encode | WebCodecs → H.264 MP4 (local) |
| Agents | Model Context Protocol (`screen-beaver-mcp`) |
| Voice | Edge TTS (optional network) |
| Music | Openverse CC catalog via MCP (optional) |

---

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** — local setup, PR rules, and our **one-business-day reply** goal.

Good first issues: [`good first issue`](https://github.com/ScreenBeaver/ScreenBeaver/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).  
Questions: [Discussions](https://github.com/ScreenBeaver/ScreenBeaver/discussions).

Changelog: [CHANGELOG.md](./CHANGELOG.md) · Show HN draft: [docs/SHOW_HN.md](./docs/SHOW_HN.md)

---

## License

[MIT](./LICENSE) © Screen Beaver

---

<p align="center">
  <img src="docs/assets/logo.png" alt="Screen Beaver" width="56" /><br/>
  <sub>Record · Polish · Export — locally.</sub>
</p>
