import type {
  CursorIconBitmap,
  CursorSample,
  CursorShape,
  RecordingTake,
  CaptionCue,
  KeystrokeCue,
  SceneEffectKind,
} from "./types";
import { shapeFromCssCursor } from "./cursorShapes";
import {
  isTauri,
  listenNativeCursor,
  listenNativeKeystroke,
  listenNativeMarker,
  listenNativeSound,
  startNativePointerHook,
  stopNativePointerHook,
} from "./nativeBridge";
import { playSoundKind, playTyping, unlockUiSounds } from "./sounds";
import {
  defaultSoundDuration,
  effectUsesShimmer,
  newSoundId,
  type SoundClip,
  type SoundKind,
} from "./soundTrack";
import { startLiveBrowserTranscription, supportsBrowserSpeech, normalizeCaptionCues } from "./transcript";
import { CTRL_DIGIT_TO_EFFECT, isSceneEffectKind, SCENE_EFFECT_META } from "./sceneEffects";
import { cueFromNativeKeystroke, cueFromShortcutEvent, mergeKeystrokeCues } from "./keystrokes";

export type SurfaceKind = "application" | "window" | "screen" | "tab" | "android";

export interface StartOptions {
  surface: SurfaceKind;
  camera: boolean;
  microphone: boolean;
  systemAudio: boolean;
  /** When true, the editor draws a smoothed custom cursor over the take. */
  smoothCursor: boolean;
  /** BCP-47 language for live browser speech recognition (AI Voiceover speak lang). */
  speakLang?: string;
  /** USB Android serial when surface === "android". */
  androidSerial?: string;
}

export interface RecorderMarker {
  kind: "zoom" | "camera-move" | "scene-effect";
  t: number;
  x: number;
  y: number;
  /** Present for Alt-hold zooms (seconds). */
  duration?: number;
  /** Ctrl+1…6 cinematic preset. */
  preset?: SceneEffectKind;
}

export interface LiveRecording {
  screenStream: MediaStream;
  cameraStream: MediaStream | null;
  stop: () => Promise<{
    take: RecordingTake;
    markers: RecorderMarker[];
    sounds: SoundClip[];
    captions: CaptionCue[];
    keystrokes: KeystrokeCue[];
  }>;
  cancel: () => void;
  startedAt: number;
  /** Push a zoom/camera/effect marker at the latest cursor sample (for HUD buttons). */
  addMarker: (kind: RecorderMarker["kind"], preset?: SceneEffectKind) => void;
  /** True when the browser can stream pointer coords over the shared surface. */
  hasSurfaceCursor: boolean;
  /** True when Tauri desktop system-wide pointer hook is active. */
  hasDesktopCursor: boolean;
  /** Editor should draw the polished cursor when samples exist. */
  smoothCursor: boolean;
}

type DisplaySurface = "monitor" | "window" | "browser";

/** Chromium CaptureController + CapturedMouseEvent (flagged / progressive). */
type CaptureControllerLike = EventTarget & {
  oncapturedmousechange: ((ev: CapturedMouseEventLike) => void) | null;
  setFocusBehavior?: (behavior: string) => void;
};

interface CapturedMouseEventLike extends Event {
  surfaceX: number;
  surfaceY: number;
}

declare global {
  interface Window {
    CaptureController?: new () => CaptureControllerLike;
  }
}

function pickMime(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

async function readDuration(url: string): Promise<{ d: number; w: number; h: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    const done = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      resolve({ d, w: v.videoWidth, h: v.videoHeight });
    };
    v.onloadedmetadata = () => {
      if (v.duration === Infinity) {
        v.currentTime = 1e101;
        v.ontimeupdate = () => {
          v.ontimeupdate = null;
          v.currentTime = 0;
          done();
        };
      } else done();
    };
    v.onerror = () => resolve({ d: 0, w: 0, h: 0 });
  });
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function readDisplaySurface(track: MediaStreamTrack): DisplaySurface {
  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  const s = settings.displaySurface;
  if (s === "browser" || s === "window" || s === "monitor") return s;
  return "monitor";
}

/**
 * Map a local pointer event into the captured surface's 0..1 space.
 * Tab → viewport; window → this browser window's outer box; monitor → that screen.
 */
function normalizeLocalPointer(e: PointerEvent | MouseEvent, surface: DisplaySurface) {
  if (surface === "browser") {
    return {
      x: clamp01(e.clientX / Math.max(1, window.innerWidth)),
      y: clamp01(e.clientY / Math.max(1, window.innerHeight)),
    };
  }

  if (surface === "window") {
    const w = Math.max(1, window.outerWidth);
    const h = Math.max(1, window.outerHeight);
    return {
      x: clamp01((e.screenX - window.screenX) / w),
      y: clamp01((e.screenY - window.screenY) / h),
    };
  }

  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const left = screen.availLeft ?? 0;
  const top = screen.availTop ?? 0;
  return {
    x: clamp01((e.screenX - left) / Math.max(1, window.screen.width)),
    y: clamp01((e.screenY - top) / Math.max(1, window.screen.height)),
  };
}

function normalizeSurfacePointer(
  surfaceX: number,
  surfaceY: number,
  track: MediaStreamTrack,
): { x: number; y: number } | null {
  if (surfaceX < 0 || surfaceY < 0) return null;
  const settings = track.getSettings();
  const w = Math.max(1, settings.width ?? 1);
  const h = Math.max(1, settings.height ?? 1);
  return { x: clamp01(surfaceX / w), y: clamp01(surfaceY / h) };
}

/**
 * Starts a capture session.
 *
 * The OS cursor stays visible on your desktop while you work. Capture uses
 * `cursor: "never"` so the recording itself has no baked-in pointer — the
 * editor draws the smoothed cursor from samples (desktop hook / extension).
 */
export async function startRecording(opts: StartOptions): Promise<LiveRecording> {
  const displaySurfaceHint =
    opts.surface === "screen" ? "monitor" : opts.surface === "tab" ? "browser" : "window";

  const CaptureCtor = window.CaptureController;
  const controller = CaptureCtor ? new CaptureCtor() : null;
  try {
    controller?.setFocusBehavior?.("no-focus-change");
  } catch {
    /* older Chromium */
  }

  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: displaySurfaceHint,
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      cursor: "never",
    } as MediaTrackConstraints,
    audio: opts.systemAudio
      ? ({
          // Chromium: request system / tab audio when the user checks “Share audio”
          // in the picker. Exact keys vary by version — both are best-effort.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...( { systemAudio: "include", suppressLocalAudioPlayback: false } as any),
        } as MediaTrackConstraints)
      : false,
    ...(controller ? { controller } : {}),
  } as DisplayMediaStreamOptions);

  const videoTrack = screenStream.getVideoTracks()[0];
  const surface = videoTrack ? readDisplaySurface(videoTrack) : displaySurfaceHint;
  if (videoTrack) {
    try {
      await videoTrack.applyConstraints({ cursor: "never" } as unknown as MediaTrackConstraints);
    } catch {
      /* some surfaces ignore */
    }
  }

  const systemAudioTracks = screenStream.getAudioTracks();
  const hasSystemAudio = systemAudioTracks.length > 0;

  let cameraStream: MediaStream | null = null;
  if (opts.camera) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user",
        },
        audio: false,
      });
    } catch {
      cameraStream = null;
    }
  }

  let micStream: MediaStream | null = null;
  if (opts.microphone) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      micStream = null;
    }
  }

  const mime = pickMime();
  const screenChunks: Blob[] = [];
  const screenRecorder = new MediaRecorder(new MediaStream(screenStream.getVideoTracks()), {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
  });
  screenRecorder.ondataavailable = (e) => e.data.size && screenChunks.push(e.data);

  let cameraRecorder: MediaRecorder | null = null;
  const cameraChunks: Blob[] = [];
  if (cameraStream) {
    cameraRecorder = new MediaRecorder(cameraStream, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
    });
    cameraRecorder.ondataavailable = (e) => e.data.size && cameraChunks.push(e.data);
  }

  const audioTracks = [...(micStream?.getAudioTracks() ?? []), ...systemAudioTracks];
  let audioRecorder: MediaRecorder | null = null;
  const audioChunks: Blob[] = [];
  let audioCtx: AudioContext | null = null;
  if (audioTracks.length === 1) {
    // Single source — record the track directly (avoids silent Web Audio when suspended).
    audioRecorder = new MediaRecorder(new MediaStream([audioTracks[0]]), {
      mimeType: "audio/webm",
    });
    audioRecorder.ondataavailable = (e) => e.data.size && audioChunks.push(e.data);
  } else if (audioTracks.length > 1) {
    audioCtx = new AudioContext();
    await audioCtx.resume().catch(() => {});
    const dest = audioCtx.createMediaStreamDestination();
    for (const t of audioTracks) {
      audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    }
    audioRecorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
    audioRecorder.ondataavailable = (e) => e.data.size && audioChunks.push(e.data);
  }
  const hasMicrophone = !!(micStream && micStream.getAudioTracks().length);

  const cursor: CursorSample[] = [];
  const cursorIcons: Record<string, CursorIconBitmap> = {};
  const markers: RecorderMarker[] = [];
  const sounds: SoundClip[] = [];
  const keystrokeCues: KeystrokeCue[] = [];
  const pushKeystroke = (cue: KeystrokeCue | null) => {
    if (!cue) return;
    const merged = mergeKeystrokeCues(keystrokeCues, [cue]);
    keystrokeCues.length = 0;
    keystrokeCues.push(...merged);
  };
  let lastTypingClip: SoundClip | null = null;
  let down = false;
  let lastX = 0.5;
  let lastY = 0.5;
  let lastShape: CursorShape = "arrow";
  let lastIconId: string | undefined;
  let usingSurfaceCursor = false;
  let usingDesktopCursor = false;
  let altHeld = false;
  let altZoom: { start: number; x: number; y: number } | null = null;
  // Timeline zero = MediaRecorder start (set when encoders begin).
  let timelineOrigin: number | null = null;
  const now = () =>
    timelineOrigin == null ? 0 : (performance.now() - timelineOrigin) / 1000;
  const nativeUnsubs: Array<() => void> = [];

  const recordSound = (kind: SoundKind, t = now()) => {
    if (kind === "typing" && lastTypingClip && t - lastTypingClip.time < lastTypingClip.duration + 0.4) {
      lastTypingClip.duration = Math.max(lastTypingClip.duration, t - lastTypingClip.time + 0.4);
      return lastTypingClip;
    }
    const clip: SoundClip = {
      id: newSoundId(kind, t),
      kind,
      time: t,
      duration: defaultSoundDuration(kind),
    };
    sounds.push(clip);
    lastTypingClip = kind === "typing" ? clip : null;
    return clip;
  };

  const gesture = (kind: SoundKind) => {
    recordSound(kind);
    playSoundKind(kind);
  };

  // Captions start after MediaRecorder so cue times match the video timeline.
  let liveCaps: ReturnType<typeof startLiveBrowserTranscription> | null = null;

  const cssShapeAt = (clientX: number, clientY: number): CursorShape => {
    try {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return "arrow";
      return shapeFromCssCursor(getComputedStyle(el).cursor);
    } catch {
      return "arrow";
    }
  };

  const pushCursor = (
    x: number,
    y: number,
    isDown = down,
    shape: CursorShape = lastShape,
    iconId?: string,
  ) => {
    const t = now();
    const prev = cursor[cursor.length - 1];
    // Drop micro-jitter duplicates that make the spring oscillate.
    if (
      prev &&
      t - prev.t < 1 / 90 &&
      Math.hypot(x - prev.x, y - prev.y) < 0.0007 &&
      prev.down === isDown &&
      (prev.shape ?? "arrow") === shape &&
      prev.iconId === iconId
    ) {
      return;
    }
    lastX = x;
    lastY = y;
    lastShape = shape;
    lastIconId = iconId;
    cursor.push({ t, x, y, down: isDown, shape, iconId });
  };

  const addMarker = (kind: RecorderMarker["kind"], preset?: SceneEffectKind) => {
    const clip: RecorderMarker = { kind, t: now(), x: lastX, y: lastY };
    if (kind === "scene-effect" && preset) {
      clip.preset = preset;
      clip.duration = SCENE_EFFECT_META[preset].duration;
    }
    markers.push(clip);
    // Whoosh for zooms / 3D effects; shimmer for glare / window-reveal.
    if (kind === "zoom") gesture("whoosh");
    if (kind === "scene-effect") {
      gesture(preset && effectUsesShimmer(preset) ? "shimmer" : "whoosh");
    }
  };

  const beginAltZoom = () => {
    if (altZoom) return;
    gesture("whoosh");
    altZoom = { start: now(), x: lastX, y: lastY };
  };

  const endAltZoom = () => {
    if (!altZoom) return;
    const dur = Math.max(0.35, now() - altZoom.start);
    markers.push({
      kind: "zoom",
      t: altZoom.start,
      x: altZoom.x,
      y: altZoom.y,
      duration: dur,
    });
    altZoom = null;
  };

  const setAlt = (next: boolean) => {
    if (next && !altHeld) beginAltZoom();
    if (!next && altHeld) endAltZoom();
    altHeld = next;
  };

  const preferExternal = () => usingDesktopCursor || usingSurfaceCursor;

  const onMove = (e: PointerEvent | MouseEvent) => {
    if (preferExternal()) return;
    const p = normalizeLocalPointer(e, surface);
    const shape = cssShapeAt(e.clientX, e.clientY);
    pushCursor(p.x, p.y, down, shape);
    if (altZoom) {
      altZoom.x = p.x;
      altZoom.y = p.y;
    }
  };
  const onDown = (e: MouseEvent) => {
    down = true;
    if (!usingDesktopCursor) {
      if (e.button === 2) gesture("right-click");
      else if (e.button === 0) gesture("click");
    }
    if (!preferExternal()) {
      const p = normalizeLocalPointer(e, surface);
      pushCursor(p.x, p.y, true, cssShapeAt(e.clientX, e.clientY));
    } else {
      pushCursor(lastX, lastY, true, lastShape, lastIconId);
    }
    // Desktop hook already emits Shift/Ctrl+Click zooms — avoid duplicates.
    if (e.button === 0 && (e.shiftKey || e.ctrlKey) && !usingDesktopCursor) addMarker("zoom");
  };
  const onUp = (e: MouseEvent) => {
    down = false;
    if (!preferExternal()) {
      const p = normalizeLocalPointer(e, surface);
      pushCursor(p.x, p.y, false, cssShapeAt(e.clientX, e.clientY));
    } else {
      pushCursor(lastX, lastY, false, lastShape, lastIconId);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "AltLeft" || e.code === "AltRight" || e.key === "Alt") {
      setAlt(true);
    }
    if (e.shiftKey && e.code === "Space") {
      e.preventDefault();
      if (!usingDesktopCursor) {
        addMarker("camera-move");
        pushKeystroke(
          cueFromShortcutEvent(now(), {
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey,
            shift: e.shiftKey,
            key: e.key,
            code: e.code,
          }),
        );
      }
      return;
    }
    // Ctrl+1…6 cinematic effects (also captured by desktop hook when focused elsewhere)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const preset = CTRL_DIGIT_TO_EFFECT[e.code];
      if (preset) {
        e.preventDefault();
        if (!usingDesktopCursor) {
          addMarker("scene-effect", preset);
          pushKeystroke(
            cueFromShortcutEvent(now(), {
              ctrl: e.ctrlKey,
              meta: e.metaKey,
              alt: e.altKey,
              shift: e.shiftKey,
              key: e.key,
              code: e.code,
            }),
          );
        }
        return;
      }
    }
    // Browser-only shortcut overlays (desktop hook emits native-keystroke instead).
    if (!usingDesktopCursor) {
      pushKeystroke(
        cueFromShortcutEvent(now(), {
          ctrl: e.ctrlKey,
          meta: e.metaKey,
          alt: e.altKey,
          shift: e.shiftKey,
          key: e.key,
          code: e.code,
        }),
      );
    }
    // Typing SFX — printable keys / backspace (not pure modifiers).
    if (
      !usingDesktopCursor &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter")
    ) {
      recordSound("typing");
      playTyping();
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    // Keep right-click audible during capture without opening menus over the HUD.
    if (liveCaps || usingDesktopCursor) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "AltLeft" || e.code === "AltRight" || e.key === "Alt") {
      setAlt(false);
    }
  };

  const onCapturedMouse = (ev: Event) => {
    if (usingDesktopCursor) return;
    const e = ev as CapturedMouseEventLike;
    if (!videoTrack) return;
    const p = normalizeSurfacePointer(e.surfaceX, e.surfaceY, videoTrack);
    if (!p) return;
    usingSurfaceCursor = true;
    pushCursor(p.x, p.y, down, lastShape);
    if (altZoom) {
      altZoom.x = p.x;
      altZoom.y = p.y;
    }
  };

  let hasSurfaceCursor = false;
  if (controller) {
    try {
      controller.addEventListener("capturedmousechange", onCapturedMouse);
      controller.oncapturedmousechange = onCapturedMouse;
      hasSurfaceCursor = supportsSurfaceCursor();
    } catch {
      hasSurfaceCursor = false;
    }
  }

  let hasDesktopCursor = false;
  unlockUiSounds();
  if (isTauri()) {
    hasDesktopCursor = await startNativePointerHook();
    if (hasDesktopCursor) {
      usingDesktopCursor = true;
      let prevDown = false;
      let prevRight = false;
      nativeUnsubs.push(
        await listenNativeCursor((ev) => {
          usingDesktopCursor = true;
          if (ev.down && !prevDown) gesture("click");
          if (ev.right && !prevRight) gesture("right-click");
          prevDown = ev.down;
          prevRight = !!ev.right;
          down = ev.down;
          if (ev.icon && ev.iconId) {
            cursorIcons[ev.iconId] = ev.icon;
          }
          const shape = ev.shape ?? "arrow";
          pushCursor(ev.x, ev.y, ev.down, shape, ev.iconId);
          if (altZoom) {
            altZoom.x = ev.x;
            altZoom.y = ev.y;
          }
          setAlt(!!ev.alt);
        }),
      );
      nativeUnsubs.push(
        await listenNativeMarker((ev) => {
          lastX = ev.x;
          lastY = ev.y;
          if (ev.kind === "scene-effect") {
            const preset =
              ev.preset && isSceneEffectKind(ev.preset) ? ev.preset : undefined;
            if (!preset) return;
            markers.push({
              kind: "scene-effect",
              t: now(),
              x: ev.x,
              y: ev.y,
              preset,
              duration: SCENE_EFFECT_META[preset].duration,
            });
            gesture(effectUsesShimmer(preset) ? "shimmer" : "whoosh");
            return;
          }
          markers.push({
            kind: ev.kind,
            t: now(),
            x: ev.x,
            y: ev.y,
            duration: ev.duration,
          });
          if (ev.kind === "zoom") gesture("whoosh");
        }),
      );
      nativeUnsubs.push(
        await listenNativeSound((ev) => {
          if (ev.kind === "typing") {
            recordSound("typing");
            playTyping();
          }
        }),
      );
      nativeUnsubs.push(
        await listenNativeKeystroke((ev) => {
          pushKeystroke(cueFromNativeKeystroke(now(), ev.label, ev.keys ?? []));
        }),
      );
    }
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("blur", () => setAlt(false));

  const cleanup = () => {
    endAltZoom();
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("contextmenu", onContextMenu, true);
    if (controller) {
      try {
        controller.removeEventListener("capturedmousechange", onCapturedMouse);
        controller.oncapturedmousechange = null;
      } catch {
        /* ignore */
      }
    }
    nativeUnsubs.forEach((u) => u());
    void stopNativePointerHook();
    screenStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    if (audioCtx) void audioCtx.close().catch(() => {});
  };

  // Zero the timeline, warm up ASR, then start encoders so speech times match video.
  timelineOrigin = performance.now();
  if (hasMicrophone && supportsBrowserSpeech()) {
    liveCaps = startLiveBrowserTranscription(timelineOrigin, opts.speakLang);
  }
  screenRecorder.start(1000);
  cameraRecorder?.start(1000);
  audioRecorder?.start(1000);

  const sourceLabel = videoTrack?.label || "Screen";

  const stopRecorder = (r: MediaRecorder | null) =>
    new Promise<void>((resolve) => {
      if (!r || r.state === "inactive") return resolve();
      r.onstop = () => resolve();
      r.stop();
    });

  return {
    screenStream,
    cameraStream,
    get startedAt() {
      return timelineOrigin ?? performance.now();
    },
    addMarker,
    hasSurfaceCursor,
    hasDesktopCursor,
    smoothCursor: opts.smoothCursor,
    cancel: () => {
      liveCaps?.stop();
      cleanup();
      cameraStream?.getTracks().forEach((t) => t.stop());
      [screenRecorder, cameraRecorder, audioRecorder].forEach((r) => {
        if (r && r.state !== "inactive") r.stop();
      });
    },
    stop: async () => {
      const elapsed = now();
      const rawCaptions = liveCaps?.stop() ?? [];
      await Promise.all([
        stopRecorder(screenRecorder),
        stopRecorder(cameraRecorder),
        stopRecorder(audioRecorder),
      ]);
      cleanup();

      const screenUrl = URL.createObjectURL(new Blob(screenChunks, { type: mime }));
      const meta = await readDuration(screenUrl);
      const cameraUrl = cameraChunks.length
        ? URL.createObjectURL(new Blob(cameraChunks, { type: mime }))
        : null;
      const micUrl = audioChunks.length
        ? URL.createObjectURL(new Blob(audioChunks, { type: "audio/webm" }))
        : null;

      const duration = meta.d || elapsed;
      // Clamp only — do not scale (scaling stretches ASR lag into worse misalignment).
      const captions = normalizeCaptionCues(rawCaptions, duration);

      // Keep cursor/markers in the same time base as the video duration.
      if (elapsed > 0.5 && Math.abs(duration - elapsed) > 0.4) {
        const scale = duration / elapsed;
        for (const s of cursor) s.t *= scale;
        for (const m of markers) m.t *= scale;
        for (const s of sounds) s.time *= scale;
        for (const k of keystrokeCues) k.time *= scale;
      }

      const take: RecordingTake = {
        screenUrl,
        cameraUrl,
        micUrl,
        duration,
        width: meta.w || 1920,
        height: meta.h || 1080,
        cursor,
        cursorIcons: Object.keys(cursorIcons).length ? cursorIcons : undefined,
        createdAt: Date.now(),
        sourceLabel,
        hasMicrophone,
        hasSystemAudio,
        captureSurface: surface,
      };
      return { take, markers, sounds: sounds.slice(), captions, keystrokes: keystrokeCues.slice() };
    },
  };
}

export function supportsCapture(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export function supportsSurfaceCursor(): boolean {
  if (typeof window === "undefined" || typeof window.CaptureController !== "function") return false;
  try {
    return "oncapturedmousechange" in window.CaptureController.prototype;
  } catch {
    return false;
  }
}
