---
name: screen-beaver-demo
description: >
  Builds polished product tutorial and launch videos in Screen Beaver on the
  user's machine. Use when the user asks to make a demo video, product launch
  video, or tutorial video with Screen Beaver; when they want captions, zooms,
  and effects added automatically while they watch; when they want the AI to
  open an app, smooth-move the cursor, click features, and record without the
  OS share picker; or when they mention Screen Beaver MCP / live build /
  native capture demos. Requires the Screen Beaver desktop app and
  screen-beaver MCP.
---

# Screen Beaver live demo builder

The user wants to **sit idle** while you **drive their product** (smooth cursor + clicks + real typing) and build a Screen Beaver video. Prefer **native capture** (no Windows share picker). Edits apply in **auto mode** (one recipe). They click **Export** themselves.

## Hard rules

1. Use **screen-beaver** MCP only. Prefer `record_and_build` (includes demo automation). Use atomic `demo_*` tools or `run_demo` for custom click paths.
2. **If `screen-beaver` is missing from this session’s MCP tool list**, stop. Tell the user to enable it under **Customize → MCPs**, run `npm run mcp:install` once, then **reload Cursor / start a new chat**. Do **not** fall back to raw HTTP, curl, fetch, or Shell against `127.0.0.1:17355`.
3. **Never** write or execute `.ps1`, `.bat`, `.cmd`, or other shell scripts to talk to Screen Beaver.
4. **Never** create JSON demo/recipe files on disk as a workaround — pass steps/payloads in MCP tool arguments.
5. **Do not** call `export_mp4` unless the user explicitly says to export.
6. Keep Screen Beaver desktop open (`npm run desktop:dev` or the installed app). Bridge: `http://127.0.0.1:17355` (used by the MCP server only). If `ping_studio` fails, tell them to open the app — do not hang.
7. **Never** ask them to click the OS screen-share picker — use `start_capture` / `record_and_build` (native window select).
8. **Never** idle-record a blank page and only sprinkle captions. Always drive the UI during capture.
9. Keep takes **as short as the script needs**. Stop as soon as the last click/type finishes (`durationSec` pad ≤ ~0.4s). Do not add long trailing waits.
10. Use `demo_type` / `{ op: "type", text }` for typing — **key-by-key**, never clipboard paste.
11. Narrate briefly in chat so they watch the Screen Beaver window.
12. **Coords:** call `get_window_layout` (or use `contentNx`/`contentNy`) — never trust Cursor’s embedded browser size. Page-relative `contentNx`/`contentNy` map through browser chrome automatically.
13. **Auto mode:** let the studio derive zooms + typing SFX from real clicks/keystrokes. Do **not** hand-place agent zooms/sounds that fight Auto. `record_and_build` captions only + `regenerateAutoZooms`.
14. **Voiceover:** after captions, call `generate_voiceover` (default English). If the user asks for another language, pass `targetLang` (e.g. `hi-IN`) — captions are translated first, then Edge TTS. Prefer `record_and_build({ voiceover: true, voiceoverLang })` which does this automatically.
15. **Background music:** use Openverse via MCP (`pick_background_music` / `record_and_build` with `backgroundMusic: true`). No Pixabay / `.env` keys. Glare / clear effects play the bundled **shimmer** SFX (`Shining.mp3`).

## Workflow A — full hands-off (opens Screen Beaver UI first)

`record_and_build` now:
1. **focus_studio** — brings Screen Beaver to front
2. **open_record_picker** — opens the same “Start a new recording” / share options UI
3. Opens `productUrl` / app
4. **start_capture** — selects the window natively (Application), shows Recording…
5. Runs `demoSteps`
6. Stops immediately + auto zooms/captions from the take
7. **generate_voiceover** — English by default; translate+TTS when `voiceoverLang` is set
8. **pick_background_music** — Openverse CC bed (soft corporate instrumental)

```
ping_studio
  → record_and_build({
      productName, productUrl, titleContains: "Edge",
      voiceover: true,
      voiceoverLang: "en-US",   // or "hi-IN" / "es-ES" etc.
      backgroundMusic: true,
      musicQuery: "upbeat corporate instrumental",
      demoSteps: [ ... ],
      introCaption: "...",
      features: [{ title: "Sign in", atSeconds: 3 }]
    })
  → Tell user: click Export when ready
```

Or on an existing take:
`generate_voiceover({ targetLang: "en-US" })`
`pick_background_music({ query: "calm tech ambient instrumental" })`
`generate_voiceover({ speakLang: "en-US", targetLang: "hi-IN" })`

## Demo steps

| op | meaning |
|----|---------|
| `wait` | `{ ms }` — keep short; no long end pads |
| `move` / `click` | prefer `{ contentNx, contentNy }` 0..1 in **webpage**; or `{ nx, ny }` outer window |
| `type` | `{ text, delayMs? }` key-by-key (emits typing SFX) |
| `scroll` / `focus` / `right_click` | as before |

## Limits

- Native capture + input automation are **Windows desktop only**.
- Demo mouse/keyboard input only works **while capture is running**.
- The OS Share dialog is never shown to agents — Screen Beaver flashes the in-app share options, then captures the window natively.
