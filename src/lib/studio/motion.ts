import type {
  CaretSample,
  CameraMove,
  CameraMoveKind,
  CameraPosition,
  CameraSettings,
  CursorSample,
  CursorShape,
  ZoomKeyframe,
} from "./types";
import { cursorStaysVisibleWhenIdle } from "./cursorShapes";

export interface CursorFrame {
  x: number;
  y: number;
  speed: number;
  down: boolean;
  /** False when no pointer sample is near this time (e.g. user left for Excel). */
  active: boolean;
  /** 0..1 — fades when idle if auto-hide is enabled. */
  opacity: number;
  shape: CursorShape;
  iconId?: string;
}

export interface CursorTrack {
  get(t: number): CursorFrame;
  clicks: { t: number; x: number; y: number }[];
  duration: number;
  isEmpty: boolean;
}

const SAMPLE_RATE = 120;
/** Don't draw / follow the custom cursor across gaps larger than this. */
const ACTIVE_GAP = 0.35;
const IDLE_SPEED = 0.028;
/** How long the cursor must sit still before the hide animation begins. */
const IDLE_BEFORE_FADE = 0.85;
/** Length of the fade + shrink animation. */
const IDLE_FADE_DUR = 0.55;
/** Raw-sample stillness window — hides even while spring settles. */
const STILL_WINDOW = 0.45;
const STILL_EPS = 0.004;

function easeInOut(p: number) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function nearestSampleIndex(samples: CursorSample[], t: number): number {
  if (samples.length === 0) return -1;
  if (t <= samples[0].t) return 0;
  const last = samples.length - 1;
  if (t >= samples[last].t) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[lo].t - t) <= Math.abs(samples[hi].t - t) ? lo : hi;
}

function isActiveAt(samples: CursorSample[], t: number): boolean {
  const i = nearestSampleIndex(samples, t);
  if (i < 0) return false;
  return Math.abs(samples[i].t - t) <= ACTIVE_GAP;
}

function sampleAt(samples: CursorSample[], t: number): CursorSample {
  if (samples.length === 0) return { t, x: 0.5, y: 0.5, down: false, shape: "arrow" };
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  // Don't interpolate across tracking gaps — hold the nearer sample.
  if (b.t - a.t > ACTIVE_GAP * 2) {
    return t - a.t <= b.t - t ? a : b;
  }
  const p = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return {
    t,
    x: lerp(a.x, b.x, p),
    y: lerp(a.y, b.y, p),
    down: a.down || b.down,
    shape: (p < 0.5 ? a.shape : b.shape) ?? a.shape ?? b.shape ?? "arrow",
    iconId: (p < 0.5 ? a.iconId : b.iconId) ?? a.iconId ?? b.iconId,
  };
}

/**
 * Critically-damped spring resampling of the raw pointer trail.
 * This is the "smooth cursor sway": raw OS/pointer samples are noisy and
 * linear, the spring gives weighted, eased motion that always trails slightly
 * behind the real position and glides through direction changes.
 */
export function buildCursorTrack(
  samples: CursorSample[],
  duration: number,
  smoothing: number,
  autoHideIdle = true,
): CursorTrack {
  const clean = [...samples].sort((a, b) => a.t - b.t);
  const clicks: { t: number; x: number; y: number }[] = [];
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].down && !clean[i - 1].down) {
      clicks.push({ t: clean[i].t, x: clean[i].x, y: clean[i].y });
    }
  }

  const total = Math.max(duration, clean.length ? clean[clean.length - 1].t : 0);
  const n = Math.max(2, Math.ceil(total * SAMPLE_RATE) + 1);
  const dt = 1 / SAMPLE_RATE;

  // smoothing 0 => stiff (nearly raw), 100 => long, floaty glide
  const s = Math.min(100, Math.max(0, smoothing)) / 100;
  // Soft spring + damping = weighted glide
  const k = lerp(1600, 36, s);
  const c = 2 * Math.sqrt(k) * lerp(1.08, 1.28, s);

  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const sp = new Float32Array(n);
  const active = new Uint8Array(n);
  const op = new Float32Array(n);
  const first = sampleAt(clean, 0);
  let px = first.x;
  let py = first.y;
  let vx = 0;
  let vy = 0;
  let wasActive = isActiveAt(clean, 0);
  let idleFor = 0;

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const on = isActiveAt(clean, t);
    active[i] = on ? 1 : 0;
    const target = sampleAt(clean, t);
    if (on && !wasActive) {
      // Snap when tracking resumes after a gap (switched back from another app).
      px = target.x;
      py = target.y;
      vx = 0;
      vy = 0;
      idleFor = 0;
    }
    wasActive = on;
    if (!on) {
      xs[i] = px;
      ys[i] = py;
      sp[i] = 0;
      op[i] = 0;
      idleFor = 0;
      continue;
    }
    const ax = k * (target.x - px) - c * vx;
    const ay = k * (target.y - py) - c * vy;
    vx += ax * dt;
    vy += ay * dt;
    // Clamp runaway velocity from noisy samples.
    const vmax = lerp(5.5, 1.45, s);
    const speed = Math.hypot(vx, vy);
    if (speed > vmax) {
      vx = (vx / speed) * vmax;
      vy = (vy / speed) * vmax;
    }
    px += vx * dt;
    py += vy * dt;
    xs[i] = px;
    ys[i] = py;
    const spd = Math.hypot(vx, vy);
    sp[i] = spd;

    // Stillness: raw samples barely moved recently (static cursor on a cell / UI)
    const stillRef = sampleAt(clean, Math.max(0, t - STILL_WINDOW));
    const rawStill =
      Math.hypot(target.x - stillRef.x, target.y - stillRef.y) < STILL_EPS && !target.down;

    if (target.shape === "hidden") {
      idleFor = 0;
      op[i] = 0;
    } else if (
      !autoHideIdle ||
      target.down ||
      spd > IDLE_SPEED ||
      !rawStill ||
      cursorStaysVisibleWhenIdle(target.shape)
    ) {
      idleFor = 0;
      op[i] = 1;
    } else {
      idleFor += dt;
      if (idleFor <= IDLE_BEFORE_FADE) op[i] = 1;
      else {
        const u = Math.min(1, (idleFor - IDLE_BEFORE_FADE) / IDLE_FADE_DUR);
        // Ease-out hide — starts slow, finishes clean
        op[i] = Math.max(0, 1 - easeInOut(u));
      }
    }
  }

  return {
    duration: total,
    isEmpty: clean.length < 2,
    clicks,
    get(t: number) {
      const idx = Math.min(n - 1, Math.max(0, t * SAMPLE_RATE));
      const i0 = Math.floor(idx);
      const i1 = Math.min(n - 1, i0 + 1);
      const f = idx - i0;
      const raw = sampleAt(clean, t);
      return {
        x: lerp(xs[i0], xs[i1], f),
        y: lerp(ys[i0], ys[i1], f),
        speed: lerp(sp[i0], sp[i1], f),
        down: raw.down,
        active: active[i0] === 1 || active[i1] === 1,
        opacity: lerp(op[i0], op[i1], f),
        shape: raw.shape ?? "arrow",
        iconId: raw.iconId,
      };
    },
  };
}

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
  weight: number;
}

export interface ZoomEvalOptions {
  /** When false, zooms are ignored. */
  enabled?: boolean;
  /** Stage width/height aspect (e.g. 9/16 for vertical). */
  stageAspect?: number;
  /** Capture content aspect before letterboxing. */
  contentAspect?: number;
  /** Cursor track lookup — enables the lazy (trailing) follow camera. */
  cursorAt?: (t: number) => CursorFrame;
}

/**
 * Evaluates the zoom track: eased punch-in, hold, eased pull-out.
 * In vertical (portrait) layouts, scale/focus are adapted so action fills the frame.
 */
export function evalZoom(
  zooms: ZoomKeyframe[],
  t: number,
  cursor: CursorFrame,
  opts: ZoomEvalOptions = {},
): ZoomState {
  if (opts.enabled === false) return { scale: 1, x: 0.5, y: 0.5, weight: 0 };

  // Overlapping zooms crossfade: the camera pans between targets while staying zoomed
  // instead of pulling out and punching back in.
  let sumW = 0;
  let sumS = 0;
  let sumX = 0;
  let sumY = 0;
  let lazy: { x: number; y: number } | null | undefined;
  for (const z of zooms) {
    if (t < z.time || t > z.time + z.duration) continue;
    const ramp = zoomRamp(z);
    const local = t - z.time;
    let w: number;
    if (local < ramp) w = easeZoom(local / ramp);
    else if (local > z.duration - ramp) w = easeZoom(Math.max(0, (z.duration - local) / ramp));
    else w = 1;
    if (w <= 1e-4) continue;
    const follow = z.followCursor;
    const caret = z.caretProgress ?? 0;
    let fx = z.x;
    let fy = z.y;
    if (lazy === undefined) lazy = opts.cursorAt ? lazyCursor(opts.cursorAt, t) : null;
    const live = cursor.active || cursor.opacity > 0.02;
    const cx = lazy ? lazy.x : live ? cursor.x : z.x;
    const cy = lazy ? lazy.y : live ? cursor.y : z.y;
    const path = z.caretPath;

    if (path && path.length && t >= path[0]!.t - CARET_LEAD_IN) {
      // Typing: the camera rides the text caret, not the mouse.
      let bx = z.x;
      let by = z.y;
      if (follow) {
        const settle = easeZoom((local - ramp) / FOLLOW_SETTLE);
        bx = lerp(z.x, cx, settle);
        by = lerp(z.y, cy, settle);
      }
      const c = caretAt(path, t);
      const cw = easeZoom((t - (path[0]!.t - CARET_LEAD_IN)) / CARET_LEAD_IN);
      fx = lerp(bx, c.x, cw);
      fy = lerp(by, c.y, cw);
    } else if (follow) {
      // Fly straight to the target during the zoom-in, then trail the smoothed pointer.
      const settle = easeZoom((local - ramp) / FOLLOW_SETTLE);
      fx = lerp(z.x, cx, settle);
      fy = lerp(z.y, cy, settle);
      if (caret > 0) {
        // Extra drift along the typing line while keys land.
        const u = easeInOut(
          Math.min(1, Math.max(0, local - ramp * 0.5) / Math.max(0.35, z.duration - ramp)),
        );
        fx = Math.min(0.94, fx + caret * u);
      } else if (cursor.shape === "ibeam") {
        fx = Math.min(0.94, fx + 0.03);
      }
    } else if (caret > 0) {
      const holdStart = ramp;
      const holdEnd = Math.max(holdStart + 0.05, z.duration - ramp);
      const u =
        local <= holdStart
          ? 0
          : local >= holdEnd
            ? 1
            : easeInOut((local - holdStart) / (holdEnd - holdStart));
      fx = Math.min(0.94, z.x + caret * u);
    }
    sumW += w;
    sumS += w * (z.scale - 1);
    sumX += w * (fx - 0.5);
    sumY += w * (fy - 0.5);
  }

  const norm = sumW > 1 ? 1 / sumW : 1;
  const best: ZoomState = {
    scale: 1 + sumS * norm,
    x: 0.5 + sumX * norm,
    y: 0.5 + sumY * norm,
    weight: Math.min(1, sumW),
  };
  return adaptZoomForPortrait(best, opts.stageAspect, opts.contentAspect);
}

/** Zoom-in / zoom-out length — long, gentle ramps like Screen Studio. */
const ZOOM_RAMP = 1.0;
/** Camera starts drifting toward the caret this long before the first typed key. */
const CARET_LEAD_IN = 0.6;
/** After arriving on target, how long the camera takes to hand over to pointer follow. */
const FOLLOW_SETTLE = 0.8;

export function zoomRamp(z: { duration: number }): number {
  return Math.min(ZOOM_RAMP, Math.max(0.3, z.duration * 0.4));
}

/** Sine ease — lower peak speed than cubic, so zooms glide rather than snap. */
function easeZoom(p: number): number {
  const u = Math.min(1, Math.max(0, p));
  return 0.5 - 0.5 * Math.cos(Math.PI * u);
}

/** Trailing weighted average of the pointer (~0.5s) for a camera that lags softly behind. */
function lazyCursor(
  cursorAt: (t: number) => CursorFrame,
  t: number,
): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = 0; i < 8; i++) {
    const f = cursorAt(Math.max(0, t - i * 0.07));
    if (!f.active && f.opacity <= 0.02) continue;
    const w = 1 - i / 9;
    sx += f.x * w;
    sy += f.y * w;
    sw += w;
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}

function caretPointAt(path: CaretSample[], t: number): { x: number; y: number } {
  if (t <= path[0]!.t) return path[0]!;
  const last = path[path.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = path[lo]!;
  const b = path[hi]!;
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
}

/** Low-passed caret position so line wraps / per-char steps pan smoothly. */
function caretAt(path: CaretSample[], t: number): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = -2; i <= 7; i++) {
    const p = caretPointAt(path, t - i * 0.07);
    const w = 1 - Math.abs(i) / 9;
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

/**
 * 0..1 how hard a zoom is currently animating (ramp in/out).
 * Used for motion blur while changing focus / tabs.
 */
export function zoomMotionStrength(zooms: ZoomKeyframe[], t: number, enabled = true): number {
  if (!enabled) return 0;
  let best = 0;
  for (const z of zooms) {
    if (t < z.time || t > z.time + z.duration) continue;
    const ramp = zoomRamp(z);
    const local = t - z.time;
    let m = 0;
    if (local < ramp) m = Math.sin((local / ramp) * Math.PI);
    else if (local > z.duration - ramp) m = Math.sin(((z.duration - local) / ramp) * Math.PI);
    best = Math.max(best, m);
  }
  // Stays under the compositor's ghosting threshold — zooms read crisp, no sudden smear.
  return best * 0.12;
}

/** 0..1 motion during an active camera arc / orbit / dip. */
export function cameraMotionStrength(moves: CameraMove[], t: number): number {
  let best = 0;
  for (const m of moves) {
    if (t < m.time || t > m.time + m.duration) continue;
    const p = (t - m.time) / Math.max(1e-6, m.duration);
    best = Math.max(best, Math.sin(p * Math.PI));
  }
  return best * 0.32;
}

/** Boost + reframe zooms when exporting / previewing vertical. */
export function adaptZoomForPortrait(
  zoom: ZoomState,
  stageAspect?: number,
  contentAspect?: number,
): ZoomState {
  if (!stageAspect || stageAspect >= 0.95 || zoom.scale <= 1.001) return zoom;
  const content = contentAspect && contentAspect > 0 ? contentAspect : 16 / 9;
  // How much taller the canvas is vs the capture window
  const mismatch = Math.max(1, content / stageAspect);
  const boost = Math.min(1.55, 1 + (mismatch - 1) * 0.2);
  return {
    scale: Math.min(3.6, 1 + (zoom.scale - 1) * boost),
    // Keep action readable in the social “upper-middle” band
    x: lerp(zoom.x, 0.5, 0.14),
    y: lerp(zoom.y, 0.42, 0.2),
    weight: zoom.weight,
  };
}

/** Interest scoring: not every click deserves a zoom. */
type ClickPt = { t: number; x: number; y: number };

/** How hard this beat should punch in — driven by what the user is doing. */
type BeatKind =
  | "glance"
  | "tour"
  | "feature"
  | "detail"
  | "spotlight"
  | "orbit"
  | "typing"
  | "menu"
  | "reveal";

type InterestBeat = {
  clicks: ClickPt[];
  t0: number;
  t1: number;
  x: number;
  y: number;
  spread: number;
  dwell: number;
  approach: number;
  score: number;
  /** When set, skips heuristic classify (typing / menu / orbit / reveal). */
  kindHint?: BeatKind;
  /** Cursor traveled to a new region after the click (open pane → interact). */
  travel?: number;
  /** Text-caret samples while typing this beat. */
  caretPath?: CaretSample[];
};

/**
 * Natural zoom strengths — soft for single clicks; typing / menus punch harder
 * so small text stays readable. `autoScale` bias shifts this whole ladder.
 */
const KIND_SCALE: Record<BeatKind, number> = {
  glance: 1.42,
  tour: 1.58,
  feature: 1.62,
  detail: 1.85,
  spotlight: 1.95,
  orbit: 1.6,
  typing: 2.05,
  menu: 2.12,
  reveal: 1.75,
};

function classifyBeat(beat: InterestBeat): BeatKind {
  if (beat.kindHint) return beat.kindHint;
  const { spread, dwell, clicks, score, approach, travel = 0 } = beat;
  const n = clicks.length;

  if (travel >= 0.12 && dwell >= 0.45) return "reveal";
  if (dwell >= 1.25 && spread < 0.09 && n <= 2) return "spotlight";
  if (spread < 0.1 && dwell >= 0.7 && approach < 0.3) return "detail";
  if (spread < 0.12 && dwell >= 0.9) return "detail";
  if (spread >= 0.18 || (n >= 3 && spread >= 0.14) || travel >= 0.2) return "tour";
  // Lonely / quick single click — soft glance, never a hard punch.
  if (n === 1 && travel < 0.1 && (dwell < 0.85 || score < 1.75)) return "glance";
  if (score < 1.55 || (dwell < 0.65 && n === 1 && travel < 0.1)) return "glance";
  return "feature";
}

/**
 * Per-section scale: kind picks the personality, `autoScale` bias shifts the whole range.
 * Manual zooms ignore this and keep whatever the user set.
 */
function scaleForBeat(kind: BeatKind, bias: number): number {
  const natural = KIND_SCALE[kind];
  const neutral = 1.85;
  const b = Math.min(2.6, Math.max(1.5, bias));
  const scaled = natural * (b / neutral);
  // Soft floor for clicks; typing/menu may reach ~2.1–2.2× under a high bias.
  const lo =
    kind === "glance"
      ? 1.32
      : kind === "feature" || kind === "tour" || kind === "orbit" || kind === "reveal"
        ? 1.45
        : 1.55;
  const hi =
    kind === "typing" || kind === "menu"
      ? 2.2
      : kind === "spotlight" || kind === "detail"
        ? 2.1
        : kind === "glance"
          ? 1.65
          : 1.9;
  return Math.min(hi, Math.max(lo, Math.round(scaled * 100) / 100));
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

/** Average cursor speed over [t0, t1]. */
function meanSpeed(track: CursorTrack, t0: number, t1: number): number {
  const a = Math.max(0, t0);
  const b = Math.max(a + 0.05, Math.min(track.duration, t1));
  let sum = 0;
  let n = 0;
  for (let t = a; t <= b; t += 1 / 30) {
    const f = track.get(t);
    if (!f.active) continue;
    sum += f.speed;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * How long the cursor stays near (x,y) after `from` — the “hold on the UI” beat
 * that makes a punch-in feel intentional.
 */
function dwellNear(
  track: CursorTrack,
  from: number,
  x: number,
  y: number,
  radius = 0.09,
  maxLook = 2.4,
): number {
  const end = Math.min(track.duration, from + maxLook);
  let dwell = 0;
  let seen = false;
  for (let t = from; t <= end; t += 1 / 30) {
    const f = track.get(t);
    if (!f.active) {
      if (seen) break;
      continue;
    }
    if (dist2(f.x, f.y, x, y) <= radius && f.speed < 0.12) {
      dwell += 1 / 30;
      seen = true;
    } else if (seen && dist2(f.x, f.y, x, y) > radius * 1.6) {
      break;
    }
  }
  return dwell;
}

/**
 * After a click, find where the cursor settles (open button → pane content).
 * Returns travel distance + destination dwell when the pointer leaves the click
 * and hangs somewhere else — the classic reveal / side-panel tour.
 */
function destinationAfterClick(
  track: CursorTrack,
  clickT: number,
  clickX: number,
  clickY: number,
): { x: number; y: number; travel: number; dwell: number; settleT: number } | null {
  const lookEnd = Math.min(track.duration, clickT + 2.8);
  let leftClick = false;
  let settleX = clickX;
  let settleY = clickY;
  let settleT = clickT;
  let stillRun = 0;

  for (let t = clickT + 0.05; t <= lookEnd; t += 1 / 30) {
    const f = track.get(t);
    if (!f.active) continue;
    const d = dist2(f.x, f.y, clickX, clickY);
    if (!leftClick) {
      if (d > 0.1) leftClick = true;
      else continue;
    }
    if (f.speed < 0.1) {
      stillRun += 1 / 30;
      if (stillRun >= 0.28) {
        settleX = f.x;
        settleY = f.y;
        settleT = t - stillRun;
        break;
      }
    } else {
      stillRun = 0;
    }
  }

  if (!leftClick) return null;
  const travel = dist2(settleX, settleY, clickX, clickY);
  if (travel < 0.1) return null;
  const dwell = dwellNear(track, settleT, settleX, settleY, 0.11, 2.2);
  if (dwell < 0.4) return null;
  return { x: settleX, y: settleY, travel, dwell, settleT };
}

/** Spatial+temporal clusters — marching across the UI stays separate beats. */
function clusterClicks(clicks: ClickPt[]): ClickPt[][] {
  const clusters: ClickPt[][] = [];
  let cur: ClickPt[] = [];
  for (const c of clicks) {
    if (!cur.length) {
      cur = [c];
      continue;
    }
    const prev = cur[cur.length - 1]!;
    const dt = c.t - prev.t;
    const d = dist2(c.x, c.y, prev.x, prev.y);
    // Spreadsheet / form field hop — new beat so Auto can follow each cell.
    if (d > 0.05 || dt > 1.25 || (d > 0.2 && dt > 0.55)) {
      clusters.push(cur);
      cur = [c];
    } else {
      cur.push(c);
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

function scoreInterestBeat(track: CursorTrack, clicks: ClickPt[]): InterestBeat | null {
  if (!clicks.length) return null;
  const t0 = clicks[0]!.t;
  const t1 = clicks[clicks.length - 1]!.t;
  let sx = 0;
  let sy = 0;
  for (const c of clicks) {
    sx += c.x;
    sy += c.y;
  }
  const x = sx / clicks.length;
  const y = sy / clicks.length;
  let spread = 0;
  for (const c of clicks) spread = Math.max(spread, dist2(c.x, c.y, x, y));

  const dwellAtClick = dwellNear(track, t1, x, y);
  const dest = destinationAfterClick(track, t1, x, y);
  const travel = dest?.travel ?? 0;
  // Prefer destination dwell when the pointer left the click for a pane / panel.
  const dwell = dest && dest.dwell > dwellAtClick ? dest.dwell : dwellAtClick;
  const approach = meanSpeed(track, t0 - 0.55, t0 - 0.05);

  // Intentional demo beat vs fly-by / frantic clicking.
  let score = 0;
  score += Math.min(1.2, clicks.length * 0.35);
  score += Math.min(1.5, dwell * 1.05);
  score += (1 - Math.min(1, approach / 0.75)) * 0.85;
  if (spread < 0.1) score += 0.45;
  else if (spread < 0.18) score += 0.2;
  else if (spread > 0.32) score -= 0.9;

  // Lonely tap-and-go: clicked and left — usually nav chrome, not a feature callout.
  // Exception: traveled to a new region and lingered (button → opened pane).
  if (clicks.length === 1 && dwellAtClick < 0.55) {
    if (dest && dest.dwell >= 0.4 && travel >= 0.1) score += 1.15;
    else score -= 1.35;
  }
  // Rapid multi-click spray across the screen (selecting cells, closing dialogs…).
  if (clicks.length >= 3 && spread > 0.28 && dwell < 0.45) score -= 1.0;
  // Still hovering the same control after the click = textbook punch-in.
  if (dwellAtClick >= 0.85 && spread < 0.14) score += 0.4;
  if (dest && travel >= 0.12) score += Math.min(0.7, travel * 1.4 + dest.dwell * 0.25);

  // Sidebars / rail chrome — left or right strip clicks rarely deserve a punch-in.
  // Soften when the cursor then settles in the content area (opened a panel).
  const settledInContent = dest && dest.x > 0.18 && dest.x < 0.82;
  if ((x < 0.11 || x > 0.9) && !settledInContent) score -= 1.25;
  if ((x < 0.16 || x > 0.86) && !settledInContent) score -= 0.45;
  // Top browser chrome / tab strip.
  if (y < 0.08) score -= 1.1;

  return { clicks, t0, t1, x, y, spread, dwell, approach, score, travel };
}

/**
 * Click opens UI → pointer glides into the new pane and hangs there.
 * Zoom starts on the approach (before the click), then followCursor tracks into the reveal.
 */
function findRevealBeats(track: CursorTrack): InterestBeat[] {
  const out: InterestBeat[] = [];
  for (const c of track.clicks) {
    if (c.t < 0.35) continue;
    const dest = destinationAfterClick(track, c.t, c.x, c.y);
    if (!dest) continue;
    if (dest.travel < 0.11 || dest.dwell < 0.45) continue;
    // Skip pure chrome escapes with no content settle.
    if (dest.x < 0.06 || dest.x > 0.94 || dest.y < 0.05 || dest.y > 0.95) continue;

    const t1 = Math.min(track.duration, dest.settleT + dest.dwell);
    out.push({
      clicks: [c],
      t0: Math.max(0, c.t - 0.45),
      t1,
      // Anchor on the click so punch-in starts there; followCursor carries to the pane.
      x: c.x,
      y: c.y,
      spread: dest.travel,
      dwell: dest.dwell,
      approach: meanSpeed(track, c.t - 0.4, c.t),
      score: 2.2 + Math.min(0.55, dest.travel) + Math.min(0.4, dest.dwell * 0.3),
      kindHint: "reveal",
      travel: dest.travel,
    });
  }
  out.sort((a, b) => b.score - a.score);
  const kept: InterestBeat[] = [];
  for (const b of out) {
    if (kept.some((k) => b.t0 < k.t1 && k.t0 < b.t1)) continue;
    kept.push(b);
  }
  return kept;
}

/**
 * Soft follow-zoom when the cursor orbits / circles a region (showing something off
 * without discrete clicks).
 */
function findOrbitBeats(track: CursorTrack, duration: number): InterestBeat[] {
  if (track.isEmpty || duration < 1.2) return [];
  const out: InterestBeat[] = [];
  const step = 0.2;
  const win = 1.35;

  for (let t0 = 0.4; t0 + win < duration; t0 += step) {
    const t1 = t0 + win;
    let sx = 0;
    let sy = 0;
    let n = 0;
    let path = 0;
    let prev: { x: number; y: number } | null = null;
    let angleAccum = 0;
    let prevAngle: number | null = null;
    let clickHits = 0;

    for (let t = t0; t <= t1; t += 1 / 24) {
      const f = track.get(t);
      if (!f.active || f.opacity < 0.2) continue;
      sx += f.x;
      sy += f.y;
      n++;
      if (prev) {
        const dx = f.x - prev.x;
        const dy = f.y - prev.y;
        path += Math.hypot(dx, dy);
        if (Math.hypot(dx, dy) > 0.002) {
          const ang = Math.atan2(dy, dx);
          if (prevAngle != null) {
            let d = ang - prevAngle;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            angleAccum += d;
          }
          prevAngle = ang;
        }
      }
      prev = { x: f.x, y: f.y };
    }
    if (n < 12) continue;
    const cx = sx / n;
    const cy = sy / n;
    // Skip sidebar orbits.
    if (cx < 0.12 || cx > 0.88) continue;

    let spread = 0;
    for (let t = t0; t <= t1; t += 1 / 24) {
      const f = track.get(t);
      if (!f.active) continue;
      spread = Math.max(spread, dist2(f.x, f.y, cx, cy));
    }
    for (const c of track.clicks) {
      if (c.t >= t0 && c.t <= t1) clickHits++;
    }

    const displacement = prev ? dist2(prev.x, prev.y, cx, cy) : 0;
    const loopiness = path / Math.max(0.04, displacement + 0.02);
    const turns = Math.abs(angleAccum) / (Math.PI * 2);

    // Circling: lots of path, stays local, meaningful rotation, few hard clicks.
    if (loopiness < 2.8 || spread > 0.22 || spread < 0.04 || turns < 0.35 || clickHits > 2) {
      continue;
    }

    out.push({
      clicks: [{ t: t0 + win * 0.35, x: cx, y: cy }],
      t0,
      t1,
      x: cx,
      y: cy,
      spread,
      dwell: win * 0.6,
      approach: 0.2,
      score: 1.35 + Math.min(0.6, turns * 0.4) + Math.min(0.4, loopiness * 0.08),
      kindHint: "orbit",
    });
  }

  // Dedupe overlapping orbit windows — keep highest score.
  out.sort((a, b) => b.score - a.score);
  const kept: InterestBeat[] = [];
  for (const b of out) {
    if (kept.some((k) => b.t0 < k.t1 && k.t0 < b.t1)) continue;
    kept.push(b);
  }
  return kept;
}

export type AutoZoomHints = {
  /** Timeline typing SFX from the recording — strongest signal for caret follow. */
  typingClips?: { time: number; duration: number }[];
  /** Extra key-down times (native / demo) when typing SFX clips are sparse. */
  keyTimes?: number[];
  /** Real text-caret positions — typing zooms lock onto these over the mouse. */
  caret?: CaretSample[];
};

/**
 * Zoom that locks onto the text field being typed into.
 * Mouse rarely moves while typing — use the click that focused the field,
 * then ease focus forward as text grows (caretProgress).
 * Typing zooms are mandatory (priority 1) over click punches.
 */
function findTypingBeats(
  track: CursorTrack,
  duration: number,
  hints?: AutoZoomHints,
): InterestBeat[] {
  const out: InterestBeat[] = [];
  const caret = [...(hints?.caret ?? [])]
    .filter((c) => c.x > 0.003 && c.y > 0.003 && c.x < 0.997 && c.y < 0.997)
    .sort((a, b) => a.t - b.t);
  const hasCaret = caret.length > 0;

  /** First caret sample just after the key (caret updates after the app handles it). */
  const caretNear = (t0: number): { x: number; y: number } | null => {
    let before: CaretSample | null = null;
    for (const c of caret) {
      if (c.t < t0 - 2.5) continue;
      if (c.t <= t0) before = c;
      else if (c.t <= t0 + 0.9) return c;
      else break;
    }
    return before;
  };

  const caretSlice = (a: number, b: number): CaretSample[] =>
    caret.filter((c) => c.t >= a - 0.2 && c.t <= b + 0.3);

  const fieldFocusAt = (t0: number): { x: number; y: number } => {
    const c = hasCaret ? caretNear(t0) : null;
    if (c) return { x: c.x, y: c.y };
    let best: ClickPt | null = null;
    for (const c of track.clicks) {
      if (c.t <= t0 + 0.05 && c.t >= t0 - 5) best = c;
    }
    if (best) return { x: best.x, y: best.y };
    for (let t = t0; t >= Math.max(0, t0 - 2.5); t -= 1 / 30) {
      const f = track.get(t);
      if (f.active) return { x: f.x, y: f.y };
    }
    const mid = track.get(Math.max(0, t0));
    return { x: mid.x || 0.5, y: mid.y || 0.45 };
  };

  const pushRange = (t0: number, t1: number) => {
    const a = Math.max(0, t0);
    const b = Math.min(duration, Math.max(a + 0.45, t1));
    if (b - a < 0.35) return;
    const path = hasCaret ? caretSlice(a, b) : [];
    const focus = path.length ? { x: path[0]!.x, y: path[0]!.y } : fieldFocusAt(a + 0.05);
    // Keep near-edge spreadsheet cells — only drop true chrome extremes.
    if (focus.x < 0.02 || focus.x > 0.98) return;
    if (focus.y < 0.02 || focus.y > 0.98) return;
    out.push({
      clicks: [{ t: a, x: focus.x, y: focus.y }],
      t0: a,
      t1: b,
      x: focus.x,
      y: focus.y,
      spread: 0.06,
      dwell: b - a,
      approach: 0.12,
      // Real caret data outranks every heuristic beat.
      score: path.length ? 3.6 : 3.2,
      kindHint: "typing",
      caretPath: path.length ? path : undefined,
    });
  };

  // Caret continuity: line wraps / Enter keep the zoom; only a jump to another field splits it.
  const hopLimit = hasCaret ? 0.16 : 0.05;

  // Merge nearby typing SFX — split when the caret/click hopped to another cell.
  const clips = [...(hints?.typingClips ?? [])].sort((a, b) => a.time - b.time);
  let burstStart: number | null = null;
  let burstEnd = 0;
  let burstFocus = fieldFocusAt(clips[0]?.time ?? 0);
  const flushBurst = () => {
    if (burstStart == null) return;
    pushRange(burstStart - 0.35, burstEnd + 0.55);
    burstStart = null;
  };
  for (const clip of clips) {
    const end = clip.time + Math.max(0.45, clip.duration);
    const focus = fieldFocusAt(clip.time);
    const hopped =
      burstStart != null && dist2(burstFocus.x, burstFocus.y, focus.x, focus.y) > hopLimit;
    if (burstStart == null) {
      burstStart = clip.time;
      burstEnd = end;
      burstFocus = focus;
    } else if (!hopped && clip.time <= burstEnd + 0.7) {
      burstEnd = Math.max(burstEnd, end);
      if (hasCaret) burstFocus = focus;
    } else {
      flushBurst();
      burstStart = clip.time;
      burstEnd = end;
      burstFocus = focus;
    }
  }
  flushBurst();

  // Native / demo key times → bursts when SFX clips were missed.
  const keyTimes = [...(hints?.keyTimes ?? [])].sort((a, b) => a - b);
  if (keyTimes.length && clips.length < 2) {
    let kStart: number | null = null;
    let kEnd = 0;
    let kFocus = fieldFocusAt(keyTimes[0] ?? 0);
    const flushKeys = () => {
      if (kStart == null) return;
      pushRange(kStart - 0.25, kEnd + 0.4);
      kStart = null;
    };
    for (const kt of keyTimes) {
      if (kt < 0 || kt > duration) continue;
      const focus = fieldFocusAt(kt);
      const hopped =
        kStart != null && dist2(kFocus.x, kFocus.y, focus.x, focus.y) > hopLimit;
      if (kStart == null) {
        kStart = kt;
        kEnd = kt + 0.35;
        kFocus = focus;
      } else if (!hopped && kt <= kEnd + 0.55) {
        kEnd = Math.max(kEnd, kt + 0.35);
        if (hasCaret) kFocus = focus;
      } else {
        flushKeys();
        kStart = kt;
        kEnd = kt + 0.35;
        kFocus = focus;
      }
    }
    flushKeys();
  }

  // I-beam stretches as a backup when SFX weren't captured.
  let runStart: number | null = null;
  let lastIbeam = 0;
  for (let t = 0.3; t < duration; t += 1 / 20) {
    const f = track.get(t);
    const isIbeam = f.active && f.shape === "ibeam";
    if (isIbeam) {
      if (runStart == null) runStart = t;
      lastIbeam = t;
    } else if (runStart != null && t - lastIbeam > 0.45) {
      if (lastIbeam - runStart >= 0.35) pushRange(runStart - 0.15, lastIbeam + 0.4);
      runStart = null;
    }
  }
  if (runStart != null && lastIbeam - runStart >= 0.35) {
    pushRange(runStart - 0.15, lastIbeam + 0.4);
  }

  out.sort((a, b) => b.score - a.score);
  const kept: InterestBeat[] = [];
  for (const b of out) {
    // Prefer longer typing beats when two overlap the same field.
    const overlapIdx = kept.findIndex(
      (k) => b.t0 < k.t1 + 0.2 && k.t0 < b.t1 + 0.2 && dist2(b.x, b.y, k.x, k.y) < 0.08,
    );
    if (overlapIdx >= 0) {
      const existing = kept[overlapIdx]!;
      if (b.dwell > existing.dwell + 0.1 || b.score > existing.score) {
        kept[overlapIdx] = b;
      }
      continue;
    }
    kept.push(b);
  }
  return kept;
}

/**
 * Dropdown / menu pick: open click → choose item (second click nearby, mostly vertical).
 */
function findMenuBeats(track: CursorTrack): InterestBeat[] {
  const clicks = track.clicks;
  const out: InterestBeat[] = [];
  for (let i = 0; i < clicks.length - 1; i++) {
    const a = clicks[i]!;
    const b = clicks[i + 1]!;
    const dt = b.t - a.t;
    if (dt < 0.28 || dt > 2.4) continue;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    // Menu lists: similar X, different Y — or compact cluster under the opener.
    const verticalList = dx < 0.14 && dy > 0.03 && dy < 0.42;
    const compactPick = dist2(a.x, a.y, b.x, b.y) < 0.22 && dt < 1.6;
    if (!verticalList && !compactPick) continue;
    if (a.x < 0.1 || a.x > 0.9) continue;

    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    out.push({
      clicks: [a, b],
      t0: Math.max(0, a.t - 0.2),
      t1: b.t + 0.45,
      x,
      y,
      spread: Math.max(dx, dy),
      dwell: dt,
      approach: meanSpeed(track, a.t - 0.4, a.t),
      score: 2.35,
      kindHint: "menu",
    });
  }
  out.sort((a, b) => b.score - a.score);
  const kept: InterestBeat[] = [];
  for (const b of out) {
    if (kept.some((k) => b.t0 < k.t1 && k.t0 < b.t1)) continue;
    kept.push(b);
  }
  return kept;
}

const HINT_RANK: Partial<Record<BeatKind, number>> = {
  typing: 5,
  menu: 4,
  reveal: 3,
  orbit: 2,
};

function beatRank(beat: InterestBeat): number {
  return HINT_RANK[beat.kindHint ?? "glance"] ?? 0;
}

function joinCaretPaths(
  a: CaretSample[] | undefined,
  b: CaretSample[] | undefined,
): CaretSample[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  const seen = new Set<number>();
  return [...a, ...b]
    .sort((p, q) => p.t - q.t)
    .filter((p) => {
      const k = Math.round(p.t * 1000);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Merge only when beats overlap or sit ≤ ~2s apart in the same pane.
 * Gaps of ~2–5s+ stay separate zooms — do not glue the whole recording together.
 * Typing always keeps priority over mouse-hover / orbit chatter in the same pane.
 */
function mergeRegionalBeats(beats: InterestBeat[]): InterestBeat[] {
  if (beats.length < 2) return beats;
  const sorted = [...beats].sort((a, b) => a.t0 - b.t0);
  const out: InterestBeat[] = [];

  for (const beat of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...beat, clicks: [...beat.clicks] });
      continue;
    }

    const gap = beat.t0 - prev.t1;
    const spatial = dist2(prev.x, prev.y, beat.x, beat.y);
    // Hard stop: far apart in time → separate punches.
    if (gap > 2.05) {
      out.push({ ...beat, clicks: [...beat.clicks] });
      continue;
    }
    // Must share a pane / neighborhood (overlap may have gap ≤ 0).
    const samePane = spatial <= 0.26 || (spatial <= 0.34 && gap <= 1.0);
    if (!samePane) {
      out.push({ ...beat, clicks: [...beat.clicks] });
      continue;
    }

    const prevTyping = prev.kindHint === "typing";
    const nextTyping = beat.kindHint === "typing";
    const typingChain = prevTyping || nextTyping;

    // While typing, ignore mouse wander for focus — keep the field lock.
    if (typingChain) {
      if (prevTyping && !nextTyping) {
        // Absorb hover/click noise into the typing beat; keep field focus.
        prev.t1 = Math.max(prev.t1, beat.t1);
        prev.dwell = Math.max(prev.dwell, beat.dwell);
        prev.score = Math.max(prev.score, beat.score);
        continue;
      }
      if (!prevTyping && nextTyping) {
        // Upgrade hover/click beat to typing focus at the caret field.
        prev.kindHint = "typing";
        prev.t0 = Math.min(prev.t0, beat.t0);
        prev.t1 = Math.max(prev.t1, beat.t1);
        prev.x = beat.x;
        prev.y = beat.y;
        prev.clicks = [...beat.clicks];
        prev.caretPath = beat.caretPath;
        prev.spread = Math.min(prev.spread, 0.08);
        prev.dwell = Math.max(prev.dwell, beat.dwell);
        prev.score = Math.max(prev.score, beat.score);
        prev.travel = 0;
        continue;
      }
      // Adjacent spreadsheet cells → separate zooms (follow mouse into each).
      // With a caret path the camera already pans between cells — keep one zoom.
      if (spatial > 0.05 && !(prev.caretPath?.length && beat.caretPath?.length && gap < 1.2)) {
        out.push({ ...beat, clicks: [...beat.clicks] });
        continue;
      }
      prev.t1 = Math.max(prev.t1, beat.t1);
      prev.clicks = [...prev.clicks, ...beat.clicks];
      prev.caretPath = joinCaretPaths(prev.caretPath, beat.caretPath);
      prev.dwell = Math.max(prev.dwell, beat.dwell);
      prev.score = Math.max(prev.score, beat.score);
      continue;
    }

    prev.t1 = Math.max(prev.t1, beat.t1);
    prev.clicks = [...prev.clicks, ...beat.clicks];
    prev.caretPath = joinCaretPaths(prev.caretPath, beat.caretPath);
    prev.spread = Math.max(prev.spread, beat.spread, spatial);
    prev.dwell = Math.max(prev.dwell, beat.dwell);
    prev.travel = Math.max(prev.travel ?? 0, beat.travel ?? 0, spatial);
    prev.score = Math.max(prev.score, beat.score);
    prev.approach = Math.min(prev.approach, beat.approach);

    const prevRank = beatRank(prev);
    const nextRank = beatRank(beat);
    if (nextRank > prevRank) prev.kindHint = beat.kindHint;
    else if (!prev.kindHint && beat.kindHint) prev.kindHint = beat.kindHint;

    let sx = 0;
    let sy = 0;
    for (const c of prev.clicks) {
      sx += c.x;
      sy += c.y;
    }
    if (prev.clicks.length) {
      prev.x = sx / prev.clicks.length;
      prev.y = sy / prev.clicks.length;
    }
  }

  return out;
}

/**
 * Glue timeline zooms only when they overlap or are ≤ ~2s apart in the same area.
 */
function coalesceRegionalZooms(zooms: ZoomKeyframe[], duration: number): ZoomKeyframe[] {
  if (zooms.length < 2) return zooms;
  const sorted = [...zooms].sort((a, b) => a.time - b.time);
  const merged: ZoomKeyframe[] = [];

  for (const z of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...z });
      continue;
    }

    const prevEnd = prev.time + prev.duration;
    const gap = z.time - prevEnd;
    const spatial = dist2(prev.x, prev.y, z.x, z.y);

    // Keep separate punches for distant cells; glue nearby chatter.
    if (gap > 2.05 || spatial > 0.28) {
      merged.push({ ...z });
      continue;
    }

    const end = Math.max(prevEnd, z.time + z.duration);
    prev.duration = Math.min(duration - prev.time, Math.max(prev.duration, end - prev.time));
    prev.scale = Math.min(prev.scale, z.scale) + Math.abs(prev.scale - z.scale) * 0.35;
    prev.scale = Math.round(prev.scale * 100) / 100;
    prev.x = (prev.x + z.x) / 2;
    prev.y = (prev.y + z.y) / 2;
    prev.followCursor = prev.followCursor || z.followCursor || spatial > 0.06;
    const joined = joinCaretPaths(prev.caretPath, z.caretPath);
    if (joined) {
      prev.caretPath = joined;
      prev.x = joined[0]!.x;
      prev.y = joined[0]!.y;
    }
    if (prev.followCursor || joined) delete prev.caretProgress;
    else {
      prev.caretProgress =
        Math.max(prev.caretProgress ?? 0, z.caretProgress ?? 0) || undefined;
    }
  }

  return merged.map((z, i) => ({
    ...z,
    id: `auto-${i}-${Math.round(z.time * 1000)}`,
  }));
}

/** True when cursor mostly scrolls vertically (wheel-like) — orbit zooms fight this. */
function isScrollishWindow(track: CursorTrack, t0: number, t1: number): boolean {
  let vert = 0;
  let horiz = 0;
  let samples = 0;
  const step = 1 / 20;
  for (let t = t0; t < t1; t += step) {
    const a = track.get(t);
    const b = track.get(t + step);
    if (!a.active || !b.active) continue;
    vert += Math.abs(b.y - a.y);
    horiz += Math.abs(b.x - a.x);
    samples++;
  }
  if (samples < 4) return false;
  return vert > horiz * 2.2 && vert / samples > 0.012;
}

/**
 * Intelligent auto zooms — priority:
 * 1) Typing (must lock field + caret)  2) Clicks / menus / reveals  3) Orbit (skip during scroll)
 * Same-region punches coalesce; `autoScale` is only a bias.
 */
export function deriveAutoZooms(
  track: CursorTrack,
  duration: number,
  autoScale = 2.15,
  hints?: AutoZoomHints,
): ZoomKeyframe[] {
  if (track.isEmpty) return [];

  const bias = Math.min(3, Math.max(1.4, autoScale));
  const typingBeats = findTypingBeats(track, duration, hints);
  const clickBeats = clusterClicks(track.clicks)
    .map((c) => scoreInterestBeat(track, c))
    .filter((b): b is InterestBeat => !!b && b.score >= 1.35)
    .filter((b) => b.t0 >= 0.45)
    // Clicks inside an active typing window are secondary — drop them.
    .filter(
      (b) =>
        !typingBeats.some(
          (t) => b.t0 < t.t1 + 0.15 && t.t0 < b.t1 + 0.15 && dist2(b.x, b.y, t.x, t.y) < 0.22,
        ),
    );

  const orbitBeats = findOrbitBeats(track, duration).filter(
    (b) => !isScrollishWindow(track, b.t0, b.t1),
  );
  const menuBeats = findMenuBeats(track);
  const revealBeats = findRevealBeats(track);

  // Prefer typing/menu/reveal over weaker overlapping click beats.
  // Sort by hint rank first so typing always lands before mouse-hover chatter.
  const priority = [...typingBeats, ...menuBeats, ...revealBeats, ...orbitBeats, ...clickBeats];
  const ranked = [...priority].sort((a, b) => {
    const rd = beatRank(b) - beatRank(a);
    if (rd !== 0) return rd;
    return b.score - a.score;
  });
  const kept: InterestBeat[] = [];
  for (const beat of ranked) {
    const conflictIdx = kept.findIndex((k) => {
      const overlap = beat.t0 < k.t1 + 0.45 && k.t0 < beat.t1 + 0.45;
      // Typing owns a wider neighborhood so click punches can't steal the field.
      const radius = beat.kindHint === "typing" || k.kindHint === "typing" ? 0.18 : 0.05;
      const sameCell = dist2(beat.x, beat.y, k.x, k.y) < radius;
      return overlap && sameCell;
    });
    if (conflictIdx < 0) {
      kept.push(beat);
      continue;
    }
    const existing = kept[conflictIdx]!;
    if (beatRank(beat) > beatRank(existing) || beat.score > existing.score + 0.15) {
      kept[conflictIdx] = beat;
    }
  }
  kept.sort((a, b) => a.t0 - b.t0);

  // Same-region chatter → one continuous beat (writing, multi-click in a panel, etc.)
  const coalesced = mergeRegionalBeats(kept);

  const out: ZoomKeyframe[] = [];
  for (const beat of coalesced) {
    const kind = classifyBeat(beat);
    const scale = scaleForBeat(kind, bias);

    const holdBase =
      kind === "typing"
        ? Math.max(1.25, beat.dwell * 0.35)
        : kind === "menu"
          ? 1.2
          : kind === "reveal"
            ? 1.35
            : kind === "spotlight"
              ? 1.5
              : kind === "detail"
                ? 1.25
                : kind === "orbit"
                  ? 1.4
                  : kind === "tour"
                    ? 1.1
                    : kind === "glance"
                      ? 0.65
                      : 1.0;
    // Typing holds through the full burst; clicks stay punchy between cells.
    const hold = Math.min(
      kind === "typing" ? 4.5 : 1.7,
      Math.max(0.7, holdBase + beat.dwell * (kind === "typing" ? 0.45 : 0.28)),
    );
    // Screen Studio style: the (slow) zoom-in finishes just as the action starts,
    // so lead ≈ the ramp length; then hold, then a gentle zoom-out.
    const lead = kind === "typing" ? 0.95 : kind === "menu" ? 0.85 : 0.9;
    const time = Math.max(0, beat.t0 - lead);
    const span = beat.t1 - time;
    let dur =
      kind === "typing"
        ? span + 0.4 + ZOOM_RAMP
        : Math.min(3.6, span + Math.min(hold, 1.2) + ZOOM_RAMP * 0.8);
    dur = Math.max(dur, kind === "typing" ? 2.6 : 2.3);
    dur = Math.min(dur, duration - time);
    if (dur < 1.6) continue;
    // Soft glances only if they scored well; never drop typing/menu/reveal/detail.
    if (kind === "glance" && beat.score < 1.9) continue;

    const fieldHop =
      kind === "typing"
        ? (beat.travel ?? 0) > 0.14 || beat.spread > 0.14
        : beat.clicks.length >= 2 || (beat.travel ?? 0) > 0.08 || beat.spread > 0.1;
    // Typing: lock field + caret (unless hopping cells).
    // Clicks/menus/reveals: follow cursor on the approach so zoom tracks into the target before the click.
    const caretPath = kind === "typing" && beat.caretPath?.length ? beat.caretPath : undefined;
    const followCursor =
      (kind === "typing" && fieldHop && !caretPath) ||
      kind === "menu" ||
      kind === "orbit" ||
      kind === "tour" ||
      kind === "reveal" ||
      kind === "glance" ||
      kind === "detail" ||
      kind === "spotlight" ||
      (kind !== "typing" && (fieldHop || beat.spread > 0.11 || beat.clicks.length >= 2));
    const caretProgress =
      kind === "typing" && !fieldHop && !caretPath
        ? Math.min(0.16, 0.06 + beat.dwell * 0.025)
        : undefined;

    out.push({
      id: `auto-${out.length}-${Math.round(time * 1000)}`,
      time,
      duration: dur,
      scale,
      x: caretPath ? caretPath[0]!.x : beat.x,
      y: caretPath ? caretPath[0]!.y : beat.y,
      followCursor,
      auto: true,
      caretProgress,
      caretPath,
    });
  }

  // Hand-offs: cur's zoom-out overlaps next's zoom-in exactly, so evalZoom crossfades
  // into a pan while staying zoomed. Short gaps are bridged the same way instead of
  // pulling all the way out and punching back in.
  const merged = coalesceRegionalZooms(out, duration);
  for (let i = 0; i < merged.length - 1; i++) {
    const cur = merged[i]!;
    const next = merged[i + 1]!;
    const curEnd = cur.time + cur.duration;
    const handoff = next.time + zoomRamp(next);
    const gap = next.time - curEnd;
    if (curEnd <= handoff && gap > 1.4) continue;
    const lastCaret = cur.caretPath?.length ? cur.caretPath[cur.caretPath.length - 1]!.t + 0.4 : 0;
    const end = Math.max(handoff, lastCaret, cur.time + 1.6);
    cur.duration = Math.min(duration - cur.time, end - cur.time);
  }
  return merged.map((z, i) => ({
    ...z,
    id: `auto-${i}-${Math.round(z.time * 1000)}`,
  }));
}

const POSITION_ANCHORS: Record<CameraPosition, { x: number; y: number }> = {
  "top-left": { x: 0.16, y: 0.18 },
  "top-center": { x: 0.5, y: 0.18 },
  "top-right": { x: 0.84, y: 0.18 },
  "middle-left": { x: 0.16, y: 0.5 },
  "middle-center": { x: 0.5, y: 0.5 },
  "middle-right": { x: 0.84, y: 0.5 },
  "bottom-left": { x: 0.16, y: 0.82 },
  "bottom-center": { x: 0.5, y: 0.82 },
  "bottom-right": { x: 0.84, y: 0.82 },
};

function cameraAnchor(camera: CameraSettings): { x: number; y: number } {
  const pos = camera.position ?? (camera.corner as CameraPosition) ?? "bottom-left";
  return { ...(POSITION_ANCHORS[pos] ?? POSITION_ANCHORS["bottom-left"]) };
}

export interface CameraPose {
  x: number;
  y: number;
  scale: number;
  rotate: number;
}

/**
 * Shift+Space camera choreography — the bubble travels along a circular arc.
 * After an arc completes, the camera stays on the destination side (does not snap back).
 */
export function evalCameraPose(camera: CameraSettings, moves: CameraMove[], t: number): CameraPose {
  let settled = cameraAnchor(camera);
  let pose: CameraPose = { x: settled.x, y: settled.y, scale: 1, rotate: 0 };

  const sorted = [...moves].sort((a, b) => a.time - b.time);
  for (const m of sorted) {
    const end = m.time + m.duration;
    if (m.kind === "orbit") {
      if (t < m.time || t > end) continue;
      const p = easeInOut((t - m.time) / m.duration);
      const a = p * Math.PI * 2 - Math.PI / 2;
      pose.x = 0.5 + Math.cos(a) * 0.3;
      pose.y = 0.5 + Math.sin(a) * 0.26;
      pose.scale = 1 + Math.sin(p * Math.PI) * 0.12;
      pose.rotate = Math.sin(p * Math.PI * 2) * 0.06;
      continue;
    }
    if (m.kind === "dip") {
      if (t < m.time || t > end) continue;
      const p = easeInOut((t - m.time) / m.duration);
      pose.x = settled.x;
      pose.y = settled.y + Math.sin(p * Math.PI) * 0.22;
      pose.scale = 1 - Math.sin(p * Math.PI) * 0.25;
      pose.rotate = 0;
      continue;
    }

    // arc-lr / arc-rl — settle permanently on the destination side
    const from = { x: settled.x, y: settled.y };
    const toX = m.kind === "arc-lr" ? 0.84 : 0.16;
    const to = { x: toX, y: settled.y };

    if (t >= end) {
      settled = to;
      pose = { x: to.x, y: to.y, scale: 1, rotate: 0 };
      continue;
    }
    if (t < m.time) {
      pose = { x: settled.x, y: settled.y, scale: 1, rotate: 0 };
      continue;
    }

    const p = easeInOut((t - m.time) / m.duration);
    pose.x = lerp(from.x, to.x, p);
    pose.y = from.y - Math.sin(p * Math.PI) * 0.34;
    pose.scale = 1 + Math.sin(p * Math.PI) * 0.16;
    pose.rotate = Math.sin(p * Math.PI) * (m.kind === "arc-lr" ? 0.05 : -0.05);
  }

  return pose;
}

/** Manual zooms win; auto zooms fill gaps that don't overlap manuals. */
export function mergeZoomTracks(
  manuals: ZoomKeyframe[],
  autos: ZoomKeyframe[],
): ZoomKeyframe[] {
  const out = [...manuals].sort((a, b) => a.time - b.time);
  for (const a of autos) {
    const overlaps = out.some((m) => {
      const a0 = a.time;
      const a1 = a.time + a.duration;
      const m0 = m.time;
      const m1 = m.time + m.duration;
      return a0 < m1 && m0 < a1;
    });
    if (!overlaps) out.push(a);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Settled camera X after all moves that have finished by time `t`. */
function settledCameraX(camera: CameraSettings, moves: CameraMove[], t: number): number {
  let x = cameraAnchor(camera).x;
  const sorted = [...moves].sort((a, b) => a.time - b.time);
  for (const m of sorted) {
    if (m.kind !== "arc-lr" && m.kind !== "arc-rl") continue;
    if (t < m.time + m.duration) break;
    x = m.kind === "arc-lr" ? 0.84 : 0.16;
  }
  return x;
}

function settledCameraY(camera: CameraSettings): number {
  return cameraAnchor(camera).y;
}

/**
 * Where attention actually lives during the first half of a zoom —
 * not just the keyframe's stored focus.
 */
function attentionDuringZoom(
  z: ZoomKeyframe,
  track?: CursorTrack,
): { x: number; y: number; weight: number } {
  if (!track || track.isEmpty) {
    return { x: z.x, y: z.y, weight: 1 };
  }
  const t0 = z.time + Math.min(0.45, z.duration * 0.15);
  const t1 = z.time + Math.min(z.duration * 0.55, z.duration - 0.2);
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  for (let t = t0; t <= t1; t += 1 / 20) {
    const f = track.get(t);
    if (!f.active || f.opacity < 0.25) continue;
    // Prefer slow cursor near the zoom focus — that's the thing being shown.
    const near = Math.max(0, 1 - dist2(f.x, f.y, z.x, z.y) / 0.35);
    const still = Math.max(0, 1 - f.speed / 0.5);
    const w = 0.35 + near * 0.9 + still * 0.6;
    sx += f.x * w;
    sy += f.y * w;
    wsum += w;
  }
  if (wsum < 0.2) return { x: z.x, y: z.y, weight: 0.4 };
  return { x: sx / wsum, y: sy / wsum, weight: Math.min(1.5, wsum / 8) };
}

/**
 * How badly the face bubble covers the action (0 = clear, ~1+ = must move).
 */
function faceInterference(
  attention: { x: number; y: number },
  camX: number,
  camY: number,
): number {
  const d = dist2(attention.x, attention.y, camX, camY);
  // Soft bubble radius in normalized stage space (~webcam circle).
  const bubbleR = 0.22;
  let score = Math.max(0, 1 - d / (bubbleR * 1.85));

  const sameSideX =
    (camX < 0.5 && attention.x < 0.5) || (camX >= 0.5 && attention.x >= 0.5);
  const sameSideY =
    (camY < 0.5 && attention.y < 0.55) || (camY >= 0.5 && attention.y >= 0.45);
  if (sameSideX) score += 0.35;
  if (sameSideX && sameSideY) score += 0.25;
  // Action deep in the camera corner is the classic “face over UI” moment.
  if (sameSideX && Math.abs(attention.x - camX) < 0.28 && Math.abs(attention.y - camY) < 0.32) {
    score += 0.4;
  }
  // Center-screen demos rarely need a sweep.
  if (Math.abs(attention.x - 0.5) < 0.12 && Math.abs(attention.y - 0.5) < 0.14) {
    score -= 0.35;
  }
  return score;
}

/**
 * Intelligent camera sweeps (Shift+Space): only move the face when it would
 * actually cover a sustained demo beat, and land opposite the action before
 * the punch-in finishes.
 */
export function deriveAutoCameraMoves(
  camera: CameraSettings,
  zooms: ZoomKeyframe[],
  duration: number,
  existingMoves: CameraMove[] = [],
  track?: CursorTrack,
): CameraMove[] {
  if (!camera.enabled || !zooms.length) return [];
  const manuals = existingMoves.filter((m) => !m.auto);
  const out: CameraMove[] = [];
  const camY = settledCameraY(camera);
  const sortedZooms = [...zooms].sort((a, b) => a.time - b.time);

  for (const z of sortedZooms) {
    const allKnown = [...manuals, ...out];
    const camX = settledCameraX(camera, allKnown, z.time);
    const attention = attentionDuringZoom(z, track);
    const interference = faceInterference(attention, camX, camY) * (0.7 + attention.weight * 0.3);

    // Already clear of the face — don't thrash.
    if (interference < 0.72) continue;

    const camOnLeft = camX < 0.5;
    // Sweep toward the side opposite the attention, not blindly “flip”.
    const wantRight = attention.x < 0.5;
    const kind: CameraMoveKind = wantRight ? "arc-lr" : "arc-rl";
    // If we're already on the preferred side, skip (interference came from Y / size).
    if ((wantRight && !camOnLeft) || (!wantRight && camOnLeft)) continue;

    // Start early so the face is gone when the zoom lands.
    const time = Math.max(0, z.time - 0.28);
    const moveDur = Math.min(1.55, Math.max(1.15, Math.min(1.7, duration - time)));
    if (moveDur < 0.95) continue;

    const last = out[out.length - 1];
    // Don't ping-pong every zoom — one sweep covers a stretch of same-side beats.
    if (last) {
      if (time < last.time + last.duration + 2.4) continue;
      if (last.kind === kind && time < last.time + 5.5) continue;
    }

    const overlapsManual = manuals.some((m) => {
      const a0 = time;
      const a1 = time + moveDur;
      return a0 < m.time + m.duration && m.time < a1;
    });
    if (overlapsManual) continue;

    out.push({
      id: `auto-cam-${out.length}-${Math.round(time * 1000)}`,
      time,
      duration: moveDur,
      kind,
      auto: true,
    });
  }

  return out;
}

/** Manual camera moves win; auto arcs fill non-overlapping gaps. */
export function mergeMoveTracks(
  manuals: CameraMove[],
  autos: CameraMove[],
): CameraMove[] {
  const out = [...manuals].sort((a, b) => a.time - b.time);
  for (const a of autos) {
    const overlaps = out.some((m) => {
      const a0 = a.time;
      const a1 = a.time + a.duration;
      const m0 = m.time;
      const m1 = m.time + m.duration;
      return a0 < m1 && m0 < a1;
    });
    if (!overlaps) out.push(a);
  }
  return out.sort((a, b) => a.time - b.time);
}
