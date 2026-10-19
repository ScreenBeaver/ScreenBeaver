# Screen Beaver Desktop (Tauri) + Browser Companion

Desktop-centric recorder for **entire screen / any app** (Excel, etc.) with system-wide cursor tracking and Shift/Ctrl+Click zooms. Optional Chrome/Edge extension improves zoom accuracy inside browser tabs.

## Architecture

| Piece | Role |
|---|---|
| **Tauri EXE** (`src-tauri`) | System-wide mouse + Shift/Ctrl+Click + Shift+Space; local bridge on `127.0.0.1:17355` |
| **React studio** (`src`) | Capture, editor, export (same UI as web) |
| **Companion extension** (`extension`) | Tab-relative cursor + zooms while you browse; posts to the desktop bridge |

You do **not** integrate per app. Share a window or entire screen once; the desktop hook tracks the cursor anywhere on that display.

## Prerequisites

- Node 20+
- Rust (rustup) — already required for Tauri
- WebView2 (Windows)
- For Store: Visual Studio (Windows Application Packaging Project) or MakeAppx + Partner Center

## Run desktop app

```bash
npm install --legacy-peer-deps
npm run desktop:dev
```

## Build release EXE / NSIS installer

```bash
npm run desktop:build              # release EXE only
npm run desktop:build:installer    # NSIS setup EXE
```

`beforeBuildCommand` always rebuilds MCP and copies it to `src-tauri/resources/mcp/index.js`. The installed app’s Remote MCP (Claude / ChatGPT / BetterClaw over the relay) runs **that** file — not your repo’s `mcp/`. Rebuild the installer after MCP or capture fixes, or agents keep talking to yesterday’s bundle.

Output EXE: `src-tauri/target/release/screen-weaver.exe`  
Installer: `src-tauri/target/release/bundle/nsis/`  
Release profile uses LTO + strip for a smaller binary.

### Frontend dist path

Desktop builds set `TAURI_ENV_PLATFORM` so Vite skips Nitro (Cloudflare SSR) and runs TanStack **SPA prerender** into `dist/client/index.html`. `frontendDist` is `../dist/client`. `scripts/prepare-tauri-frontend.mjs` rewrites asset URLs to relative paths for WebView2. Web/Cloudflare deploys are unchanged.

## Install Chrome / Edge extension

1. Open `chrome://extensions` or `edge://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Start the Screen Beaver desktop app (bridge must be up)
5. Extension popup should say **Connected**

In any tab: **Shift+Click** or **Ctrl+Click** = zoom, **Shift+Space** = camera sweep.

## Recording tips

- Prefer **Entire screen** or an **application window**
- Keep camera enabled — a large bubble appears bottom-left/right (click to flip)
- With desktop tracking on, leave the Screen Beaver window and demo Excel normally
- Real cursor stays visible while recording; smooth cursor is applied in the editor

## Android USB (desktop)

In **New recording → Android phone (USB)**:

1. First use downloads portable **scrcpy + adb** (~11 MB) into `%LOCALAPPDATA%\screen-weaver\android-runtime\` (not a system USB driver install).
2. On the phone: Developer options → **USB debugging** → plug in → tap **Allow**.
3. Screen Beaver mirrors the phone with mouse/keyboard control and records an MP4 into the studio.

ADB only addresses debug-enabled Android devices. Other USB ports (keyboards, drives, etc.) are left alone. Windows may still install a normal per-phone composite driver the first time debugging is enabled — that is PnP, not a system-wide USB hijack.

## Microsoft Store (MSIX)

Full steps: [`packaging/msix/README.md`](packaging/msix/README.md)

```bash
npm run desktop:build:store
```

1. Stages `packaging/msix/payload/` with the release EXE (no nested installer)
2. Create a **Windows Application Packaging Project** in Visual Studio pointing at that payload
3. Align `Identity` / publisher with Partner Center (`packaging/msix/Package.appxmanifest`)
4. Build `.msix` and upload as an **MSIX** app with `runFullTrust`
5. Declare screen capture / camera / microphone capabilities as required by Store policies

Update `identifier` / `publisher` in `src-tauri/tauri.conf.json` and the Appx identity before submitting.

## Web vs desktop

| | Web (browser) | Desktop EXE |
|---|---|---|
| Record screen | Yes | Yes |
| Smooth cursor in editor | When this page tracked the pointer | System-wide |
| Zoom in Excel / other apps | Limited | Yes |
| Tab zooms via extension | Optional | Yes (with extension) |
