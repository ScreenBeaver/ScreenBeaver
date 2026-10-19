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
9. Keep takes **as short as the script needs**. Stop as soon as the last click/type finishes (`durationSec` pad ≤ ~0.4s). Do not add long trailing waits. After record, if the end still hangs, call `patch_trim({ trimEndSlackSec: 0.25 })`.
10. Use `demo_type` / `{ op: "type", text }` for typing — **key-by-key**, never clipboard paste. **Typing must be zoomed** (Auto priority 1). Click each cell before typing so the field locks.
11. Narrate briefly in chat so they watch the Screen Beaver window.
12. **Coords:** call `get_window_layout` (or use `contentNx`/`contentNy`) — never trust Cursor’s embedded browser size. Page-relative `contentNx`/`contentNy` map through browser chrome automatically.
13. **Auto zooms (priority):** (1) typing locks the field + caret — never fight it with manual zooms; (2) clicks punch into the click location; scroll should not spawn orbit zooms. Prefer `regenerate_zooms` after record. Only `add_zoom` / `update_zoom` when Auto missed a beat.
14. **Motion designer pass:** after `record_and_build`, always `peek_studio`. If zooms are weak/late/wrong → `regenerate_zooms` or `update_zoom` / `add_zoom`. If end lag → `patch_trim({ trimEndSlackSec: 0.25 })`. Frame look → `patch_frame` / `apply_style_preset`.
15. **Voiceover:** after captions, call `generate_voiceover` (default English). If the user asks for another language, pass `targetLang` (e.g. `hi-IN`) — captions are translated first, then Edge TTS. Prefer `record_and_build({ voiceover: true, voiceoverLang })` which does this automatically.
16. **Background music:** use Openverse via MCP (`pick_background_music` / `record_and_build` with `backgroundMusic: true`). No Pixabay / `.env` keys. Glare / clear effects play the bundled **shimmer** SFX (`Shining.mp3`).

## Short user ask → you expand (every product — workflow is embedded)

Users write only short asks about **any** product. **You already know Phase A → B**. Never ask them to paste it.

```
get_demo_skill → ping_studio → make_product_tutorial({ topic })
Phase A: DRY RUN the exact lesson with demo_* (no capture) — screenshot after each step until proven
Phase B: open_url (NEW TAB, not new window) → start_capture → same steps → stop → regenerate_zooms → peek → remember → Export
```

`open_url` opens a **new tab** in the existing browser — never spawn extra Edge/Chrome windows.
Browser **window title = active tab**. Match `Canva` / `Sheets`, never bare `Edge`. Prefer browser windows; never scout Claude/Cursor chats.
Phase A must actually perform the prompt (clicks + typing), not just look. Phase B is the camera take — Auto zooms from cursor (Screen Studio feel). If `regenerate_zooms` → 0 autos, re-do Phase B.
- **Sheets / Excel:** short scout then `record_and_build` is OK when the sheet UI is visible.
- **Everything else:** full Phase A dry-run, then Phase B record.

Never record blind. Never give up on a spinner/blank. Never invent passwords.
Screen Beaver MCP **is** allowed to drive the screen — use it; don’t refuse as paid computer use.
All clicks/drags = **real OS cursor** (`durationMs` ≥ 400; `demo_drag` for drag).
**Typing:** ~150ms/key, include typo→backspace→fix.

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
- Demo mouse/keyboard: during capture, or explore-without-record when `titleContains` is set.
- The OS Share dialog is never shown to agents — Screen Beaver flashes the in-app share options, then captures the window natively.
