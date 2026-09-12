import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { TopBar } from "@/components/studio/TopBar";
import { IconRail } from "@/components/studio/IconRail";
import { Inspector } from "@/components/studio/Inspector";
import { Stage } from "@/components/studio/Stage";
import { Timeline } from "@/components/studio/Timeline";
import { AgentHost } from "@/components/studio/AgentHost";
import { StartPage } from "@/components/studio/StartPage";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { ExportDialog } from "@/components/studio/ExportDialog";
import { StudioProvider, useStudio } from "@/lib/studio/store";
import { AccountProvider, useAccount } from "@/lib/account/AccountProvider";
import {
  saveProjectAsYasharka,
  prepareProjectSave,
  upsertProjectLibraryEntry,
  newLibraryId,
} from "@/lib/studio/projectFiles";
import { persistTakeMedia } from "@/lib/studio/projectMedia";
import {
  startRecording,
  supportsCapture,
  type LiveRecording,
  type StartOptions,
} from "@/lib/studio/recorder";
import { startAndroidRecording, supportsAndroidCapture } from "@/lib/studio/androidCapture";
import { matchDeviceFrame } from "@/lib/studio/deviceFrames";
import { deriveAutoZooms, deriveAutoCameraMoves, mergeZoomTracks, mergeMoveTracks } from "@/lib/studio/motion";
import {
  ensureClickSounds,
  ensureZoomWhooshes,
  ensureEffectShimmers,
  ensureTypingSounds,
  deriveTypingFromSoftTaps,
} from "@/lib/studio/soundTrack";
import { makeCursorTrack } from "@/lib/studio/compositor";
import { openRecordingPip, supportsRecordingPip } from "@/lib/studio/recordingPip";
import { focusStudioWindow } from "@/lib/studio/nativeBridge";
import { listenAgentUi } from "@/lib/studio/agentUi";
import { mergeKeystrokeCues } from "@/lib/studio/keystrokes";
import { RecordingCameraBubble } from "@/components/studio/RecordingCameraBubble";
import { Circle, Square, ZoomIn, Move, PictureInPicture2 } from "lucide-react";
import { unlockUiSounds, playWhoosh } from "@/lib/studio/sounds";
import {
  CTRL_DIGIT_TO_EFFECT,
  createEffectBundle,
  SCENE_EFFECT_META,
} from "@/lib/studio/sceneEffects";
import type { SceneEffectKind } from "@/lib/studio/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Screen Beaver" },
      {
        name: "description",
        content:
          "Record your screen, add zooms and captions, then export an MP4.",
      },
      { property: "og:title", content: "Screen Beaver" },
      {
        property: "og:description",
        content: "Screen recorder and video editor for product demos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StudioRoute,
});

function StudioRoute() {
  return (
    <StudioProvider>
      <AccountProvider>
        <AgentHost />
        <Editor />
        <Toaster />
      </AccountProvider>
    </StudioProvider>
  );
}

function Editor() {
  const studio = useStudio();
  const { requireFeature, features, loading: accountLoading } =
    useAccount();
  const { clock, screenRef, cameraRef, micRef, setTake, addZoom, addMove, addEffect, take, setProject, project, selectedZoom, setSelectedZoom, selectedMove, setSelectedMove, selectedSound, setSelectedSound, selectedCaption, setSelectedCaption, selectedEffect, setSelectedEffect, selectedVideoSegment, setSelectedVideoSegment, removeZoom, removeMove, removeSound, removeCaptionCue, removeEffect, removeVideoSegment, undo, redo, beginHistoryBatch, endHistoryBatch, clearHistory, splitSelectedAt } = studio;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSurface, setPickerSurface] = useState<
    "screen" | "application" | "tab" | "android" | undefined
  >();
  const [exportOpen, setExportOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  /** When false, show the start/home page. New Project / Open / Record opens the editor. */
  const [studioOpen, setStudioOpen] = useState(false);
  /** Stable id for library + IndexedDB media so Save → reopen keeps the video. */
  const [projectMediaId, setProjectMediaId] = useState(() => newLibraryId());
  const [missingMediaLabel, setMissingMediaLabel] = useState<string | null>(null);
  const [live, setLive] = useState<LiveRecording | null>(null);
  const [nativeRecording, setNativeRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const liveRef = useRef<LiveRecording | null>(null);
  const pipCloseRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  // Keep latest project for finish() — look presets (Clean Demo etc.) must survive stop.
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    unlockUiSounds();
  }, []);

  // Android takes: fill the phone, drop desktop chrome crops, auto-pick device shell.
  useEffect(() => {
    if (!take?.sourceLabel?.startsWith("Android")) return;
    const frameId = project.frame.deviceFrameId || "none";
    const needsFrame = frameId === "none";
    const needsCropFix =
      (project.frame.nativeChromeCrop ?? 0) > 0.001 || (project.frame.taskbarCrop ?? 0) > 0.001;
    if (!needsFrame && !needsCropFix) return;
    const matched = matchDeviceFrame(take.sourceLabel);
    setProject({
      frame: {
        ...project.frame,
        deviceFrameId: needsFrame ? matched.frameId : frameId,
        deviceColorId: needsFrame
          ? matched.colorId
          : project.frame.deviceColorId || matched.colorId,
        nativeChromeCrop: 0,
        taskbarCrop: 0,
        chrome: "none",
        ratio: take.height >= take.width ? "9:16" : project.frame.ratio,
        padding: Math.min(project.frame.padding || 16, 16),
      },
    });
  }, [take?.sourceLabel, take?.width, take?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+S / Save → Save As Screen Beaver Project (.yasharka) + embed video
  const saveProject = useCallback(async () => {
    const mediaId = projectMediaId || newLibraryId();
    if (!projectMediaId) setProjectMediaId(mediaId);

    const { file, mediaSaved, packed } = await prepareProjectSave(project, take, mediaId);

    // Always keep Recent projects locally (even if Save As is cancelled).
    upsertProjectLibraryEntry({
      id: mediaId,
      name: project.name || "Untitled Project",
      updatedAt: Date.now(),
      sourceLabel: take?.sourceLabel,
      duration: take?.duration,
      file,
    });

    const result = await saveProjectAsYasharka(file, project.name || "Untitled Project", packed);
    if (result.cancelled) {
      toast.success("Saved to Recent projects", {
        description: "File Save As was cancelled — you can still reopen from Home.",
      });
      void import("@/lib/studio/homeActivity").then(({ logHomeActivity }) => {
        logHomeActivity("save", `Saved ${project.name || "Untitled Project"}`, "library");
      });
      return;
    }

    toast.success(
      result.method === "picker" ? "Saved as .yasharka" : "Downloaded .yasharka",
      {
        description: mediaSaved
          ? "Recording is inside the project file — reopen anytime."
          : take
            ? "Project saved, but the recording could not be included. Link the video if you reopen."
            : "Project settings saved.",
      },
    );
    void import("@/lib/studio/homeActivity").then(({ logHomeActivity }) => {
      logHomeActivity("save", `Saved ${project.name || "Untitled Project"}`, ".yasharka");
    });
  }, [project, take, projectMediaId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "s") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      e.preventDefault();
      void saveProject();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveProject]);

  useEffect(() => {
    return listenAgentUi((detail) => {
      if (detail.type === "open-picker") {
        setStudioOpen(true);
        setPickerSurface(detail.surface);
        setPickerOpen(true);
      } else if (detail.type === "close-picker") {
        setPickerOpen(false);
      } else if (detail.type === "native-recording") {
        setNativeRecording(detail.active);
        if (detail.active) {
          setStudioOpen(true);
          setPickerOpen(false);
        }
      }
    });
  }, []);

  useEffect(() => {
    liveRef.current = live;
    if (!live) return;
    const id = setInterval(() => setElapsed((performance.now() - live.startedAt) / 1000), 200);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!live || live.hasDesktopCursor) return;
    const onBlur = () => {
      toast.message("Switched away from this window", {
        description:
          "Use the Screen Beaver desktop app to track the cursor in other apps.",
        id: "cursor-blur",
      });
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [live]);

  const closePip = useCallback(() => {
    pipCloseRef.current?.();
    pipCloseRef.current = null;
  }, []);

  const finish = useCallback(async () => {
    const session = liveRef.current;
    if (!session) return;
    liveRef.current = null;
    setLive(null);
    closePip();
    const { take: newTake, markers, sounds, captions, keystrokes } = await session.stop();
    // Live look (Clean Demo / frame / background) — never a stale finish() closure.
    const project = projectRef.current;
    setTake(newTake);
    setStudioOpen(true);
    setMissingMediaLabel(null);
    const mediaId = newLibraryId();
    setProjectMediaId(mediaId);
    void persistTakeMedia(mediaId, newTake);
    const hasCursorPath = newTake.cursor.length >= 2;

    const zoomMarkers = markers.filter((m) => m.kind === "zoom");
    const moveMarkers = markers.filter((m) => m.kind === "camera-move");
    const effectMarkers = markers.filter((m) => m.kind === "scene-effect" && m.preset);

    const manuals = zoomMarkers.map((m, i) => {
      const hold = typeof m.duration === "number" && m.duration > 0;
      const time = hold ? m.t : Math.max(0, m.t - 0.35);
      const duration = hold
        ? Math.min(newTake.duration - time, Math.max(0.45, m.duration! + 0.35))
        : Math.min(newTake.duration - time, 2.6);
      return {
        id: `z-${i}-${Math.round(m.t * 1000)}`,
        time,
        duration,
        scale: project.zoom?.autoScale ?? 2.15,
        x: m.x,
        y: m.y,
        followCursor: true,
        auto: false,
      };
    });

    const track = makeCursorTrack(newTake, 72, true);
    const wantAuto = project.zoom?.enabled !== false && (project.zoom?.mode ?? "auto") === "auto";
    const autos = wantAuto
      ? deriveAutoZooms(track, newTake.duration, project.zoom?.autoScale ?? 2.15, {
          typingClips: (sounds ?? [])
            .filter((s) => s.kind === "typing")
            .map((s) => ({ time: s.time, duration: s.duration })),
        })
      : [];

    const effectZooms = [];
    const effectMoves = [];
    const effects = [];
    for (let i = 0; i < effectMarkers.length; i++) {
      const m = effectMarkers[i]!;
      const bundle = createEffectBundle(
        m.preset!,
        m.t,
        { x: m.x, y: m.y },
        project.zoom?.autoScale ?? 2.15,
      );
      effects.push(bundle.effect);
      for (const z of bundle.zooms) effectZooms.push(z);
      for (const m of bundle.moves) effectMoves.push(m);
    }

    // Auto product intro: window rises from below with glare (3D), unless one exists.
    if (
      wantAuto &&
      features?.effects &&
      !effects.some((e) => e.kind === "window-reveal" && e.time < 0.4)
    ) {
      const intro = createEffectBundle(
        "window-reveal",
        0,
        { x: 0.5, y: 0.45 },
        project.zoom?.autoScale ?? 2.15,
      );
      effects.unshift(intro.effect);
      for (const z of intro.zooms) effectZooms.push(z);
    }

    const merged =
      project.zoom?.enabled === false
        ? []
        : mergeZoomTracks([...manuals, ...effectZooms], autos);

    const manualMoves = [
      ...moveMarkers.map((m, i) => ({
        id: `m-${i}-${Math.round(m.t * 1000)}`,
        time: m.t,
        duration: 1.6,
        kind: (i % 2 === 0 ? "arc-lr" : "arc-rl") as "arc-lr" | "arc-rl",
      })),
      ...effectMoves,
    ];
    const moves = mergeMoveTracks(
      manualMoves,
      wantAuto
        ? deriveAutoCameraMoves(project.camera, merged, newTake.duration, manualMoves, track)
        : [],
    );

    let nextSounds = sounds ?? [];
    if (wantAuto) {
      nextSounds = ensureClickSounds(track.clicks, nextSounds);
      nextSounds = ensureZoomWhooshes(merged, nextSounds);
      nextSounds = ensureTypingSounds(deriveTypingFromSoftTaps(newTake.cursor), nextSounds);
    }
    nextSounds = ensureEffectShimmers(effects, nextSounds);

    const isAndroid = (newTake.sourceLabel || "").startsWith("Android");
    if (isAndroid && newTake.cursor.length < 2) {
      toast.message("No click path on this take", {
        description: "Record Android again and click or type in the mirror window.",
        action: {
          label: "Record Android",
          onClick: () => {
            setPickerSurface("android");
            setPickerOpen(true);
          },
        },
        duration: 8000,
      });
    }

    const taskbarCrop =
      newTake.captureSurface === "monitor"
        ? Math.min(0.08, Math.max(0.045, 48 / Math.max(900, newTake.height)))
        : project.frame.taskbarCrop ?? 0;

    const nextRatio = isAndroid
      ? newTake.height >= newTake.width
        ? ("9:16" as const)
        : ("16:9" as const)
      : project.frame.ratio;

    const androidHint = newTake.sourceLabel || "";
    const deviceMatch = isAndroid ? matchDeviceFrame(androidHint) : null;

    const demoName = newTake.sourceLabel
      ? `${newTake.sourceLabel} Demo`
      : "Untitled Recording";
    const projectPatch = {
      zooms: merged,
      moves,
      effects,
      sounds: nextSounds,
      trim: { start: 0, end: newTake.duration },
      name: demoName,
      background: project.background,
      frame: {
        ...project.frame,
        taskbarCrop: isAndroid ? 0 : taskbarCrop,
        nativeChromeCrop: isAndroid ? 0 : project.frame.nativeChromeCrop,
        ratio: nextRatio,
        chrome: isAndroid ? "none" : project.frame.chrome,
        padding: isAndroid ? Math.min(project.frame.padding, 16) : project.frame.padding,
        deviceFrameId: deviceMatch?.frameId ?? project.frame.deviceFrameId ?? "none",
        deviceColorId: deviceMatch?.colorId ?? project.frame.deviceColorId ?? "black",
      },
      zoom: {
        enabled: project.zoom?.enabled !== false,
        mode: project.zoom?.mode ?? "auto",
        autoScale: project.zoom?.autoScale ?? 1.85,
      },
      cursor: {
        visible: (session.smoothCursor || isAndroid) && hasCursorPath,
        smoothing: 72,
        size: 100,
        clickRipple: true,
        autoHideIdle: true,
        style: project.cursor?.style ?? "auto",
      },
      captions: {
        ...(project.captions ?? {
          enabled: true,
          burnIn: true,
          fontSize: 36,
          cues: [],
        }),
        cues: captions?.length ? captions : project.captions?.cues ?? [],
        enabled: true,
        burnIn: true,
      },
      keystrokes: {
        ...(project.keystrokes ?? {
          enabled: true,
          burnIn: true,
          size: 100,
          position: "bottom" as const,
          cues: [],
        }),
        cues: keystrokes?.length
          ? mergeKeystrokeCues([], keystrokes)
          : project.keystrokes?.cues ?? [],
        enabled: project.keystrokes?.enabled !== false,
        burnIn: project.keystrokes?.burnIn !== false,
      },
    };
    setProject(projectPatch);
    clearHistory();
    clock.set(0);
    clock.setPlaying(false);
    setInspectorOpen(true);
    setPickerOpen(false);
    void focusStudioWindow();

    // Persist into Recent projects immediately (no Save As required).
    const libraryId = projectMediaId || newLibraryId();
    if (!projectMediaId) setProjectMediaId(libraryId);
    void prepareProjectSave({ ...project, ...projectPatch }, newTake, libraryId)
      .then(({ file }) => {
        upsertProjectLibraryEntry({
          id: libraryId,
          name: demoName,
          updatedAt: Date.now(),
          sourceLabel: newTake.sourceLabel,
          duration: newTake.duration,
          file,
        });
      })
      .catch(() => {
        /* library persist is best-effort */
      });

    const zoomCount = merged.length;
    const sfxCount = nextSounds.length;
    const fxCount = effects.length;
    const autoCam = moves.filter((m) => m.auto).length;
    if (session.smoothCursor && !hasCursorPath) {
      toast.message("No smooth cursor path captured", {
        description:
          "Use the Screen Beaver desktop app to track the cursor in other apps.",
      });
    } else if (zoomCount > 0 || sfxCount > 0 || fxCount > 0 || autoCam > 0 || (keystrokes?.length ?? 0) > 0) {
      const autoN = merged.filter((z) => z.auto).length;
      toast.success(
        `Recording ready · ${newTake.duration.toFixed(1)}s` +
          (zoomCount ? ` · ${zoomCount} zoom${zoomCount === 1 ? "" : "s"}` : "") +
          (autoN ? ` (${autoN} auto)` : "") +
          (autoCam ? ` · ${autoCam} camera` : "") +
          (fxCount ? ` · ${fxCount} effect${fxCount === 1 ? "" : "s"}` : "") +
          (sfxCount ? ` · ${sfxCount} SFX` : "") +
          (captions?.length ? ` · ${captions.length} captions` : "") +
          (keystrokes?.length ? ` · ${keystrokes.length} shortcuts` : ""),
      );
    } else {
      toast.success(`Recording ready · ${newTake.duration.toFixed(1)}s`);
    }
    void import("@/lib/studio/homeActivity").then(({ logHomeActivity }) => {
      logHomeActivity("record", "Finished screen recording", `${newTake.duration.toFixed(1)}s`);
    });
  }, [setTake, setProject, clearHistory, clock, closePip, features?.effects, projectMediaId, project]);

  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const openPip = useCallback(async () => {
    const session = liveRef.current;
    if (!session || !supportsRecordingPip()) {
      toast.error("Floating controls aren't supported in this browser");
      return;
    }
    closePip();
    const handle = await openRecordingPip({
      onZoom: () => {
        liveRef.current?.addMarker("zoom");
        toast.message("Zoom marked");
      },
      onCamera: () => {
        liveRef.current?.addMarker("camera-move");
        toast.message("Camera sweep marked");
      },
      onStop: () => void finishRef.current(),
      getElapsed: () => {
        const s = liveRef.current;
        return s ? (performance.now() - s.startedAt) / 1000 : 0;
      },
    });
    if (!handle) {
      toast.error("Couldn't open floating controls");
      return;
    }
    pipCloseRef.current = handle.close;
    toast.success("Floating controls ready — drag them where you need");
  }, [closePip]);

  const begin = useCallback(async (opts: StartOptions) => {
    if (opts.surface === "android") {
      if (!supportsAndroidCapture()) {
        toast.error("Android USB recording needs the Screen Beaver desktop app.");
        return;
      }
      setPickerOpen(false);
      try {
        toast.message("Starting Android mirror…", {
          description: "First run may download a small helper (~11 MB).",
        });
        const session = await startAndroidRecording(opts);
        setLive(session);
        setElapsed(0);
        toast.success(
          session.hasDesktopCursor
            ? "Phone mirrored — use the mirror window, then Stop."
            : "Phone mirrored — control the phone, then Stop.",
        );
      } catch (err) {
        console.error(err);
        toast.error(err instanceof Error ? err.message : "Android capture failed");
      }
      return;
    }

    if (!supportsCapture()) {
      toast.error("Screen capture isn't available in this browser. Use Chrome, Edge or Arc.");
      return;
    }
    setPickerOpen(false);
    try {
      const session = await startRecording(opts);
      setLive(session);
      setElapsed(0);
      session.screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        void finishRef.current();
      });
      toast.success(
        session.hasDesktopCursor
          ? "Recording — Shift+Click or Ctrl+Click to mark zooms."
          : "Recording — your cursor stays visible. Use the desktop app for zooms in other apps.",
      );
    } catch (err) {
      console.error(err);
      toast.error("Capture was cancelled or blocked");
    }
  }, []);

  // editor hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.code === "Space" && !e.shiftKey) {
        e.preventDefault();
        const v = screenRef.current;
        if (!v) return;
        if (v.paused) {
          const trimStart = project.trim.start || 0;
          const trimEnd = project.trim.end > 0 ? project.trim.end : take?.duration ?? v.duration;
          if (v.currentTime < trimStart || v.currentTime >= trimEnd - 0.05) {
            v.currentTime = trimStart;
            if (cameraRef.current) cameraRef.current.currentTime = trimStart;
            if (micRef.current) micRef.current.currentTime = trimStart;
            clock.set(trimStart);
          }
          void v.play();
          if (cameraRef.current) void cameraRef.current.play();
          if (micRef.current) {
            micRef.current.currentTime = v.currentTime;
            void micRef.current.play().catch(() => {});
          }
          clock.setPlaying(true);
        } else {
          v.pause();
          cameraRef.current?.pause();
          micRef.current?.pause();
          clock.setPlaying(false);
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
        const isRedo = e.key === "y" || e.key === "Y" || e.shiftKey;
        e.preventDefault();
        if (isRedo) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && take && !e.altKey) {
        const kind = CTRL_DIGIT_TO_EFFECT[e.code] as SceneEffectKind | undefined;
        if (kind) {
          if (!requireFeature("effects", "Scene effects")) return;
          e.preventDefault();
          const cursor = take.cursor;
          let fx = 0.5;
          let fy = 0.42;
          if (cursor.length) {
            let best = cursor[0]!;
            let bestD = Math.abs(best.t - clock.time);
            for (const s of cursor) {
              const d = Math.abs(s.t - clock.time);
              if (d < bestD) {
                best = s;
                bestD = d;
              }
            }
            fx = best.x;
            fy = best.y;
          }
          const bundle = createEffectBundle(
            kind,
            clock.time,
            { x: fx, y: fy },
            project.zoom?.autoScale ?? 2.15,
          );
          beginHistoryBatch();
          addEffect(bundle.effect);
          for (const z of bundle.zooms) addZoom(z);
          for (const m of bundle.moves) addMove(m);
          endHistoryBatch();
          if (bundle.zooms[0]) setSelectedZoom(bundle.zooms[0].id);
          setSelectedEffect(bundle.effect.id);
          playWhoosh();
          toast.message(`${SCENE_EFFECT_META[kind].label}`, {
            description: SCENE_EFFECT_META[kind].shortcut,
          });
          return;
        }
      }
      if ((e.key === "c" || e.key === "C") && take && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const { ok, message } = splitSelectedAt(clock.time);
        if (ok) toast.success(message);
        else toast.message(message);
        return;
      }
      if (e.key === "z" && take && !e.ctrlKey && !e.metaKey) {
        const id = `z-${Date.now()}`;
        addZoom({
          id,
          time: clock.time,
          duration: 2.4,
          scale: project.zoom?.autoScale ?? 2,
          x: 0.5,
          y: 0.5,
          followCursor: false,
          auto: false,
        });
        setSelectedZoom(id);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && take) {
        if (selectedVideoSegment) {
          e.preventDefault();
          removeVideoSegment(selectedVideoSegment);
        } else if (selectedEffect) {
          e.preventDefault();
          removeEffect(selectedEffect);
          setSelectedEffect(null);
        } else if (selectedZoom) {
          e.preventDefault();
          removeZoom(selectedZoom);
          setSelectedZoom(null);
        } else if (selectedMove) {
          e.preventDefault();
          removeMove(selectedMove);
          setSelectedMove(null);
        } else if (selectedSound) {
          e.preventDefault();
          removeSound(selectedSound);
          setSelectedSound(null);
        } else if (selectedCaption) {
          e.preventDefault();
          removeCaptionCue(selectedCaption);
          setSelectedCaption(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    clock,
    screenRef,
    cameraRef,
    micRef,
    addZoom,
    addMove,
    addEffect,
    take,
    requireFeature,
    project.trim.start,
    project.trim.end,
    project.zoom?.autoScale,
    selectedZoom,
    selectedMove,
    selectedSound,
    selectedCaption,
    selectedEffect,
    selectedVideoSegment,
    removeZoom,
    removeMove,
    removeSound,
    removeCaptionCue,
    removeEffect,
    removeVideoSegment,
    setSelectedZoom,
    setSelectedMove,
    setSelectedSound,
    setSelectedCaption,
    setSelectedEffect,
    setSelectedVideoSegment,
    undo,
    redo,
    beginHistoryBatch,
    endHistoryBatch,
    splitSelectedAt,
  ]);

  if (accountLoading) {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden bg-[#0a0c10]">
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <img src="/logo.png" alt="" className="h-12 w-12 rounded-xl object-contain" />
          <p className="text-[13px] text-white/50">Starting Screen Beaver…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-shell">
      <TopBar
        onExport={() => setExportOpen(true)}
        onRecord={() => (live ? void finish() : setPickerOpen(true))}
        onSave={() => void saveProject()}
        onGoHome={() => setStudioOpen(false)}
        recording={!!live}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />

      <div className="flex min-h-0 flex-1">
        <IconRail />
        <main className="flex min-w-0 flex-1 flex-col bg-stage">
          <Stage
            onRecordClick={() => setPickerOpen(true)}
            nativeRecording={nativeRecording || !!live}
            missingMediaLabel={missingMediaLabel}
            onMediaLinked={() => setMissingMediaLabel(null)}
          />
          <Timeline
            onProjectOpened={(r) => {
              if (r.mediaId) setProjectMediaId(r.mediaId);
              else setProjectMediaId(newLibraryId());
              setMissingMediaLabel(r.hasVideo ? null : r.sourceLabel ?? "screen recording");
            }}
          />
        </main>
        {inspectorOpen && <Inspector onExport={() => setExportOpen(true)} />}
      </div>

      {live?.cameraStream && <RecordingCameraBubble stream={live.cameraStream} />}

      {live && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 ring-1 ring-hairline shadow-lg">
          <span className="flex items-center gap-2 pr-2 text-[12px] font-semibold tabular-nums hairline-r">
            <Circle className="h-2 w-2 animate-pulse fill-record text-record" />
            {elapsed.toFixed(1)}s
          </span>
          {live.hasDesktopCursor && (
            <span className="hidden text-[10px] uppercase tracking-wider text-ember sm:inline">Track</span>
          )}
          <button
            type="button"
            onClick={() => {
              live.addMarker("zoom");
              toast.message("Zoom marked");
            }}
            className="flex items-center gap-1.5 rounded bg-panel-raised px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent"
            title="Add zoom at the current cursor"
          >
            <ZoomIn className="h-3.5 w-3.5" />
            Zoom
          </button>
          <button
            type="button"
            onClick={() => {
              live.addMarker("camera-move");
              toast.message("Camera sweep marked");
            }}
            className="flex items-center gap-1.5 rounded bg-panel-raised px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent"
            title="Add a camera sweep"
          >
            <Move className="h-3.5 w-3.5" />
            Camera
          </button>
          {supportsRecordingPip() && (
            <button
              type="button"
              onClick={() => void openPip()}
              className="flex items-center gap-1.5 rounded bg-panel-raised px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent"
              title="Float controls over other apps"
            >
              <PictureInPicture2 className="h-3.5 w-3.5" />
              Pop out
            </button>
          )}
          <button
            onClick={() => void finish()}
            className="flex items-center gap-1.5 rounded bg-record px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground"
          >
            <Square className="h-3 w-3 fill-current" />
            Stop
          </button>
        </div>
      )}

      <SourcePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        preferredSurface={pickerSurface}
        onStart={(o) => void begin(o)}
      />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />

      {!studioOpen && (
        <div className="absolute inset-0 z-50">
          <StartPage
            onRecordClick={() => {
              setStudioOpen(true);
              setPickerOpen(true);
              setMissingMediaLabel(null);
              setProjectMediaId(newLibraryId());
            }}
            onEnterStudio={() => setStudioOpen(true)}
            onProjectOpened={(r) => {
              if (r.mediaId) setProjectMediaId(r.mediaId);
              else setProjectMediaId(newLibraryId());
              setMissingMediaLabel(r.hasVideo ? null : r.sourceLabel ?? "screen recording");
            }}
          />
        </div>
      )}
    </div>
  );
}
