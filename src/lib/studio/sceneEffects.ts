/** Scene effects triggered by Ctrl+1…7. */

import type { CameraMove, SceneEffect, SceneEffectKind, ZoomKeyframe } from "./types";

export const SCENE_EFFECT_KINDS: SceneEffectKind[] = [
  "hero-zoom",
  "tilt-3d",
  "focus-zoom",
  "spin-3d",
  "glare",
  "mockup-tilt",
  "window-reveal",
  "rotate-3d",
  "float-3d",
  "punch-in",
];

export const SCENE_EFFECT_META: Record<
  SceneEffectKind,
  { label: string; shortcut: string; duration: number; digit: number; blurb: string; group: string }
> = {
  "hero-zoom": {
    label: "Hero zoom",
    shortcut: "Ctrl+1",
    duration: 3.0,
    digit: 1,
    blurb: "Zoom in on the subject.",
    group: "Zoom",
  },
  "tilt-3d": {
    label: "3D tilt",
    shortcut: "Ctrl+2",
    duration: 3.4,
    digit: 2,
    blurb: "Tilt in from the left.",
    group: "3D",
  },
  "focus-zoom": {
    label: "Focus zoom",
    shortcut: "Ctrl+3",
    duration: 2.8,
    digit: 3,
    blurb: "Zoom that follows the cursor.",
    group: "Zoom",
  },
  "spin-3d": {
    label: "3D spin",
    shortcut: "Ctrl+4",
    duration: 3.6,
    digit: 4,
    blurb: "Spin around the subject.",
    group: "3D",
  },
  glare: {
    label: "Glare stripe",
    shortcut: "Ctrl+5",
    duration: 2.4,
    digit: 5,
    blurb: "Light sweeps across the frame.",
    group: "Light",
  },
  "mockup-tilt": {
    label: "Mockup reveal",
    shortcut: "Ctrl+6",
    duration: 3.4,
    digit: 6,
    blurb: "Tilt in from the right.",
    group: "3D",
  },
  "window-reveal": {
    label: "Window reveal",
    shortcut: "Auto intro",
    duration: 3.2,
    digit: 7,
    blurb: "Rises into place — good for intros.",
    group: "3D",
  },
  "rotate-3d": {
    label: "3D rotate",
    shortcut: "",
    duration: 4.2,
    digit: 0,
    blurb: "Rotate like a turntable.",
    group: "3D",
  },
  "float-3d": {
    label: "Float",
    shortcut: "",
    duration: 3.6,
    digit: 0,
    blurb: "Gentle float.",
    group: "3D",
  },
  "punch-in": {
    label: "Punch in",
    shortcut: "",
    duration: 2.2,
    digit: 0,
    blurb: "Quick zoom punch.",
    group: "Zoom",
  },
};

/** Map KeyboardEvent.code → effect when Ctrl is held. */
export const CTRL_DIGIT_TO_EFFECT: Record<string, SceneEffectKind> = {
  Digit1: "hero-zoom",
  Digit2: "tilt-3d",
  Digit3: "focus-zoom",
  Digit4: "spin-3d",
  Digit5: "glare",
  Digit6: "mockup-tilt",
  /** Ctrl+7 = normal glare only (window-reveal stays auto intro / API). */
  Digit7: "glare",
  Numpad1: "hero-zoom",
  Numpad2: "tilt-3d",
  Numpad3: "focus-zoom",
  Numpad4: "spin-3d",
  Numpad5: "glare",
  Numpad6: "mockup-tilt",
  Numpad7: "glare",
};

export function isSceneEffectKind(v: string): v is SceneEffectKind {
  return (SCENE_EFFECT_KINDS as string[]).includes(v);
}

export function newEffectId(kind: SceneEffectKind, t: number) {
  return `fx-${kind}-${Math.round(t * 1000)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ScenePose {
  /** 0..1 envelope of any active cinematic effect */
  weight: number;
  rotateY: number;
  rotateX: number;
  rotateZ: number;
  /** Extra mockup scale (0 = none) */
  lift: number;
  /** Camera truck — fraction of frame width (−1…1, negative = from left) */
  panX: number;
  /** Camera pedestal — fraction of frame height */
  panY: number;
  /** Glare intensity 0..1 */
  glare: number;
  /** Glare band position 0..1 across the frame */
  glareT: number;
  /** Extra motion-blur hint during ramps */
  motion: number;
}

const IDENTITY: ScenePose = {
  weight: 0,
  rotateY: 0,
  rotateX: 0,
  rotateZ: 0,
  lift: 0,
  panX: 0,
  panY: 0,
  glare: 0,
  glareT: 0.5,
  motion: 0,
};

function easeInOut(p: number) {
  const t = Math.min(1, Math.max(0, p));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Screenshot-studio camera path: approach → hold → retreat (0→1→0),
 * with longer soft ramps so zoom-in / zoom-out feel continuous.
 */
export function effectEnvelope(local: number, duration: number): number {
  if (duration <= 0 || local < 0 || local > duration) return 0;
  const rampIn = Math.min(0.85, duration * 0.32);
  const rampOut = Math.min(0.95, duration * 0.34);
  if (local < rampIn) return easeInOut(local / rampIn);
  if (local > duration - rampOut) return easeInOut((duration - local) / rampOut);
  return 1;
}

/** Progress 0..1 through the clip (for spin / glare sweeps). */
function clipProgress(local: number, duration: number) {
  return Math.min(1, Math.max(0, local / Math.max(1e-6, duration)));
}

export function effectMotionStrength(effects: SceneEffect[] | undefined, t: number): number {
  if (!effects?.length) return 0;
  let best = 0;
  for (const e of effects) {
    if (t < e.time || t > e.time + e.duration) continue;
    const local = t - e.time;
    const ramp = Math.min(0.75, e.duration * 0.32);
    let m = 0;
    if (local < ramp) m = Math.sin((local / ramp) * Math.PI);
    else if (local > e.duration - ramp) m = Math.sin(((e.duration - local) / ramp) * Math.PI);
    else if (e.kind === "spin-3d" || e.kind === "window-reveal" || e.kind === "rotate-3d") m = 0.45;
    best = Math.max(best, m);
  }
  return best;
}

/**
 * 3D / mockup camera pose.
 * Camera starts off to one side (L/R), dollies in while tilting,
 * holds, then pulls back and flattens.
 */
export function evalScenePose(effects: SceneEffect[] | undefined, t: number): ScenePose {
  if (!effects?.length) return IDENTITY;
  let pose: ScenePose = { ...IDENTITY };
  let maxW = 0;

  for (const e of effects) {
    if (t < e.time || t > e.time + e.duration) continue;
    const local = t - e.time;
    const w = effectEnvelope(local, e.duration);
    if (w < 0.001 && e.kind !== "window-reveal") continue;
    const p = clipProgress(local, e.duration);
    // Glare stripe never drives the 3D transform path — shimmer only.
    if (e.kind !== "glare") maxW = Math.max(maxW, w);

    switch (e.kind) {
      case "hero-zoom": {
        pose.lift += w * 0.05;
        pose.rotateX += w * -0.05;
        pose.panY += w * 0.03;
        break;
      }
      case "tilt-3d": {
        pose.rotateY += w * -0.48;
        pose.rotateX += w * 0.12;
        pose.rotateZ += w * -0.05;
        pose.lift += w * 0.12;
        pose.panX += w * -0.14;
        pose.panY += w * 0.03;
        break;
      }
      case "focus-zoom": {
        pose.lift += w * 0.04;
        pose.rotateY += w * 0.05;
        pose.panX += (e.x - 0.5) * w * 0.06;
        pose.panY += (e.y - 0.5) * w * 0.04;
        break;
      }
      case "spin-3d": {
        const spin = Math.sin(p * Math.PI) * 0.55;
        const yaw = (p - 0.5) * 1.25;
        pose.rotateY += w * yaw;
        pose.rotateX += w * spin * 0.18;
        pose.rotateZ += w * Math.sin(p * Math.PI * 2) * 0.04;
        pose.lift += w * 0.14;
        pose.panX += w * Math.sin(p * Math.PI) * -0.1;
        pose.panY += w * Math.cos(p * Math.PI) * 0.04;
        break;
      }
      case "glare": {
        // Ctrl+5 / Ctrl+7 — diagonal white shimmer only, no 3D.
        const sweep = Math.max(w, Math.sin(p * Math.PI) * 0.98);
        pose.glare = Math.max(pose.glare, sweep);
        pose.glareT = easeInOut(p);
        break;
      }
      case "mockup-tilt": {
        pose.rotateY += w * 0.46;
        pose.rotateX += w * -0.1;
        pose.rotateZ += w * 0.04;
        pose.lift += w * 0.13;
        pose.panX += w * 0.14;
        pose.panY += w * -0.02;
        pose.glare = Math.max(pose.glare, w * 0.28);
        pose.glareT = 0.3 + easeInOut(p) * 0.4;
        break;
      }
      case "window-reveal": {
        // Auto intro: window rises from below, yawed on Y, settles flat with a glare flash.
        const settle = easeInOut(Math.min(1, p / 0.82));
        const remaining = 1 - settle;
        maxW = Math.max(maxW, Math.max(w, remaining));
        pose.panY += remaining * 0.62;
        pose.rotateY += remaining * 0.78;
        pose.rotateX += remaining * 0.14;
        pose.rotateZ += remaining * -0.03;
        pose.lift += remaining * 0.1;
        const glarePulse = Math.sin(settle * Math.PI) * 0.9;
        pose.glare = Math.max(pose.glare, glarePulse);
        pose.glareT = settle;
        break;
      }
      case "rotate-3d": {
        // Turntable: sweep yaw across the clip while holding a slight lift.
        const yaw = (p - 0.5) * 1.55;
        pose.rotateY += w * yaw;
        pose.rotateX += w * 0.08;
        pose.lift += w * 0.16;
        pose.panY += w * 0.02;
        break;
      }
      case "float-3d": {
        const bob = Math.sin(p * Math.PI * 2) * 0.06;
        pose.panY += w * (bob - 0.02);
        pose.rotateY += w * Math.sin(p * Math.PI) * 0.22;
        pose.rotateX += w * -0.06;
        pose.lift += w * (0.1 + bob * 0.4);
        break;
      }
      case "punch-in": {
        pose.lift += w * 0.09;
        pose.rotateX += w * -0.04;
        break;
      }
    }
  }

  pose.weight = maxW;
  pose.motion = effectMotionStrength(effects, t);
  return pose;
}

export interface EffectBundle {
  effect: SceneEffect;
  zooms: ZoomKeyframe[];
  moves: CameraMove[];
}

/** Prefer a side “camera seat” for 3D templates; keep user focus for focus/hero. */
function cameraSeat(
  kind: SceneEffectKind,
  focus: { x: number; y: number },
): { x: number; y: number } {
  switch (kind) {
    case "tilt-3d":
      return { x: 0.28, y: 0.46 };
    case "mockup-tilt":
      return { x: 0.72, y: 0.44 };
    case "spin-3d":
    case "rotate-3d":
      return { x: 0.5, y: 0.48 };
    case "float-3d":
      return { x: 0.5, y: 0.42 };
    case "glare":
    case "window-reveal":
      return { x: 0.5, y: 0.45 };
    case "hero-zoom":
    case "punch-in":
      return {
        x: focus.x,
        y: Math.min(0.52, Math.max(0.3, focus.y - 0.06)),
      };
    case "focus-zoom":
    default:
      return focus;
  }
}

/**
 * Build timeline clips for an effect insert.
 * 3D templates include a zoom-in → hold → zoom-out path plus optional webcam moves.
 */
export function createEffectBundle(
  kind: SceneEffectKind,
  time: number,
  focus: { x: number; y: number },
  autoScale = 2.15,
): EffectBundle {
  const meta = SCENE_EFFECT_META[kind];
  // Window reveal intros snap to the start of the take when triggered near t=0.
  const start = kind === "window-reveal" && time < 0.55 ? 0 : time;
  const duration = meta.duration;
  const seat = cameraSeat(kind, focus);
  const stamp = Math.round(start * 1000);
  const effect: SceneEffect = {
    id: newEffectId(kind, start),
    kind,
    time: start,
    duration,
    x: seat.x,
    y: seat.y,
  };

  const zooms: ZoomKeyframe[] = [];
  const moves: CameraMove[] = [];

  const punch = (
    scale: number,
    opts?: { follow?: boolean; id?: string; t?: number; dur?: number },
  ): ZoomKeyframe => ({
    id: opts?.id ?? `z-${kind}-${stamp}`,
    time: opts?.t ?? start,
    duration: opts?.dur ?? duration,
    scale,
    x: seat.x,
    y: seat.y,
    followCursor: opts?.follow ?? false,
    auto: false,
  });

  switch (kind) {
    case "hero-zoom":
      zooms.push(punch(Math.min(2.2, Math.max(1.7, autoScale * 0.85))));
      break;

    case "tilt-3d":
      zooms.push(punch(Math.min(1.85, Math.max(1.45, autoScale * 0.75))));
      moves.push({
        id: `m-tilt-${stamp}`,
        time: start,
        duration: Math.min(duration * 0.85, 2.4),
        kind: "arc-rl",
      });
      break;

    case "focus-zoom":
      zooms.push(punch(Math.min(2.15, Math.max(1.65, autoScale * 0.9)), { follow: true }));
      break;

    case "spin-3d":
      zooms.push(punch(Math.min(1.8, Math.max(1.4, autoScale * 0.72))));
      moves.push({
        id: `m-spin-${stamp}`,
        time: start,
        duration: Math.min(duration * 0.9, 2.8),
        kind: "orbit",
      });
      break;

    case "glare":
      // Ctrl+5 / Ctrl+7 — shimmer only, no zoom punch, no camera move.
      break;

    case "mockup-tilt":
      zooms.push(punch(Math.min(1.85, Math.max(1.45, autoScale * 0.75))));
      moves.push({
        id: `m-mock-${stamp}`,
        time: start,
        duration: Math.min(duration * 0.85, 2.4),
        kind: "arc-lr",
      });
      break;

    case "window-reveal":
      // Soft settle zoom while the window rises into place (auto intro).
      zooms.push(punch(1.28, { t: start, dur: duration * 0.9 }));
      break;

    case "rotate-3d":
      zooms.push(punch(Math.min(1.65, Math.max(1.35, autoScale * 0.68))));
      break;

    case "float-3d":
      zooms.push(punch(Math.min(1.55, Math.max(1.28, autoScale * 0.62))));
      break;

    case "punch-in":
      zooms.push(
        punch(Math.min(2.35, Math.max(1.85, autoScale * 0.95)), {
          follow: true,
          dur: Math.min(duration, 2.0),
        }),
      );
      break;
  }

  return { effect, zooms, moves };
}
