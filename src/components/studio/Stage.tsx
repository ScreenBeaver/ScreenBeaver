import { useCallback, useEffect, useRef, useState } from "react";
import {
  Crop,
  Maximize2,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  MonitorPlay,
  ChevronDown,
  Link2,
} from "lucide-react";
import { renderScene, makeCursorTrack, stageAspect, primeCursorIcons } from "@/lib/studio/compositor";
import { wallpaperImageUrl } from "@/lib/studio/wallpapers";
import { cutoutFrame, invalidateCutoutCache, loadSegmenter } from "@/lib/studio/segmenter";
import { usePlaying, useStudio } from "@/lib/studio/store";
import type { AspectRatio, VoiceoverClip } from "@/lib/studio/types";
import { lastKeptSource, nextKeptSource, speedAtSource } from "@/lib/studio/videoEdit";
import { playSoundKind, playTick, stopTypingBed, unlockUiSounds } from "@/lib/studio/sounds";
import { makeTakeFromLocalVideoFile } from "@/lib/studio/localVideoImport";
import { clearPendingRelink, getPendingRelink } from "@/lib/studio/projectFiles";
import { persistTakeMedia } from "@/lib/studio/projectMedia";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { CropEditor } from "@/components/studio/CropEditor";
import { isFullCrop } from "@/lib/studio/crop";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const RATIOS: { value: AspectRatio; label: string; name: string }[] = [
  { value: "16:9", label: "16:9", name: "Wide" },
  { value: "4:3", label: "4:3", name: "Classic" },
  { value: "3:2", label: "3:2", name: "Photo" },
  { value: "1:1", label: "1:1", name: "Square" },
  { value: "9:16", label: "9:16", name: "Vertical" },
  { value: "auto", label: "Auto", name: "Original" },
];

const EMPTY_VOICEOVER_CLIPS: VoiceoverClip[] = [];

export function Stage({
  onRecordClick,
  nativeRecording = false,
  missingMediaLabel = null,
  onMediaLinked,
}: {
  onRecordClick: () => void;
  nativeRecording?: boolean;
  missingMediaLabel?: string | null;
  onMediaLinked?: () => void;
}) {
  const studio = useStudio();
  const {
    project,
    take,
    clock,
    screenRef,
    cameraRef,
    micRef,
    patchFrame,
    selectedZoom,
    updateZoom,
    setPickingFocus,
    pickingFocus,
    setSelectedZoom,
    setInspector,
    setTake,
  } = studio;
  const playing = usePlaying();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const linkVideoRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(1);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const camBgImageRef = useRef<HTMLImageElement | null>(null);
  const cursorTrackRef = useRef(makeCursorTrack(null, 0));
  const [focusHint, setFocusHint] = useState<{ x: number; y: number } | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const lastSoundTimeRef = useRef(-1);
  const soundIdxRef = useRef(0);
  const voiceoverElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const activeVoiceoverIdRef = useRef<string | null>(null);
  const musicElRef = useRef<HTMLAudioElement | null>(null);

  const voiceoverOn =
    !!(project.voiceover?.enabled && project.voiceover.clips && project.voiceover.clips.length > 0);
  const voiceoverClips = voiceoverOn ? project.voiceover!.clips : EMPTY_VOICEOVER_CLIPS;
  const musicOn = !!(project.music?.enabled && project.music.url);
  const musicUrl = musicOn ? project.music!.url! : null;
  const musicVol = project.music?.volume ?? 0.16;

  // Keep HTML media in sync with project / per-clip playback speed.
  useEffect(() => {
    const screen = screenRef.current;
    const camera = cameraRef.current;
    const mic = micRef.current;
    if (!screen || !take) return;
    const apply = () => {
      const rate = speedAtSource(project, take.duration, screen.currentTime || clock.time);
      if (screen) screen.playbackRate = rate;
      if (camera) camera.playbackRate = rate;
      if (mic) mic.playbackRate = rate;
    };
    apply();
    screen.addEventListener("timeupdate", apply);
    return () => screen.removeEventListener("timeupdate", apply);
  }, [project, take, screenRef, cameraRef, micRef, clock]);

  const syncVoiceover = useCallback(
    (t: number, shouldPlay: boolean) => {
      const mic = micRef.current;
      const clips = voiceoverClips;
      if (!voiceoverOn || !clips.length) {
        if (mic) mic.volume = 1;
        activeVoiceoverIdRef.current = null;
        voiceoverElsRef.current.forEach((el) => {
          el.pause();
        });
        return;
      }

      const active = clips.find((c) => t >= c.start && t < c.start + c.duration) ?? null;
      if (mic) mic.volume = active ? 0 : 1;

      const nextId = active?.id ?? null;
      voiceoverElsRef.current.forEach((el, id) => {
        if (id !== nextId) {
          if (!el.paused) el.pause();
          return;
        }
        if (!active) return;
        const local = Math.max(0, t - active.start);
        if (Math.abs(el.currentTime - local) > 0.2) {
          try {
            el.currentTime = local;
          } catch {
            /* ignore */
          }
        }
        if (shouldPlay && el.paused) void el.play().catch(() => {});
        if (!shouldPlay && !el.paused) el.pause();
      });
      activeVoiceoverIdRef.current = nextId;
    },
    [micRef, voiceoverOn, voiceoverClips],
  );

  const syncMusic = useCallback(
    (t: number, shouldPlay: boolean, voActive: boolean) => {
      const el = musicElRef.current;
      if (!el || !musicOn || !musicUrl) {
        el?.pause();
        return;
      }
      el.loop = project.music?.loop !== false;
      el.volume = Math.min(1, Math.max(0, musicVol * (voActive ? 0.22 : 1)));
      if (el.duration && Number.isFinite(el.duration) && el.duration > 0) {
        const local = project.music?.loop !== false ? t % el.duration : Math.min(t, el.duration);
        if (Math.abs(el.currentTime - local) > 0.35) {
          try {
            el.currentTime = local;
          } catch {
            /* ignore */
          }
        }
      }
      if (shouldPlay && el.paused) void el.play().catch(() => {});
      if (!shouldPlay && !el.paused) el.pause();
    },
    [musicOn, musicUrl, musicVol, project.music?.loop],
  );

  useEffect(() => {
    unlockUiSounds();
  }, []);

  useEffect(() => {
    if (!musicOn || !musicUrl) {
      musicElRef.current?.pause();
      musicElRef.current = null;
      return;
    }
    let el = musicElRef.current;
    if (!el) {
      el = new Audio(musicUrl);
      el.preload = "auto";
      musicElRef.current = el;
    } else if (el.src !== musicUrl && !el.src.endsWith(musicUrl)) {
      el.src = musicUrl;
    }
    el.loop = project.music?.loop !== false;
    el.volume = Math.min(1, Math.max(0, musicVol));
    return () => {
      el?.pause();
    };
  }, [musicOn, musicUrl, musicVol, project.music?.loop]);

  // Bind <audio> elements for AI voiceover clips
  useEffect(() => {
    const map = voiceoverElsRef.current;
    const ids = new Set(voiceoverClips.map((c) => c.id));
    for (const [id, el] of [...map.entries()]) {
      if (!ids.has(id)) {
        el.pause();
        map.delete(id);
      }
    }
    for (const clip of voiceoverClips) {
      let el = map.get(clip.id);
      if (!el) {
        el = new Audio(clip.audioUrl);
        el.preload = "auto";
        map.set(clip.id, el);
      } else if (el.src !== clip.audioUrl) {
        el.src = clip.audioUrl;
      }
    }
    return () => {
      /* keep elements across clip list updates; cleared when empty via above */
    };
  }, [voiceoverClips]);

  useEffect(() => {
    if (!voiceoverOn) {
      if (micRef.current) micRef.current.volume = 1;
      voiceoverElsRef.current.forEach((el) => el.pause());
      activeVoiceoverIdRef.current = null;
    }
  }, [voiceoverOn, micRef]);

  useEffect(() => {
    cursorTrackRef.current = makeCursorTrack(
      take,
      project.cursor.smoothing,
      project.cursor.autoHideIdle,
    );
    primeCursorIcons(take?.cursorIcons);
  }, [take, project.cursor.smoothing, project.cursor.autoHideIdle]);

  useEffect(() => {
    const custom = project.background.imageUrl;
    const paperUrl =
      project.background.mode === "wallpaper" || project.background.mode === "motion"
        ? wallpaperImageUrl(project.background.wallpaperId)
        : null;
    const url = project.background.mode === "image" ? custom : paperUrl ?? custom;
    if (!url) {
      bgImageRef.current = null;
      paintDirtyRef.current += 1;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
      paintDirtyRef.current += 1;
    };
    img.onerror = () => {
      bgImageRef.current = null;
      paintDirtyRef.current += 1;
    };
    img.src = url;
  }, [project.background.imageUrl, project.background.mode, project.background.wallpaperId]);

  useEffect(() => {
    const url = project.camera.backgroundImageUrl;
    if (!url) {
      camBgImageRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => (camBgImageRef.current = img);
    img.src = url;
  }, [project.camera.backgroundImageUrl]);

  useEffect(() => {
    if (project.camera.backgroundMode !== "none") void loadSegmenter();
  }, [project.camera.backgroundMode]);

  const projectRef = useRef(project);
  projectRef.current = project;
  const voiceoverClipsRef = useRef(voiceoverClips);
  voiceoverClipsRef.current = voiceoverClips;
  const sortedSoundsRef = useRef(project.sounds ?? []);
  /** Bumped on project edits / canvas resize / video seek so paused preview never stays black. */
  const paintDirtyRef = useRef(0);
  paintDirtyRef.current += 1;

  // Keep camera element decoding: sync to playhead whenever the take loads / URL changes.
  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !take?.cameraUrl) return;
    invalidateCutoutCache();
    const bump = () => {
      paintDirtyRef.current += 1;
    };
    const syncToClock = () => {
      try {
        const t = clock.time;
        if (Math.abs(cam.currentTime - t) > 0.04) cam.currentTime = t;
      } catch {
        /* ignore */
      }
      bump();
    };
    cam.addEventListener("loadeddata", syncToClock);
    cam.addEventListener("seeked", bump);
    cam.addEventListener("error", bump);
    // Kick decode — some engines stay blank until an explicit seek after metadata.
    if (cam.readyState >= 1) syncToClock();
    else {
      const onMeta = () => syncToClock();
      cam.addEventListener("loadedmetadata", onMeta, { once: true });
      return () => {
        cam.removeEventListener("loadeddata", syncToClock);
        cam.removeEventListener("seeked", bump);
        cam.removeEventListener("error", bump);
        cam.removeEventListener("loadedmetadata", onMeta);
      };
    }
    return () => {
      cam.removeEventListener("loadeddata", syncToClock);
      cam.removeEventListener("seeked", bump);
      cam.removeEventListener("error", bump);
    };
  }, [take?.cameraUrl, take, cameraRef, clock]);

  // Keep clock + camera + mic in sync with the screen video; respect keep-segments; stop at end.
  // While playing, the rAF loop owns clock.set — timeupdate only handles seek gaps / end.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || !take) return;
    const end = lastKeptSource(project, take.duration);
    const onTime = () => {
      if (screen.paused) return;
      const t = screen.currentTime;
      const next = nextKeptSource(project, take.duration, t);
      if (next == null || t >= end - 0.02) {
        screen.pause();
        cameraRef.current?.pause();
        micRef.current?.pause();
        voiceoverElsRef.current.forEach((el) => el.pause());
        clock.setPlaying(false);
        clock.set(end);
        return;
      }
      if (Math.abs(next - t) > 0.04) {
        screen.currentTime = next;
        if (cameraRef.current) cameraRef.current.currentTime = next;
        if (micRef.current) micRef.current.currentTime = next;
        clock.set(next);
      }
      // Don't clock.set(t) here — rAF already drives the playhead.
    };
    const onSeeked = () => {
      clock.set(screen.currentTime);
      const t = screen.currentTime;
      const cam = cameraRef.current;
      if (cam) {
        try {
          if (Math.abs(cam.currentTime - t) > 0.04) cam.currentTime = t;
        } catch {
          /* ignore */
        }
      }
      if (micRef.current) micRef.current.currentTime = t;
      syncVoiceover(t, !screen.paused);
      // Frame is decoded now — force a paint (scrub often drew black while seeking).
      paintDirtyRef.current += 1;
      invalidateCutoutCache();
    };
    const onEnded = () => {
      cameraRef.current?.pause();
      micRef.current?.pause();
      voiceoverElsRef.current.forEach((el) => el.pause());
      clock.setPlaying(false);
    };
    screen.addEventListener("timeupdate", onTime);
    screen.addEventListener("seeked", onSeeked);
    screen.addEventListener("ended", onEnded);
    return () => {
      screen.removeEventListener("timeupdate", onTime);
      screen.removeEventListener("seeked", onSeeked);
      screen.removeEventListener("ended", onEnded);
    };
  }, [take, clock, screenRef, cameraRef, micRef, project, syncVoiceover]);

  useEffect(() => {
    sortedSoundsRef.current = [...(project.sounds ?? [])].sort((a, b) => a.time - b.time);
  }, [project.sounds]);

  // Canvas render loop — 60fps while playing; dirty-only while paused.
  useEffect(() => {
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;
    let lastCanvas: HTMLCanvasElement | null = null;
    let lastDrawnTime = -1;
    let lastDrawnDirty = -1;
    let lastBufferW = 0;
    let lastBufferH = 0;
    let lastMask: HTMLCanvasElement | null = null;
    let forceDraw = true;

    const loop = () => {
      const canvas = canvasRef.current;
      const proj = projectRef.current;
      if (canvas) {
        if (canvas !== lastCanvas) {
          // alpha:true — opaque false fills black and makes empty seeks look like a hard crash.
          ctx = canvas.getContext("2d", { alpha: true });
          lastCanvas = canvas;
          forceDraw = true;
        }
        if (ctx) {
          const screen = screenRef.current;
          const end = take ? lastKeptSource(proj, take.duration) : 0;
          const clips = voiceoverClipsRef.current;

          if (playing && screen && !screen.paused) {
            const t = screen.currentTime;
            const next = take ? nextKeptSource(proj, take.duration, t) : t;
            if (end > 0 && (next == null || t >= end - 0.02)) {
              screen.pause();
              cameraRef.current?.pause();
              micRef.current?.pause();
              voiceoverElsRef.current.forEach((el) => el.pause());
              musicElRef.current?.pause();
              clock.setPlaying(false);
              clock.set(end);
            } else if (next != null && Math.abs(next - t) > 0.04) {
              screen.currentTime = next;
              if (cameraRef.current) cameraRef.current.currentTime = next;
              if (micRef.current) micRef.current.currentTime = next;
              clock.set(next);
            } else {
              clock.set(screen.currentTime);
              if (
                cameraRef.current &&
                Math.abs(cameraRef.current.currentTime - screen.currentTime) > 0.12
              ) {
                cameraRef.current.currentTime = screen.currentTime;
              }
              const mic = micRef.current;
              if (mic && Math.abs(mic.currentTime - screen.currentTime) > 0.18) {
                mic.currentTime = screen.currentTime;
              }
              syncVoiceover(screen.currentTime, true);
              const voHit = clips.some(
                (c) =>
                  screen.currentTime >= c.start &&
                  screen.currentTime < c.start + c.duration,
              );
              syncMusic(screen.currentTime, true, voHit);
            }
          } else {
            syncVoiceover(clock.time, false);
            syncMusic(clock.time, false, false);
          }

          const t = clock.time;
          const sfx = sortedSoundsRef.current;
          if (playing) {
            const prev = lastSoundTimeRef.current;
            if (t < prev - 0.05) {
              soundIdxRef.current = 0;
              while (soundIdxRef.current < sfx.length && sfx[soundIdxRef.current]!.time < t - 0.02) {
                soundIdxRef.current += 1;
              }
            } else {
              while (soundIdxRef.current < sfx.length && sfx[soundIdxRef.current]!.time <= t) {
                const st = sfx[soundIdxRef.current]!.time;
                if (st > prev) {
                  const clip = sfx[soundIdxRef.current]!;
                  playSoundKind(clip.kind, {
                    duration:
                      clip.kind === "typing" || clip.kind === "shimmer"
                        ? clip.duration
                        : undefined,
                  });
                }
                soundIdxRef.current += 1;
              }
            }
            lastSoundTimeRef.current = t;
          } else if (Math.abs(t - lastSoundTimeRef.current) > 0.001) {
            lastSoundTimeRef.current = t;
            soundIdxRef.current = 0;
            while (soundIdxRef.current < sfx.length && sfx[soundIdxRef.current]!.time <= t) {
              soundIdxRef.current += 1;
            }
          }

          const camera = cameraRef.current;
          const needCutout =
            proj.camera.enabled &&
            proj.camera.backgroundMode !== "none" &&
            !!camera &&
            !!camera.videoWidth &&
            !camera.seeking &&
            camera.readyState >= 2;
          if (needCutout) {
            lastMask = cutoutFrame(camera!, performance.now(), proj.camera.mirror);
          } else if (!proj.camera.enabled || proj.camera.backgroundMode === "none") {
            lastMask = null;
          }
          // Keep prior mask only while camera is mid-seek so we don't flash empty.

          const dirtyGen = paintDirtyRef.current;
          const timeDirty = Math.abs(t - lastDrawnTime) > 0.0005;
          const bufferDirty = canvas.width !== lastBufferW || canvas.height !== lastBufferH;
          const settingsDirty = dirtyGen !== lastDrawnDirty;
          // Keep painting until decoded frames match the playhead (scrub / jump).
          const screenPending = !!(
            screen &&
            (screen.seeking ||
              screen.readyState < 2 ||
              Math.abs(screen.currentTime - t) > 0.08)
          );
          const cameraPending = !!(
            proj.camera.enabled &&
            take?.cameraUrl &&
            camera &&
            (camera.seeking ||
              camera.readyState < 2 ||
              !camera.videoWidth ||
              Math.abs(camera.currentTime - t) > 0.12)
          );
          const mediaPending = screenPending || cameraPending;
          const shouldDraw =
            forceDraw || playing || timeDirty || bufferDirty || settingsDirty || mediaPending;

          if (shouldDraw && canvas.width > 0 && canvas.height > 0) {
            // Nudge camera toward the playhead while paused (decode needs a real seek).
            if (
              !playing &&
              camera &&
              take?.cameraUrl &&
              camera.readyState >= 1 &&
              !camera.seeking &&
              Math.abs(camera.currentTime - t) > 0.08
            ) {
              try {
                camera.currentTime = t;
              } catch {
                /* ignore */
              }
            }
            renderScene(ctx, canvas.width, canvas.height, {
              project: proj,
              take,
              time: t,
              cursorTrack: cursorTrackRef.current,
              media: {
                screen,
                camera: camera && camera.videoWidth ? camera : null,
                cameraMask: lastMask,
                backgroundImage: bgImageRef.current,
                cameraBackgroundImage: camBgImageRef.current,
              },
            });
            // Don't settle while seeking — otherwise a blank interim frame sticks forever.
            if (!mediaPending) {
              lastDrawnTime = t;
              lastDrawnDirty = dirtyGen;
              lastBufferW = canvas.width;
              lastBufferH = canvas.height;
              forceDraw = false;
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [take, playing, clock, screenRef, cameraRef, syncVoiceover, syncMusic]);

  // Size the backing canvas to the stage box.
  // Only depend on aspect-driving fields — assigning canvas.width clears the bitmap.
  const stageRatio = project.frame.ratio;
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const aspect = stageAspect(projectRef.current, take);
    const fit = () => {
      const box = wrap.getBoundingClientRect();
      const scale = preview;
      const maxW = box.width * scale;
      const maxH = box.height * scale;
      let w: number;
      let h: number;
      // Portrait: size by height first so 9:16 uses the full stage column.
      if (aspect < 1) {
        h = maxH;
        w = h * aspect;
        if (w > maxW) {
          w = maxW;
          h = w / aspect;
        }
      } else {
        w = maxW;
        h = w / aspect;
        if (h > maxH) {
          h = maxH;
          w = h * aspect;
        }
      }
      const cssW = Math.round(w);
      const cssH = Math.round(h);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      // Cap DPR — 2× full-stage paints dominate CPU with camera/cutout on.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const bufW = Math.round(cssW * dpr);
      const bufH = Math.round(cssH * dpr);
      if (canvas.width !== bufW || canvas.height !== bufH) {
        canvas.width = bufW;
        canvas.height = bufH;
        // Buffer wipe — ensure the next rAF repaints immediately.
        paintDirtyRef.current += 1;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [stageRatio, take, preview]);

  const toggle = useCallback(() => {
    const screen = screenRef.current;
    const camera = cameraRef.current;
    const mic = micRef.current;
    if (!screen) return;
    playTick();
    if (screen.paused) {
      const trimStart = project.trim.start || 0;
      const trimEnd = project.trim.end > 0 ? project.trim.end : take?.duration ?? screen.duration;
      if (screen.currentTime < trimStart || screen.currentTime >= trimEnd - 0.05) {
        screen.currentTime = trimStart;
        if (camera) camera.currentTime = trimStart;
        if (mic) mic.currentTime = trimStart;
        clock.set(trimStart);
      }
      void screen.play();
      if (camera) {
        camera.currentTime = screen.currentTime;
        void camera.play();
      }
      if (mic) {
        mic.currentTime = screen.currentTime;
        void mic.play().catch(() => {});
      }
      syncVoiceover(screen.currentTime, true);
      const voHit = voiceoverClips.some(
        (c) =>
          screen.currentTime >= c.start && screen.currentTime < c.start + c.duration,
      );
      syncMusic(screen.currentTime, true, voHit);
      clock.setPlaying(true);
    } else {
      screen.pause();
      camera?.pause();
      mic?.pause();
      voiceoverElsRef.current.forEach((el) => el.pause());
      musicElRef.current?.pause();
      stopTypingBed();
      clock.setPlaying(false);
    }
  }, [
    screenRef,
    cameraRef,
    micRef,
    clock,
    project.trim.start,
    project.trim.end,
    take?.duration,
    syncVoiceover,
    syncMusic,
    voiceoverClips,
  ]);

  const nudge = (delta: number) => {
    const screen = screenRef.current;
    if (!screen) return;
    playTick();
    const trimStart = project.trim.start || 0;
    const trimEnd = project.trim.end > 0 ? project.trim.end : take?.duration ?? 0;
    const t = Math.min(trimEnd, Math.max(trimStart, screen.currentTime + delta));
    screen.currentTime = t;
    if (cameraRef.current) cameraRef.current.currentTime = t;
    if (micRef.current) micRef.current.currentTime = t;
    syncVoiceover(t, false);
    clock.set(t);
  };

  const cutAtPlayhead = () => {
    const { ok, message } = studio.splitSelectedAt(clock.time);
    if (ok) toast.success(message);
    else toast.message(message);
  };

  const onCanvasPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pickingFocus || !selectedZoom) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const nx = (e.clientX - box.left) / box.width;
    const ny = (e.clientY - box.top) / box.height;
    // Approximate content inset from padding (matches compositor feel)
    const inset = (project.frame.padding / 100) * 0.22;
    const x = Math.min(1, Math.max(0, (nx - inset) / Math.max(0.2, 1 - inset * 2)));
    const y = Math.min(1, Math.max(0, (ny - inset) / Math.max(0.2, 1 - inset * 2)));
    const crop = project.frame.crop;
    const sx = crop.x + x * crop.w;
    const sy = crop.y + y * crop.h;
    updateZoom(selectedZoom, { x: sx, y: sy, followCursor: false, auto: false });
    setFocusHint({ x: nx, y: ny });
    setPickingFocus(false);
    window.setTimeout(() => setFocusHint(null), 900);
  };

  const ratio = RATIOS.find((r) => r.value === project.frame.ratio) ?? RATIOS[0];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={wrapRef} className="flex min-h-0 flex-1 items-center justify-center p-5">
        <div className="relative">
          <canvas
            ref={canvasRef}
            onPointerDown={onCanvasPointer}
            className={cn("block rounded-md", pickingFocus && "cursor-crosshair ring-2 ring-primary/70")}
          />
          {pickingFocus && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <span className="rounded bg-panel px-3 py-1 text-[11px] font-medium ring-1 ring-hairline">
                Click to set zoom focus
              </span>
            </div>
          )}
          {(focusHint || pickingFocus) && focusHint && (
            <div
              className="pointer-events-none absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 border border-ember bg-ember/15"
              style={{ left: `${focusHint.x * 100}%`, top: `${focusHint.y * 100}%` }}
            />
          )}
          {!take && nativeRecording && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-stage/80 text-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded bg-record/15 text-record ring-1 ring-record/40">
                <span className="h-2.5 w-2.5 animate-pulse rounded-sm bg-record" />
              </span>
              <span className="font-medium text-foreground">Recording…</span>
              <span className="text-xs text-muted-foreground">Agent is driving the shared window</span>
            </div>
          )}
          {!take && !nativeRecording && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-md bg-stage/85 px-6 text-center">
              <input
                ref={linkVideoRef}
                type="file"
                accept="video/*,.mp4,.webm,.mov"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  try {
                    const pending = getPendingRelink();
                    const t = await makeTakeFromLocalVideoFile(file, pending?.cursor ?? []);
                    setTake(t);
                    if (pending?.mediaId) void persistTakeMedia(pending.mediaId, t);
                    clearPendingRelink();
                    onMediaLinked?.();
                    toast.success("Recording linked", { description: file.name });
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Could not link video");
                  }
                }}
              />
              {missingMediaLabel ? (
                <>
                  <span className="flex h-11 w-11 items-center justify-center rounded bg-panel-raised ring-1 ring-hairline">
                    <Link2 className="h-5 w-5 text-ember" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-[14px] font-medium tracking-tight text-foreground">
                      Recording missing
                    </p>
                    <p className="max-w-sm text-[12px] text-muted-foreground">
                      Project look is loaded, but the video isn’t here. Link{" "}
                      <span className="font-medium text-foreground">{missingMediaLabel}</span>{" "}
                      or another video to continue.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => linkVideoRef.current?.click()}
                      className="rounded-md bg-royal-grad px-3.5 py-1.5 text-[12px] font-semibold"
                    >
                      Link video
                    </button>
                    <button
                      type="button"
                      onClick={onRecordClick}
                      className="rounded-md bg-panel-raised px-3.5 py-1.5 text-[12px] font-medium ring-1 ring-hairline hover:bg-accent"
                    >
                      New recording
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={onRecordClick}
                  className="flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded bg-panel-raised ring-1 ring-hairline">
                    <MonitorPlay className="h-5 w-5 text-ember" />
                  </span>
                  <span className="font-medium tracking-tight text-foreground">New recording</span>
                  <span className="text-xs">Window · screen · or browser tab</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* transport — flat charcoal strip */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-shell px-4 py-2 hairline-t">
        <div className="flex min-w-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex shrink-0 items-center gap-2 rounded bg-panel-raised px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-accent">
              <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{ratio.name}</span>
              <span className="text-muted-foreground">{ratio.label}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {RATIOS.map((r) => (
                <DropdownMenuItem key={r.value} onClick={() => patchFrame({ ratio: r.value })}>
                  <span className="w-16">{r.name}</span>
                  <span className="text-muted-foreground">{r.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            disabled={!take}
            onClick={() => {
              if (!take) return;
              setCropOpen(true);
            }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40",
              isFullCrop(project.frame.crop)
                ? "bg-panel-raised hover:bg-accent"
                : "bg-royal-grad",
            )}
          >
            <Crop className="h-3.5 w-3.5" />
            Crop
          </button>
        </div>

        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => nudge(-2)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Back 2 seconds"
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            onClick={toggle}
            className="flex h-8 w-8 items-center justify-center rounded bg-royal-grad transition-opacity hover:opacity-90"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-px" />}
          </button>
          <button
            onClick={() => nudge(2)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Forward 2 seconds"
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-w-0 items-center justify-end gap-3">
          <button
            onClick={cutAtPlayhead}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Cut video at playhead into two clips"
            title="Cut video at playhead (C) · select a zoom/SFX clip first to cut those instead"
          >
            <Scissors className="h-4 w-4" />
          </button>
          <Slider
            value={[preview * 100]}
            min={40}
            max={100}
            step={1}
            onValueChange={([v]) => setPreview(v / 100)}
            className="w-24 shrink-0"
          />
        </div>
      </div>

      {/* Hidden but NON-ZERO sized — Chromium suspends decode on 0×0 videos, so canvas gets blank frames. */}
      {take && (
        <div
          className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] opacity-0"
          aria-hidden
        >
          <video
            ref={screenRef}
            src={take.screenUrl}
            crossOrigin="anonymous"
            playsInline
            muted
            preload="auto"
            className="h-[180px] w-[320px]"
          />
          {take.cameraUrl ? (
            <video
              key={take.cameraUrl}
              ref={cameraRef}
              src={take.cameraUrl}
              crossOrigin="anonymous"
              playsInline
              muted
              preload="auto"
              className="h-[180px] w-[180px]"
            />
          ) : null}
          {take.micUrl ? <audio ref={micRef} src={take.micUrl} preload="auto" /> : null}
        </div>
      )}

      {take && (
        <CropEditor
          open={cropOpen}
          onOpenChange={setCropOpen}
          videoUrl={take.screenUrl}
          videoWidth={take.width}
          videoHeight={take.height}
          currentTime={clock.time}
          initialCrop={project.frame.crop}
          onApply={(crop) => {
            patchFrame({ crop });
            toast.success(
              isFullCrop(crop)
                ? "Crop reset to full frame"
                : `Cropped to ${Math.round(crop.w * take.width)}×${Math.round(crop.h * take.height)}`,
            );
          }}
        />
      )}
    </div>
  );
}
