# Screen Beaver - Product features

**What I am:** a local desktop studio for recording screens (and Android phones) and turning raw takes into polished product demos — smooth cursor, cinematic zooms, effects, captions, AI voiceover, music, and H.264 MP4 export. Nothing is uploaded for export; encoding happens on your machine.

**Who I am for:** founders, PMs, and developers who need tutorial / launch / walkthrough videos without a full video-editing suite.

**Where I run:** browser-based studio UI + optional **Tauri desktop app** (Windows) for system-wide cursor tracking, picker-free native capture, USB Android recording, and MCP/agent control. Companion **Chrome/Edge extension** can refine tab-relative cursor/zooms when the desktop bridge is up (`127.0.0.1:17355`).

---

## Table of contents

1. [Recording](#1-recording)
2. [Live recording experience](#2-live-recording-experience)
3. [Start page & projects](#3-start-page--projects)
4. [Studio layout](#4-studio-layout)
5. [Background, frame & crop](#5-background-frame--crop)
6. [Motion backgrounds](#6-motion-backgrounds)
7. [Cursor](#7-cursor)
8. [Zoom](#8-zoom)
9. [Camera (selfie / PiP)](#9-camera-selfie--pip)
10. [Scene effects](#10-scene-effects)
11. [Timeline editing](#11-timeline-editing)
12. [Sound effects](#12-sound-effects)
13. [Captions](#13-captions)
14. [AI voiceover](#14-ai-voiceover)
15. [Audio & music](#15-audio--music)
16. [Keyboard shortcut overlays](#16-keyboard-shortcut-overlays-in-the-video)
17. [Auto pipeline after a take](#17-auto-pipeline-after-a-take)
18. [Export](#18-export)
19. [Desktop / Tauri capabilities](#19-desktop--tauri-capabilities)
20. [Android USB capture](#20-android-usb-capture)
21. [MCP / agent control](#21-mcp--agent-control)
22. [Themes, aspect ratios & look presets](#22-themes-aspect-ratios--look-presets)
23. [Keyboard cheat sheet](#23-keyboard-cheat-sheet)
24. [What I am not](#24-what-i-am-not)

---

## 1. Recording

### Capture surfaces

| Source | What you get | Notes |
|--------|----------------|-------|
| **Entire screen** | Full display | Best for OS menus, dropdowns, right-click context menus |
| **Application window** | One app window | Cleaner framing; menus that draw *outside* the window are missed |
| **Browser tab** | Single tab | Cleanest page capture; no chrome outside the tab |
| **Android phone (USB)** | Phone mirror + MP4 | Desktop app only; portable ADB/scrcpy (see [§20](#20-android-usb-capture)) |

### Tracks you can include

- **Screen / mirror video** — primary take
- **Camera** — selfie bubble recorded alongside (hidden for Android surface)
- **Microphone** — narration; also feeds live captions (Chrome/Edge speech recognition)
- **System / tab audio** — when the OS/browser share dialog includes “Share audio”
- **Smooth cursor path** — samples while recording so the editor can draw a polished cursor and derive auto zooms

### How recording starts

1. **New recording** from the start page, top bar, or empty stage
2. **Source picker** chooses surface + camera / mic / system audio / smooth cursor
3. Browser path uses `getDisplayMedia` (OS share picker)
4. Desktop **native capture** (and MCP) can record an app window **without** the OS Share dialog
5. Android path starts scrcpy mirror + file recording after device select

---

## 2. Live recording experience

While a take is rolling:

- **Centered HUD** — elapsed time, pulsing record indicator
- **Track** badge when the desktop system-wide pointer hook is active
- **Zoom** / **Camera** HUD buttons — plant a zoom or camera-sweep marker at the live cursor
- **Pop out** — Document Picture-in-Picture control bar (Zoom / Camera / Stop) when the browser supports it
- **Stop** — ends the session and runs the auto edit pipeline into the studio
- **Camera bubble** — large circular live preview (≈132-152px); click to flip bottom-left ↔ bottom-right; mirrored

### Gestures & hotkeys *during* capture

| Input | Result |
|-------|--------|
| **Shift+Click** / **Ctrl+Click** | Zoom keyframe at cursor (desktop hook / extension; no duplicates when hook owns input) |
| **Hold Alt** | Zoom follows cursor for as long as Alt is held |
| **Shift+Space** | Camera arc / sweep marker |
| **Ctrl+1 … Ctrl+6** | Cinematic scene-effect presets (system-wide on desktop) |
| **Ctrl+7** | Glare stripe (shimmer-style light pass) |
| **Modifier chords, F-keys, Esc** | Recorded as **keyboard shortcut overlays** for the video |

Typing on printable keys (without Ctrl/Cmd/Alt) can drive **typing SFX** feedback while recording.

---

## 3. Start page & projects

### Left rail tabs

- **Home** — create / record / open / import / recent projects
- **Media** — imported videos, images, audio
- **Audio** — audio-focused library slice
- **Projects** — saved `.yasharka` library entries

### Actions

- **Create a new video** — empty studio shell
- **Record screen** — opens source picker
- **Open** `.yasharka` project files
- **Import media** — video → take; audio → background music bed; images → library; projects → open
- **Drag & drop** onto the start page or timeline
- **Theme** — Light / Dark
- **Recent projects** — open or delete from the local library

### Project format (`.yasharka`)

- Saves styling, timeline markers, zooms, effects, captions, keystrokes, music metadata, etc.
- **Ctrl+S** / Top bar **Save** — writes a library entry and downloads the project file
- Opening settings without the original video prompts a **link recording** flow on the stage
- Media blobs may need re-linking after a browser restart (object URLs are session-local unless re-imported)

---

## 4. Studio layout

| Region | Job |
|--------|-----|
| **Top bar** | Home, new recording, save, discard, undo/redo, look presets, inspector toggle, theme, Export / Stop |
| **Icon rail** | Inspector tabs: Background · Motion · Effects · Cursor · Zoom · Camera · Captions · Voiceover · Audio · Shortcuts · Export |
| **Stage** | Live composited preview, playhead transport, aspect ratio, crop |
| **Timeline** | Multi-lane edit: Clip · Zoom · Cam · FX · SFX · Captions |
| **Inspector** | Deep controls for the active tab (~280px, toggleable) |
| **Agent host** | Quiet activity strip when MCP/agent commands run |

---

## 5. Background, frame & crop

### Background modes

- **Wallpaper** — curated gradient meshes (sunbeam, arctic, midnight, slate, brand-style packs, …)
- **Gradient** — from / to colors + angle
- **Color** — solid fill
- **Image** — custom upload
- **Motion** — animated fields (see [§6](#6-motion-backgrounds)); switch via Motion tab
- **Background blur** — 0-100% softens wallpapers / images / gradients

### Product frame

- **Padding**, **corner radius**, **shadow**
- **Window chrome:** None · Browser · macOS · Windows
  - Browser: address/search text + optional site label; can crop real browser chrome via **Hide native header**
  - macOS / Windows: custom window title
- **Chrome theme:** Dark / Light
- **Hide native header** (0-30%) — strip real OS/browser title bar from the take
- **Hide taskbar** (0-12%) — strip Windows taskbar on full-screen takes (often auto-set)

### Device frames (phones / tablets)

Catalog includes generic Android, Xiaomi/Redmi, Pixel, Galaxy, OnePlus/Oppo, iPhone lines, and tablet shells, each with colorways (black, graphite, titanium variants, brand colors, …).

Selecting a phone typically:

- Forces **9:16** (tablet often **4:3**)
- Clears desktop window chrome
- Tightens padding  
Android USB takes can **auto-match** a frame from the device label.

### Crop your recording

Interactive crop tool (Stage **Crop**, or Background → **Open crop tool**):

- Drag the selection; 8 resize handles
- Aspect locks: **Free · Original · 16:9 · 4:3 · 1:1 · 9:16**
- Numeric width / height in source pixels
- **Reset to full** · **Apply crop**
- Stored as normalized `frame.crop` and honored in preview **and** export — focus a region or hide UI chrome for the whole take

---

## 6. Motion backgrounds

Optional animated stage backdrops:

- **Ribbon Field**
- **Aurora**
- **Sunset Mesh**
- **Linear Glow**

Toggle **Use motion background** in the Motion inspector.

---

## 7. Cursor

- **Show smoothed cursor** over the take (needs a captured path)
- **Style override:** Auto · Arrow · Hand · I-beam · Cross · Move · Wait (and custom bitmaps from the desktop hook when available)
- **Motion smoothing** — springy follow of raw samples
- **Size** — roughly 60-220%
- **Click ripple** on downs
- **Auto-hide** when the cursor is idle
- Desktop hook streams **real OS cursor shapes** (I-beam, resize, hand, …) and **custom app icons** (Excel cell cursor, etc.) into the smoothed overlay
- When an app hides the OS pointer (many games), Screen Beaver **does not** draw a fake arrow on top

---

## 8. Zoom

### Modes

- **Auto** — derive zooms from clicks, typing bursts, and interaction density; merge nearby same-region punches; **intensity bias** (~1.5-2.6×); **Regenerate auto zooms & camera**
- **Manual** — you place zooms; **Add zoom at playhead**; **Pick focus on preview** (click the stage)

### Per-zoom controls

- Scale, duration, follow-cursor, focus x/y, remove
- Vertical (**9:16**) export reframes / boosts zooms for social crops

### How zooms get onto the timeline

- Live markers (Shift/Ctrl+Click, Alt-hold, HUD Zoom)
- Auto derivation after stop
- Effects bundles (Hero, Focus, Punch, 3D templates, …)
- Timeline Insert · Zoom · or **Z** at playhead

---

## 9. Camera (selfie / PiP)

- Show / hide camera bubble in the composition
- **3×3 position grid** (corners, edges, center)
- **Mirror**, **roundness**, **size**, optional **different size while zoomed**
- **Avoid covering cursor** — softly pushes the bubble away from the pointer
- **Drop shadow**
- **Backdrop behind the person:** None · Blur · Color · Image  
  Blur / replace uses on-device **person segmentation** when MediaPipe loads; fails soft to raw camera
- **Camera moves** at playhead: Arc L→R · Arc R→L · Orbit · Dip away  
  Auto camera arcs can be derived with zooms when the camera is enabled

---

## 10. Scene effects

Insert cinematic passes (inspector Effects rail, timeline Insert, or **Ctrl+1-7** while recording/editing):

| Preset | Feel |
|--------|------|
| **Hero zoom** (Ctrl+1) | Punch in, hold, pull out |
| **3D tilt** (Ctrl+2) | Camera from the left + zoom |
| **Focus zoom** (Ctrl+3) | Tight follow on the cursor |
| **3D spin** (Ctrl+4) | Orbit + zoom |
| **Glare stripe** (Ctrl+5 / Ctrl+7) | Diagonal light shimmer |
| **Mockup reveal** (Ctrl+6) | Camera from the right + zoom |
| **Window reveal** | Product rises into frame (often auto-inserted as intro) |
| **3D rotate / Float / Punch in** | Extra FX-rail variants |

Bundles may add zoom clips, camera moves, and whoosh / shimmer SFX automatically.

---

## 11. Timeline editing

### Lanes

1. **Clip** — screen take, waveform-ish bed, trim in/out, multi-segment cuts  
2. **Zoom**  
3. **Cam** — camera moves  
4. **FX** — scene effects  
5. **SFX** — click / whoosh / shimmer / typing / …  
6. **Caps** — caption cues  

### Editing powers

- Drag clips to move; drag edges to resize
- Select → inspector details or **Delete**
- **Trim** handles on the main clip (in/out)
- **Cut / split** at playhead (**C** or Insert → Cut) — select the **Clip** lane first (clears zoom/FX selection), then cut; builds keep-segments; delete a segment to drop a range
- Selecting a clip opens the **Clip** inspector: per-clip speed, cut, delete
- With multiple clips: **drag to reorder**, drag **edges to trim** that clip only
- **Insert strip:** Zoom · Camera · effects 1-6 · Click · R-click · Whoosh · Shimmer · Typing · Caption · Cut
- Resizable timeline height (drag separator; double-click to reset)
- Drop video onto the timeline to link/replace the take
- **Undo / Redo** (Top bar, **Ctrl+Z**, **Ctrl+Shift+Z** / Ctrl+Y) — deep history (~50 steps)
- Stage: **Space** play/pause, skip ±2s, aspect menu, crop, timecode

### Playback speed

Per-clip **0.5×-2.0×** in the Clip panel (falls back to Audio → default speed). Shown on each clip bed.

---

## 12. Sound effects

Kinds used in the product:

- **Click** / **Right-click**
- **Whoosh** — zoom / camera motion accents
- **Shimmer** — glare / reveal light passes
- **Typing** — keyboard bed / bursts (including soft-keyboard heuristics on Android)

Auto placement after a take:

- Whooshes aligned to zooms
- Clicks from cursor downs
- Typing from key bursts / soft taps
- Shimmers from matching effects  

Manual insert from the timeline strip; previewable in the editor.

---

## 13. Captions

- **Show** in preview · **Burn into** preview/export
- Font size control
- **Live captions** via Chrome/Edge Web Speech while recording (mic on) — no cloud model download for ASR
- Refresh from session, nudge **±0.5s**, edit text per cue, **Download .srt**, clear all
- Captions are **not** pulled from a finished file without a downloadable model — re-record with mic for ASR

---

## 14. AI voiceover

- Toggle **AI voiceover** (studio mutes mic under VO clips during playback/export)
- **Speaking language** for ASR alignment context
- **Translate & speak as** — translate caption cues, then synthesize
- **Edge TTS** voice catalog (neural voices by locale)
- Actions: Translate captions · Generate AI voiceover · Clear voiceover
- Clips sit on the timeline aligned to captions; music ducks under VO on export

---

## 15. Audio & music

- Take **microphone** and/or **system audio** status + inline preview
- **Background music** bed — import audio or pull Creative Commons tracks via MCP/Openverse helpers
- Volume control (~4-40%), loop, clear
- Music ducks under AI voiceover when both are present on export

---

## 16. Keyboard shortcut overlays (in the video)

Screen Studio-style **keycaps** burned into the frame:

- Captured during recording (desktop hook system-wide; browser when focused; Android when typing into the mirror with the hook on)
- Shows modifier chords (Ctrl / Alt / Win), function keys, Esc, etc. — not every plain letter of typing
- Inspector **Shortcuts / Keys**:
  - Show in video · Burn into export · Size · Position (bottom / left / right / center)
  - List, edit labels, remove cues, clear all
- Same panel also lists the **editor cheat sheet**

---

## 17. Auto pipeline after a take

When you hit Stop, Screen Beaver typically:

1. Imports screen (+ camera / mic) and cursor path  
2. Builds **auto zooms** (if Zoom mode is auto) and merges with manual/effect zooms  
3. Derives **auto camera moves** when useful  
4. May insert a **window-reveal** intro  
5. Ensures **whoosh / click / typing / shimmer** SFX  
6. Applies **live captions** if any  
7. Applies **keystroke overlays** if any  
8. For Android: clears desktop chrome crops, prefers **9:16**, may auto-pick a **device frame**  
9. For full-monitor takes: may set **taskbar crop**  
10. Opens the studio with inspector ready and a summary toast (zooms, SFX, effects, captions, shortcuts counts)

---

## 18. Export

- **Format:** H.264 **MP4** only (WebCodecs / browser encode — Chrome or Edge recommended)
- **Nothing uploaded** for the encode itself
- **Resolution:** 720p · 1080p · 1440p · 4K (landscape); matching vertical sizes for 9:16
- **Frame rate:** 24 · 30 · 60 fps
- **Quality:** Web · High · Max
- Frame-by-frame compositor render (same look as the stage): background, frame/device shell, crop, zooms, effects, cursor, camera, captions, keycaps
- Mixes mic, SFX, voiceover, and ducked music
- Filename: `{project-name}.mp4`

---

## 19. Desktop / Tauri capabilities

The desktop shell unlocks:

| Capability | Why it matters |
|------------|----------------|
| **System-wide pointer hook** | Cursor + zooms + Alt-hold + Shift+Space + Ctrl+1-7 even when focus is in Excel/other apps |
| **Native window capture** | Record without the OS Share picker; list windows/monitors |
| **Android USB** | scrcpy mirror + control + record |
| **Extension bridge** | `127.0.0.1:17355` — companion extension + MCP |
| **MCP / agent control** | Drive window + Android USB via `android_*` / `record_android_and_build` |
| **Store packaging** | Raw release EXE → full-trust MSIX (no WiX/NSIS/MSI nested install) |

Web-only mode still records via the browser picker but loses system-wide tracking and Android USB.

---

## 20. Android USB capture

- Desktop app required
- Portable **ADB + scrcpy** under `%LOCALAPPDATA%\screen-weaver\android-runtime\`
- Device list (USB / network serials), refresh, select
- Mirror window accepts mouse/keyboard; recording writes MP4
- Cursor path sampled over the mirror for zooms / clicks
- Typing / soft-keyboard tap heuristics for typing SFX
- PC keyboard chords while controlling the phone → shortcut overlays (hook without blanking the OS cursor)
- Finish path: phone aspect, device shell, no leftover desktop chrome crop

---

## 21. MCP / agent control

Agents (e.g. Cursor) can drive Screen Beaver through the MCP server while you watch the UI update.

### Preferred agent flows

- `record_and_build` / `live_build_demo` — capture + auto captions/zooms/recipe-style polish  
- User clicks **Export** for the final MP4 (agents can also call export tools when appropriate)

### Tool groups (high level)

- **Studio presence:** ping, status, capabilities, focus, window layout  
- **Capture:** list targets, open URL/path, open picker, start/stop native capture  
- **Demo input:** move, click, type, scroll, focus, wait, run scripted demos (only while an active Screen Beaver capture allows it)  
- **Edit:** seek, add caption/zoom/effect/sound/camera move, set captions, regenerate zooms, apply recipe / style preset, patch frame, rename  
- **Voice:** translate captions, generate voiceover, list TTS voices, synthesize speech  
- **Music:** search / pick / set / clear Creative Commons beds (Openverse)  
- **Ship:** ready_for_export, export_mp4  

Guide resource: `screen-weaver://guide` / `get_agent_guide`.

---

## 22. Themes, aspect ratios & look presets

### App theme

Light / Dark (start page + top bar).

### Canvas aspect (stage)

| Name | Ratio |
|------|-------|
| Wide | 16:9 |
| Classic | 4:3 |
| Photo | 3:2 |
| Square | 1:1 |
| Vertical | 9:16 |
| Original | Auto from the take |

### Look presets (Top bar wand / MCP)

Opinionated styling packs, e.g.:

- **Clean Demo**
- **Day Product**
- **Vivid Launch**
- **Night Product**
- **Tight Tutorial**

---

## 23. Keyboard cheat sheet

### While recording (desktop)

| Shortcut | Action |
|----------|--------|
| Ctrl+1 … Ctrl+6 | Scene effect presets |
| Ctrl+7 | Glare stripe |
| Hold Alt | Zoom for hold duration |
| Shift+Click / Ctrl+Click | Zoom marker |
| Shift+Space | Camera arc |

### In the editor

| Shortcut | Action |
|----------|--------|
| Space | Play / pause |
| ← / → | Nudge playhead ~2s (also transport buttons) |
| Z | Manual zoom at playhead |
| C | Cut / split at playhead |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Delete | Remove selected clip / zoom / effect / sound / … |
| Ctrl+S | Save `.yasharka` |

Crop is available from the stage **Crop** control and Background → crop tool (editor **C** is reserved for cut).

---

## 24. What I am not

- Not a general NLE (no multi-cam timeline, no arbitrary title graphics suite, no After Effects graph)
- Not a cloud editor — export is local; Edge TTS / Openverse calls are optional network features for VO/music
- Not a replacement for OBS streaming
- Web-only mode cannot track the cursor inside native apps the way the desktop hook can
- Live captions need Chrome/Edge + mic during the take; they are not magic speech-from-file without a model

---

## One-line identity

**I am Screen Beaver: record any screen or USB Android phone, automatically (and manually) add zooms, motion, effects, cursor polish, captions, voiceover, music, and shortcut callouts, then export a crisp MP4 — locally, for product stories that look intentional.**

---

*Generated from the product surface as of the current codebase. If a control exists in the UI, it should appear above; if something is experimental or desktop-only, that is called out in place.*
