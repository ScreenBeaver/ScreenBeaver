import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Film, Plus, Search, Video, X, Volume2, MessageSquare, Sparkles, Scissors } from "lucide-react";
import { useClock, useStudio, formatTimecode } from "@/lib/studio/store";
import type { CameraMoveKind, SceneEffectKind, SoundKind } from "@/lib/studio/types";
import { playSoundKind, playWhoosh } from "@/lib/studio/sounds";
import { effectUsesShimmer } from "@/lib/studio/soundTrack";
import {
  defaultSoundDuration,
  newSoundId,
  SOUND_LABELS,
} from "@/lib/studio/soundTrack";
import {
  createEffectBundle,
  SCENE_EFFECT_KINDS,
  SCENE_EFFECT_META,
} from "@/lib/studio/sceneEffects";
import { getVideoSegments, layoutVideoSegments, reorderIndexAtTimeline, editDuration, sourceToTimeline, timelineToSource, hasVideoCuts } from "@/lib/studio/videoEdit";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  applyProjectFile,
  clearPendingRelink,
  getPendingRelink,
  getProjectLibraryEntry,
  readProjectFileFull,
  type ApplyProjectResult,
} from "@/lib/studio/projectFiles";
import { persistTakeMedia } from "@/lib/studio/projectMedia";
import { makeTakeFromLocalVideoFile } from "@/lib/studio/localVideoImport";
import { classifyMediaFile } from "@/lib/studio/mediaKind";

const MIN_CLIP = 0.35;
const MIN_SOUND = 0.12;
const MIN_CAPTION = 0.4;
const MIN_TRIM_SPAN = 0.5;
const MIN_SEG_TRIM = 0.2;

const TIMELINE_H_KEY = "sw-timeline-height";
const TIMELINE_H_DEFAULT = 240;
const TIMELINE_H_MIN = 148;
const TIMELINE_H_MAX_RATIO = 0.58;

function readStoredTimelineHeight(): number {
  if (typeof window === "undefined") return TIMELINE_H_DEFAULT;
  const n = Number(window.localStorage.getItem(TIMELINE_H_KEY));
  if (!Number.isFinite(n)) return TIMELINE_H_DEFAULT;
  const { min, max } = timelineHeightBounds();
  return clamp(n, min, max);
}

function timelineHeightBounds() {
  if (typeof window === "undefined") {
    return { min: TIMELINE_H_MIN, max: 480 };
  }
  return {
    min: TIMELINE_H_MIN,
    max: Math.max(TIMELINE_H_MIN + 40, Math.round(window.innerHeight * TIMELINE_H_MAX_RATIO)),
  };
}

function useWaveform(seed: number, count = 48) {
  return useMemo(() => {
    let s = seed || 1;
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    return Array.from({ length: count }, (_, i) => {
      const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 14));
      return 0.18 + rand() * 0.82 * env;
    });
  }, [seed, count]);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

type DragKind =
  | { type: "seek" }
  | { type: "trim-start" }
  | { type: "trim-end" }
  | { type: "zoom-move"; id: string; originTime: number; originX: number }
  | { type: "zoom-start"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "zoom-end"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "move-move"; id: string; originTime: number; originX: number }
  | { type: "move-start"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "move-end"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "effect-move"; id: string; originTime: number; originX: number }
  | { type: "effect-start"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "effect-end"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "sound-move"; id: string; originTime: number; originX: number }
  | { type: "sound-start"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "sound-end"; id: string; originTime: number; originDur: number; originX: number }
  | { type: "cap-move"; id: string; originStart: number; originEnd: number; originX: number }
  | { type: "cap-start"; id: string; originStart: number; originEnd: number; originX: number }
  | { type: "cap-end"; id: string; originStart: number; originEnd: number; originX: number }
  | { type: "video-reorder"; id: string; fromIndex: number; originX: number }
  | {
      type: "video-start";
      id: string;
      originIn: number;
      originOut: number;
      originLaneStart: number;
      speed: number;
    }
  | {
      type: "video-end";
      id: string;
      originIn: number;
      originOut: number;
      originLaneStart: number;
      speed: number;
    };

const SOUND_COLORS: Record<SoundKind, string> = {
  click: "bg-clip-audio",
  "right-click": "bg-clip-audio/90",
  whoosh: "bg-clip-audio/80",
  typing: "bg-clip-audio",
  shimmer: "bg-clip-audio/95",
};

/** Captions share a cooler teal so they don't collide with SFX gold */
const CAPTION_CLIP =
  "group absolute top-0.5 flex h-[calc(100%-4px)] min-w-[36px] cursor-grab items-center rounded-sm bg-clip-cap px-1.5 text-[10px] font-medium text-clip-cap-fg clip-block active:cursor-grabbing";

const TOOL_BTN =
  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-panel-raised hover:text-foreground disabled:opacity-35";

function LaneLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-0 z-20 flex w-10 items-center justify-end pr-1.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Timeline({
  onProjectOpened,
}: {
  onProjectOpened?: (result: ApplyProjectResult) => void;
} = {}) {
  const studio = useStudio();
  const {
    take,
    project,
    clock,
    screenRef,
    cameraRef,
    micRef,
    selectedZoom,
    setSelectedZoom,
    selectedMove,
    setSelectedMove,
    selectedSound,
    setSelectedSound,
    selectedCaption,
    setSelectedCaption,
    selectedEffect,
    setSelectedEffect,
    selectedVideoSegment,
    setSelectedVideoSegment,
    removeVideoSegment,
    setInspector,
    patchVideoSegment,
    reorderVideoSegment,
    updateZoom,
    updateMove,
    updateEffect,
    updateSound,
    updateCaptionCue,
    removeZoom,
    removeMove,
    removeEffect,
    removeSound,
    removeCaptionCue,
    addZoom,
    addMove,
    addEffect,
    addSound,
    addCaptionCue,
    patchTrim,
    splitSelectedAt,
    beginHistoryBatch,
    endHistoryBatch,
    reset,
    replaceProject,
    setTake,
    patchMusic,
  } = studio;
  const { time } = useClock();
  const scrubRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const [panelHeight, setPanelHeight] = useState(readStoredTimelineHeight);
  const [dragActive, setDragActive] = useState(false);
  const [viewportW, setViewportW] = useState(800);
  const resizeDrag = useRef<{ startY: number; startH: number } | null>(null);
  const sourceDuration = take?.duration || 12;
  const multiCut = hasVideoCuts(project);
  // After cuts, the video lane is packed edit-time; keep playhead/clips on that ruler.
  const duration =
    multiCut && take
      ? Math.max(0.001, editDuration(project, sourceDuration))
      : sourceDuration;
  const trimStart = project.trim.start || 0;
  const trimEnd = project.trim.end > 0 ? project.trim.end : sourceDuration;
  const wave = useWaveform(take?.createdAt ?? 7);

  // ~48px per second; grow with duration so long takes scroll horizontally
  const pxPerSec = useMemo(() => {
    if (duration <= 8) return 64;
    if (duration <= 20) return 48;
    if (duration <= 60) return 36;
    return 28;
  }, [duration]);
  const trackWidth = Math.max(viewportW, Math.ceil(duration * pxPerSec) + 48);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportW(Math.max(320, el.clientWidth));
    });
    ro.observe(el);
    setViewportW(Math.max(320, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const clampH = () => {
      const { min, max } = timelineHeightBounds();
      setPanelHeight((h) => clamp(h, min, max));
    };
    clampH();
    window.addEventListener("resize", clampH);
    return () => window.removeEventListener("resize", clampH);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TIMELINE_H_KEY, String(Math.round(panelHeight)));
    } catch {
      /* ignore */
    }
  }, [panelHeight]);

  // Window-level drag so shrinking still works when the pointer leaves the thin grip.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = resizeDrag.current;
      if (!drag) return;
      const { min, max } = timelineHeightBounds();
      const next = clamp(drag.startH + (drag.startY - e.clientY), min, max);
      setPanelHeight(next);
    };
    const onUp = () => {
      resizeDrag.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeDrag.current = { startY: e.clientY, startH: panelHeight };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const resetTimelineHeight = () => {
    const { min, max } = timelineHeightBounds();
    setPanelHeight(clamp(TIMELINE_H_DEFAULT, min, max));
  };

  const seekMedia = useCallback(
    (t: number) => {
      const clamped = clamp(t, 0, sourceDuration);
      clock.set(clamped);
      const screen = screenRef.current;
      const camera = cameraRef.current;
      const mic = micRef.current;
      if (screen) {
        try {
          screen.currentTime = clamped;
        } catch {
          /* not ready */
        }
      }
      if (camera) {
        try {
          camera.currentTime = clamped;
        } catch {
          /* not ready */
        }
      }
      if (mic) {
        try {
          mic.currentTime = clamped;
        } catch {
          /* not ready */
        }
      }
    },
    [clock, sourceDuration, screenRef, cameraRef, micRef],
  );

  /** Pointer x → lane time (edit time when multi-cut, else source). */
  const clientToLaneTime = useCallback(
    (clientX: number) => {
      const scrub = scrubRef.current;
      if (!scrub) return 0;
      const box = scrub.getBoundingClientRect();
      const x = clientX - box.left;
      return clamp((x / Math.max(1, box.width)) * duration, 0, duration);
    },
    [duration],
  );

  /** Pointer x → source media time (what the clock / video use). */
  const clientToSourceTime = useCallback(
    (clientX: number) => {
      const laneT = clientToLaneTime(clientX);
      if (!multiCut || !take) return laneT;
      return timelineToSource(project, sourceDuration, laneT);
    },
    [clientToLaneTime, multiCut, take, project, sourceDuration],
  );

  const clientToTime = clientToSourceTime;

  const applyDrag = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const t = clientToSourceTime(clientX);
      const laneT = clientToLaneTime(clientX);

      if (drag.type === "seek") {
        seekMedia(t);
        return;
      }
      if (drag.type === "trim-start") {
        patchTrim({ start: clamp(t, 0, trimEnd - MIN_TRIM_SPAN) });
        return;
      }
      if (drag.type === "trim-end") {
        patchTrim({ end: clamp(t, trimStart + MIN_TRIM_SPAN, sourceDuration) });
        return;
      }
      if (drag.type === "zoom-move") {
        const dt = clientToSourceTime(clientX) - clientToSourceTime(drag.originX);
        const z = project.zooms.find((x) => x.id === drag.id);
        if (!z) return;
        const next = clamp(drag.originTime + dt, 0, sourceDuration - z.duration);
        updateZoom(drag.id, { time: next });
        return;
      }
      if (drag.type === "zoom-start") {
        const z = project.zooms.find((x) => x.id === drag.id);
        if (!z) return;
        const end = drag.originTime + drag.originDur;
        const nextStart = clamp(t, 0, end - MIN_CLIP);
        updateZoom(drag.id, { time: nextStart, duration: end - nextStart });
        return;
      }
      if (drag.type === "zoom-end") {
        const nextEnd = clamp(t, drag.originTime + MIN_CLIP, sourceDuration);
        updateZoom(drag.id, { duration: nextEnd - drag.originTime });
        return;
      }
      if (drag.type === "move-move") {
        const dt = clientToSourceTime(clientX) - clientToSourceTime(drag.originX);
        const m = project.moves.find((x) => x.id === drag.id);
        if (!m) return;
        const next = clamp(drag.originTime + dt, 0, sourceDuration - m.duration);
        updateMove(drag.id, { time: next });
        return;
      }
      if (drag.type === "move-start") {
        const m = project.moves.find((x) => x.id === drag.id);
        if (!m) return;
        const end = drag.originTime + drag.originDur;
        const nextStart = clamp(t, 0, end - MIN_CLIP);
        updateMove(drag.id, { time: nextStart, duration: end - nextStart });
        return;
      }
      if (drag.type === "move-end") {
        const nextEnd = clamp(t, drag.originTime + MIN_CLIP, sourceDuration);
        updateMove(drag.id, { duration: nextEnd - drag.originTime });
        return;
      }
      if (drag.type === "effect-move") {
        const dt = clientToSourceTime(clientX) - clientToSourceTime(drag.originX);
        const fx = (project.effects ?? []).find((x) => x.id === drag.id);
        if (!fx) return;
        const next = clamp(drag.originTime + dt, 0, sourceDuration - fx.duration);
        updateEffect(drag.id, { time: next });
        return;
      }
      if (drag.type === "effect-start") {
        const fx = (project.effects ?? []).find((x) => x.id === drag.id);
        if (!fx) return;
        const end = drag.originTime + drag.originDur;
        const nextStart = clamp(t, 0, end - MIN_CLIP);
        updateEffect(drag.id, { time: nextStart, duration: end - nextStart });
        return;
      }
      if (drag.type === "effect-end") {
        const nextEnd = clamp(t, drag.originTime + MIN_CLIP, sourceDuration);
        updateEffect(drag.id, { duration: nextEnd - drag.originTime });
        return;
      }
      if (drag.type === "sound-move") {
        const dt = clientToSourceTime(clientX) - clientToSourceTime(drag.originX);
        const s = (project.sounds ?? []).find((x) => x.id === drag.id);
        if (!s) return;
        const next = clamp(drag.originTime + dt, 0, sourceDuration - s.duration);
        updateSound(drag.id, { time: next });
        return;
      }
      if (drag.type === "sound-start") {
        const s = (project.sounds ?? []).find((x) => x.id === drag.id);
        if (!s) return;
        const end = drag.originTime + drag.originDur;
        const nextStart = clamp(t, 0, end - MIN_SOUND);
        updateSound(drag.id, { time: nextStart, duration: end - nextStart });
        return;
      }
      if (drag.type === "sound-end") {
        const nextEnd = clamp(t, drag.originTime + MIN_SOUND, sourceDuration);
        updateSound(drag.id, { duration: nextEnd - drag.originTime });
        return;
      }
      if (drag.type === "cap-move") {
        const dt = clientToSourceTime(clientX) - clientToSourceTime(drag.originX);
        const len = drag.originEnd - drag.originStart;
        const nextStart = clamp(drag.originStart + dt, 0, sourceDuration - len);
        updateCaptionCue(drag.id, { start: nextStart, end: nextStart + len });
        return;
      }
      if (drag.type === "cap-start") {
        const nextStart = clamp(t, 0, drag.originEnd - MIN_CAPTION);
        updateCaptionCue(drag.id, { start: nextStart });
        return;
      }
      if (drag.type === "cap-end") {
        const nextEnd = clamp(t, drag.originStart + MIN_CAPTION, sourceDuration);
        updateCaptionCue(drag.id, { end: nextEnd });
        return;
      }
      if (drag.type === "video-reorder") {
        const toIndex = reorderIndexAtTimeline(project, sourceDuration, laneT, drag.id);
        reorderVideoSegment(drag.id, toIndex);
        return;
      }
      if (drag.type === "video-start") {
        const nextIn = clamp(
          drag.originIn + (laneT - drag.originLaneStart) * drag.speed,
          0,
          drag.originOut - MIN_SEG_TRIM,
        );
        patchVideoSegment(drag.id, { in: nextIn });
        return;
      }
      if (drag.type === "video-end") {
        const nextOut = clamp(
          drag.originIn + (laneT - drag.originLaneStart) * drag.speed,
          drag.originIn + MIN_SEG_TRIM,
          sourceDuration,
        );
        patchVideoSegment(drag.id, { out: nextOut });
      }
    },
    [
      clientToSourceTime,
      clientToLaneTime,
      seekMedia,
      patchTrim,
      trimEnd,
      trimStart,
      sourceDuration,
      project,
      project.zooms,
      project.moves,
      project.effects,
      project.sounds,
      updateZoom,
      updateMove,
      updateEffect,
      updateSound,
      updateCaptionCue,
      reorderVideoSegment,
      patchVideoSegment,
    ],
  );

  const beginDrag = (kind: DragKind, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = kind;
  };

  // Window-level drag — clips capture pointer on themselves, so parent handlers never fire.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      applyDrag(e.clientX);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyDrag]);

  const ticks = useMemo(() => {
    // Prefer 2s marks (2, 4, 6…) as requested; fall back for very short/long takes
    let step = 2;
    if (duration <= 6) step = 1;
    else if (duration > 90) step = 5;
    else if (duration > 180) step = 10;
    const out: number[] = [0];
    for (let t = step; t <= duration + 0.001; t += step) {
      out.push(Math.round(t * 1000) / 1000);
    }
    if (out[out.length - 1] < duration - 0.05) out.push(Math.round(duration * 10) / 10);
    return out;
  }, [duration]);

  const pct = (t: number) => `${clamp((t / Math.max(0.001, duration)) * 100, 0, 100)}%`;
  const sourceToLane = (sourceT: number) => {
    if (!multiCut || !take) return sourceT;
    return sourceToTimeline(project, sourceDuration, sourceT) ?? 0;
  };
  const laneRange = (start: number, len: number) => {
    if (!multiCut || !take) return { left: pct(start), width: pct(Math.max(0.05, len)) };
    const a = sourceToTimeline(project, sourceDuration, start);
    if (a == null) return null;
    const b = sourceToTimeline(project, sourceDuration, start + len);
    const end = b ?? a + len / Math.max(0.5, project.speed || 1);
    return { left: pct(a), width: pct(Math.max(0.05, end - a)) };
  };
  const playheadLeft = pct(sourceToLane(time));
  const trimmed = Math.max(0, trimEnd - trimStart);

  // Keep playhead visible while scrubbing/playing
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const x = (sourceToLane(time) / Math.max(0.001, duration)) * trackWidth;
    const left = sc.scrollLeft;
    const right = left + sc.clientWidth;
    const margin = 48;
    if (x < left + margin) sc.scrollLeft = Math.max(0, x - margin);
    else if (x > right - margin) sc.scrollLeft = x - sc.clientWidth + margin;
  }, [time, duration, trackWidth, multiCut, project, sourceDuration, take]);

  // Cut is handled via studio.splitSelectedAt from the Stage scissors button.

  const selectOnly = (
    kind: "zoom" | "move" | "effect" | "sound" | "caption",
    id: string,
  ) => {
    setSelectedZoom(kind === "zoom" ? id : null);
    setSelectedMove(kind === "move" ? id : null);
    setSelectedEffect(kind === "effect" ? id : null);
    setSelectedSound(kind === "sound" ? id : null);
    setSelectedCaption(kind === "caption" ? id : null);
    setSelectedVideoSegment(null);
  };

  const cutSelected = () => {
    const { ok, message } = splitSelectedAt(clock.time);
    if (ok) toast.success(message);
    else toast.message(message);
  };

  const insertZoom = () => {
    if (!take) return;
    const t = clamp(clock.time, trimStart, Math.max(trimStart, trimEnd - 2.4));
    const id = `z-${Date.now()}`;
    playWhoosh();
    addZoom({
      id,
      time: t,
      duration: Math.min(2.4, sourceDuration - t),
      scale: 2.15,
      x: 0.5,
      y: 0.5,
      followCursor: true,
      auto: false,
    });
    addSound({
      id: newSoundId("whoosh", t),
      kind: "whoosh",
      time: t,
      duration: defaultSoundDuration("whoosh"),
    });
    setSelectedZoom(id);
    setSelectedMove(null);
    setSelectedSound(null);
    setSelectedCaption(null);
    setSelectedEffect(null);
  };

  const insertMove = (kind: CameraMoveKind = "arc-lr") => {
    if (!take) return;
    const t = clamp(clock.time, trimStart, Math.max(trimStart, trimEnd - 1.6));
    const id = `m-${Date.now()}`;
    addMove({ id, time: t, duration: Math.min(1.6, sourceDuration - t), kind });
    setSelectedMove(id);
    setSelectedZoom(null);
    setSelectedSound(null);
    setSelectedCaption(null);
    setSelectedEffect(null);
  };

  const insertEffect = (kind: SceneEffectKind) => {
    if (!take) return;
    const meta = SCENE_EFFECT_META[kind];
    const t = clamp(clock.time, trimStart, Math.max(trimStart, trimEnd - meta.duration));
    const cursor = take.cursor;
    let fx = 0.5;
    let fy = 0.42;
    if (cursor.length) {
      let best = cursor[0]!;
      let bestD = Math.abs(best.t - t);
      for (const s of cursor) {
        const d = Math.abs(s.t - t);
        if (d < bestD) {
          best = s;
          bestD = d;
        }
      }
      fx = best.x;
      fy = best.y;
    }
    const bundle = createEffectBundle(kind, t, { x: fx, y: fy }, project.zoom?.autoScale ?? 2.15);
    beginHistoryBatch();
    addEffect(bundle.effect);
    for (const z of bundle.zooms) addZoom(z);
    for (const m of bundle.moves) addMove(m);
    endHistoryBatch();
    playSoundKind(effectUsesShimmer(kind) ? "shimmer" : "whoosh", {
      duration: effectUsesShimmer(kind) ? 2.8 : 0.55,
    });
    if (effectUsesShimmer(kind)) {
      addSound({
        id: newSoundId("shimmer", t),
        kind: "shimmer",
        time: t,
        duration: defaultSoundDuration("shimmer"),
      });
    }
    setSelectedEffect(bundle.effect.id);
    setSelectedZoom(bundle.zooms[0]?.id ?? null);
    setSelectedMove(null);
    setSelectedSound(null);
    setSelectedCaption(null);
  };

  const insertSound = (kind: SoundKind) => {
    if (!take) return;
    const t = clamp(clock.time, trimStart, Math.max(trimStart, trimEnd - 0.2));
    const id = newSoundId(kind, t);
    const clipDur = defaultSoundDuration(kind);
    playSoundKind(kind, { duration: kind === "typing" ? clipDur : undefined });
    addSound({ id, kind, time: t, duration: clipDur });
    setSelectedSound(id);
    setSelectedZoom(null);
    setSelectedMove(null);
    setSelectedCaption(null);
    setSelectedEffect(null);
  };

  const insertCaption = () => {
    if (!take) return;
    const t = clamp(clock.time, trimStart, Math.max(trimStart, trimEnd - 2));
    const id = `cap-${Date.now()}`;
    addCaptionCue({
      id,
      start: t,
      end: Math.min(sourceDuration, t + 2.4),
      text: "New caption",
    });
    setSelectedCaption(id);
    setSelectedZoom(null);
    setSelectedMove(null);
    setSelectedSound(null);
  };

  const sounds = project.sounds ?? [];
  const cues = project.captions?.cues ?? [];
  const videoSegments = take ? getVideoSegments(project, take.duration) : [];
  const videoSpans = take ? layoutVideoSegments(project, take.duration) : [];
  const videoSelected =
    !!selectedVideoSegment ||
    (!selectedZoom && !selectedMove && !selectedEffect && !selectedSound && !selectedCaption);
  const activeClipId =
    selectedVideoSegment ??
    (videoSegments.length === 1 ? videoSegments[0]?.id ?? null : null);
  const activeClipSpeed = activeClipId
    ? (videoSpans.find((s) => s.id === activeClipId)?.speed ??
      project.speed ??
      1)
    : project.speed;

  return (
    <section
      className="relative flex min-h-0 shrink-0 flex-col overflow-hidden bg-background hairline-t"
      style={{ height: panelHeight, maxHeight: panelHeight }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragActive(false);
        const dt = e.dataTransfer;

        // Internal drag: project from StartPage
        const projectId = dt.getData("application/x-sw-project-id");
        if (projectId) {
          const entry = getProjectLibraryEntry(projectId);
          if (!entry) {
            toast.error("Project not found");
            return;
          }
          const result = await applyProjectFile(entry.file, { replaceProject, setTake }, {
            fallbackMediaId: entry.id,
          });
          onProjectOpened?.({
            ...result,
            mediaId: result.mediaId ?? entry.id,
          });
          if (result.hasVideo) toast.success("Project applied");
          else {
            toast.message("Project settings applied", {
              description: "Link the screen recording to restore the video.",
            });
          }
          return;
        }

        const files = dt.files;
        if (!files || files.length === 0) return;
        const arr = Array.from(files);

        // Project file (.yasharka)
        const projFile = arr.find((f) => f.name.toLowerCase().endsWith(".yasharka"));
        if (projFile) {
          try {
            const unpacked = await readProjectFileFull(projFile);
            const result = await applyProjectFile(unpacked.file, { replaceProject, setTake }, {
              embeddedBlobs: unpacked.blobs,
            });
            onProjectOpened?.(result);
            if (result.hasVideo) toast.success("Project loaded");
            else {
              toast.message("Project settings loaded", {
                description: "Link the screen recording to restore the video.",
              });
            }
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Project load failed");
          }
          return;
        }

        // Local audio => background music bed
        const audioFile = arr.find((f) => classifyMediaFile(f) === "audio");
        if (audioFile) {
          try {
            patchMusic({
              enabled: true,
              url: URL.createObjectURL(audioFile),
              title: audioFile.name.replace(/\.[^.]+$/, ""),
              creator: "",
              license: "",
              volume: 0.16,
              loop: true,
              sourceId: undefined,
            });
            toast.success("Background music loaded");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Audio import failed");
          }
          return;
        }

        // Local video => import into the stage (create take / relink without wiping edits)
        const videoFile = arr.find((f) => classifyMediaFile(f) === "video");
        if (videoFile) {
          try {
            const pending = getPendingRelink();
            const nextTake = await makeTakeFromLocalVideoFile(videoFile, pending?.cursor ?? []);
            if (!take) {
              setTake(nextTake);
              if (pending?.mediaId) void persistTakeMedia(pending.mediaId, nextTake);
              clearPendingRelink();
              onProjectOpened?.({
                hasVideo: true,
                mediaId: pending?.mediaId,
                sourceLabel: nextTake.sourceLabel,
              });
              toast.success("Video linked", { description: videoFile.name });
            } else {
              reset();
              setTake(nextTake);
              toast.success("Video imported");
            }
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Video import failed");
          }
        }
      }}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-30 ring-2 ring-ember ring-offset-2 ring-offset-panel bg-black/20" />
      )}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        title="Drag to resize timeline · double-click to reset"
        onPointerDown={onResizePointerDown}
        onDoubleClick={resetTimelineHeight}
        className="group absolute inset-x-0 -top-1.5 z-40 flex h-4 cursor-ns-resize items-center justify-center"
      >
        <div className="h-0.5 w-10 bg-muted-foreground/40 transition-colors group-hover:bg-ember group-active:bg-ember" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-1.5 pt-1.5">
      {/* Insert strip */}
      <div className="mb-1.5 flex shrink-0 items-center gap-2 border-b border-hairline pb-1.5">
        <div className="flex shrink-0 items-center gap-1.5 pr-2 hairline-r">
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Insert
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          <button type="button" disabled={!take} onClick={insertZoom} className={TOOL_BTN}>
            <Plus className="h-3 w-3" />
            Zoom
          </button>
          <button
            type="button"
            disabled={!take}
            onClick={() => insertMove(project.moves.length % 2 === 0 ? "arc-lr" : "arc-rl")}
            className={TOOL_BTN}
          >
            <Plus className="h-3 w-3" />
            Camera
          </button>
          {SCENE_EFFECT_KINDS.filter((kind) => SCENE_EFFECT_META[kind].digit > 0).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={!take}
              title={`${SCENE_EFFECT_META[kind].label} · ${SCENE_EFFECT_META[kind].shortcut}`}
              onClick={() => insertEffect(kind)}
              className={TOOL_BTN}
            >
              <Sparkles className="h-3 w-3 text-clip-fx-fg/80" />
              {SCENE_EFFECT_META[kind].digit}
            </button>
          ))}
          <button type="button" disabled={!take} onClick={() => insertSound("click")} className={TOOL_BTN}>
            <Plus className="h-3 w-3" />
            Click
          </button>
          <button
            type="button"
            disabled={!take}
            onClick={() => insertSound("right-click")}
            title="Right click"
            className={TOOL_BTN}
          >
            <Plus className="h-3 w-3" />
            R-click
          </button>
          <button type="button" disabled={!take} onClick={() => insertSound("whoosh")} className={TOOL_BTN}>
            <Plus className="h-3 w-3" />
            Whoosh
          </button>
          <button
            type="button"
            disabled={!take}
            onClick={() => insertSound("shimmer")}
            title="Glare / clear shimmer"
            className={TOOL_BTN}
          >
            <Plus className="h-3 w-3" />
            Shimmer
          </button>
          <button type="button" disabled={!take} onClick={() => insertSound("typing")} className={TOOL_BTN}>
            <Plus className="h-3 w-3" />
            Typing
          </button>
          <button type="button" disabled={!take} onClick={insertCaption} className={TOOL_BTN}>
            <Plus className="h-3 w-3" />
            Caption
          </button>
          <button
            type="button"
            disabled={!take}
            onClick={cutSelected}
            title="Cut the video at the playhead (select a zoom/SFX clip first to cut those instead)"
            className={cn(TOOL_BTN, "text-destructive hover:text-destructive")}
          >
            <Scissors className="h-3 w-3" />
            Cut
          </button>
          {take && activeClipId && (
            <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-hairline pl-2">
              <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                Speed
              </span>
              {[0.5, 1, 1.25, 1.5, 2].map((rate) => {
                const active = Math.abs(activeClipSpeed - rate) < 0.001;
                return (
                  <button
                    key={rate}
                    type="button"
                    title={`Clip speed ${rate}×`}
                    onClick={() => {
                      setSelectedVideoSegment(activeClipId);
                      setInspector("clip");
                      patchVideoSegment(activeClipId, { speed: rate });
                    }}
                    className={cn(
                      TOOL_BTN,
                      "min-w-[2rem] justify-center px-1 tabular-nums",
                      active && "bg-panel-raised text-foreground ring-1 ring-ember/50",
                    )}
                  >
                    {rate % 1 ? rate.toFixed(2) : rate}×
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
          In {formatTimecode(trimStart)} · Out {formatTimecode(trimEnd)}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-auto"
      >
        <div
          className="relative ml-10"
          ref={scrubRef}
          style={{ width: trackWidth, minWidth: "calc(100% - 2.5rem)" }}
        >
        {/* sticky lane labels in the left gutter */}
        <div className="pointer-events-none absolute -left-10 bottom-0 top-0 z-20 w-10 bg-background">
          <div className="h-6 border-b border-hairline" />
          <LaneLabel className="top-[28px] h-12">Clip</LaneLabel>
          <LaneLabel className="top-[84px] h-10">Zoom</LaneLabel>
          <LaneLabel className="top-[130px] h-8">Cam</LaneLabel>
          <LaneLabel className="top-[168px] h-8">FX</LaneLabel>
          <LaneLabel className="top-[206px] h-9">SFX</LaneLabel>
          <LaneLabel className="top-[248px] h-10">Caps</LaneLabel>
        </div>

        {/* time ruler */}
        <div className="relative mb-1 h-5 select-none border-b border-hairline bg-shell/60">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 -translate-x-1/2 text-center text-[9px] tabular-nums text-muted-foreground/60"
              style={{ left: pct(t) }}
            >
              {Number.isInteger(t) ? `${t}s` : `${t.toFixed(1)}s`}
              <div className="mx-auto mt-0.5 h-1 w-px bg-foreground/20" />
            </div>
          ))}
        </div>

        {/* video / clip track */}
        <div
          className="relative h-12 overflow-hidden rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-video-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
            setSelectedVideoSegment(null);
            setSelectedZoom(null);
            setSelectedMove(null);
            setSelectedEffect(null);
            setSelectedSound(null);
            setSelectedCaption(null);
          }}
        >
          {/* Full-lane bed when single implicit clip */}
          {videoSegments.length <= 1 && (
            <div
              data-video-clip
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag({ type: "seek" }, e);
                seekMedia(clientToTime(e.clientX));
                setSelectedVideoSegment(videoSegments[0]?.id ?? null);
                setSelectedZoom(null);
                setSelectedMove(null);
                setSelectedEffect(null);
                setSelectedSound(null);
                setSelectedCaption(null);
                setInspector("clip");
              }}
              className={cn(
                "absolute inset-0 cursor-grab overflow-hidden rounded-sm bg-clip-video clip-block active:cursor-grabbing",
                videoSelected && take && "clip-selected clip-block-on",
              )}
            >
              <div className="absolute inset-0 flex items-end gap-px px-1 opacity-55">
                {wave.map((h, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-t-[1px] bg-clip-video-fg/70"
                    style={{ height: `${(h * 52).toFixed(0)}%` }}
                  />
                ))}
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
                style={{ width: pct(trimStart) }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
                style={{ width: pct(duration - trimEnd) }}
              />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-start justify-center gap-0.5 px-3 text-clip-video-fg">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <Film className="h-3 w-3 opacity-90" />
                  {project.name || "Clip"}
                </span>
                <span className="text-[10px] font-medium opacity-80">
                  {formatTimecode(trimmed)} · {project.speed.toFixed(project.speed % 1 ? 2 : 0)}x
                </span>
              </div>
            </div>
          )}

          {videoSegments.length > 1 &&
            videoSpans.map((span, i) => {
              const selected = selectedVideoSegment === span.id;
              const spd = span.speed;
              return (
                <div
                  key={span.id}
                  data-video-clip
                  data-clip
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelectedVideoSegment(span.id);
                    setSelectedZoom(null);
                    setSelectedMove(null);
                    setSelectedEffect(null);
                    setSelectedSound(null);
                    setSelectedCaption(null);
                    setInspector("clip");
                    // Seek to the clicked lane point (not clip start) so the playhead
                    // stays aligned while dragging to reorder.
                    seekMedia(clientToSourceTime(e.clientX));
                    beginDrag(
                      { type: "video-reorder", id: span.id, fromIndex: i, originX: e.clientX },
                      e,
                    );
                  }}
                  className={cn(
                    "absolute inset-y-0 overflow-hidden rounded-sm bg-clip-video clip-block cursor-grab active:cursor-grabbing",
                    selected && "clip-selected clip-block-on",
                  )}
                  style={{
                    left: pct(span.timelineStart),
                    width: pct(Math.max(0.05, span.timelineEnd - span.timelineStart)),
                  }}
                >
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-start justify-center gap-0.5 px-2 text-clip-video-fg">
                    <span className="flex items-center gap-1 text-[10px] font-semibold">
                      <Film className="h-3 w-3 opacity-90" />
                      Clip {i + 1}
                    </span>
                    <span className="text-[9px] font-medium opacity-80">
                      {formatTimecode(span.out - span.in)} · {spd.toFixed(spd % 1 ? 2 : 0)}x
                    </span>
                  </div>
                  {selected && (
                    <>
                      <button
                        type="button"
                        title="Trim start"
                        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize rounded-l-sm bg-black/30 hover:bg-black/50"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          beginDrag(
                            {
                              type: "video-start",
                              id: span.id,
                              originIn: span.in,
                              originOut: span.out,
                              originLaneStart: span.timelineStart,
                              speed: span.speed,
                            },
                            e,
                          );
                        }}
                      />
                      <button
                        type="button"
                        title="Trim end"
                        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize rounded-r-sm bg-black/30 hover:bg-black/50"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          beginDrag(
                            {
                              type: "video-end",
                              id: span.id,
                              originIn: span.in,
                              originOut: span.out,
                              originLaneStart: span.timelineStart,
                              speed: span.speed,
                            },
                            e,
                          );
                        }}
                      />
                      <button
                        type="button"
                        title="Remove this clip (Delete)"
                        className="absolute right-1.5 top-1 z-10 rounded bg-black/35 p-0.5 text-clip-video-fg hover:bg-black/55"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeVideoSegment(span.id);
                          toast.message("Video clip removed");
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </div>

        {/* trim handles — only when a single keep-range (no multi-cut yet) */}
        {videoSegments.length <= 1 && (
          <>
            <button
              type="button"
              title="Trim start"
              onPointerDown={(e) => beginDrag({ type: "trim-start" }, e)}
              className="absolute z-20 flex h-10 w-2.5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-[2px] bg-clip-select text-[9px] font-bold text-background"
              style={{ left: pct(trimStart), top: 28 }}
            >
              ❚
            </button>
            <button
              type="button"
              title="Trim end"
              onPointerDown={(e) => beginDrag({ type: "trim-end" }, e)}
              className="absolute z-20 flex h-10 w-2.5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-[2px] bg-clip-select text-[9px] font-bold text-background"
              style={{ left: pct(trimEnd), top: 28 }}
            >
              ❚
            </button>
          </>
        )}

        {/* zoom track */}
        <div
          className="relative mt-2 h-10 rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            seekMedia(clientToTime(e.clientX));
            insertZoom();
          }}
        >
          {project.zooms.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-2 text-[10px] text-muted-foreground/70">
              Zoom
            </div>
          )}
          {project.zooms.map((z) => {
            const range = laneRange(z.time, z.duration);
            if (!range) return null;
            return (
            <div
              key={z.id}
              data-clip
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                selectOnly("zoom", z.id);
                beginDrag(
                  { type: "zoom-move", id: z.id, originTime: z.time, originX: e.clientX },
                  e,
                );
              }}
              onClick={() => seekMedia(z.time + z.duration / 2)}
              className={cn(
                "group absolute top-0.5 flex h-[calc(100%-4px)] min-w-[48px] cursor-grab items-center justify-center rounded-sm bg-clip-zoom text-clip-zoom-fg clip-block active:cursor-grabbing",
                selectedZoom === z.id && "clip-selected clip-block-on",
              )}
              style={range}
            >
              <span
                className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-sm bg-black/25"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "zoom-start",
                      id: z.id,
                      originTime: z.time,
                      originDur: z.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <span
                className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-sm bg-black/25"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "zoom-end",
                      id: z.id,
                      originTime: z.time,
                      originDur: z.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <span className="flex items-center gap-1 truncate px-2 text-[11px] font-medium">
                <Search className="h-3 w-3 shrink-0" />
                {z.scale.toFixed(1)}x · {z.auto ? "Auto" : "Manual"}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeZoom(z.id);
                }}
                className="absolute right-1 top-0.5 hidden rounded p-0.5 group-hover:block"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            );
          })}
        </div>

        {/* camera track */}
        <div
          className="relative mt-1.5 h-8 rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            seekMedia(clientToTime(e.clientX));
            insertMove();
          }}
        >
          {project.moves.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-2 text-[10px] text-muted-foreground/70">
              Camera
            </div>
          )}
          {project.moves.map((m) => {
            const range = laneRange(m.time, m.duration);
            if (!range) return null;
            return (
            <div
              key={m.id}
              data-clip
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                selectOnly("move", m.id);
                beginDrag(
                  { type: "move-move", id: m.id, originTime: m.time, originX: e.clientX },
                  e,
                );
              }}
              onClick={() => seekMedia(m.time + m.duration / 2)}
              className={cn(
                "group absolute top-0.5 flex h-[calc(100%-4px)] min-w-[40px] cursor-grab items-center justify-center rounded-sm bg-clip-cam px-1 text-[10px] font-semibold text-clip-cam-fg clip-block active:cursor-grabbing",
                selectedMove === m.id && "clip-selected clip-block-on",
              )}
              style={range}
            >
              <span
                className="absolute inset-y-0 left-0 w-1 cursor-ew-resize rounded-l-sm bg-black/20"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "move-start",
                      id: m.id,
                      originTime: m.time,
                      originDur: m.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <span
                className="absolute inset-y-0 right-0 w-1 cursor-ew-resize rounded-r-sm bg-black/20"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "move-end",
                      id: m.id,
                      originTime: m.time,
                      originDur: m.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <Video className="mr-0.5 h-2.5 w-2.5" />
              {m.auto ? "Auto" : m.kind}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeMove(m.id);
                }}
                className="absolute -right-1 -top-1 hidden rounded bg-background/80 p-0.5 text-foreground group-hover:block"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
            );
          })}
        </div>

        {/* effects track */}
        <div
          className="relative mt-1.5 h-8 rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
          }}
        >
          {(project.effects ?? []).length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-2 text-[10px] text-muted-foreground/70">
              Effects
            </div>
          )}
          {(project.effects ?? []).map((fx) => {
            const range = laneRange(fx.time, fx.duration);
            if (!range) return null;
            return (
            <div
              key={fx.id}
              data-clip
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                selectOnly("effect", fx.id);
                beginDrag(
                  { type: "effect-move", id: fx.id, originTime: fx.time, originX: e.clientX },
                  e,
                );
              }}
              onClick={() => seekMedia(fx.time + fx.duration / 2)}
              className={cn(
                "group absolute top-0.5 flex h-[calc(100%-4px)] min-w-[44px] cursor-grab items-center justify-center rounded-sm bg-clip-fx px-1 text-[10px] font-semibold text-clip-fx-fg clip-block active:cursor-grabbing",
                selectedEffect === fx.id && "clip-selected clip-block-on",
              )}
              style={range}
            >
              <span
                className="absolute inset-y-0 left-0 w-1 cursor-ew-resize rounded-l-sm bg-black/20"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "effect-start",
                      id: fx.id,
                      originTime: fx.time,
                      originDur: fx.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <span
                className="absolute inset-y-0 right-0 w-1 cursor-ew-resize rounded-r-sm bg-black/20"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "effect-end",
                      id: fx.id,
                      originTime: fx.time,
                      originDur: fx.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <Sparkles className="mr-0.5 h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{SCENE_EFFECT_META[fx.kind].label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeEffect(fx.id);
                }}
                className="absolute -right-1 -top-1 hidden rounded bg-background/80 p-0.5 text-foreground group-hover:block"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
            );
          })}
        </div>

        {/* SFX track */}
        <div
          className="relative mt-1.5 h-9 rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
          }}
        >
          {sounds.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/70">
              SFX
            </div>
          )}
          {sounds.map((s) => {
            const range = laneRange(s.time, Math.max(s.duration, 0.12));
            if (!range) return null;
            return (
            <div
              key={s.id}
              data-clip
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                playSoundKind(s.kind, {
                  duration:
                    s.kind === "typing" || s.kind === "shimmer" ? s.duration : undefined,
                  keyTick: s.kind === "typing" ? false : undefined,
                });
                selectOnly("sound", s.id);
                beginDrag(
                  { type: "sound-move", id: s.id, originTime: s.time, originX: e.clientX },
                  e,
                );
              }}
              onClick={() => seekMedia(s.time + Math.max(s.duration, 0.12) / 2)}
              className={cn(
                "group absolute top-0.5 flex h-[calc(100%-4px)] min-w-[28px] cursor-grab items-center justify-center overflow-hidden rounded-sm px-1 text-[10px] font-semibold text-clip-audio-fg clip-block active:cursor-grabbing",
                SOUND_COLORS[s.kind],
                selectedSound === s.id && "clip-selected clip-block-on",
              )}
              style={range}
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[55%] items-end gap-px px-0.5 opacity-60">
                {Array.from({ length: 12 }, (_, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-t-[0.5px] bg-clip-audio-fg/70"
                    style={{ height: `${30 + ((i * 37) % 70)}%` }}
                  />
                ))}
              </div>
              <span
                className="absolute inset-y-0 left-0 w-1 cursor-ew-resize rounded-l-sm bg-black/25"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "sound-start",
                      id: s.id,
                      originTime: s.time,
                      originDur: s.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <span
                className="absolute inset-y-0 right-0 w-1 cursor-ew-resize rounded-r-sm bg-black/25"
                onPointerDown={(e) =>
                  beginDrag(
                    {
                      type: "sound-end",
                      id: s.id,
                      originTime: s.time,
                      originDur: s.duration,
                      originX: e.clientX,
                    },
                    e,
                  )
                }
              />
              <Volume2 className="relative z-[1] mr-0.5 h-2.5 w-2.5 shrink-0" />
              <span className="relative z-[1] truncate">{SOUND_LABELS[s.kind]}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSound(s.id);
                }}
                className="absolute -right-1 -top-1 z-[1] hidden rounded bg-background/80 p-0.5 text-foreground group-hover:block"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
            );
          })}
        </div>

        {/* Captions track */}
        <div
          className="relative mt-1.5 h-10 rounded-sm lane-bed"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            beginDrag({ type: "seek" }, e);
            seekMedia(clientToTime(e.clientX));
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip]")) return;
            seekMedia(clientToTime(e.clientX));
            insertCaption();
          }}
        >
          {cues.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/70">
              Captions
            </div>
          )}
          {cues.map((c) => {
            const len = Math.max(0.2, c.end - c.start);
            const range = laneRange(c.start, len);
            if (!range) return null;
            return (
              <div
                key={c.id}
                data-clip
                role="button"
                tabIndex={0}
                title={c.text}
                onPointerDown={(e) => {
                  selectOnly("caption", c.id);
                  beginDrag(
                    {
                      type: "cap-move",
                      id: c.id,
                      originStart: c.start,
                      originEnd: c.end,
                      originX: e.clientX,
                    },
                    e,
                  );
                }}
                onClick={() => seekMedia(c.start + Math.max(0.2, c.end - c.start) / 2)}
                className={cn(
                  CAPTION_CLIP,
                  selectedCaption === c.id && "clip-selected clip-block-on",
                )}
                style={range}
              >
                <span
                  className="absolute inset-y-0 left-0 w-1 cursor-ew-resize rounded-l-sm bg-black/25"
                  onPointerDown={(e) =>
                    beginDrag(
                      {
                        type: "cap-start",
                        id: c.id,
                        originStart: c.start,
                        originEnd: c.end,
                        originX: e.clientX,
                      },
                      e,
                    )
                  }
                />
                <span
                  className="absolute inset-y-0 right-0 w-1 cursor-ew-resize rounded-r-sm bg-black/25"
                  onPointerDown={(e) =>
                    beginDrag(
                      {
                        type: "cap-end",
                        id: c.id,
                        originStart: c.start,
                        originEnd: c.end,
                        originX: e.clientX,
                      },
                      e,
                    )
                  }
                />
                <MessageSquare className="mr-1 h-2.5 w-2.5 shrink-0 opacity-90" />
                <span className="truncate">{c.text || "Caption"}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCaptionCue(c.id);
                  }}
                  className="absolute -right-1 -top-1 hidden rounded bg-background/80 p-0.5 text-foreground group-hover:block"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>

        {/* playhead — white line + rectangular handle */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-playhead"
          style={{ left: playheadLeft }}
        >
          <span className="absolute -left-[5px] top-0 h-3 w-2.5 rounded-[2px] bg-playhead shadow-sm" />
        </div>
        </div>
      </div>

      <div className="mt-1 flex shrink-0 items-center justify-between gap-3 px-1 text-[10px] tabular-nums text-muted-foreground">
        <span>
          {formatTimecode(time)} / {formatTimecode(duration)}
        </span>
        <span className="truncate text-[10px]">{pxPerSec}px/s</span>
      </div>
      </div>
    </section>
  );
}
