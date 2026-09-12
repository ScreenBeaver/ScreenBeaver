/** Sound-effect clips on the timeline (editable after recording). */

export type SoundKind = "click" | "right-click" | "whoosh" | "typing" | "shimmer";

export interface SoundClip {
  id: string;
  kind: SoundKind;
  /** Start time in the take (seconds). */
  time: number;
  /**
   * How long this clip occupies on the timeline.
   * One-shots are short; typing bursts grow with keystrokes.
   */
  duration: number;
}

export const SOUND_URLS: Record<SoundKind, string> = {
  click: "/sounds/NormalClick.mp3",
  "right-click": "/sounds/RightClick.mp3",
  whoosh: "/sounds/Whoosh.mp3",
  typing: "/sounds/KeyboardTyping.mp3",
  /** Glare / window-reveal shimmer (Shining.mp3). */
  shimmer: "/sounds/Shining.mp3",
};

export const SOUND_LABELS: Record<SoundKind, string> = {
  click: "Click",
  "right-click": "Right-click",
  whoosh: "Whoosh",
  typing: "Typing",
  shimmer: "Shimmer",
};

/** Default timeline width when the event is a one-shot. */
export function defaultSoundDuration(kind: SoundKind): number {
  switch (kind) {
    case "click":
      return 0.18;
    case "right-click":
      return 0.22;
    case "whoosh":
      return 0.55;
    case "typing":
      return 0.35;
    case "shimmer":
      return 2.8;
  }
}

export function newSoundId(kind: SoundKind, t: number) {
  return `sfx-${kind}-${Math.round(t * 1000)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** True when two SFX occupy roughly the same moment. */
export function soundsNear(a: { kind: SoundKind; time: number }, b: { kind: SoundKind; time: number }, window = 0.28) {
  return a.kind === b.kind && Math.abs(a.time - b.time) < window;
}

/**
 * Ensure each zoom punch has a whoosh (Shift+Click / auto zoom).
 * Keeps existing clips; only fills gaps. Skips when a shimmer already covers
 * the moment (glare / window-reveal intro).
 */
export function ensureZoomWhooshes(
  zooms: { time: number }[],
  sounds: SoundClip[],
): SoundClip[] {
  // Drop whooshes that collide with shimmer (glare / window-reveal).
  const out = sounds.filter((s) => {
    if (s.kind !== "whoosh") return true;
    return !sounds.some((o) => o.kind === "shimmer" && Math.abs(o.time - s.time) < 0.55);
  });
  for (const z of zooms) {
    const hasWhoosh = out.some((s) => s.kind === "whoosh" && Math.abs(s.time - z.time) < 0.35);
    if (hasWhoosh) continue;
    const hasShimmer = out.some((s) => s.kind === "shimmer" && Math.abs(s.time - z.time) < 0.55);
    if (hasShimmer) continue;
    out.push({
      id: `auto-whoosh-${Math.round(z.time * 1000)}`,
      kind: "whoosh",
      time: z.time,
      duration: defaultSoundDuration("whoosh"),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Scene effects that use the shimmer (glare) sample instead of whoosh. */
export function effectUsesShimmer(kind: string): boolean {
  return kind === "glare" || kind === "window-reveal" || kind === "mockup-tilt";
}

/**
 * Ensure each glare / window-reveal effect has a shimmer SFX.
 * Keeps existing clips; only fills gaps.
 */
export function ensureEffectShimmers(
  effects: { kind: string; time: number }[],
  sounds: SoundClip[],
): SoundClip[] {
  const out = [...sounds];
  for (const e of effects) {
    if (!effectUsesShimmer(e.kind)) continue;
    const has = out.some((s) => s.kind === "shimmer" && Math.abs(s.time - e.time) < 0.4);
    if (has) continue;
    out.push({
      id: `auto-shimmer-${Math.round(e.time * 1000)}`,
      kind: "shimmer",
      time: e.time,
      duration: defaultSoundDuration("shimmer"),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Fill missing click SFX from the cursor down-edges (when recording missed them).
 */
export function ensureClickSounds(
  clicks: { t: number }[],
  sounds: SoundClip[],
): SoundClip[] {
  const out = [...sounds];
  for (const c of clicks) {
    const has = out.some(
      (s) => (s.kind === "click" || s.kind === "right-click") && Math.abs(s.time - c.t) < 0.22,
    );
    if (has) continue;
    out.push({
      id: `auto-click-${Math.round(c.t * 1000)}`,
      kind: "click",
      time: c.t,
      duration: defaultSoundDuration("click"),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Merge typing bursts from Android (PC keys into scrcpy / soft-keyboard clusters).
 * Extends overlapping bursts instead of stacking duplicates.
 */
export function ensureTypingSounds(
  bursts: { t: number; duration: number }[],
  sounds: SoundClip[],
): SoundClip[] {
  const out = [...sounds];
  for (const b of bursts) {
    const start = Math.max(0, b.t);
    const dur = Math.max(0.35, b.duration);
    const existing = out.find(
      (s) => s.kind === "typing" && start < s.time + s.duration + 0.35 && s.time < start + dur + 0.35,
    );
    if (existing) {
      const end = Math.max(existing.time + existing.duration, start + dur);
      existing.time = Math.min(existing.time, start);
      existing.duration = end - existing.time;
      continue;
    }
    out.push({
      id: `auto-typing-${Math.round(start * 1000)}`,
      kind: "typing",
      time: start,
      duration: dur,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Soft-keyboard heuristic when we only have cursor taps (no explicit typing track):
 * ≥3 quick taps in the lower half → typing bed.
 */
export function deriveTypingFromSoftTaps(
  samples: { t: number; x: number; y: number; down: boolean }[],
): { t: number; duration: number }[] {
  const taps: number[] = [];
  let prevDown = false;
  for (const s of samples) {
    if (s.down && !prevDown && s.y > 0.55) taps.push(s.t);
    prevDown = s.down;
  }
  if (taps.length < 3) return [];
  const bursts: { t: number; duration: number }[] = [];
  let i = 0;
  while (i < taps.length) {
    const start = taps[i]!;
    let j = i + 1;
    while (j < taps.length && taps[j]! - taps[j - 1]! <= 0.45) j++;
    if (j - i >= 3) {
      const end = taps[j - 1]!;
      bursts.push({ t: start, duration: Math.max(0.35, end - start + 0.28) });
    }
    i = j;
  }
  return bursts;
}
