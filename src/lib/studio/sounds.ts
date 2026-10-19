/**
 * Gesture / timeline SFX. Uses bundled MP3s for real actions
 * (click, right-click, whoosh, typing, shimmer) — not fake UI beeps.
 */

import { SOUND_URLS, type SoundKind } from "./soundTrack";

let ctx: AudioContext | null = null;
/** UI click/hover SFX — off by default (can sound cheap); user can enable in Account menu. */
const UI_SOUNDS_KEY = "screenbeaver.uiSounds";
let muted = readStoredMuted();
let unlockBound = false;

function readStoredMuted(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem(UI_SOUNDS_KEY);
    if (v === null) return true; // default: muted
    return v !== "1" && v !== "true" && v !== "on";
  } catch {
    return true;
  }
}

const buffers: Partial<Record<SoundKind, AudioBuffer | null>> = {};
let loadPromise: Promise<void> | null = null;

/** Live typing bed — one looped source stopped when the burst ends. */
let typingBed: { source: AudioBufferSourceNode; gain: GainNode; stopAt: number } | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

async function ensureBuffers() {
  const missing = (Object.keys(SOUND_URLS) as SoundKind[]).filter(
    (k) => buffers[k] === undefined,
  );
  if (missing.length === 0) return;
  // Previous load may have finished before new kinds (e.g. shimmer) were added.
  if (loadPromise) {
    await loadPromise;
    const still = (Object.keys(SOUND_URLS) as SoundKind[]).filter(
      (k) => buffers[k] === undefined,
    );
    if (still.length === 0) return;
    loadPromise = null;
  }
  loadPromise = (async () => {
    const c = getCtx();
    if (!c) return;
    const toLoad = (Object.keys(SOUND_URLS) as SoundKind[]).filter(
      (k) => buffers[k] === undefined,
    );
    try {
      await Promise.all(
        toLoad.map(async (kind) => {
          const res = await fetch(SOUND_URLS[kind]);
          if (!res.ok) {
            buffers[kind] = null;
            return;
          }
          const raw = await res.arrayBuffer();
          try {
            buffers[kind] = await c.decodeAudioData(raw.slice(0));
          } catch (err) {
            console.error("Failed to decode SFX", kind, err);
            buffers[kind] = null;
          }
        }),
      );
    } catch (err) {
      console.error("Failed to load SFX", err);
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/** Call once from a user gesture so later plays work (WebView2 autoplay). */
export function unlockUiSounds() {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  void ensureBuffers();
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const kick = () => {
    const ac = getCtx();
    if (ac?.state === "suspended") void ac.resume();
    void ensureBuffers();
  };
  window.addEventListener("pointerdown", kick, true);
  window.addEventListener("keydown", kick, true);
}

export type PlaySoundOpts = {
  /** How long the sample should be audible (seconds). Typing loops within this. */
  duration?: number;
  gain?: number;
  /** Play only a short keystroke tick from the typing bed (recording feedback). */
  keyTick?: boolean;
};

function playViaElement(url: string, gain: number, duration?: number) {
  try {
    const a = new Audio(url);
    a.volume = Math.min(1, Math.max(0, gain));
    void a.play().catch(() => {});
    if (duration != null && duration > 0) {
      window.setTimeout(() => {
        a.pause();
        a.currentTime = 0;
      }, duration * 1000);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Play a sample. One-shots play once (capped by duration if set).
 * Typing with `duration` loops until that window ends — never the full 8s file alone.
 */
export function playSoundKind(kind: SoundKind, opts: PlaySoundOpts | number = {}) {
  if (muted) return;
  const options: PlaySoundOpts = typeof opts === "number" ? { gain: opts } : opts;
  const gain = options.gain ?? 0.95;
  const url = SOUND_URLS[kind];
  const fallbackDur =
    options.duration ??
    (options.keyTick
      ? 0.08
      : kind === "typing"
        ? 0.35
        : kind === "whoosh"
          ? 0.55
          : kind === "shimmer"
            ? 2.8
            : undefined);
  const c = getCtx();
  if (!c) {
    playViaElement(url, gain, fallbackDur);
    return;
  }

  const fire = (buf: AudioBuffer | null | undefined) => {
    if (muted) return;
    if (!buf) {
      playViaElement(url, gain, fallbackDur);
      return;
    }

    // Short keycap tick while recording — never start the whole 8s asset.
    if (kind === "typing" && options.keyTick) {
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf;
      g.gain.value = gain * 0.85;
      src.connect(g);
      g.connect(c.destination);
      const tick = Math.min(0.085, buf.duration * 0.02);
      src.start(0, 0, tick);
      return;
    }

    // Typing bed: loop a short slice only for the clip window — never the full ~8s file.
    if (kind === "typing") {
      const hold = Math.max(0.12, options.duration ?? 0.35);
      stopTypingBed();
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf;
      src.loop = true;
      const loopEnd = Math.min(buf.duration, 1.2);
      src.loopStart = 0;
      src.loopEnd = loopEnd;
      const level = gain * 0.7;
      g.gain.value = level;
      src.connect(g);
      g.connect(c.destination);
      const stopAt = c.currentTime + hold;
      src.start(0);
      g.gain.setValueAtTime(level, Math.max(0, stopAt - 0.05));
      g.gain.linearRampToValueAtTime(0.0001, stopAt);
      src.stop(stopAt + 0.02);
      typingBed = { source: src, gain: g, stopAt };
      return;
    }

    // Shimmer (glare): play the full useful sample with a soft fade — never a 0.35s stub.
    if (kind === "shimmer") {
      const hold = Math.min(
        buf.duration,
        Math.max(0.8, options.duration ?? Math.min(buf.duration, 3.2)),
      );
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf;
      const level = gain * 0.9;
      g.gain.value = level;
      src.connect(g);
      g.connect(c.destination);
      const t0 = c.currentTime;
      const fade = Math.min(0.25, hold * 0.15);
      g.gain.setValueAtTime(level, t0);
      g.gain.setValueAtTime(level, Math.max(t0, t0 + hold - fade));
      g.gain.linearRampToValueAtTime(0.0001, t0 + hold);
      src.start(0, 0, hold);
      return;
    }

    const src = c.createBufferSource();
    const g = c.createGain();
    src.buffer = buf;
    g.gain.value = gain;
    src.connect(g);
    g.connect(c.destination);
    const maxDur =
      options.duration != null
        ? Math.min(buf.duration, Math.max(0.04, options.duration))
        : Math.min(buf.duration, kind === "whoosh" ? 0.55 : 0.35);
    src.start(0, 0, maxDur);
  };

  const play = async () => {
    await ensureBuffers();
    fire(buffers[kind]);
  };

  if (c.state === "suspended") {
    void c
      .resume()
      .then(play)
      .catch(() => playViaElement(url, gain, fallbackDur));
  } else {
    void play();
  }
}

export function stopTypingBed() {
  if (!typingBed) return;
  try {
    typingBed.gain.gain.cancelScheduledValues(0);
    typingBed.gain.gain.setValueAtTime(0.0001, getCtx()?.currentTime ?? 0);
    typingBed.source.stop();
  } catch {
    /* already stopped */
  }
  typingBed = null;
}

export function playClick() {
  playSoundKind("click");
}

export function playRightClick() {
  playSoundKind("right-click");
}

export function playWhoosh() {
  playSoundKind("whoosh", { duration: 0.55 });
}

/** Glare / clear shimmer (Shining.mp3). */
export function playShimmer() {
  playSoundKind("shimmer", { duration: 3.0 });
}

/** Per-keystroke feedback while recording — short tick only. */
export function playTyping() {
  playSoundKind("typing", { keyTick: true });
}

/** @deprecated soft synthetic — prefer playWhoosh for zooms */
export function playAdd() {
  playWhoosh();
}

export function playToggle(on: boolean) {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const run = () => {
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(on ? 720 : 380, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.06);
  };
  if (c.state === "suspended") void c.resume().then(run).catch(() => {});
  else run();
}

export function playTick() {
  playToggle(true);
}

export function playEdit() {
  playToggle(true);
}

export function setUiSoundsMuted(v: boolean) {
  muted = v;
  if (typeof window === "undefined") return;
  try {
    // Store enabled state (1 = sounds on) so default-missing stays muted.
    localStorage.setItem(UI_SOUNDS_KEY, v ? "0" : "1");
  } catch {
    /* ignore */
  }
  if (v) stopTypingBed();
}

/**
 * Enable or disable click / whoosh / typing / shimmer SFX.
 * Applies to live UI feedback, timeline preview playback, and MP4 export mix.
 */
export function setUiSoundsEnabled(enabled: boolean) {
  setUiSoundsMuted(!enabled);
}

/** Whether timeline SFX (clicks, whoosh, typing, shimmer) mix into export. */
export function exportSfxEnabled() {
  return !muted;
}

export function uiSoundsMuted() {
  return muted;
}

export function uiSoundsEnabled() {
  return !muted;
}

/** Decode all SFX buffers (for export mixing). */
export async function getSoundBuffers(): Promise<Partial<Record<SoundKind, AudioBuffer>>> {
  await ensureBuffers();
  const out: Partial<Record<SoundKind, AudioBuffer>> = {};
  for (const kind of Object.keys(SOUND_URLS) as SoundKind[]) {
    const buf = buffers[kind];
    if (buf) out[kind] = buf;
  }
  return out;
}

export function getAudioContext(): AudioContext | null {
  return getCtx();
}
