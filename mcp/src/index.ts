/**
 * Screen Beaver MCP — Cursor / Claude drive the desktop studio live.
 * Default UX: build the edit step-by-step while the user watches; they click Export.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  cacheMusicLocally,
  defaultMusicQuery,
  pickBestMusicHit,
  searchOpenverseMusic,
} from "./music.js";
import {
  ensureGrowingSkillSeeded,
  findProductSkill,
  fullHarnessGuide,
  growingSkillPath,
  rememberLesson,
  renderGrowingMarkdown,
  renderProductSkill,
  saveProductSkill,
  type SkillStep,
} from "./growingSkill.js";
import { SERVER_INSTRUCTIONS, withClientCompat } from "./clientCompat.js";

const BRIDGE =
  process.env.SCREEN_BEAVER_BRIDGE ??
  process.env.SCREEN_WEAVER_BRIDGE ??
  "http://127.0.0.1:17355";

/** Hard cap so MCP tools never hang the agent forever. */
const FETCH_TIMEOUT_MS = 45_000;
const DEMO_FETCH_TIMEOUT_MS = 90_000;
/** Target capture length for short demos (open → two clicks → done). */
const DEFAULT_MAX_CAPTURE_SEC = 28;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every demo_* action this process performs, so a recorded take can be saved as the
 * product's playbook even when the model forgets to (ChatGPT / Gemini often do).
 * Module-level: HTTP mode builds a server per request but shares this process.
 */
const journal = {
  steps: [] as SkillStep[],
  lastProduct: null as string | null,
  lastUrl: null as string | null,
  captureStart: -1,
  captureProduct: null as string | null,
  captureTitle: null as string | null,
  /** Name the agent passed explicitly (productName / name) — beats window titles. */
  productName: null as string | null,
};

const GENERIC_TITLE = /untitled|new tab|^(chrome|edge|firefox|browser|home)$/i;

function brandFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
    const parts = host.replace(/^(www|app|my|web)\./i, "").split(".");
    const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    if (!label || /^(localhost|\d+)$/.test(label)) return null;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return null;
  }
}

/** Product name for the skill file: explicit name → URL brand → non-generic window title. */
function skillProductName(): string | null {
  const explicit = journal.productName?.trim();
  if (explicit && !GENERIC_TITLE.test(explicit)) return explicit;
  const brand = brandFromUrl(journal.lastUrl);
  if (brand) return brand;
  const title = journal.lastProduct?.trim();
  return title && !GENERIC_TITLE.test(title) ? title : null;
}

function journalPush(step: Record<string, unknown> & { op: string }, product?: string | null) {
  if (product?.trim()) journal.lastProduct = product.trim();
  const clean: SkillStep = { op: step.op };
  for (const [k, v] of Object.entries(step)) {
    if (v !== undefined && v !== null && k !== "hwnd") clean[k] = v;
  }
  journal.steps.push(clean);
  if (journal.steps.length > 300) {
    journal.steps.splice(0, 100);
    if (journal.captureStart >= 0) journal.captureStart = Math.max(0, journal.captureStart - 100);
  }
}

function autoSaveSkillAfterTake(imported: unknown): Record<string, unknown> {
  const product = journal.captureProduct || skillProductName();
  const start = journal.captureStart;
  journal.captureStart = -1;
  if (!product) {
    return { saved: false, reason: "No product known — call save_product_skill yourself." };
  }
  const steps = start >= 0 ? journal.steps.slice(start) : [];
  const rec = imported && typeof imported === "object" ? (imported as Record<string, unknown>) : {};
  const autoZooms = Number(rec.autoZooms) || 0;
  const durationMatch = typeof rec.message === "string" ? rec.message.match(/([\d.]+)s/) : null;
  const durationSec = durationMatch ? Number(durationMatch[1]) : Number(rec.durationMs) / 1000 || 0;
  const good = autoZooms > 0 && durationSec >= 2;
  try {
    const skill = saveProductSkill({
      product,
      url: journal.lastUrl ?? undefined,
      titleContains: journal.captureTitle ?? undefined,
      // Only a take that actually worked may replace the journaled steps.
      steps: good && steps.length >= 2 ? steps : undefined,
      outcome: good
        ? `success (autoZooms=${autoZooms}, ${durationSec.toFixed(1)}s)`
        : `failed take (autoZooms=${autoZooms}, ${durationSec.toFixed(1)}s)`,
      source: "auto",
    });
    return {
      saved: true,
      product: skill.product,
      steps: skill.steps.length,
      takes: skill.takes,
      next: `Refine it: save_product_skill({ product: "${skill.product}", steps: [the exact steps that worked], gotchas: [what to avoid] }).`,
    };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function productSkillHint(query: string | null | undefined): Record<string, unknown> | undefined {
  const skill = findProductSkill(query);
  if (!skill) return undefined;
  return {
    product: skill.product,
    takes: skill.takes,
    successes: skill.successes,
    url: skill.url,
    titleContains: skill.titleContains,
    steps: skill.steps,
    gotchas: skill.gotchas,
    instruction: skill.steps.length
      ? "A proven playbook exists for this product. Phase A: replay these steps (run_demo or demo_*) and confirm with peek_window, adapting coordinates if the layout moved. Then Phase B records the same steps."
      : "Known product — read the gotchas before exploring.",
  };
}

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
        : action === "peek_stage"
          ? 45_000
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

type CapTarget = {
  kind?: string;
  title?: string;
  id?: string;
  processName?: string;
  width?: number;
  height?: number;
};

function isChatOrIdeWindow(title: string, processName?: string): boolean {
  const t = title.toLowerCase();
  const p = (processName || "").toLowerCase();
  // Exclude chat/IDE *processes*. Never drop Edge/Chrome just because the title
  // mentions Claude/Cursor (other tabs rewrite the window title).
  if (/claude|cursor|discord|slack|screen-weaver|screen_weaver|windsurf/.test(p)) {
    return true;
  }
  if (isBrowserProcess(p)) return false;
  return /claude|chatgpt|cursor|windsurf|discord|slack|screen beaver|screen weaver|copilot/.test(
    t,
  );
}

function isBrowserProcess(processName?: string): boolean {
  return /msedge|chrome|firefox|brave|opera|chromium/.test(
    (processName || "").toLowerCase(),
  );
}

async function listWindowTargets(): Promise<CapTarget[]> {
  try {
    const listed = (await agentCommand("list_capture_targets", {}, 10_000)) as {
      targets?: CapTarget[];
    };
    return Array.isArray(listed?.targets) ? listed.targets : [];
  } catch {
    return [];
  }
}

/** Prefer browser windows; never pick Claude/Cursor chats that mention the product. */
function findTitleHit(targets: CapTarget[], needle: string): CapTarget | undefined {
  const n = needle.toLowerCase();
  if (!n) return undefined;
  let best: CapTarget | undefined;
  let bestScore = -1;
  for (const t of targets) {
    if (t.kind !== "window") continue;
    const title = t.title || "";
    const proc = t.processName || "";
    if (isChatOrIdeWindow(title, proc)) continue;
    if (!title.toLowerCase().includes(n) && !proc.toLowerCase().includes(n)) continue;
    const area = (t.width ?? 0) * (t.height ?? 0);
    const score = (isBrowserProcess(proc) ? 1_000_000_000 : 0) + area;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function isHeavySpaUrl(url?: string): boolean {
  return !!url && /canva\.com|figma\.com|notion\.(so|site)|miro\.com|adobe\.com/i.test(url);
}

function isSheetsLikeUrl(url?: string): boolean {
  return !!url && /sheets\.new|sheets\.google|docs\.google\.com\/spreadsheets/i.test(url);
}

/** Empty / still-loading scout PNG — keep polling the same window. */
function looksLikeBlankScoutPng(pngBase64?: string): boolean {
  if (!pngBase64) return true;
  // base64 → ~3/4 bytes; real SaaS UIs are usually well above this once painted.
  const approxBytes = Math.floor((pngBase64.length * 3) / 4);
  return approxBytes < 45_000;
}

function readyWaitBudgetMs(productUrl?: string): number {
  if (isSheetsLikeUrl(productUrl)) return 15_000;
  if (isHeavySpaUrl(productUrl)) return 75_000;
  // Generic websites / unknown SaaS — Sheets is easy; everything else needs patience.
  return 55_000;
}

async function shotWindowPng(titleContains: string): Promise<{
  pngBase64?: string;
  layout?: unknown;
}> {
  const qs = new URLSearchParams({ titleContains });
  try {
    const shot = (await bridgeGet(`/capture/window_shot?${qs}`, 15_000)) as {
      pngBase64?: string;
      layout?: unknown;
    };
    if (shot?.pngBase64) return { pngBase64: shot.pngBase64, layout: { ok: true, layout: shot.layout } };
  } catch {
    /* fall through */
  }
  const layout = await bridgeGet(`/capture/window_layout?${qs}`, 8_000).catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  return { layout };
}

/**
 * Poll screenshots until the page looks loaded (non-blank + size stable), or max wait.
 * Never opens extra windows — caller opens at most once first.
 */
async function waitUntilPageReady(opts: {
  titleContains: string;
  productUrl?: string;
  maxMs?: number;
}): Promise<{
  pngBase64?: string;
  layout?: unknown;
  log: unknown[];
  ready: boolean;
  elapsedMs: number;
}> {
  const maxMs = opts.maxMs ?? readyWaitBudgetMs(opts.productUrl);
  const pollMs = isHeavySpaUrl(opts.productUrl) ? 3_500 : 2_500;
  const log: unknown[] = [];
  const started = Date.now();
  let prevLen = 0;
  let stableHits = 0;
  let last: { pngBase64?: string; layout?: unknown } = {};

  log.push({
    waitUntilPageReady: true,
    titleContains: opts.titleContains,
    maxMs,
    pollMs,
    note: "Poll until UI paints — do not give up on blank/dark frames early",
  });

  while (Date.now() - started < maxMs) {
    const elapsedMs = Date.now() - started;
    const targets = await listWindowTargets();
    const hit = findTitleHit(targets, opts.titleContains);
    if (!hit) {
      log.push({ poll: "waiting_for_window_title", elapsedMs });
      await sleep(pollMs);
      continue;
    }

    last = await shotWindowPng(opts.titleContains);
    const len = last.pngBase64?.length ?? 0;
    const blank = looksLikeBlankScoutPng(last.pngBase64);
    const delta =
      prevLen > 0 ? Math.abs(len - prevLen) / Math.max(prevLen, 1) : 1;

    if (!blank && prevLen > 0 && delta < 0.15) {
      stableHits += 1;
    } else if (!blank && len > 160_000) {
      // Clearly rich UI even on first solid frame
      stableHits = Math.max(stableHits, 1);
    } else if (blank) {
      stableHits = 0;
    }

    log.push({
      poll: {
        elapsedMs,
        title: hit.title,
        pngChars: len,
        blank,
        stableHits,
        delta: Number(delta.toFixed(3)),
      },
    });

    if (!blank && stableHits >= 1) {
      return { ...last, log, ready: true, elapsedMs: Date.now() - started };
    }

    prevLen = len;
    await sleep(pollMs);
  }

  const ready = !looksLikeBlankScoutPng(last.pngBase64);
  log.push({
    waitEnded: ready ? "ready_at_timeout" : "still_blank_at_timeout",
    elapsedMs: Date.now() - started,
  });
  return { ...last, log, ready, elapsedMs: Date.now() - started };
}

/** If the product window isn't open, open it once — then WAIT. Never spam new windows. */
async function ensureProductWindow(opts: {
  titleNeedle: string;
  productUrl?: string;
  openPath?: string;
  productName?: string;
  alreadyOpened?: boolean;
}): Promise<{ hit: CapTarget | null; log: unknown[]; targets: CapTarget[] }> {
  const log: unknown[] = [];
  const needle = opts.titleNeedle.trim();
  let targets = await listWindowTargets();
  let hit = findTitleHit(targets, needle);

  if (hit) {
    log.push({
      captureTarget: { id: hit.id, title: hit.title, titleNeedle: needle },
      note: "Product window already open — not opening another",
    });
    return { hit, log, targets };
  }

  if (!opts.alreadyOpened) {
    if (opts.productUrl) {
      log.push({ ensureOpen: `No "${needle}" browser window — opening once` });
      log.push(await bridgePost("/capture/open", { url: opts.productUrl }, 10_000));
      // Short settle only; waitUntilPageReady does the real polling.
      await sleep(isSheetsLikeUrl(opts.productUrl) ? 2_000 : 4_000);
    } else if (opts.openPath) {
      log.push({ ensureOpen: `Opening path once` });
      log.push(await bridgePost("/capture/open", { path: opts.openPath }, 10_000));
      await sleep(2_000);
    } else {
      log.push({
        ensureOpenSkipped: "No productUrl/openPath — cannot open product automatically",
      });
    }
    targets = await listWindowTargets();
    hit = findTitleHit(targets, needle);
  }

  // Poll for window title (SPA title often appears late) — never open a second window.
  const titleDeadline = Date.now() + (isHeavySpaUrl(opts.productUrl) ? 45_000 : 25_000);
  while (!hit && Date.now() < titleDeadline) {
    log.push({ ensureWait: "waiting for window title — not opening another window" });
    await sleep(3_000);
    targets = await listWindowTargets();
    hit = findTitleHit(targets, needle);
  }

  if (hit) {
    log.push({
      captureTarget: { id: hit.id, title: hit.title, titleNeedle: needle },
    });
  } else {
    log.push({
      ensureFailed: true,
      titleNeedle: needle,
      sampleTitles: targets
        .filter((t) => t.kind === "window" && !isChatOrIdeWindow(t.title || "", t.processName))
        .slice(0, 12)
        .map((t) => t.title),
    });
  }
  return { hit: hit ?? null, log, targets };
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

type OcrLine = { text: string; x: number; y: number; w: number; h: number };

const SCREEN_TEXT_MAX_LINES = 140;

/**
 * Windows OCR of a screenshot → "label @ nx,ny" lines (centers, 0..1 of the image).
 * ChatGPT drops MCP image blocks, so this is how text-only clients "see" the screen.
 */
async function screenTextFor(pngBase64: string): Promise<string[] | null> {
  try {
    const res = (await bridgePost("/ocr", { pngBase64 }, 12_000)) as {
      ok?: boolean;
      ocr?: { lines?: OcrLine[] };
    };
    const lines = res?.ocr?.lines;
    if (!res?.ok || !Array.isArray(lines)) return null;
    return lines
      .filter((l) => l.text && l.w > 0 && l.h > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, SCREEN_TEXT_MAX_LINES)
      .map((l) => {
        const cx = (l.x + l.w / 2).toFixed(3);
        const cy = (l.y + l.h / 2).toFixed(3);
        const text = l.text.length > 70 ? `${l.text.slice(0, 67)}…` : l.text;
        return `${text} @ ${cx},${cy}`;
      });
  } catch {
    return null;
  }
}

async function scoutResult(data: unknown, pngBase64?: string | string[]) {
  const frames = Array.isArray(pngBase64) ? pngBase64 : pngBase64 ? [pngBase64] : [];
  // OCR the first frame only — enough to read the UI without slowing multi-frame peeks.
  const screenText = frames[0] ? await screenTextFor(frames[0]) : null;
  const payload =
    screenText && data && typeof data === "object" && !Array.isArray(data)
      ? {
          ...(data as Record<string, unknown>),
          screenText,
          screenTextHelp:
            "OCR of the screenshot: 'label @ nx,ny' = center of that text as 0..1 of the window (pass as nx/ny to demo_click). Icons without text are not listed — use the image when you can see it.",
        }
      : data;
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [
    {
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ];
  for (const frame of frames) {
    if (frame) content.push({ type: "image", data: frame, mimeType: "image/png" });
  }
  return { content };
}

const GUIDE = `# Screen Beaver — agent operating manual

The user gives **short** asks only (“Canva Instagram post demo”, “Sheets tutorial”). **You already know the workflow** — never ask them to paste Phase A/B or explore steps. Expand into **see → learn → record → polish → verify → remember**. They click **Export**. Never export_mp4 unless asked.

## Growing skill (Hermes-style — never stay silent)
1. **Start of session:** call \`get_demo_skill({ product })\` — general lessons + that product's **proven playbook** (exact steps + gotchas). If a playbook exists, replay it in Phase A instead of exploring from scratch.
2. **After every take** (good or bad): \`save_product_skill({ product, steps, gotchas, outcome })\` with the exact steps that worked, and \`remember_demo_lesson\` for general notes. (A recorded take also auto-saves its demo_* steps as the playbook.)
3. Lessons live in MCP resource \`screen-beaver://growing-skill\`; product playbooks in \`~/.screen-beaver/skills/\`.
4. Every screenshot result includes \`screenText\` (OCR "label @ nx,ny") — use it when you cannot view images.

## DEFAULT WORKFLOW (every product the user asks — embedded; they never paste this)
Applies to **all** short asks (Sheets, Excel, Canva, Figma, Notion, random URLs, desktop apps). Skip = fail.

### Phase A — Dry run the EXACT demo (NO recording) — like a motion designer rehearsing
Sheets is the easy case. **Other SaaS (Canva, etc.):** you must physically do the lesson once before the camera rolls.

1. Prefer **browser** windows. Never scout Claude/Cursor chats. Open the product **at most once** (\`open_url\` = **new tab**, never a new browser window).
2. Wait until loaded (poll screenshots). Then run the **exact user ask** with \`demo_click\` / \`demo_type\` / \`demo_wait\` + \`titleContains\` (product name) — e.g. Canva: open design → heading → body with typo+fix → font → element. After every step: wait until paint → \`peek_window\` (screenshot; **does not reload**). Prove the path. Never ask the user what is on screen — screenshot it.
3. Do **not** \`start_capture\` / \`record_and_build\` until Phase A screenshots show the finished result.

### Phase B — New tab, then record the same steps (Screen Studio–style zooms)
1. \`open_url\` again → **new tab** in the same browser (not a new window). Wait until the start screen is ready.
2. \`start_capture({ titleContains: product })\` — never bare \`Edge\`/\`Chrome\`.
3. Replay the **exact** Phase A steps with real cursor (\`durationMs\` ≥ 400, type ~150ms). No mid-take scouting that opens tabs. No dead time.
4. \`stop_capture\` → \`live_build_demo\` / \`regenerate_zooms\` (Auto zooms from cursor+typing — Screen Studio feel) → \`peek_studio\` → \`remember_demo_lesson\` → user Export.
5. If \`regenerate_zooms\` returns 0 autos, the cursor track is missing — do **not** ship a flat take; re-run Phase B.

**Sheets / Excel:** scout until sheet UI is in the PNG → \`record_and_build\`.
**Every other online product:** full explore (wait-until-loaded + click path) before record. Do not jump to \`record_and_build\` blind.

If the studio UI times out mid-take: \`stop_capture\` still works. Re-focus, import if needed, continue — do **not** abandon after a successful Phase A.

## Reply style (critical)
After tools finish, reply in **≤6 short lines**. Always use screenshots you received.

## Real cursor (critical)
All pointer actions = **real OS cursor** (smooth move + SendInput). Never teleport.
- \`durationMs\` ≥ 400 on clicks; use \`demo_drag\` for drags.
- Heavy SPA: wait 800–2500ms after each click before the next.

## Hard rules
- **Only** screen-beaver MCP tools. No shell, curl, .ps1, or JSON files on disk.
- Sheets → \`https://sheets.new\`. Desktop Excel → \`ms-excel:\` (real Excel app). Never confuse the two.
- **Typing:** \`delayMs\` ≈ **150**. Use intentional typos + \`\\b\` / \`op:"backspace"\` then retype. Never 30–50ms robot typing.
- Spreadsheet demos must feel like a **real mini lesson**: headers, multiple rows, \`=B2*C2\`, \`=SUM(...)\`, division/average — not two lonely numbers.
- **Mouse then keys:** move → settle → **click** (Auto zooms punch in *before* the click) → then type. Never Tab-hop silently. After record, \`regenerate_zooms\` + \`peek_studio\`.
- Auto zoom priority: (1) typing field lock (2) click punch-before-click. Always apply a **style preset** (default vivid).
- \`record_and_build\` stays lean (voiceover/music off by default). Add VO after if asked.
- Takes for rich sheets/Excel: ~25–35s. Drive the UI the whole time. Cut end lag with \`patch_trim({ trimEndSlackSec: 0.25 })\`.

## After \`make_product_tutorial\`
- \`needsExplore: false\` (Sheets/Excel ready): study PNG → \`record_and_build\` → peek → remember → Export.
- \`needsExplore: true\` (default for every other product): follow \`explorePlan\` — Phase A then Phase B. Do **not** \`start_capture\` / \`record_and_build\` until screenshots prove the path.

## Auth / desktop notes
- Read every scout PNG: Sign in / Log in / Get started / Continue with Google.
- Ask the user to sign in if needed — never invent passwords.
- Native desktop: \`open_path\` + \`titleContains\` / \`list_capture_targets\`.
- Never blind-click any product you haven’t seen in a screenshot.

## Manual / interactive control
1. \`open_url\` / \`open_path\` → \`list_capture_targets\` → \`start_capture\`
2. Drive UI: \`demo_move\`, \`demo_click\`, \`demo_type\` (key-by-key, ~110ms), \`demo_scroll\`, \`demo_focus\`, \`demo_wait\`
3. \`stop_capture\` → \`live_build_demo\` (autoMode default) → \`generate_voiceover\`

## Android USB phone
1. Phone: USB debugging on, plugged in, tap **Allow** on the trust prompt.
2. \`android_ensure_runtime\` (first run downloads portable scrcpy/adb) → \`android_list_devices\`
3. \`android_start\` (optional \`serial\`) → mirror window **Screen Beaver Android**
4. Drive with \`demo_*\` / \`run_demo\` on the mirror (same as window capture)
5. \`android_stop\` or \`stop_capture\` → imports phone take + device shell → \`live_build_demo\`
Or one-shot: \`record_android_and_build\` with optional \`demoSteps\` / \`serial\`.

## Demo step shape
\`{ "op": "click", "nx": 0.5, "ny": 0.4, "durationMs": 600 }\`
\`{ "op": "click", "contentNx": 0.5, "contentNy": 0.4 }\` — page-relative (preferred for web)
\`{ "op": "type", "text": "Hello", "delayMs": 150 }\` — slow human typing + SFX  
\`{ "op": "type", "text": "15\\b\\b12" }\` or \`{ "op": "backspace", "count": 2 }\` — fix a typo like a person  
Coords: prefer contentNx/contentNy; nx/ny are 0..1 of outer window. Input works during capture, or explore-without-record when \`titleContains\` is set.

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
  op: z.enum([
    "wait",
    "move",
    "click",
    "drag",
    "scroll",
    "focus",
    "right_click",
    "type",
    "backspace",
  ]),
  ms: z.number().optional(),
  nx: z.number().optional(),
  ny: z.number().optional(),
  /** 0..1 within the webpage content area (auto-maps through browser chrome). Prefer over nx/ny for web demos. */
  contentNx: z.number().optional(),
  contentNy: z.number().optional(),
  /** Drag destination (with op=drag). */
  toNx: z.number().optional(),
  toNy: z.number().optional(),
  toContentNx: z.number().optional(),
  toContentNy: z.number().optional(),
  space: z.enum(["window", "content"]).optional(),
  durationMs: z.number().optional(),
  dragMs: z.number().optional().describe("For op=drag: duration of the drag move (default ~700)"),
  click: z.boolean().optional(),
  inWindow: z.boolean().optional(),
  delta: z.number().optional(),
  hwnd: z.number().optional(),
  text: z
    .string()
    .optional()
    .describe(
      "For op=type: key-by-key text. \\n Enter, \\t Tab, \\b Backspace (human typos). Not clipboard paste.",
    ),
  count: z.number().optional().describe("For op=backspace: how many times (default 1)"),
  delayMs: z
    .number()
    .optional()
    .describe("Per-key delay for type/backspace (default ~150ms — slow human tutorial pace)"),
});

/** Slow human tutorial typing pace (ms between keys). */
const HUMAN_TYPE_MS = 150;
const BS = "\b";

type DemoStep = z.infer<typeof demoStepSchema>;

/** Build a small “typo → backspace → correct” beat so typing feels human. */
function typeWithTypo(correct: string, typo: string, delayMs = HUMAN_TYPE_MS): DemoStep[] {
  return [
    { op: "type", text: typo, delayMs },
    { op: "wait", ms: 320 },
    { op: "type", text: BS.repeat(typo.length), delayMs: Math.round(delayMs * 0.9) },
    { op: "wait", ms: 220 },
    { op: "type", text: correct, delayMs },
  ];
}

/**
 * Detailed spreadsheet tutorial: headers + rows + multiply + SUM + division.
 * Mouse-selects every cell before typing so Auto zooms can follow pointer → then keys.
 */
function richSpreadsheetDemoSteps(kind: "sheets" | "excel"): DemoStep[] {
  const d = HUMAN_TYPE_MS;
  // Approximate A–D × rows 1–6 in the grid (Sheets = page content; Excel = window).
  const colX = kind === "sheets" ? [0.12, 0.22, 0.33, 0.45] : [0.16, 0.27, 0.39, 0.51];
  const rowY = kind === "sheets"
    ? [0.195, 0.255, 0.315, 0.375, 0.435, 0.495]
    : [0.3, 0.355, 0.41, 0.465, 0.52, 0.575];

  // Slow approach so Auto zoom punches in *before* the click lands.
  const clickCell = (c: number, r: number, durationMs = 680): DemoStep =>
    kind === "sheets"
      ? { op: "click", contentNx: colX[c]!, contentNy: rowY[r]!, durationMs }
      : { op: "click", nx: colX[c]!, ny: rowY[r]!, durationMs };

  const fill = (c: number, r: number, text: string, moveMs = 650): DemoStep[] => [
    clickCell(c, r, moveMs),
    { op: "wait", ms: 320 },
    { op: "type", text, delayMs: d },
    { op: "wait", ms: 280 },
  ];

  const fillTypo = (c: number, r: number, correct: string, typo: string): DemoStep[] => [
    clickCell(c, r, 560),
    { op: "wait", ms: 340 },
    ...typeWithTypo(correct, typo, d),
    { op: "wait", ms: 300 },
  ];

  return [
    { op: "wait", ms: kind === "excel" ? 3200 : 2000 },
    { op: "focus" },
    // Headers — click each column
    ...fill(0, 0, "Item", 620),
    ...fill(1, 0, "Qty", 500),
    ...fill(2, 0, "Price", 500),
    ...fill(3, 0, "Total", 500),
    // Row 1
    ...fill(0, 1, "Widgets", 560),
    ...fillTypo(1, 1, "12", "15"),
    ...fill(2, 1, "4.5", 500),
    ...fill(3, 1, "=B2*C2", 540),
    // Row 2
    ...fill(0, 2, "Cables", 540),
    ...fill(1, 2, "8", 480),
    ...fill(2, 2, "2.25", 500),
    ...fill(3, 2, "=B3*C3", 540),
    // Row 3
    ...fill(0, 3, "Cases", 540),
    ...fill(1, 3, "5", 480),
    ...fill(2, 3, "9", 500),
    ...fill(3, 3, "=B4*C4", 540),
    // SUM + average
    ...fill(0, 4, "SUM", 560),
    ...fill(3, 4, "=SUM(D2:D4)", 580),
    ...fill(0, 5, "Avg/line", 560),
    ...fill(3, 5, "=D5/3", 580),
    { op: "wait", ms: 900 },
  ];
}

/** Short default script when the agent doesn't supply demoSteps — never invent a full product tour. */
function defaultWebExploreSteps(): z.infer<typeof demoStepSchema>[] {
  return [
    { op: "wait", ms: 1200 },
    { op: "focus" },
    { op: "click", contentNx: 0.5, contentNy: 0.4, durationMs: 650 },
    { op: "wait", ms: 900 },
    { op: "click", contentNx: 0.55, contentNy: 0.52, durationMs: 550 },
    { op: "wait", ms: 800 },
  ];
}

function extractHttpUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s)\]}'"]+/i);
  return m?.[0]?.replace(/[.,;:]+$/, "");
}

function inferProductFromTopic(topic: string): {
  productName: string;
  productUrl?: string;
  openPath?: string;
  titleContains: string;
  demoSteps: z.infer<typeof demoStepSchema>[];
  introCaption: string;
  features: z.infer<typeof featureBeatSchema>[];
  /** Unknown / arbitrary site — agent must study screenshots before recording. */
  needsExplore: boolean;
} {
  const t = topic.toLowerCase();
  const urlInTopic = extractHttpUrl(topic);
  const sheets =
    t.includes("sheet") ||
    t.includes("spreadsheet") ||
    (t.includes("formula") && (t.includes("google") || t.includes("sheet")));
  const excelDesktop = t.includes("excel") && !t.includes("google") && !t.includes("sheet");

  if (sheets || (t.includes("formula") && !excelDesktop)) {
    return {
      productName: "Google Sheets",
      productUrl: "https://sheets.new",
      titleContains: "Sheets",
      introCaption: "Build a mini sales sheet",
      features: [
        { title: "Headers & rows", atSeconds: 3, holdSeconds: 2.4 },
        { title: "Multiply line totals", atSeconds: 12, holdSeconds: 2.6 },
        { title: "SUM the column", atSeconds: 22, holdSeconds: 2.4 },
        { title: "Average with division", atSeconds: 28, holdSeconds: 2.4 },
      ],
      demoSteps: richSpreadsheetDemoSteps("sheets"),
      needsExplore: false,
    };
  }

  if (excelDesktop) {
    return {
      productName: "Excel",
      // Opens real desktop Excel (Office protocol) — not the web app.
      productUrl: "ms-excel:",
      titleContains: "Excel",
      introCaption: "Excel — formulas that sell the story",
      features: [
        { title: "Headers & sample rows", atSeconds: 4, holdSeconds: 2.5 },
        { title: "Qty × Price", atSeconds: 14, holdSeconds: 2.6 },
        { title: "SUM totals", atSeconds: 24, holdSeconds: 2.4 },
        { title: "Divide for average", atSeconds: 30, holdSeconds: 2.4 },
      ],
      demoSteps: richSpreadsheetDemoSteps("excel"),
      needsExplore: false,
    };
  }

  // Any other product the user names — resolve URL when known; always needsExplore.
  const knownHomes: Array<{ match: RegExp; name: string; url: string; title: string }> = [
    { match: /canva/, name: "Canva", url: "https://www.canva.com", title: "Canva" },
    { match: /figma/, name: "Figma", url: "https://www.figma.com", title: "Figma" },
    { match: /notion/, name: "Notion", url: "https://www.notion.so", title: "Notion" },
    { match: /\bmiro\b/, name: "Miro", url: "https://miro.com", title: "Miro" },
    { match: /adobe|express/, name: "Adobe Express", url: "https://express.adobe.com", title: "Adobe" },
  ];
  for (const k of knownHomes) {
    if (k.match.test(t)) {
      return {
        productName: k.name,
        productUrl: urlInTopic || k.url,
        titleContains: k.title,
        introCaption: `Tour ${k.name}`,
        features: [
          { title: "Open the product", atSeconds: 4, holdSeconds: 2.5 },
          { title: "Key action", atSeconds: 14, holdSeconds: 2.5 },
        ],
        demoSteps: defaultWebExploreSteps(),
        needsExplore: true,
      };
    }
  }

  // Arbitrary site / named product — open URL if present; always explore before inventing clicks.
  let hostName = "Product";
  if (urlInTopic) {
    try {
      hostName = new URL(urlInTopic).hostname.replace(/^www\./, "") || "Product";
    } catch {
      /* keep default */
    }
  }
  const name =
    (urlInTopic
      ? hostName
      : topic.replace(/\s+/g, " ").trim().slice(0, 48)) || "Product";
  return {
    productName: name,
    productUrl: urlInTopic,
    titleContains: urlInTopic ? hostName.slice(0, 24) : name.slice(0, 24) || "Edge",
    introCaption: `Tour ${name}`,
    features: [
      { title: "Find your way in", atSeconds: 3 },
      { title: "Key moment", atSeconds: 8 },
    ],
    demoSteps: defaultWebExploreSteps(),
    needsExplore: true,
  };
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

  const isWeb =
    !!args.productUrl &&
    (/^https?:\/\//i.test(args.productUrl) || args.productUrl.includes("sheets"));
  return {
    version: 1 as const,
    name: args.productName,
    // Always ship a polished look — agents must not leave default empty chrome.
    preset: args.preset ?? ("vivid" as const),
    frame: {
      padding: 10,
      radius: 4,
      ...(isWeb
        ? {
            chrome: "browser" as const,
            browserUrl: args.productUrl!.replace(/^https?:\/\//, "").replace(/\/$/, ""),
            nativeChromeCrop: 0.11,
          }
        : { chrome: "none" as const, nativeChromeCrop: 0 }),
    },
    captions,
    regenerateAutoZooms: true,
    notes:
      "Auto zooms follow the cursor (Screen Studio–style). Frame pad 10% / radius 4%. peek_studio to confirm.",
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

function createScreenBeaverMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "screen-beaver",
      version: "0.3.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
  "get_capabilities",
  {
    description:
      "Screen Beaver MCP capabilities. Scout with scout_product, then record_and_build (or live_build_demo on an existing take). User clicks Export.",
    inputSchema: {},
  },
  async () =>
    textResult({
      bridge: BRIDGE,
      preferredTool: "make_product_tutorial",
      scoutFirst: true,
      userClicksExport: true,
      noShellScripts: true,
      noPs1OrJsonFiles: true,
      tools: [
        "ping_studio",
        "studio_status",
        "verify_take",
        "scout_product",
        "peek_studio",
        "make_product_tutorial",
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
        "demo_drag",
        "demo_type",
        "demo_scroll",
        "demo_focus",
        "demo_wait",
        "run_demo",
        "record_and_build",
        "live_build_demo",
        "add_caption",
        "add_zoom",
        "update_zoom",
        "remove_zoom",
        "clear_auto_zooms",
        "regenerate_zooms",
        "patch_trim",
        "patch_frame",
        "apply_style_preset",
        "apply_recipe",
        "seek_playhead",
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
        "get_demo_skill",
        "save_product_skill",
        "remember_demo_lesson",
      ],
      growingSkill:
        "Call get_demo_skill at session start; remember_demo_lesson after every take so Claude/BetterClaw/Cursor improve on this PC.",
      requiresDesktopApp: true,
      nativeCapture: "Windows-only, no OS share picker — open studio first, then record_and_build",
      androidUsb:
        "android_list_devices → android_start → demo_* → android_stop (or record_android_and_build). Phone needs USB debugging.",
      autoMode:
        "Zooms: typing locks field (priority 1), clicks punch in (priority 2). regenerate_zooms after edits. Trim dead air with patch_trim({ trimEndSlackSec: 0.25 }).",
      typing: "demo_type / op:type uses real key-by-key keyboard events + typing SFX — Auto MUST zoom on typing",
      voiceover: "generate_voiceover after captions; default en-US; other langs translate then TTS",
      music: "Openverse CC search (no API key) → pick_background_music; glare uses shimmer SFX",
      motionDesigner:
        "peek_studio → fix with update_zoom / add_zoom / regenerate_zooms / patch_trim / patch_frame / apply_style_preset. Cut end lag with patch_trim trimEndSlackSec.",
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
  "verify_take",
  {
    description:
      "After record_and_build: duration, captions, Auto zoom count, cursor samples. Use summaryLine in your short user reply.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("verify_take")),
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
      "Screen + window + browser-content rects (does NOT reload the page). Prefer titleContains=product (Canva). Prefer contentNx/contentNy for web clicks. If Canva match fails, retry with Edge — never ask the user to describe the screen.",
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
    try {
      return textResult(
        await bridgeGet(
          q ? `/capture/window_layout?${q}` : "/capture/window_layout?titleContains=Edge",
        ),
      );
    } catch (err) {
      const primary = titleContains?.trim() || "Edge";
      if (/^edge$/i.test(primary)) throw err;
      const layout = await bridgeGet(`/capture/window_layout?titleContains=Edge`, 8_000).catch(
        (e2) => ({ error: e2 instanceof Error ? e2.message : String(e2) }),
      );
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fallbackTitleContains: "Edge",
        layout,
        hint: "Use scout_product / window screenshot next — layout does not reload the page. Prefer browser windows even if the title mentions Claude.",
      });
    }
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
  async ({ url }) => {
    journal.lastUrl = url;
    return textResult(await bridgePost("/capture/open", { url }));
  },
);

server.registerTool(
  "peek_window",
  {
    description:
      "Screenshot + layout of an existing window WITHOUT opening a URL or reloading. Use after every Phase A click (titleContains=Canva). Does not touch the page.",
    inputSchema: {
      titleContains: z
        .string()
        .optional()
        .describe("Product or browser title match (default Canva → Edge fallback)"),
      hwnd: z.number().optional(),
    },
  },
  async ({ titleContains, hwnd }) => {
    const primary = titleContains?.trim() || "Canva";
    const tryShot = async (needle: string) => {
      const qs = new URLSearchParams({ titleContains: needle });
      if (typeof hwnd === "number") qs.set("hwnd", String(hwnd));
      return (await bridgeGet(`/capture/window_shot?${qs}`, 15_000)) as {
        pngBase64?: string;
        layout?: unknown;
        hwnd?: number;
        error?: string;
      };
    };
    try {
      await bridgeGet("/health", 4_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Open Screen Beaver desktop first.",
      });
    }
    let shot = await tryShot(primary).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!("pngBase64" in shot && shot.pngBase64) && !/^edge$/i.test(primary)) {
      shot = await tryShot("Edge").catch((e) => ({
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    const png = "pngBase64" in shot ? shot.pngBase64 : undefined;
    return scoutResult(
      {
        ok: Boolean(png),
        titleUsed: primary,
        blankScout: looksLikeBlankScoutPng(png),
        note: "peek_window does not reload or open tabs — study the PNG and continue Phase A.",
        shot,
      },
      png,
    );
  },
);

server.registerTool(
  "scout_product",
  {
    description:
      "REQUIRED before recording unfamiliar UIs. Opens URL/app once if needed, waits until loaded, returns layout + PNG. For mid-dry-run checks use peek_window instead (no reload).",
    inputSchema: {
      productUrl: z.string().optional().describe("https://… (Sheets formulas: https://sheets.new)"),
      openPath: z.string().optional().describe("Local .exe / document to open"),
      titleContains: z
        .string()
        .optional()
        .describe("Window title/process match (default Sheets/Edge from URL)"),
      settleMs: z
        .number()
        .optional()
        .describe("Wait after open before screenshot (default 2500; Canva/Figma up to 20000)"),
      productName: z.string().optional().describe("Human name for planning hints"),
      hwnd: z.number().optional().describe("Optional window handle from targets list"),
    },
  },
  async ({ productUrl, openPath, titleContains, settleMs, productName, hwnd }) => {
    if (!productUrl && !openPath) {
      return textResult({
        ok: false,
        error: "Provide productUrl and/or openPath to scout.",
      });
    }
    try {
      await bridgeGet("/health", 4_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Open Screen Beaver desktop first, then retry scout_product.",
      });
    }

    const title =
      titleContains ||
      (productUrl && /sheets\.new|sheets\.google/i.test(productUrl) ? "Sheets" : null) ||
      (productUrl && /canva\.com/i.test(productUrl) ? "Canva" : null) ||
      (productName ? productName.slice(0, 24) : null) ||
      (productUrl
        ? (() => {
            try {
              return new URL(productUrl).hostname.replace(/^www\./, "").split(".")[0] || "Edge";
            } catch {
              return "Edge";
            }
          })()
        : null) ||
      "Chrome";

    const log: unknown[] = [];
    // Reuse existing product browser window; open at most once.
    const ensured = await ensureProductWindow({
      titleNeedle: title,
      productUrl: productUrl || undefined,
      openPath: openPath || undefined,
      productName: productName || undefined,
    });
    log.push(...ensured.log);

    const maxWait =
      typeof settleMs === "number"
        ? Math.min(90_000, Math.max(3_000, settleMs))
        : readyWaitBudgetMs(productUrl);
    const ready = await waitUntilPageReady({
      titleContains: title,
      productUrl: productUrl || undefined,
      maxMs: maxWait,
    });
    log.push(...ready.log);

    const targets = await bridgeGet("/capture/targets", 8_000);
    const pngBase64 = ready.pngBase64;
    const layout = ready.layout;
    const blank = !ready.ready;
    journal.lastProduct = title;
    if (productName?.trim()) journal.productName = productName.trim();
    if (productUrl) journal.lastUrl = productUrl;
    return scoutResult(
      {
        ok: true,
        productName: productName ?? null,
        productSkill: productSkillHint(productName) ?? productSkillHint(title),
        productUrl: productUrl ?? null,
        openPath: openPath ?? null,
        settleMs: ready.elapsedMs,
        titleUsed: title,
        hwnd: typeof hwnd === "number" ? hwnd : null,
        hasScreenshot: Boolean(pngBase64),
        blankScout: blank,
        pageReady: ready.ready,
        captureTarget: ensured.hit,
        openLog: log,
        targets,
        layout,
        next: blank
          ? [
              "Still blank after polling — call scout_product again (same URL). Do NOT open another Edge window. Do NOT ask the user to open the product. Keep waiting.",
            ]
          : [
              "Look at the screenshot image in this tool result.",
              "Plan short demoSteps with contentNx/contentNy (or keyboard-first on Sheets).",
              "Call record_and_build — then verify_take. Reply to the user in ≤6 short lines.",
            ],
      },
      pngBase64,
    );
  },
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
      "Focus Screen Beaver, flash share options, then start native window recording (no OS Share dialog). titleContains must be the product (Canva, Sheets) — browser window title is the active tab; bare Edge/Chrome often records the wrong tab.",
    inputSchema: {
      windowId: z.string().optional().describe("e.g. window:123456 or monitor:0"),
      titleContains: z.string().optional().describe("Match window title or process name"),
      showPicker: z.boolean().optional().describe("Flash in-app share UI first (default true)"),
      surface: z.enum(["screen", "application", "tab"]).optional(),
    },
  },
  async ({ windowId, titleContains, showPicker, surface }) => {
    const result = await agentCommand(
      "start_capture",
      {
        windowId,
        titleContains,
        showPicker: showPicker !== false,
        surface: surface ?? "application",
      },
      25_000,
    );
    const ok = !(result && typeof result === "object" && (result as { ok?: unknown }).ok === false);
    if (ok) {
      journal.captureStart = journal.steps.length;
      journal.captureProduct = skillProductName();
      journal.captureTitle = titleContains?.trim() || null;
    }
    return textResult(result);
  },
);

const isFinalizing = (v: unknown) =>
  Boolean(v && typeof v === "object" && (v as { finalizing?: boolean }).finalizing);

/**
 * Big takes keep the encoder busy after stop. Wait (bounded, so the MCP call doesn't
 * hit client timeouts) until /capture/last reports a finished MP4.
 */
async function waitForFinalizedCapture(maxMs: number): Promise<{ ready: boolean; meta: unknown }> {
  const deadline = Date.now() + maxMs;
  let meta: unknown = null;
  for (;;) {
    try {
      meta = await bridgeGet("/capture/last", 10_000);
      if (!isFinalizing(meta)) return { ready: true, meta };
    } catch {
      /* bridge busy — retry */
    }
    if (Date.now() > deadline) return { ready: false, meta };
    await sleep(2_000);
  }
}

const FINALIZE_HINT =
  "The MP4 is still being written (long/large take). Wait ~30 s, then call import_last_capture — do NOT re-record and do NOT tell the user the take failed.";

async function importWhenFinalized(): Promise<{ imported: unknown; error: string | null }> {
  let imported: unknown = null;
  let importErr: string | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      imported = await agentCommand("import_last_capture", {}, 150_000);
      importErr = null;
      break;
    } catch (err) {
      importErr = err instanceof Error ? err.message : String(err);
      await sleep(2_000 + i * 2_000);
    }
  }
  return { imported, error: importErr };
}

async function stopCaptureAndImport(): Promise<{
  ok: boolean;
  finalizing?: boolean;
  stopped?: unknown;
  imported?: unknown;
  error?: string;
  message: string;
}> {
  let stopped: unknown = null;
  let stopErr: string | null = null;
  try {
    // Rust answers within ~15 s; if the encoder is still flushing it returns finalizing:true.
    stopped = await bridgePost("/capture/stop", {}, 45_000);
  } catch (err) {
    stopErr = err instanceof Error ? err.message : String(err);
    // Session may already be gone after a client timeout — recover last file.
    try {
      stopped = await bridgeGet("/capture/last", 10_000);
    } catch (err2) {
      stopErr = `${stopErr}; last=${err2 instanceof Error ? err2.message : String(err2)}`;
    }
  }

  if (isFinalizing(stopped) || stopErr) {
    const { ready, meta } = await waitForFinalizedCapture(150_000);
    if (!ready) {
      return {
        ok: false,
        finalizing: true,
        stopped: meta ?? stopped,
        message: FINALIZE_HINT,
      };
    }
    stopped = meta;
    stopErr = null;
  }

  const { imported, error: importErr } = await importWhenFinalized();
  const ok = Boolean(stopped) && !importErr;
  return {
    ok,
    stopped,
    imported,
    error: importErr || stopErr || undefined,
    message: ok
      ? "Capture stopped and imported into the studio."
      : importErr
        ? `Capture on disk — import failed (${importErr}). Call import_last_capture / peek_studio again.`
        : `Capture stop issue (${stopErr}). Check /capture/last and import_last_capture.`,
  };
}

server.registerTool(
  "stop_capture",
  {
    description:
      "Stop native window OR Android USB capture and import into Screen Beaver. Recovers the take from disk if stop already finished / timed out.",
    inputSchema: {},
  },
  async () => {
    const stopped = await stopCaptureAndImport();
    if (!stopped.ok) return textResult(stopped);
    return textResult({
      ...stopped,
      productSkill: autoSaveSkillAfterTake(stopped.imported),
      next: [
        "regenerate_zooms (if autoZooms is 0) → peek_studio → fix with update_zoom / patch_trim.",
        "save_product_skill with the exact steps + gotchas so the next demo of this product is faster.",
        "Tell the user to click Export.",
      ],
    });
  },
);

server.registerTool(
  "import_last_capture",
  {
    description:
      "Import the most recent native capture into the studio (use when stop timed out but the MP4 exists, or studio shows No take loaded).",
    inputSchema: {},
  },
  async () => {
    try {
      await bridgeGet("/capture/last", 10_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "No capture on disk yet.",
      });
    }
    const { ready, meta } = await waitForFinalizedCapture(150_000);
    if (!ready) {
      return textResult({ ok: false, finalizing: true, last: meta, message: FINALIZE_HINT });
    }
    const { imported, error } = await importWhenFinalized();
    if (error) {
      return textResult({
        ok: false,
        error,
        last: meta,
        hint: "The MP4 is complete on disk. Call peek_studio — if the studio window is frozen, ask the user to bring it to the front, then import_last_capture again.",
      });
    }
    const out = {
      ok: true,
      imported,
      message: "Last capture imported into the studio.",
    };
    return textResult({ ...out, productSkill: autoSaveSkillAfterTake(imported) });
  },
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
  async ({ steps, hwnd }) => {
    const result = await bridgePost("/input/run", {
      steps,
      hwnd: hwnd ?? null,
    });
    for (const s of steps) journalPush(s);
    return textResult(result);
  },
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
  async ({ nx, ny, contentNx, contentNy, durationMs, click, inWindow }) => {
    const result = await bridgePost("/input/move", {
      nx: contentNx ?? nx ?? 0.5,
      ny: contentNy ?? ny ?? 0.5,
      contentNx,
      contentNy,
      space: typeof contentNx === "number" ? "content" : undefined,
      durationMs: durationMs ?? 550,
      click: click ?? false,
      inWindow: inWindow ?? true,
    });
    journalPush(
      typeof contentNx === "number"
        ? { op: click ? "click" : "move", contentNx, contentNy, durationMs }
        : { op: click ? "click" : "move", nx, ny, durationMs },
    );
    return textResult(result);
  },
);

server.registerTool(
  "demo_click",
  {
    description:
      "Real OS cursor: smooth-move then SendInput click. Prefer contentNx/contentNy. durationMs ≥ 400. Works during capture, or explore-without-record if titleContains is set (e.g. Canva).",
    inputSchema: {
      button: z.enum(["left", "right"]).optional(),
      nx: z.number().optional().describe("If set with ny, move then click (window space)"),
      ny: z.number().optional(),
      contentNx: z.number().optional(),
      contentNy: z.number().optional(),
      durationMs: z.number().optional(),
      titleContains: z
        .string()
        .optional()
        .describe("Explore without capture: target window title substring (Canva, Edge, …)"),
    },
  },
  async ({ button, nx, ny, contentNx, contentNy, durationMs, titleContains }) => {
    const useContent = typeof contentNx === "number" && typeof contentNy === "number";
    const useWindow = typeof nx === "number" && typeof ny === "number";
    const op = button === "right" ? "right_click" : "click";
    if (useContent || useWindow) {
      const result = await bridgePost("/input/move", {
        nx: contentNx ?? nx ?? 0.5,
        ny: contentNy ?? ny ?? 0.5,
        contentNx,
        contentNy,
        space: useContent ? "content" : undefined,
        durationMs: Math.max(400, durationMs ?? 600),
        click: button !== "right",
        inWindow: true,
        titleContains,
      });
      journalPush(
        useContent ? { op, contentNx, contentNy, durationMs } : { op, nx, ny, durationMs },
        titleContains,
      );
      return textResult(result);
    }
    const result = await bridgePost("/input/click", { button: button ?? "left" });
    journalPush({ op }, titleContains);
    return textResult(result);
  },
);

server.registerTool(
  "demo_drag",
  {
    description:
      "Real OS cursor drag: smooth-move to start → mouse down → drag to end → mouse up. Prefer contentNx/toContentNx for web. Only while capture is running.",
    inputSchema: {
      contentNx: z.number().optional(),
      contentNy: z.number().optional(),
      toContentNx: z.number().optional(),
      toContentNy: z.number().optional(),
      nx: z.number().optional(),
      ny: z.number().optional(),
      toNx: z.number().optional(),
      toNy: z.number().optional(),
      durationMs: z.number().optional().describe("Approach duration (min 400)"),
      dragMs: z.number().optional().describe("Drag move duration (default 700)"),
    },
  },
  async (args) => {
    const step = {
      op: "drag",
      contentNx: args.contentNx,
      contentNy: args.contentNy,
      toContentNx: args.toContentNx,
      toContentNy: args.toContentNy,
      nx: args.nx,
      ny: args.ny,
      toNx: args.toNx,
      toNy: args.toNy,
      durationMs: Math.max(400, args.durationMs ?? 600),
      dragMs: Math.max(300, args.dragMs ?? 700),
    };
    const result = await bridgePost("/input/run", { steps: [step] });
    journalPush(step);
    return textResult(result);
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
  async ({ delta }) => {
    const result = await bridgePost("/input/scroll", { delta });
    journalPush({ op: "scroll", delta });
    return textResult(result);
  },
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
      ms: z
        .number()
        .describe("Milliseconds to wait (max 30000). Use 4000–12000 for Canva/Figma load."),
    },
  },
  async ({ ms }) => {
    const clamped = Math.min(30_000, Math.max(0, Math.floor(ms)));
    await sleep(clamped);
    journalPush({ op: "wait", ms: clamped });
    return textResult({ ok: true, waitedMs: clamped });
  },
);

server.registerTool(
  "demo_type",
  {
    description:
      "Type text key-by-key into the focused captured window (not clipboard). \\n = Enter, \\t = Tab. Only while capture is running.",
    inputSchema: {
      text: z
        .string()
        .max(500)
        .describe("Text to type. Use \\n for Enter, \\t for Tab."),
      delayMs: z
        .number()
        .optional()
        .describe("Delay between keys in ms (default 110 — human tutorial pace)"),
    },
  },
  async ({ text, delayMs }) => {
    const result = await bridgePost(
      "/input/type",
      { text, delayMs: delayMs ?? HUMAN_TYPE_MS },
      Math.min(DEMO_FETCH_TIMEOUT_MS, 5_000 + text.length * (delayMs ?? HUMAN_TYPE_MS)),
    );
    journalPush({ op: "type", text, delayMs: delayMs ?? HUMAN_TYPE_MS });
    return textResult(result);
  },
);

server.registerTool(
  "make_product_tutorial",
  {
    description:
      "PRIMARY for any short user ask about any product. Scouts + screenshot. Always Phase A explore (study PNG; click-explore when needsExplore) then Phase B record. Sheets/Excel may record_and_build after a ready-sheet scout; everything else: new tab + start_capture after proven path. User never pastes this workflow.",
    inputSchema: {
      topic: z
        .string()
        .describe(
          "What to teach, e.g. Google Sheets formulas — or a full https://… URL for a new product",
        ),
      productUrl: z.string().optional(),
      openPath: z.string().optional().describe("Desktop app .exe / document if not a website"),
      productName: z.string().optional(),
      titleContains: z.string().optional(),
    },
  },
  async ({ topic, productUrl, openPath, productName, titleContains }) => {
    // Fold explicit productUrl into topic so URL extraction / needsExplore stay consistent.
    const topicForInfer =
      productUrl && !/https?:\/\//i.test(topic) ? `${topic} ${productUrl}` : topic;
    const inferred = inferProductFromTopic(topicForInfer);
    const url = productUrl ?? inferred.productUrl;
    const path = openPath ?? inferred.openPath;
    const name = productName ?? inferred.productName;
    const needsExplore = inferred.needsExplore;

    try {
      await bridgeGet("/health", 4_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Open Screen Beaver desktop first.",
      });
    }

    const title = titleContains || inferred.titleContains;
    const scoutLog: unknown[] = [];
    // Open at most once — reuse existing browser window titled like the product.
    const ensured = await ensureProductWindow({
      titleNeedle: title,
      productUrl: url,
      openPath: path,
    });
    scoutLog.push(...ensured.log);

    // Poll until the page paints (Sheets ~15s budget; Canva/other SaaS up to ~75s).
    const ready = await waitUntilPageReady({
      titleContains: title,
      productUrl: url,
    });
    scoutLog.push(...ready.log);
    const layout = ready.layout;
    const pngBase64 = ready.pngBase64;
    const targets = await bridgeGet("/capture/targets", 8_000).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    }));

    const recordArgs = {
      productName: name,
      productUrl: url,
      openPath: path,
      titleContains: title,
      demoSteps: inferred.demoSteps,
      introCaption: inferred.introCaption,
      features: inferred.features,
      preset: "vivid" as const,
      maxCaptureSec: needsExplore ? 20 : 36,
      // Keep the first tool under Claude's relay budget — VO/music as follow-ups.
      voiceover: false,
      backgroundMusic: false,
      autoMode: true,
    };

    const blank = !ready.ready;
    const explorePlan = [
      "PHASE A DRY RUN (no start_capture): study PNG, then perform the EXACT lesson with demo_click/demo_type (real cursor) — heading, body typo+fix, font, element. Screenshot after each step until proven.",
      blank
        ? "Still blank: wait/re-scout SAME browser — never open another window, never ask the user to open the product."
        : "If auth needed: click it, re-scout, ask user to sign in — never invent passwords.",
      "PHASE B: open_url → NEW TAB (same window, not new window) → wait loaded → start_capture({ titleContains: product }) → replay EXACT Phase A steps → stop_capture.",
      "Then live_build_demo + regenerate_zooms (Auto zooms like Screen Studio) + peek_studio + remember_demo_lesson. If autoZooms=0, re-record Phase B — do not deliver a flat take.",
    ];

    journal.lastProduct = title || name || null;
    if (name?.trim()) journal.productName = name.trim();
    if (url) journal.lastUrl = url;
    const productSkill = productSkillHint(name) ?? productSkillHint(topic);

    return scoutResult(
      {
        ok: true,
        topic,
        productSkill,
        needsExplore,
        hasScreenshot: Boolean(pngBase64),
        blankScout: blank,
        pageReady: ready.ready,
        waitedMs: ready.elapsedMs,
        mustStudyScreenshot: true,
        scout: {
          targets,
          layout,
          openLog: scoutLog,
          titleUsed: title,
          captureTarget: ensured.hit,
        },
        explorePlan: needsExplore || blank ? explorePlan : undefined,
        nextTool: blank ? "scout_product" : needsExplore ? "demo_click" : "record_and_build",
        forbidUntilExploreDone: needsExplore || blank
          ? ["start_capture", "record_and_build"]
          : undefined,
        recordArgs,
        instruction: blank
          ? "blankScout=true after polling — keep waiting / re-scout the SAME browser window. Do not open more Edge windows. Do not ask the user to open the product. Do not give up."
          : needsExplore
            ? "needsExplore=true — Phase A = full dry-run of the exact ask (demo_* automation, no capture). Phase B = new TAB + start_capture + same steps + regenerate_zooms. Do NOT record_and_build until Phase A is proven."
            : "STUDY the PNG. Then record_and_build(recordArgs). regenerate_zooms + peek_studio. User clicks Export.",
      },
      pngBase64,
    );
  },
);

server.registerTool(
  "record_and_build",
  {
    description:
      "Record+edit AFTER Phase A explore for whatever product the user asked. Sheets/Excel: OK after a ready-sheet scout PNG. All other products: ONLY after screenshots proved the path — prefer new-tab start_capture+demo_* over calling this blind. Auto zooms. User clicks Export.",
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
        .describe("Generate Edge TTS voiceover after build (default false — call generate_voiceover after)."),
      voiceoverLang: z
        .string()
        .optional()
        .describe("Voiceover/caption locale (default en-US). Non-English translates captions first."),
      voice: z.string().optional().describe("Edge Neural voice id (optional; picked for voiceoverLang)"),
      backgroundMusic: z
        .boolean()
        .optional()
        .describe("Pick an Openverse CC bed after build (default false — call pick_background_music after)."),
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
    const wantVoiceover = args.voiceover === true;
    const wantMusic = args.backgroundMusic === true;
    const voiceoverLang = args.voiceoverLang || "en-US";
    const musicQuery = args.musicQuery || defaultMusicQuery(args.productName);
    // Prefer product name over bare "Edge" — Edge window title is the *active tab*.
    // Matching "Edge" while Instagram is focused records Instagram.
    const titleNeedle = (() => {
      if (args.titleContains?.trim()) return args.titleContains.trim();
      if (args.productName?.trim() && !/^product$/i.test(args.productName)) {
        return args.productName.trim().slice(0, 32);
      }
      if (args.productUrl) {
        try {
          const host = new URL(args.productUrl).hostname.replace(/^www\./, "");
          const brand = host.split(".")[0];
          if (brand && brand !== "google" && brand !== "microsoft") return brand;
        } catch {
          /* ignore */
        }
      }
      return args.productUrl ? "Edge" : "Chrome";
    })();
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

    // 2) Ensure product browser window exists — open at most once, then wait (no window spam).
    if (!args.windowId) {
      const ensured = await ensureProductWindow({
        titleNeedle,
        productUrl: args.productUrl,
        openPath: args.openPath,
        productName: args.productName,
      });
      log.push(...ensured.log);
      if (!ensured.hit) {
        return textResult({
          ok: false,
          error: `No browser window titled like "${titleNeedle}" after open+wait. Keep waiting / retry — do not capture Claude chat or Instagram.`,
          titleNeedle,
          sampleTitles: ensured.targets
            .filter((t) => t.kind === "window" && !isChatOrIdeWindow(t.title || "", t.processName))
            .slice(0, 12)
            .map((t) => t.title),
          log,
        });
      }
      // Extra settle for heavy SPAs before capture
      // Wait until UI paints before capturing (critical for Canva / non-Sheets sites).
      const ready = await waitUntilPageReady({
        titleContains: titleNeedle,
        productUrl: args.productUrl,
      });
      log.push(...ready.log);
      if (!ready.ready) {
        return textResult({
          ok: false,
          error: `Product window found but page still blank after ${ready.elapsedMs}ms. Retry record_and_build — do not capture yet.`,
          titleNeedle,
          log,
        });
      }
    }

    // 3) Start native capture via the agent (closes picker, shows Recording…)
    const captureStartedAt = Date.now();
    const started = await agentCommand(
      "start_capture",
      {
        windowId: args.windowId,
        titleContains: args.windowId ? undefined : titleNeedle,
        showPicker: false, // already opened above
        surface: shareSurface,
      },
      25_000,
    );
    log.push({ start: started });
    if (
      started &&
      typeof started === "object" &&
      "ok" in started &&
      (started as { ok?: boolean }).ok === false
    ) {
      return textResult({
        ok: false,
        error:
          (started as { error?: string }).error ||
          `start_capture failed for titleContains="${titleNeedle}"`,
        titleNeedle,
        log,
      });
    }
    await sleep(400);

    const demo = await bridgePost(
      "/input/run",
      { steps },
      DEMO_FETCH_TIMEOUT_MS,
    );
    log.push({ demo });
    // Wall-clock end of real demo (before idle pad) — used to cut trailing lag.
    const demoEndedSec = (Date.now() - captureStartedAt) / 1000;

    // Keep takes tight: pad a little, then stop.
    const elapsedSec = demoEndedSec;
    const remainingPad = Math.max(0, Math.min(padSec, maxCaptureSec - elapsedSec));
    if (remainingPad > 0) await sleep(remainingPad * 1000);

    // Stop + import with disk recovery (long Canva encodes used to time out and leave No take loaded).
    const stopImport = await stopCaptureAndImport();
    log.push({ stopImport });
    await sleep(400);
    const stopped = stopImport.stopped;

    const dur =
      typeof stopped === "object" &&
      stopped &&
      "durationMs" in stopped &&
      typeof (stopped as { durationMs: unknown }).durationMs === "number"
        ? (stopped as { durationMs: number }).durationMs / 1000
        : Math.min(maxCaptureSec, elapsedSec + remainingPad);

    // Out-point just after the last real action (not the idle pad).
    const trimEnd = Math.min(dur, Math.max(1.2, demoEndedSec + 0.2));

    let autoZooms = 0;
    let cursorSamples = 0;
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
      const applied = await agentCommand("apply_recipe", { recipe });
      log.push({ apply_recipe: applied });
      if (applied && typeof applied === "object") {
        autoZooms = Number((applied as { autoZooms?: number }).autoZooms) || 0;
        cursorSamples = Number((applied as { cursorSamples?: number }).cursorSamples) || 0;
      }
      // Same as clicking “Regenerate auto zooms” in the app — ensures Auto mode punches land.
      const regen = await agentCommand("regenerate_zooms", {});
      log.push({ regenerate_zooms: regen });
      if (regen && typeof regen === "object") {
        autoZooms = Number((regen as { autoZooms?: number }).autoZooms) || autoZooms;
        cursorSamples = Number((regen as { cursorSamples?: number }).cursorSamples) || cursorSamples;
      }
      // Cut trailing dead air so export doesn't hang on empty seconds.
      const trimmed = await agentCommand("patch_trim", {
        start: 0,
        end: trimEnd,
        trimEndSlackSec: 0.3,
      });
      log.push({ patch_trim: trimmed, suggestedTrimEnd: trimEnd });
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
      // Make the studio look intentional (padding / wallpaper) — not a bare default.
      log.push(
        await agentCommand("apply_preset", {
          preset: args.preset ?? "vivid",
        }),
      );
      log.push(
        await agentCommand("patch_frame", {
          frame: { padding: 10, radius: 4 },
        }),
      );
      log.push(await agentCommand("focus_studio", {}));
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

    let productSkill: Record<string, unknown> = { saved: false };
    try {
      const skill = saveProductSkill({
        product: args.productName,
        url: args.productUrl,
        titleContains: titleNeedle,
        // Generic fallback steps are not a playbook — only keep steps the agent chose.
        steps: args.demoSteps && args.demoSteps.length >= 2 ? (args.demoSteps as SkillStep[]) : undefined,
        outcome: autoZooms > 0 ? `success (autoZooms=${autoZooms})` : "recorded (autoZooms=0)",
        source: "auto",
      });
      productSkill = { saved: true, product: skill.product, steps: skill.steps.length, takes: skill.takes };
    } catch (err) {
      productSkill = { saved: false, error: err instanceof Error ? err.message : String(err) };
    }

    return textResult({
      ok: true,
      productName: args.productName,
      productSkill,
      recordedSec: dur,
      maxCaptureSec,
      autoMode,
      autoZooms,
      cursorSamples,
      voiceover: wantVoiceover,
      voiceoverLang,
      backgroundMusic: wantMusic,
      demoSteps: steps.length,
      nextTool: "peek_studio",
      thenRemember: "remember_demo_lesson",
      message:
        autoZooms > 0
          ? `Recorded ~${dur.toFixed(1)}s · Auto zooms ×${autoZooms} · vivid polish. Call peek_studio, then remember_demo_lesson, then tell the user to click Export.`
          : `Recorded ~${dur.toFixed(1)}s but Auto zooms=0 (cursorSamples=${cursorSamples}). Call regenerate_zooms + peek_studio; remember what failed via remember_demo_lesson. User clicks Export.`,
      steps: log.length,
    });
  },
);

server.registerTool(
  "peek_studio",
  {
    description:
      "REQUIRED after record. Returns composed VIDEO FRAMES from the stage (cells, zooms, padding) as PNGs so you can SEE the take — not just window chrome. Call after record_and_build / regenerate_zooms.",
    inputSchema: {},
  },
  async () => {
    try {
      await bridgeGet("/health", 4_000);
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "Open Screen Beaver desktop (studio loaded) — not just the MCP link.",
      });
    }
    await agentCommand("focus_studio", {}, 8_000);
    await sleep(500);
    const status = await agentCommand("verify_take", {}, 12_000);
    const peek = (await agentCommand("peek_stage", {}, 45_000)) as {
      ok?: boolean;
      error?: string;
      frames?: { t: number; pngBase64: string }[];
      times?: number[];
      look?: unknown;
      message?: string;
    };
    const stageFrames = (peek?.frames ?? [])
      .map((f) => f?.pngBase64)
      .filter((b): b is string => typeof b === "string" && b.length > 80);

    // Fallback: OS window shot if stage render failed (still better than nothing).
    let windowPng: string | undefined;
    if (!stageFrames.length) {
      try {
        const qs = new URLSearchParams({ titleContains: "Screen Beaver" });
        const shot = (await bridgeGet(`/capture/window_shot?${qs}`, 12_000)) as {
          pngBase64?: string;
        };
        windowPng = shot?.pngBase64;
      } catch {
        /* ignore */
      }
    }

    const images = stageFrames.length ? stageFrames : windowPng ? [windowPng] : [];
    return scoutResult(
      {
        ok: images.length > 0,
        hasScreenshot: images.length > 0,
        source: stageFrames.length ? "stage_video_frames" : windowPng ? "window_shot" : "none",
        mustStudyScreenshot: true,
        frameTimes: peek?.times ?? [],
        status,
        look: peek?.look,
        peekError: peek?.ok === false ? peek.error : undefined,
        instruction:
          "STUDY every PNG frame. Confirm: sheet cells readable, Auto zooms on important beats, padding≈10, radius≈4, vivid wallpaper. If wrong → patch_frame({padding:10,radius:4}) / regenerate_zooms / re-record, then peek_studio again. Then tell the user to click Export.",
      },
      images,
    );
  },
);

server.registerTool(
  "get_agent_guide",
  {
    description: "Idle-watch + native capture workflow: record any window, build live, user clicks Export.",
    inputSchema: {},
  },
  async () => textResult(fullHarnessGuide(GUIDE)),
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
    description:
      "Add one manual zoom keyframe. For typing cells prefer regenerate_zooms after a take; use add_zoom to force a punch on a click that Auto missed.",
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
  "update_zoom",
  {
    description:
      "Tweak an existing zoom (time/scale/focus/followCursor). Use after peek_studio when a punch is late, weak, or off-target.",
    inputSchema: {
      id: z.string(),
      time: z.number().optional(),
      duration: z.number().optional(),
      scale: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      followCursor: z.boolean().optional(),
    },
  },
  async (args) => textResult(await agentCommand("update_zoom", args)),
);

server.registerTool(
  "remove_zoom",
  {
    description: "Delete one zoom keyframe by id (from studio_status / peek).",
    inputSchema: { id: z.string() },
  },
  async (args) => textResult(await agentCommand("remove_zoom", args)),
);

server.registerTool(
  "clear_auto_zooms",
  {
    description: "Remove all auto zooms; keep manual ones. Then add_zoom or regenerate_zooms.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("clear_auto_zooms", {})),
);

server.registerTool(
  "patch_trim",
  {
    description:
      "Set in/out points. Prefer trimEndSlackSec: 0.2–0.4 to cut trailing lag after the last click/type. Or pass start/end seconds.",
    inputSchema: {
      start: z.number().optional(),
      end: z.number().optional(),
      trimEndSlackSec: z
        .number()
        .optional()
        .describe("Keep this many seconds after last click/sound/caption, then cut"),
    },
  },
  async (args) => textResult(await agentCommand("patch_trim", args)),
);

server.registerTool(
  "patch_frame",
  {
    description: "Adjust stage frame padding/radius (default padding 10, radius 4).",
    inputSchema: {
      padding: z.number().optional(),
      radius: z.number().optional(),
      shadow: z.number().optional(),
    },
  },
  async (args) => textResult(await agentCommand("patch_frame", args)),
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
    description:
      "Rebuild Auto zooms: typing locks the field (priority 1); clicks punch in *before* the click (priority 2). Call after record or after clearing bad zooms.",
    inputSchema: {},
  },
  async () => textResult(await agentCommand("regenerate_zooms")),
);

server.registerTool(
  "get_demo_skill",
  {
    description:
      "Call FIRST in every session. Returns the growing demo skill for this PC (Hermes-style): general lessons, the list of product skills, and — when `product` is given — that product's proven playbook (exact steps + gotchas) to replay.",
    inputSchema: {
      product: z
        .string()
        .optional()
        .describe("Product or the user's ask, e.g. 'Canva' or 'Canva Instagram post demo'"),
    },
  },
  async ({ product }) => {
    const seeded = ensureGrowingSkillSeeded();
    const skill = findProductSkill(product);
    return textResult({
      path: growingSkillPath(),
      lessonCount: seeded.count,
      seeded: seeded.seeded,
      productSkill: skill
        ? { found: true, markdown: renderProductSkill(skill), steps: skill.steps, gotchas: skill.gotchas }
        : product
          ? {
              found: false,
              note: `No playbook for "${product}" yet — explore (Phase A). One is saved automatically when the take is recorded.`,
            }
          : undefined,
      skill: renderGrowingMarkdown(),
      hint: "After every take: save_product_skill (exact steps + gotchas) and remember_demo_lesson (general notes). That is how this skill grows.",
    });
  },
);

server.registerTool(
  "save_product_skill",
  {
    description:
      "Save/refine the playbook for one product after a take (Hermes-style skill). steps = the exact run_demo steps that worked (op, contentNx/contentNy or nx/ny, text, ms). gotchas = short things to avoid. Next time get_demo_skill/make_product_tutorial returns it so the demo is replayed instead of re-explored.",
    inputSchema: {
      product: z.string().describe("Product name, e.g. 'Canva'"),
      url: z.string().optional().describe("Start URL that worked"),
      titleContains: z.string().optional().describe("Window title match that worked"),
      steps: z.array(demoStepSchema).optional().describe("Exact proven steps in order"),
      gotchas: z.array(z.string()).optional().describe("Short lessons, e.g. 'Wait 3s after Create design'"),
      outcome: z
        .string()
        .optional()
        .describe("e.g. 'success' or 'failed: zooms missing' — counts toward this product's take history"),
    },
  },
  async (args) => {
    try {
      const skill = saveProductSkill({
        ...args,
        steps: args.steps as SkillStep[] | undefined,
        source: "agent",
      });
      return textResult({
        ok: true,
        product: skill.product,
        steps: skill.steps.length,
        gotchas: skill.gotchas.length,
        takes: skill.takes,
        successes: skill.successes,
      });
    } catch (err) {
      return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
);

server.registerTool(
  "remember_demo_lesson",
  {
    description:
      "Append a lesson from this take (what worked / failed for zooms, clicks, typing, trim). Grows the harness for Claude, BetterClaw, and Cursor.",
    inputSchema: {
      lesson: z
        .string()
        .describe("Concrete note, e.g. 'Sheets: zoom before click on formula bar; trimEndSlackSec 0.3'"),
      product: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    try {
      return textResult(rememberLesson(args));
    } catch (err) {
      return textResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
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
      description: "Idle-watch Screen Beaver agent guide + growing lessons",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "screen-beaver://guide",
          text: fullHarnessGuide(GUIDE),
          mimeType: "text/markdown",
        },
      ],
    }),
  );

  server.registerResource(
    "growing-skill",
    "screen-beaver://growing-skill",
    {
      description:
        "Learned demo lessons on this PC — inject into Claude / BetterClaw / Cursor harness",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "screen-beaver://growing-skill",
          text: renderGrowingMarkdown(),
          mimeType: "text/markdown",
        },
      ],
    }),
  );

  return server;
}

const DEFAULT_HTTP_PORT = 17356;

function parseCliArgs(argv: string[]) {
  const flags = new Set(argv);
  const http =
    flags.has("--http") ||
    process.env.SCREEN_BEAVER_MCP_TRANSPORT?.toLowerCase() === "http";

  let port = Number(process.env.SCREEN_BEAVER_MCP_PORT ?? DEFAULT_HTTP_PORT);
  const portIdx = argv.indexOf("--port");
  if (portIdx >= 0 && argv[portIdx + 1]) {
    port = Number(argv[portIdx + 1]);
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port: ${port}`);
  }

  let token = process.env.SCREEN_BEAVER_MCP_TOKEN?.trim() || "";
  const tokenIdx = argv.indexOf("--token");
  if (tokenIdx >= 0 && argv[tokenIdx + 1]) {
    token = argv[tokenIdx + 1].trim();
  }

  return {
    http,
    port,
    token,
  };
}

function secretMatches(gotRaw: string | null | undefined, expected: string): boolean {
  if (!gotRaw || !expected) return false;
  const got = Buffer.from(gotRaw.trim());
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** Bearer header (BetterClaw) or ?token= (Claude.ai / clients without custom headers). */
function requestAuthorized(
  authorization: string | undefined,
  url: URL,
  expected: string,
): boolean {
  if (secretMatches(url.searchParams.get("token"), expected)) return true;
  if (!authorization) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return secretMatches(m?.[1], expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "screen-beaver-mcp" });
    return;
  }

  if (path !== "/mcp") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!requestAuthorized(req.headers.authorization, url, token)) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Unauthorized — pass Authorization: Bearer <token> or ?token=<token> on the MCP URL.",
      },
      id: null,
    });
    return;
  }

  const server = createScreenBeaverMcpServer();
  // JSON (not SSE) so Claude.ai's connector check / mcp-proxy accept the response.
  // Without this, initialize returns text/event-stream and Claude often shows 502.
  const transport = withClientCompat(
    new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    }),
  );
  try {
    await server.connect(transport);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP HTTP request failed:", err);
    void transport.close();
    void server.close();
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

async function startHttpServer(port: number, token: string) {
  if (!token) {
    console.error(
      "HTTP mode requires --token <secret> (long random). Refusing to listen.",
    );
    process.exit(1);
  }

  const httpServer = createServer((req, res) => {
    void handleMcpHttpRequest(req, res, token);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "EADDRINUSE"
          ? `Port ${port} already in use — close the other Screen Beaver MCP / node process, then retry.`
          : err.message;
      console.error(`MCP HTTP listen failed: ${msg}`);
      reject(new Error(msg));
    });
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });

  console.error(`Screen Beaver MCP (Streamable HTTP) on http://127.0.0.1:${port}/mcp`);
  console.error(`Health: http://127.0.0.1:${port}/health`);
  console.error(
    "Tunnel example: cloudflared tunnel --url http://127.0.0.1:" + port,
  );
  console.error(
    "BetterClaw: https://<tunnel-host>/mcp + Authorization: Bearer <token>",
  );
  console.error(
    "Claude.ai (no request headers): https://<tunnel-host>/mcp?token=<token> — auth: No sign-in",
  );
  console.error("Keep Screen Beaver desktop open (bridge http://127.0.0.1:17355).");

  const shutdown = () => {
    console.error("Shutting down MCP HTTP server…");
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const { http, port, token } = parseCliArgs(process.argv.slice(2));
  if (http) {
    try {
      await startHttpServer(port, token);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
  const server = createScreenBeaverMcpServer();
  const transport = withClientCompat(new StdioServerTransport());
  await server.connect(transport);
}

await main();
