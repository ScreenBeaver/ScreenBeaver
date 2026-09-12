/**
 * Split a timeline clip into two pieces at time `t`.
 * Used by the scissors / cut tool.
 */

import type {
  CaptionCue,
  CameraMove,
  ProjectState,
  SceneEffect,
  ZoomKeyframe,
} from "./types";
import type { SoundClip } from "./soundTrack";
import { newSoundId } from "./soundTrack";

const MIN_CLIP = 0.35;
const MIN_SOUND = 0.12;
const MIN_CAPTION = 0.4;

export type SplitSelection = {
  zoom: string | null;
  move: string | null;
  effect: string | null;
  sound: string | null;
  caption: string | null;
};

export type SplitResult = {
  ok: boolean;
  message: string;
  project?: ProjectState;
  selection?: Partial<SplitSelection>;
};

function contains(t: number, start: number, len: number, minPiece: number): boolean {
  return t >= start + minPiece && t <= start + len - minPiece;
}

/**
 * When a clip is selected, clamp (or pick midpoint) so Cut works even if the
 * playhead is at the clip start / just outside the clip.
 */
function resolveCutTime(
  t: number,
  start: number,
  len: number,
  minPiece: number,
  selected: boolean,
): number | null {
  if (len < minPiece * 2 + 1e-4) return null;
  const lo = start + minPiece;
  const hi = start + len - minPiece;
  if (selected) {
    if (t < start || t > start + len) return (lo + hi) / 2;
    return Math.min(hi, Math.max(lo, t));
  }
  return contains(t, start, len, minPiece) ? t : null;
}

/**
 * Dissect the selected clip (or the clip under the playhead) into two parts at `t`.
 */
export function splitClipAtTime(
  project: ProjectState,
  selection: SplitSelection,
  t: number,
): SplitResult {
  const time = Math.max(0, t);

  const tryCaption = (id: string | null, required: boolean): SplitResult | null => {
    const cues = project.captions?.cues ?? [];
    const c = id
      ? cues.find((x) => x.id === id)
      : cues.find((x) => contains(time, x.start, x.end - x.start, MIN_CAPTION));
    if (!c) return required ? { ok: false, message: "Selected caption not found" } : null;
    const cut = resolveCutTime(time, c.start, c.end - c.start, MIN_CAPTION, !!id);
    if (cut == null) {
      return required
        ? {
            ok: false,
            message:
              c.end - c.start < MIN_CAPTION * 2
                ? "Caption is too short to split"
                : "Move the playhead onto the selected caption, then cut",
          }
        : null;
    }
    const rightId = `cap-cut-${Date.now()}`;
    const left: CaptionCue = { ...c, end: cut };
    const right: CaptionCue = { ...c, id: rightId, start: cut, end: c.end };
    return {
      ok: true,
      message: "Caption split into two",
      project: {
        ...project,
        captions: {
          ...(project.captions ?? { enabled: true, burnIn: true, fontSize: 36, cues: [] }),
          cues: cues.flatMap((x) => (x.id === c.id ? [left, right] : [x])),
        },
      },
      selection: { caption: rightId, zoom: null, move: null, effect: null, sound: null },
    };
  };

  const tryZoom = (id: string | null, required: boolean): SplitResult | null => {
    const z = id
      ? project.zooms.find((x) => x.id === id)
      : project.zooms.find((x) => contains(time, x.time, x.duration, MIN_CLIP));
    if (!z) return required ? { ok: false, message: "Selected zoom not found" } : null;
    const cut = resolveCutTime(time, z.time, z.duration, MIN_CLIP, !!id);
    if (cut == null) {
      return required
        ? {
            ok: false,
            message:
              z.duration < MIN_CLIP * 2
                ? "Zoom clip is too short to split"
                : "Move the playhead onto the selected zoom clip, then cut",
          }
        : null;
    }
    const rightId = `z-cut-${Date.now()}`;
    const left: ZoomKeyframe = { ...z, duration: cut - z.time, auto: false };
    const right: ZoomKeyframe = {
      ...z,
      id: rightId,
      time: cut,
      duration: z.time + z.duration - cut,
      auto: false,
    };
    return {
      ok: true,
      message: "Zoom clip split into two",
      project: {
        ...project,
        zooms: project.zooms.flatMap((x) => (x.id === z.id ? [left, right] : [x])),
      },
      selection: { zoom: rightId, move: null, effect: null, sound: null, caption: null },
    };
  };

  const tryMove = (id: string | null, required: boolean): SplitResult | null => {
    const m = id
      ? project.moves.find((x) => x.id === id)
      : project.moves.find((x) => contains(time, x.time, x.duration, MIN_CLIP));
    if (!m) return required ? { ok: false, message: "Selected camera clip not found" } : null;
    const cut = resolveCutTime(time, m.time, m.duration, MIN_CLIP, !!id);
    if (cut == null) {
      return required
        ? {
            ok: false,
            message:
              m.duration < MIN_CLIP * 2
                ? "Camera clip is too short to split"
                : "Move the playhead onto the selected camera clip, then cut",
          }
        : null;
    }
    const rightId = `m-cut-${Date.now()}`;
    const left: CameraMove = { ...m, duration: cut - m.time };
    const right: CameraMove = { ...m, id: rightId, time: cut, duration: m.time + m.duration - cut };
    return {
      ok: true,
      message: "Camera clip split into two",
      project: {
        ...project,
        moves: project.moves.flatMap((x) => (x.id === m.id ? [left, right] : [x])),
      },
      selection: { move: rightId, zoom: null, effect: null, sound: null, caption: null },
    };
  };

  const tryEffect = (id: string | null, required: boolean): SplitResult | null => {
    const effects = project.effects ?? [];
    const fx = id
      ? effects.find((x) => x.id === id)
      : effects.find((x) => contains(time, x.time, x.duration, MIN_CLIP));
    if (!fx) return required ? { ok: false, message: "Selected effect not found" } : null;
    const cut = resolveCutTime(time, fx.time, fx.duration, MIN_CLIP, !!id);
    if (cut == null) {
      return required
        ? {
            ok: false,
            message:
              fx.duration < MIN_CLIP * 2
                ? "Effect clip is too short to split"
                : "Move the playhead onto the selected effect clip, then cut",
          }
        : null;
    }
    const rightId = `fx-cut-${Date.now()}`;
    const left: SceneEffect = { ...fx, duration: cut - fx.time };
    const right: SceneEffect = {
      ...fx,
      id: rightId,
      time: cut,
      duration: fx.time + fx.duration - cut,
    };
    return {
      ok: true,
      message: "Effect clip split into two",
      project: {
        ...project,
        effects: effects.flatMap((x) => (x.id === fx.id ? [left, right] : [x])),
      },
      selection: { effect: rightId, zoom: null, move: null, sound: null, caption: null },
    };
  };

  const trySound = (id: string | null, required: boolean): SplitResult | null => {
    const sounds = project.sounds ?? [];
    const s = id
      ? sounds.find((x) => x.id === id)
      : sounds.find((x) => contains(time, x.time, x.duration, MIN_SOUND));
    if (!s) return required ? { ok: false, message: "Selected sound not found" } : null;
    const cut = resolveCutTime(time, s.time, s.duration, MIN_SOUND, !!id);
    if (cut == null) {
      return required
        ? {
            ok: false,
            message:
              s.duration < MIN_SOUND * 2
                ? "Sound clip is too short to split"
                : "Move the playhead onto the selected sound clip, then cut",
          }
        : null;
    }
    const rightId = newSoundId(s.kind, cut);
    const left: SoundClip = { ...s, duration: cut - s.time };
    const right: SoundClip = {
      id: rightId,
      kind: s.kind,
      time: cut,
      duration: s.time + s.duration - cut,
    };
    return {
      ok: true,
      message: "Sound clip split into two",
      project: {
        ...project,
        sounds: sounds.flatMap((x) => (x.id === s.id ? [left, right] : [x])),
      },
      selection: { sound: rightId, zoom: null, move: null, effect: null, caption: null },
    };
  };

  if (selection.caption) return tryCaption(selection.caption, true)!;
  if (selection.zoom) return tryZoom(selection.zoom, true)!;
  if (selection.move) return tryMove(selection.move, true)!;
  if (selection.effect) return tryEffect(selection.effect, true)!;
  if (selection.sound) return trySound(selection.sound, true)!;

  return (
    tryCaption(null, false) ||
    tryZoom(null, false) ||
    tryMove(null, false) ||
    tryEffect(null, false) ||
    trySound(null, false) || {
      ok: false,
      message: "Select a video, zoom, effect, sound, or caption clip, then press Cut",
    }
  );
}

