/**
 * Screen Beaver MCP — Cursor / Claude drive the desktop studio live.
 * Default UX: build the edit step-by-step while the user watches; they click Export.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cacheMusicLocally,
  defaultMusicQuery,
  pickBestMusicHit,
  searchOpenverseMusic,
} from "./music.js";

const BRIDGE =
  process.env.SCREEN_BEAVER_BRIDGE ??
  process.env.SCREEN_WEAVER_BRIDGE ??
  "http://127.0.0.1:17355";

/** Hard cap so MCP tools never hang the agent forever. */
const FETCH_TIMEOUT_MS = 45_000;
const DEMO_FETCH_TIMEOUT_MS = 90_000;
/** Target capture length for short demos (open → two clicks → done). */
const DEFAULT_MAX_CAPTURE_SEC = 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Bridge timed out after ${timeoutMs}ms — is Screen Beaver desktop open?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const recipeSchema = z
  .object({
    version: z.literal(1),
    name: z.string().optional(),
    preset: z.enum(["clean", "vivid", "night", "tight"]).optional(),
    background: z.record(z.unknown()).optional(),
    frame: z.record(z.unknown()).optional(),
    voiceover: z
      .object({
        enabled: z.boolean().optional(),
        speakLang: z.string().optional(),
        targetLang: z.string().optional(),
        voice: z.string().optional(),
      })
      .optional(),
    captions: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          text: z.string(),
          originalText: z.string().optional(),
        }),
      )
      .optional(),
    zooms: z
      .array(
        z.object({
          time: z.number(),
          duration: z.number().optional(),
          scale: z.number().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          followCursor: z.boolean().optional(),
        }),
      )
      .optional(),
    regenerateAutoZooms: z.boolean().optional(),
    effects: z
      .array(
        z.object({
          kind: z.enum([
            "hero-zoom",
            "tilt-3d",
            "focus-zoom",
            "spin-3d",
            "glare",
            "mockup-tilt",
          ]),
          time: z.number(),
          duration: z.number().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        }),
      )
      .optional(),
    sounds: z
      .array(
        z.object({
          kind: z.enum(["click", "right-click", "whoosh", "typing"]),
          time: z.number(),
          duration: z.number().optional(),
        }),
      )
      .optional(),
    speed: z.number().optional(),
    trim: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
    export: z
      .object({
        width: z.number().optional(),
        fps: z.number().optional(),
        quality: z.enum(["web", "high", "max"]).optional(),
      })
      .optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const featureBeatSchema = z.object({
  title: z.string().describe("Short feature name shown as a caption"),
  atSeconds: z.number().describe("When this feature appears in the recording"),
  caption: z.string().optional().describe("Override caption text (defaults to title)"),
  holdSeconds: z.number().optional().describe("Caption length, default 2.4"),
  zoom: z.boolean().optional().describe("Add a focus zoom here (default true)"),
  scale: z.number().optional(),
  effect: z
    .enum(["hero-zoom", "tilt-3d", "focus-zoom", "spin-3d", "glare", "mockup-tilt"])
    .optional()
    .describe("Optional cinematic effect at this beat"),
  sound: z.enum(["click", "whoosh", "typing"]).optional(),
});

async function bridgeGet(path: string, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetchWithTimeout(`${BRIDGE}${path}`, {}, timeoutMs);
  if (!res.ok) throw new Error(`Bridge ${path} failed (${res.status})`);
  return res.json();
}

async function bridgePost(path: string, body: unknown, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetchWithTimeout(
    `${BRIDGE}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      typeof json === "object" && json && "error" in json
        ? String((json as { error: unknown }).error)
        : `Bridge ${path} failed (${res.status})`,
    );
  }
  return json;
}

async function agentCommand(action: string, payload: unknown = {}, timeoutMs?: number) {
  const defaultTimeout =
    action === "export"
      ? 90_000
      : action === "generate_voiceover"
        ? 120_000
        : action === "import_last_capture" || action === "stop_capture"
          ? 45_000
          : 12_000;
  return bridgePost(
    "/agent/command",
    {
      action,
      payload,
      timeoutMs: timeoutMs ?? defaultTimeout,
    },
    (timeoutMs ?? defaultTimeout) + 5_000,
  );
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

const GUIDE = `# Screen Beaver — direct MCP control (no shell scripts)

The user sits idle with Screen Beaver **desktop** open. Drive everything through **screen-beaver MCP tools**. They click **Export**. Do **not** call export_mp4 unless they ask.

## Hard rule — MCP only
- **Never** write/run \`.ps1\`, \`.bat\`, \`.cmd\`, or shell one-liners to talk to the bridge.
- **Never** create JSON recipe/demo files on disk as a workaround.
- Call MCP tools directly. Cursor Cloud / local Cursor both use the same tools.

## Fast product video (preferred)
1. \`ping_studio\` (fail → tell user to run \`npm run desktop:dev\`)
2. \`record_and_build\` with short \`demoSteps\` (clicks / \`type\` keystrokes). Auto zooms from the take; captions from features; voiceover generated from captions (English default).
3. Keep takes focused. Tell user to click **Export**.

Flow inside \`record_and_build\`:
open URL/app → native capture (no OS Share picker) → drive UI → stop → auto zooms/captions → **generate_voiceover** → ready for export.

## Manual / interactive control
1. \`open_url\` / \`open_path\` → \`list_capture_targets\` → \`start_capture\`
2. Drive UI: \`demo_move\`, \`demo_click\`, \`demo_type\` (key-by-key), \`demo_scroll\`, \`demo_focus\`, \`demo_wait\`
3. \`stop_capture\` → \`live_build_demo\` (autoMode default) → \`generate_voiceover\`

## Android USB phone
1. Phone: USB debugging on, plugged in, tap **Allow** on the trust prompt.
2. \`android_ensure_runtime\` (first run downloads portable scrcpy/adb) → \`android_list_devices\`
3. \`android_start\` (optional \`serial\`) → mirror window **Screen Beaver Android**
4. Drive with \`demo_*\` / \`run_demo\` on the mirror (same as window capture)
5. \`android_stop\` or \`stop_capture\` → imports phone take + device shell → \`live_build_demo\`
Or one-shot: \`record_android_and_build\` with optional \`demoSteps\` / \`serial\`.

## Demo step shape
\`{ "op": "click", "nx": 0.5, "ny": 0.4, "durationMs": 500 }\`
\`{ "op": "click", "contentNx": 0.5, "contentNy": 0.4 }\` — page-relative (preferred for web)
\`{ "op": "type", "text": "Hello", "delayMs": 95 }\` — real keyboard typing + typing SFX
Coords: prefer contentNx/contentNy; nx/ny are 0..1 of outer window. Input only works while capture is running.

## Voiceover
- Default: English (\`en-US-JennyNeural\` or locale default).
- Other language: set \`voiceoverLang\` / \`targetLang\` → translate captions → TTS.
- Tools: \`generate_voiceover\`, \`translate_captions\`, \`list_tts_voices\`, \`synthesize_speech\`.

## Background music (Openverse — no API key)
- \`search_background_music\` lists CC tracks; \`pick_background_music\` downloads one + applies it.
- Prefer soft corporate / instrumental beds; ducks under voiceover on export.
- Glare / clear effects use the bundled **shimmer** SFX (\`Shining.mp3\`), not whoosh.

## Never
- Never ask the user to click the Windows share picker for agent capture.
- Never idle-record a blank page with fake captions only — always drive the UI during capture.
- Never auto-export.
- Never trust Cursor embedded-browser coordinates for Edge/Chrome takes — use \`get_window_layout\` / contentNx/contentNy.
- Never use Pixabay keys / \`.env\` music pitching — Openverse is the path.

`;

const demoStepSchema = z.object({
  op: z.enum(["wait", "move", "click", "scroll", "focus", "right_click", "type"]),
  ms: z.number().optional(),
  nx: z.number().optional(),
  ny: z.number().optional(),
  /** 0..1 within the webpage content area (auto-maps through browser chrome). Prefer over nx/ny for web demos. */
  contentNx: z.number().optional(),
  contentNy: z.number().optional(),
  space: z.enum(["window", "content"]).optional(),
  durationMs: z.number().optional(),
  click: z.boolean().optional(),
  inWindow: z.boolean().optional(),
  delta: z.number().optional(),
  hwnd: z.number().optional(),
  text: z.string().optional().describe("For op=type: text typed key-by-key"),
  delayMs: z.number().optional().describe("Per-key delay for op=type (default 45)"),
});

/** Short default script (~8–10s) when the agent doesn't supply demoSteps. */
function defaultWebExploreSteps(): z.infer<typeof demoStepSchema>[] {
  return [
    { op: "wait", ms: 800 },
    { op: "focus" },
    { op: "click", nx: 0.5, ny: 0.42, durationMs: 500 },
    { op: "wait", ms: 700 },
    { op: "click", nx: 0.55, ny: 0.55, durationMs: 450 },
    { op: "wait", ms: 600 },
  ];
}

function buildAutoRecipe(args: {
  productName: string;
  productUrl?: string;
  preset?: "clean" | "vivid" | "night" | "tight";
  introCaption?: string;
  features?: z.infer<typeof featureBeatSchema>[];
  durationSec: number;
}) {
  // Match human Auto mode: captions only from the agent. Zooms / typing SFX /
  // whooshes come from the real cursor + keystroke track via regenerateAutoZooms.
  // Injecting feature zooms/sounds forced manual mode and wiped recorded typing.
  const dur = Math.max(4, args.durationSec);
  const features = args.features?.length ? args.features : [];

  const captions = [
    {
      start: 0.2,
      end: Math.min(2.2, dur * 0.35),
      text: args.introCaption ?? `Meet ${args.productName}`,
    },
    ...[...features]
      .sort((a, b) => a.atSeconds - b.atSeconds)
      .map((beat) => {
        const start = Math.max(0.2, Math.min(beat.atSeconds, dur - 0.8));
        const hold = Math.min(beat.holdSeconds ?? 2.0, Math.max(1.2, dur - start));
        return {
          start,
          end: start + hold,
          text: (beat.caption ?? beat.title).trim(),
        };
      }),
  ];

  return {
    version: 1 as const,
    name: args.productName,
    preset: args.preset ?? ("vivid" as const),
    frame: args.productUrl
      ? {
          chrome: "browser",
          browserUrl: args.productUrl.replace(/^https?:\/\//, ""),
          nativeChromeCrop: 0.11,
        }
      : undefined,
    captions,
    regenerateAutoZooms: true,
    notes:
      "Auto mode: zooms/SFX from recorded clicks + typing (same as human Auto). Agent only sets captions.",
  };
}

const EXAMPLE_RECIPE = {
  version: 1 as const,
  name: "Product Launch",
  preset: "vivid" as const,
  frame: {
    chrome: "browser",
    browserUrl: "example.com",
    nativeChromeCrop: 0.11,
  },
  captions: [
    { start: 0.3, end: 2.8, text: "Meet the product" },
    { start: 3.0, end: 5.5, text: "Here's the core workflow" },
    { start: 6.0, end: 8.5, text: "Ship faster with less friction" },
  ],
  regenerateAutoZooms: true,
  effects: [{ kind: "hero-zoom" as const, time: 0.2, duration: 1.4 }],
  notes: "Prefer live_build_demo so the user can watch edits appear.",
};

const server = new McpServer({
  name: "screen-beaver",
  version: "0.2.0",
});

server.registerTool(
  "get_capabilities",
  {
    description:
      "Screen Beaver MCP capabilities. Prefer record_and_build for open+record+edit, or live_build_demo when a take exists. User clicks Export.",
    inputSchema: {},
  },
  async () =>
    textResult({
      bridge: BRIDGE,
      preferredTool: "record_and_build",
      userClicksExport: true,
      noShellScripts: true,
      noPs1OrJsonFiles: true,
      tools: [
        "ping_studio",
        "studio_status",
        "list_capture_targets",
        "get_window_layout",
        "open_url",
        "open_path",
        "start_capture",
        "stop_capture",
        "android_ensure_runtime",
        "android_list_devices",
        "android_start",
        "android_stop",
        "record_android_and_build",
        "demo_move",
        "demo_click",
        "demo_type",
        "demo_scroll",
        "demo_focus",
        "demo_wait",
        "run_demo",
        "record_and_build",
        "live_build_demo",
        "add_caption",
        "add_zoom",
        "add_effect",
        "add_sound",
        "translate_captions",
        "generate_voiceover",
        "search_background_music",
        "pick_background_music",
        "set_background_music",
        "clear_background_music",
        "list_tts_voices",
        "synthesize_speech",
        "ready_for_export",
        "export_mp4",
      ],
      requiresDesktopApp: true,
      nativeCapture: "Windows-only, no OS share picker — open studio first, then record_and_build",
      androidUsb:
        "android_list_devices → android_start → demo_* → android_stop (or record_android_and_build). Phone needs USB debugging.",
      autoMode: "Captions/zooms from take (regenerateAutoZooms); agent features = captions only",
      typing: "demo_type / op:type uses real key-by-key keyboard events + typing SFX",
      voiceover: "generate_voiceover after captions; default en-US; other langs translate then TTS",
      music: "Openverse CC search (no API key) → pick_background_music; glare uses shimmer SFX",
      note: "Prefer contentNx/contentNy. Keep demoSteps focused. Do not write PowerShell or JSON files.",
    }),
);

server.registerTool(
  "ping_studio",
  {
    description: "Check whether Screen Beaver desktop bridge is reachable.",
    inputSchema: {},
  },
  async () => {
    try {
      const health = (await bridgeGet("/health")) as {
        ok?: boolean;
        mcpEntitled?: boolean;
      };
      const agent = (await bridgeGet("/agent")) as {
        ok?: boolean;
        mcpEntitled?: boolean;
      };
      const mcpEntitled = health.mcpEntitled === true || agent.mcpEntitled === true;
      if (!mcpEntitled) {
        return textResult({
          ok: true,
          health,
          agent,
          mcpEntitled: false,
          error: "Desktop bridge reported MCP as not entitled.",
          hint: "Restart Screen Beaver desktop and keep the studio window open, then retry.",
        });
      }
      return textResult({ ok: true, health, agent, mcpEntitled: true });
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Start desktop app: npm run desktop:dev — keep the studio window open.",
      });
    }
  },
);

server.registerTool(
  "studio_status",
  {
    description: "Recording/project status from the open Screen Beaver studio.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("status")),
);

server.registerTool(
  "focus_studio",
  {
    description:
      "Bring the Screen Beaver desktop window to the front (use before opening the record picker).",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("focus_studio", {}, 8_000)),
);

server.registerTool(
  "open_record_picker",
  {
    description:
      "Open the in-app “Start a new recording” / share options dialog (Application window by default). Does not open the OS Share dialog.",
    inputSchema: {
      surface: z.enum(["screen", "application", "tab"]).optional(),
    },
  },
  async ({ surface }) =>
    textResult(
      await agentCommand("open_record_picker", { surface: surface ?? "application" }, 8_000),
    ),
);

server.registerTool(
  "list_capture_targets",
  {
    description:
      "List capturable windows and monitors (Windows desktop). Use to pick a target for start_capture without the OS share picker.",
    inputSchema: {},
  },
  async () => textResult(await bridgeGet("/capture/targets")),
);

server.registerTool(
  "get_window_layout",
  {
    description:
      "Screen + window + browser-content rects for resolution-aware clicks. Prefer contentNx/contentNy (0..1 of the webpage) in demo steps — the bridge maps through chrome automatically. Call before planning clicks; do not use Cursor’s embedded browser size.",
    inputSchema: {
      titleContains: z.string().optional().describe("Match window title/process (default Edge)"),
      hwnd: z.number().optional(),
    },
  },
  async ({ titleContains, hwnd }) => {
    const qs = new URLSearchParams();
    if (typeof hwnd === "number") qs.set("hwnd", String(hwnd));
    if (titleContains) qs.set("titleContains", titleContains);
    const q = qs.toString();
    return textResult(
      await bridgeGet(q ? `/capture/window_layout?${q}` : "/capture/window_layout?titleContains=Edge"),
    );
  },
);

server.registerTool(
  "open_url",
  {
    description: "Open a URL in the default browser (for product demos).",
    inputSchema: {
      url: z.string().describe("https://… or domain like acme.com"),
    },
  },
  async ({ url }) => textResult(await bridgePost("/capture/open", { url })),
);

server.registerTool(
  "open_path",
  {
    description:
      "Open a local app or document path. Blocked for scripts/shells (.ps1/.bat/cmd/etc) — use MCP demo_* tools instead of launching automation scripts.",
    inputSchema: { path: z.string() },
  },
  async ({ path }) => textResult(await bridgePost("/capture/open", { path })),
);

server.registerTool(
  "start_capture",
  {
    description:
      "Focus Screen Beaver, flash share options, then start native window recording (no OS Share dialog). Prefer titleContains (e.g. Edge, Chrome).",
    inputSchema: {
      windowId: z.string().optional().describe("e.g. window:123456 or monitor:0"),
      titleContains: z.string().optional().describe("Match window title or process name"),
      showPicker: z.boolean().optional().describe("Flash in-app share UI first (default true)"),
      surface: z.enum(["screen", "application", "tab"]).optional(),
    },
  },
  async ({ windowId, titleContains, showPicker, surface }) =>
    textResult(
      await agentCommand(
        "start_capture",
        {
          windowId,
          titleContains,
          showPicker: showPicker !== false,
          surface: surface ?? "application",
        },
        25_000,
      ),
    ),
);

server.registerTool(
  "stop_capture",
  {
    description:
      "Stop native window OR Android USB capture and import the recording into Screen Beaver (cursor track included).",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("stop_capture", {}, 45_000)),
);

server.registerTool(
  "android_ensure_runtime",
  {
    description:
      "Download/install portable ADB+scrcpy into app data if needed (~11 MB). Safe to call every time before listing devices.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("android_ensure_runtime", {}, 120_000)),
);

server.registerTool(
  "android_list_devices",
  {
    description:
      "List USB/network Android devices (ADB). Requires USB debugging + Allow on the phone. Call android_ensure_runtime first if unsure.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("android_list_devices", {}, 30_000)),
);

server.registerTool(
  "android_start",
  {
    description:
      "Start USB Android mirror+file recording (scrcpy window titled Screen Beaver Android). Optional serial when multiple devices. Then use demo_* tools; finish with android_stop or stop_capture.",
    inputSchema: {
      serial: z.string().optional().describe("ADB serial from android_list_devices"),
    },
  },
  async ({ serial }) =>
    textResult(await agentCommand("android_start", { serial }, 60_000)),
);

server.registerTool(
  "android_stop",
  {
    description:
      "Stop Android USB recording, import the phone MP4 into the studio (device shell + cursor/typing when available).",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("android_stop", {}, 60_000)),
);

server.registerTool(
  "record_android_and_build",
  {
    description:
      "One-shot phone demo: ensure runtime → list/pick device → start mirror → optional demoSteps on the mirror → stop → auto captions/zooms. User clicks Export.",
    inputSchema: {
      serial: z.string().optional(),
      productName: z.string().optional().describe("Name for the project / captions (default Android Demo)"),
      maxCaptureSec: z.number().optional().describe("Max record length (default 12)"),
      demoSteps: z.array(demoStepSchema).optional(),
      autoMode: z.boolean().optional().describe("Apply zooms/captions after import (default true)"),
      features: z.array(featureBeatSchema).optional().describe("Caption feature beats"),
      introCaption: z.string().optional(),
      preset: z.enum(["clean", "vivid", "night", "tight"]).optional(),
      voiceover: z.boolean().optional().describe("Generate voiceover after build (default true)"),
      voiceoverLang: z.string().optional(),
    },
  },
  async (args) => {
    const log: unknown[] = [];
    const productName = args.productName?.trim() || "Android Demo";
    const maxSec = Math.min(30, Math.max(4, args.maxCaptureSec ?? DEFAULT_MAX_CAPTURE_SEC));
    const autoMode = args.autoMode !== false;
    const wantVoiceover = args.voiceover !== false;
    const voiceoverLang = args.voiceoverLang || "en-US";

    log.push(await agentCommand("android_ensure_runtime", {}, 120_000));
    const listed = await agentCommand("android_list_devices", {}, 30_000);
    log.push(listed);
    const devices = (listed as { devices?: Array<{ serial: string; state: string }> })?.devices ?? [];
    const ready = devices.filter((d) => d.state === "device");
    const serial =
      args.serial?.trim() ||
      (ready.length === 1 ? ready[0]!.serial : undefined);
    if (!serial) {
      return textResult({
        ok: false,
        error:
          ready.length === 0
            ? "No Android device ready — enable USB debugging, plug in, tap Allow, then retry"
            : "Multiple devices — pass serial from android_list_devices",
        devices: ready,
        log,
      });
    }
    log.push(await agentCommand("android_start", { serial }, 60_000));
    await sleep(900);
    const steps =
      args.demoSteps && args.demoSteps.length > 0
        ? args.demoSteps
        : ([
            { op: "wait", ms: 700 },
            { op: "focus" },
            { op: "click", nx: 0.5, ny: 0.45, durationMs: 450 },
            { op: "wait", ms: 600 },
            { op: "click", nx: 0.5, ny: 0.62, durationMs: 400 },
            { op: "wait", ms: 500 },
          ] as z.infer<typeof demoStepSchema>[]);
    const demoDeadline = Date.now() + maxSec * 1000;
    try {
      log.push(
        await bridgePost(
          "/input/run",
          { steps },
          Math.min(DEMO_FETCH_TIMEOUT_MS, maxSec * 1000 + 15_000),
        ),
      );
    } catch (err) {
      log.push({
        demoError: err instanceof Error ? err.message : String(err),
      });
    }
    const remain = demoDeadline - Date.now();
    if (remain > 400) await sleep(Math.min(remain, 2500));
    const stopped = await agentCommand("android_stop", {}, 60_000);
    log.push(stopped);
    if ((stopped as { ok?: boolean })?.ok === false) {
      return textResult({ ok: false, stopped, log });
    }
    await sleep(400);

    const dur =
      typeof stopped === "object" &&
      stopped &&
      "durationMs" in stopped &&
      typeof (stopped as { durationMs: unknown }).durationMs === "number"
        ? (stopped as { durationMs: number }).durationMs / 1000
        : maxSec;

    if (autoMode) {
      const recipe = buildAutoRecipe({
        productName,
        preset: args.preset,
        introCaption: args.introCaption,
        features: args.features,
        durationSec: dur,
      });
      log.push(await agentCommand("notify", { message: `Auto-building “${productName}”` }));
      log.push(await agentCommand("apply_recipe", { recipe }));
      if (wantVoiceover) {
        log.push(
          await agentCommand(
            "generate_voiceover",
            {
              speakLang: "en-US",
              targetLang: voiceoverLang,
              translate: !voiceoverLang.toLowerCase().startsWith("en"),
            },
            120_000,
          ),
        );
      }
      log.push(await agentCommand("ready_for_export", {}, 8_000));
    }

    return textResult({
      ok: true,
      serial,
      message: "Android demo imported — user should click Export",
      stopped,
      log,
    });
  },
);

server.registerTool(
  "run_demo",
  {
    description:
      "Drive the captured window like a human demo: smooth cursor moves, clicks, scrolls. Pass steps IN THIS TOOL CALL (never write a .ps1/.json file). Call while capture is running. Coords nx/ny are 0..1 inside the window.",
    inputSchema: {
      steps: z.array(demoStepSchema).min(1),
      hwnd: z.number().optional().describe("Optional HWND; defaults to active capture window"),
    },
  },
  async ({ steps, hwnd }) =>
    textResult(
      await bridgePost("/input/run", {
        steps,
        hwnd: hwnd ?? null,
      }),
    ),
);

server.registerTool(
  "demo_move",
  {
    description:
      "Atomic MCP action: smooth-move cursor inside the captured window. Prefer contentNx/contentNy (webpage 0..1); nx/ny are outer-window. Optional click. Only while capture is running.",
    inputSchema: {
      nx: z.number().optional().describe("0..1 X inside capture window (outer)"),
      ny: z.number().optional().describe("0..1 Y inside capture window (outer)"),
      contentNx: z.number().optional().describe("0..1 X inside webpage content"),
      contentNy: z.number().optional().describe("0..1 Y inside webpage content"),
      durationMs: z.number().optional(),
      click: z.boolean().optional(),
      inWindow: z.boolean().optional(),
    },
  },
  async ({ nx, ny, contentNx, contentNy, durationMs, click, inWindow }) =>
    textResult(
      await bridgePost("/input/move", {
        nx: contentNx ?? nx ?? 0.5,
        ny: contentNy ?? ny ?? 0.5,
        contentNx,
        contentNy,
        space: typeof contentNx === "number" ? "content" : undefined,
        durationMs: durationMs ?? 550,
        click: click ?? false,
        inWindow: inWindow ?? true,
      }),
    ),
);

server.registerTool(
  "demo_click",
  {
    description:
      "Atomic MCP action: left or right click at current cursor (or move+click). Prefer contentNx/contentNy for web pages. Only while capture is running.",
    inputSchema: {
      button: z.enum(["left", "right"]).optional(),
      nx: z.number().optional().describe("If set with ny, move then click (window space)"),
      ny: z.number().optional(),
      contentNx: z.number().optional(),
      contentNy: z.number().optional(),
      durationMs: z.number().optional(),
    },
  },
  async ({ button, nx, ny, contentNx, contentNy, durationMs }) => {
    const useContent = typeof contentNx === "number" && typeof contentNy === "number";
    const useWindow = typeof nx === "number" && typeof ny === "number";
    if (useContent || useWindow) {
      return textResult(
        await bridgePost("/input/move", {
          nx: contentNx ?? nx ?? 0.5,
          ny: contentNy ?? ny ?? 0.5,
          contentNx,
          contentNy,
          space: useContent ? "content" : undefined,
          durationMs: durationMs ?? 550,
          click: button !== "right",
          inWindow: true,
        }),
      );
    }
    return textResult(await bridgePost("/input/click", { button: button ?? "left" }));
  },
);

server.registerTool(
  "demo_scroll",
  {
    description:
      "Atomic MCP action: mouse wheel. Negative delta scrolls down. Only while capture is running.",
    inputSchema: {
      delta: z.number().describe("Wheel notches; negative = down"),
    },
  },
  async ({ delta }) => textResult(await bridgePost("/input/scroll", { delta })),
);

server.registerTool(
  "demo_focus",
  {
    description: "Bring the captured window to the foreground. Only while capture is running.",
    inputSchema: {},
  },
  async () => textResult(await bridgePost("/input/run", { steps: [{ op: "focus" }] })),
);

server.registerTool(
  "demo_wait",
  {
    description: "Pause between demo beats (MCP-side sleep). Prefer this over shell sleep.",
    inputSchema: {
      ms: z.number().describe("Milliseconds to wait (max 8000)"),
    },
  },
  async ({ ms }) => {
    const clamped = Math.min(8_000, Math.max(0, Math.floor(ms)));
    await sleep(clamped);
    return textResult({ ok: true, waitedMs: clamped });
  },
);

server.registerTool(
  "demo_type",
  {
    description:
      "Type text key-by-key into the focused captured window (real keyboard events, not clipboard paste). Only while capture is running.",
    inputSchema: {
      text: z.string().max(500),
      delayMs: z.number().optional().describe("Delay between keys in ms (default 45)"),
    },
  },
  async ({ text, delayMs }) =>
    textResult(
      await bridgePost(
        "/input/type",
        { text, delayMs: delayMs ?? 45 },
        Math.min(DEMO_FETCH_TIMEOUT_MS, 5_000 + text.length * (delayMs ?? 45)),
      ),
    ),
);

server.registerTool(
  "record_and_build",
  {
    description:
      "PRIMARY: focus Screen Beaver → open Start recording / share options → open URL/app → native capture of that window → demoSteps → stop+auto edit. User clicks Export.",
    inputSchema: {
      productName: z.string(),
      productUrl: z.string().optional(),
      openPath: z
        .string()
        .optional()
        .describe("Optional local app/document to open instead of (or after) productUrl"),
      titleContains: z
        .string()
        .optional()
        .describe("Window title/process match, default Edge/Chrome or productName"),
      windowId: z.string().optional(),
      durationSec: z
        .number()
        .optional()
        .describe("Pad after demo finishes before stop (default 0.35, max 1.2). Keep tiny — stop immediately when steps end."),
      maxCaptureSec: z
        .number()
        .optional()
        .describe("Hard stop target for the take (default 12)"),
      demoSteps: z
        .array(demoStepSchema)
        .optional()
        .describe("UI automation during capture; keep short (two clicks ≈ 10s)"),
      preset: z.enum(["clean", "vivid", "night", "tight"]).optional(),
      introCaption: z.string().optional(),
      features: z.array(featureBeatSchema).optional(),
      autoMode: z
        .boolean()
        .optional()
        .describe("Apply zooms/captions in one recipe (default true). Avoids MCP hanging."),
      voiceover: z
        .boolean()
        .optional()
        .describe("Generate Edge TTS voiceover from captions after build (default true)."),
      voiceoverLang: z
        .string()
        .optional()
        .describe("Voiceover/caption locale (default en-US). Non-English translates captions first."),
      voice: z.string().optional().describe("Edge Neural voice id (optional; picked for voiceoverLang)"),
      backgroundMusic: z
        .boolean()
        .optional()
        .describe("Pick an Openverse CC bed after build (default true)."),
      musicQuery: z
        .string()
        .optional()
        .describe("Openverse search query for the bed (default soft corporate instrumental)."),
      musicVolume: z.number().optional().describe("Bed volume 0..1 (default 0.16)"),
      stepDelayMs: z
        .number()
        .optional()
        .describe("Only used when autoMode=false (default 350)"),
      shareSurface: z
        .enum(["screen", "application", "tab"])
        .optional()
        .describe("Which share option to highlight in the picker (default application)"),
    },
  },
  async (args) => {
    const padSec = Math.min(1.2, Math.max(0, args.durationSec ?? 0.35));
    const maxCaptureSec = Math.min(45, Math.max(6, args.maxCaptureSec ?? DEFAULT_MAX_CAPTURE_SEC));
    const autoMode = args.autoMode !== false;
    const wantVoiceover = args.voiceover !== false;
    const wantMusic = args.backgroundMusic !== false;
    const voiceoverLang = args.voiceoverLang || "en-US";
    const musicQuery = args.musicQuery || defaultMusicQuery(args.productName);
    const title =
      args.titleContains ||
      (args.productUrl ? "Edge" : null) ||
      args.productName ||
      "Chrome";
    const steps = args.demoSteps?.length ? args.demoSteps : defaultWebExploreSteps();
    const shareSurface = args.shareSurface ?? "application";

    // Fail fast if desktop isn't up — don't hang.
    try {
      await bridgeGet("/health", 4_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Open Screen Beaver first (npm run desktop:dev), keep the studio window visible, then retry.",
      });
    }

    const log: unknown[] = [];

    // 1) Bring Screen Beaver to front and open the Start a new recording / share UI
    log.push(await agentCommand("focus_studio", {}, 8_000));
    await sleep(350);
    log.push(
      await agentCommand("open_record_picker", { surface: shareSurface }, 8_000),
    );
    await sleep(700);

    // 2) Open the product URL / app so the capture target exists
    if (args.productUrl) {
      log.push(await bridgePost("/capture/open", { url: args.productUrl }, 10_000));
      await sleep(1400);
    }
    if (args.openPath) {
      log.push(await bridgePost("/capture/open", { path: args.openPath }, 10_000));
      await sleep(1000);
    }

    // 3) Start native capture via the agent (closes picker, shows Recording…)
    const captureStartedAt = Date.now();
    const started = await agentCommand(
      "start_capture",
      {
        windowId: args.windowId,
        titleContains: args.windowId ? undefined : title,
        showPicker: false, // already opened above
        surface: shareSurface,
      },
      25_000,
    );
    log.push({ start: started });
    await sleep(400);

    const demo = await bridgePost(
      "/input/run",
      { steps },
      DEMO_FETCH_TIMEOUT_MS,
    );
    log.push({ demo });

    // Keep takes tight: pad a little, then stop.
    const elapsedSec = (Date.now() - captureStartedAt) / 1000;
    const remainingPad = Math.max(0, Math.min(padSec, maxCaptureSec - elapsedSec));
    if (remainingPad > 0) await sleep(remainingPad * 1000);

    const stopped = await agentCommand("stop_capture", {}, 45_000);
    log.push({ stop: stopped });
    await sleep(400);

    const dur =
      typeof stopped === "object" &&
      stopped &&
      "durationMs" in stopped &&
      typeof (stopped as { durationMs: unknown }).durationMs === "number"
        ? (stopped as { durationMs: number }).durationMs / 1000
        : Math.min(maxCaptureSec, elapsedSec + remainingPad);

    if (autoMode) {
      const recipe = buildAutoRecipe({
        productName: args.productName,
        productUrl: args.productUrl,
        preset: args.preset,
        introCaption: args.introCaption,
        features: args.features,
        durationSec: dur,
      });
      log.push(await agentCommand("notify", { message: `Auto-building “${args.productName}”` }));
      log.push(await agentCommand("apply_recipe", { recipe }));
      if (wantVoiceover) {
        log.push(
          await agentCommand("notify", {
            message:
              voiceoverLang.toLowerCase().startsWith("en")
                ? "Generating English voiceover…"
                : `Translating + voiceover (${voiceoverLang})…`,
          }),
        );
        log.push(
          await agentCommand(
            "generate_voiceover",
            {
              speakLang: "en-US",
              targetLang: voiceoverLang,
              voice: args.voice,
              translate: !voiceoverLang.toLowerCase().startsWith("en"),
            },
            120_000,
          ),
        );
      }
      if (wantMusic) {
        try {
          log.push(await agentCommand("notify", { message: "Picking background music…" }));
          const hits = await searchOpenverseMusic(musicQuery, 10);
          const best = pickBestMusicHit(hits);
          if (best) {
            const cached = await cacheMusicLocally(best);
            log.push(
              await agentCommand("set_background_music", {
                url: cached.localUrl,
                title: best.title,
                creator: best.creator,
                license: best.license,
                volume: args.musicVolume ?? 0.16,
                enabled: true,
                loop: true,
                sourceId: best.id,
              }),
            );
          } else {
            log.push({ music: { ok: false, error: "No Openverse hits" } });
          }
        } catch (err) {
          log.push({
            music: { ok: false, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      log.push(await agentCommand("ready_for_export"));
    } else {
      const delay = Math.min(800, Math.max(150, args.stepDelayMs ?? 350));
      const run = async (action: string, payload: unknown = {}, timeoutMs?: number) => {
        const r = await agentCommand(action, payload, timeoutMs);
        log.push({ action, result: r });
        await sleep(delay);
        return r;
      };
      const recipe = buildAutoRecipe({
        productName: args.productName,
        productUrl: args.productUrl,
        preset: args.preset,
        introCaption: args.introCaption,
        features: args.features,
        durationSec: dur,
      });
      await run("notify", { message: `Building “${args.productName}”` });
      await run("apply_recipe", { recipe });
      if (wantVoiceover) {
        await run(
          "generate_voiceover",
          {
            speakLang: "en-US",
            targetLang: voiceoverLang,
            voice: args.voice,
            translate: !voiceoverLang.toLowerCase().startsWith("en"),
          },
          120_000,
        );
      }
      if (wantMusic) {
        try {
          await run("notify", { message: "Picking background music…" });
          const hits = await searchOpenverseMusic(musicQuery, 10);
          const best = pickBestMusicHit(hits);
          if (best) {
            const cached = await cacheMusicLocally(best);
            await run("set_background_music", {
              url: cached.localUrl,
              title: best.title,
              creator: best.creator,
              license: best.license,
              volume: args.musicVolume ?? 0.16,
              enabled: true,
              loop: true,
              sourceId: best.id,
            });
          }
        } catch (err) {
          log.push({
            music: { ok: false, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      await run("ready_for_export");
    }

    return textResult({
      ok: true,
      productName: args.productName,
      recordedSec: dur,
      maxCaptureSec,
      autoMode,
      voiceover: wantVoiceover,
      voiceoverLang,
      backgroundMusic: wantMusic,
      demoSteps: steps.length,
      message: `Recorded ~${dur.toFixed(1)}s and auto-built “${args.productName}”${wantVoiceover ? ` with ${voiceoverLang} voiceover` : ""}${wantMusic ? " + background music" : ""}. Tell the user to click Export.`,
      steps: log.length,
    });
  },
);

server.registerTool(
  "get_agent_guide",
  {
    description: "Idle-watch + native capture workflow: record any window, build live, user clicks Export.",
    inputSchema: {},
  },
  async () => textResult(GUIDE),
);

server.registerTool(
  "live_build_demo",
  {
    description:
      "Build captions/zooms/effects on the current take. Default autoMode applies one recipe + auto-zooms (fast). Set autoMode=false to step slowly for watching.",
    inputSchema: {
      productName: z.string(),
      productUrl: z.string().optional(),
      preset: z.enum(["clean", "vivid", "night", "tight"]).optional(),
      introCaption: z.string().optional(),
      features: z.array(featureBeatSchema).min(1),
      regenerateAutoZooms: z.boolean().optional(),
      autoMode: z
        .boolean()
        .optional()
        .describe("One-shot recipe apply (default true). Prevents long MCP hangs."),
      stepDelayMs: z
        .number()
        .optional()
        .describe("Only when autoMode=false — pause between visible steps (default 400)"),
      durationSec: z
        .number()
        .optional()
        .describe("Approx take length for caption timing (default from studio or 12)"),
      voiceover: z
        .boolean()
        .optional()
        .describe("Generate Edge TTS voiceover from captions (default true)"),
      voiceoverLang: z
        .string()
        .optional()
        .describe("Voiceover locale (default en-US). Non-English translates first."),
      voice: z.string().optional(),
    },
  },
  async ({
    productName,
    productUrl,
    preset,
    introCaption,
    features,
    regenerateAutoZooms,
    autoMode,
    stepDelayMs,
    durationSec,
    voiceover,
    voiceoverLang,
    voice,
  }) => {
    const useAuto = autoMode !== false;
    const wantVoiceover = voiceover !== false;
    const lang = voiceoverLang || "en-US";
    const log: unknown[] = [];

    let dur = durationSec ?? 12;
    try {
      const status = (await agentCommand("status", {}, 8_000)) as { duration?: number };
      if (typeof status?.duration === "number" && status.duration > 1) {
        dur = status.duration;
      }
    } catch {
      /* keep default */
    }

    const recipe = buildAutoRecipe({
      productName,
      productUrl,
      preset,
      introCaption,
      features,
      durationSec: dur,
    });
    if (regenerateAutoZooms === false) {
      recipe.regenerateAutoZooms = false;
    }

    if (useAuto) {
      log.push(await agentCommand("notify", { message: `Auto-building “${productName}”` }));
      log.push(await agentCommand("apply_recipe", { recipe }));
      if (wantVoiceover) {
        log.push(
          await agentCommand(
            "generate_voiceover",
            {
              speakLang: "en-US",
              targetLang: lang,
              voice,
              translate: !lang.toLowerCase().startsWith("en"),
            },
            120_000,
          ),
        );
      }
      const ready = await agentCommand("ready_for_export");
      log.push(ready);
      return textResult({
        ok: true,
        productName,
        autoMode: true,
        voiceover: wantVoiceover,
        voiceoverLang: lang,
        steps: log.length,
        ready,
        message: `Auto build finished for “${productName}”${wantVoiceover ? ` with ${lang} voiceover` : ""}. Tell the user to click Export.`,
      });
    }

    const delay = Math.min(1200, Math.max(150, stepDelayMs ?? 400));
    const run = async (action: string, payload: unknown = {}, timeoutMs?: number) => {
      const r = await agentCommand(action, payload, timeoutMs);
      log.push({ action, result: r });
      await sleep(delay);
      return r;
    };

    await run("notify", { message: `Building “${productName}” — watch the timeline` });
    await run("apply_recipe", { recipe });
    if (wantVoiceover) {
      await run(
        "generate_voiceover",
        {
          speakLang: "en-US",
          targetLang: lang,
          voice,
          translate: !lang.toLowerCase().startsWith("en"),
        },
        120_000,
      );
    }
    const ready = await run("ready_for_export");
    return textResult({
      ok: true,
      productName,
      autoMode: false,
      voiceover: wantVoiceover,
      voiceoverLang: lang,
      steps: log.length,
      ready,
      message: `Live build finished for “${productName}”${wantVoiceover ? ` with ${lang} voiceover` : ""}. Tell the user to click Export.`,
    });
  },
);

server.registerTool(
  "add_caption",
  {
    description: "Add one caption cue and seek the playhead so the user sees it.",
    inputSchema: {
      start: z.number(),
      end: z.number(),
      text: z.string(),
    },
  },
  async (args) => textResult(await agentCommand("add_caption", args)),
);

server.registerTool(
  "add_zoom",
  {
    description: "Add one zoom keyframe (visible on the timeline).",
    inputSchema: {
      time: z.number(),
      duration: z.number().optional(),
      scale: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      followCursor: z.boolean().optional(),
    },
  },
  async (args) => textResult(await agentCommand("add_zoom", args)),
);

server.registerTool(
  "add_effect",
  {
    description: "Add one cinematic scene effect.",
    inputSchema: {
      kind: z.enum(["hero-zoom", "tilt-3d", "focus-zoom", "spin-3d", "glare", "mockup-tilt"]),
      time: z.number(),
      duration: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  async (args) => textResult(await agentCommand("add_effect", args)),
);

server.registerTool(
  "add_sound",
  {
    description: "Add one SFX clip on the timeline.",
    inputSchema: {
      kind: z.enum(["click", "right-click", "whoosh", "typing"]),
      time: z.number(),
      duration: z.number().optional(),
    },
  },
  async (args) => textResult(await agentCommand("add_sound", args)),
);

server.registerTool(
  "seek_playhead",
  {
    description: "Move the studio playhead so the preview shows a moment.",
    inputSchema: { time: z.number() },
  },
  async ({ time }) => textResult(await agentCommand("seek", { time })),
);

server.registerTool(
  "apply_style_preset",
  {
    description: "Apply clean|vivid|night|tight look.",
    inputSchema: { preset: z.enum(["clean", "vivid", "night", "tight"]) },
  },
  async ({ preset }) => textResult(await agentCommand("apply_preset", { preset })),
);

server.registerTool(
  "apply_recipe",
  {
    description: "Apply a full recipe at once (prefer live_build_demo when the user wants to watch).",
    inputSchema: { recipe: recipeSchema },
  },
  async ({ recipe }) => textResult(await agentCommand("apply_recipe", { recipe })),
);

server.registerTool(
  "set_captions",
  {
    description: "Replace all captions at once.",
    inputSchema: {
      captions: z.array(
        z.object({
          start: z.number(),
          end: z.number(),
          text: z.string(),
          originalText: z.string().optional(),
        }),
      ),
    },
  },
  async ({ captions }) => textResult(await agentCommand("set_captions", { captions })),
);

server.registerTool(
  "regenerate_zooms",
  {
    description: "Rebuild auto-zooms from cursor clicks in the recording.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("regenerate_zooms")),
);

server.registerTool(
  "translate_captions",
  {
    description:
      "Translate current caption cues from speakLang → targetLang (MyMemory). Usually before generate_voiceover for non-English.",
    inputSchema: {
      speakLang: z.string().optional().describe("Source language (default en-US)"),
      targetLang: z.string().optional().describe("Target language (e.g. hi-IN, es-ES)"),
    },
  },
  async ({ speakLang, targetLang }) =>
    textResult(
      await agentCommand("translate_captions", {
        speakLang: speakLang ?? "en-US",
        targetLang: targetLang ?? "en-US",
      }),
    ),
);

server.registerTool(
  "generate_voiceover",
  {
    description:
      "Generate Edge TTS voiceover from current captions (AI Voiceover panel). Default English. For other languages set targetLang — translates captions first, then speaks.",
    inputSchema: {
      speakLang: z.string().optional().describe("Caption source language (default en-US)"),
      targetLang: z
        .string()
        .optional()
        .describe("Speak/translate-to locale (default en-US). e.g. hi-IN, es-ES, fr-FR"),
      voice: z.string().optional().describe("Edge Neural voice id (optional)"),
      translate: z
        .boolean()
        .optional()
        .describe("Force/skip translate. Default: translate when speakLang≠targetLang"),
    },
  },
  async ({ speakLang, targetLang, voice, translate }) =>
    textResult(
      await agentCommand(
        "generate_voiceover",
        {
          speakLang: speakLang ?? "en-US",
          targetLang: targetLang ?? "en-US",
          voice,
          translate,
        },
        120_000,
      ),
    ),
);

server.registerTool(
  "search_background_music",
  {
    description:
      "Search Creative Commons background beds on Openverse (no API key). Returns candidates; use pick_background_music to apply one.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Search text (default: upbeat corporate instrumental)"),
      limit: z.number().optional().describe("Max results (default 8, max 20)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const hits = await searchOpenverseMusic(query || defaultMusicQuery(), limit ?? 8);
      return textResult({ ok: true, query: query || defaultMusicQuery(), hits });
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

server.registerTool(
  "pick_background_music",
  {
    description:
      "Search Openverse, download the best instrumental bed into the studio, and set it as background music.",
    inputSchema: {
      query: z.string().optional().describe("Openverse query (default soft corporate instrumental)"),
      volume: z.number().optional().describe("Bed volume 0..1 (default 0.16)"),
      id: z.string().optional().describe("Optional Openverse id from search_background_music"),
    },
  },
  async ({ query, volume, id }) => {
    try {
      const q = query || defaultMusicQuery();
      const hits = await searchOpenverseMusic(q, 12);
      const chosen = id ? hits.find((h) => h.id === id) || pickBestMusicHit(hits) : pickBestMusicHit(hits);
      if (!chosen) {
        return textResult({ ok: false, error: "No Openverse audio hits for that query" });
      }
      const cached = await cacheMusicLocally(chosen);
      const applied = await agentCommand("set_background_music", {
        url: cached.localUrl,
        title: chosen.title,
        creator: chosen.creator,
        license: chosen.license,
        volume: volume ?? 0.16,
        enabled: true,
        loop: true,
        sourceId: chosen.id,
      });
      return textResult({
        ok: true,
        track: chosen,
        localUrl: cached.localUrl,
        applied,
      });
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

server.registerTool(
  "set_background_music",
  {
    description: "Set a local or same-origin URL as the project background music bed.",
    inputSchema: {
      url: z.string().describe("Same-origin URL e.g. /sounds/bg/….mp3"),
      title: z.string().optional(),
      creator: z.string().optional(),
      license: z.string().optional(),
      volume: z.number().optional(),
      sourceId: z.string().optional(),
    },
  },
  async (args) =>
    textResult(
      await agentCommand("set_background_music", {
        ...args,
        enabled: true,
        loop: true,
      }),
    ),
);

server.registerTool(
  "clear_background_music",
  {
    description: "Remove the current background music bed.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("clear_background_music")),
);

server.registerTool(
  "ready_for_export",
  {
    description:
      "Mark the live build complete and open the Export panel. User clicks Export — do not export for them.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("ready_for_export")),
);

server.registerTool(
  "example_recipe",
  {
    description: "Starter recipe JSON (reference). Prefer live_build_demo for the idle-watch UX.",
    inputSchema: {
      productUrl: z.string().optional(),
      productName: z.string().optional(),
    },
  },
  async ({ productUrl, productName }) => {
    const recipe = {
      ...EXAMPLE_RECIPE,
      name: productName ? `${productName} Launch` : EXAMPLE_RECIPE.name,
      frame: {
        ...EXAMPLE_RECIPE.frame,
        browserUrl: productUrl ?? EXAMPLE_RECIPE.frame.browserUrl,
      },
    };
    return textResult(recipe);
  },
);

server.registerTool(
  "validate_recipe",
  {
    description: "Validate recipe JSON in-memory (do not write files).",
    inputSchema: { recipe: recipeSchema },
  },
  async ({ recipe }) => textResult({ ok: true, recipe }),
);

server.registerTool(
  "list_tts_voices",
  {
    description: "List Edge TTS voices from the desktop bridge.",
    inputSchema: {},
  },
  async () => textResult(await bridgeGet("/voices")),
);

server.registerTool(
  "synthesize_speech",
  {
    description: "Synthesize speech via desktop Edge TTS bridge.",
    inputSchema: {
      text: z.string(),
      voice: z.string().optional(),
    },
  },
  async ({ text, voice }) =>
    textResult(await bridgePost("/tts", { text, voice: voice ?? "en-US-JennyNeural" })),
);

server.registerTool(
  "export_mp4",
  {
    description:
      "ONLY if the user explicitly asks to export. Otherwise use ready_for_export and let them click Export.",
    inputSchema: {
      width: z.number().optional(),
      fps: z.number().optional(),
      quality: z.enum(["web", "high", "max"]).optional(),
    },
  },
  async ({ width, fps, quality }) =>
    textResult(await agentCommand("export", { width, fps, quality }, 90_000)),
);

server.registerResource(
  "agent-guide",
  "screen-beaver://guide",
  {
    description: "Idle-watch Screen Beaver agent guide",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "screen-beaver://guide", text: GUIDE, mimeType: "text/markdown" }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
