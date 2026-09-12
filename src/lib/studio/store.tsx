import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  BackgroundSettings,
  CameraMove,
  SceneEffect,
  CameraSettings,
  CursorSettings,
  FrameSettings,
  ProjectState,
  RecordingTake,
  ZoomKeyframe,
  ZoomSettings,
  CaptionSettings,
  SoundClip,
  CaptionCue,
  KeystrokeCue,
  KeystrokeSettings,
  VoiceoverSettings,
  VoiceoverClip,
  BackgroundMusicSettings,
} from "./types";
import { deriveAutoZooms, deriveAutoCameraMoves, mergeZoomTracks, mergeMoveTracks } from "./motion";
import { makeCursorTrack } from "./compositor";
import { splitClipAtTime } from "./splitClip";
import { deleteVideoSegment, splitVideoAtTimeline, updateVideoSegment, reorderVideoSegment } from "./videoEdit";
import { ensureClickSounds, ensureZoomWhooshes, ensureEffectShimmers } from "./soundTrack";

const HISTORY_LIMIT = 50;

function revokeVoiceoverUrls(clips: VoiceoverClip[]) {
  for (const c of clips) {
    if (c.audioUrl?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(c.audioUrl);
      } catch {
        /* ignore */
      }
    }
  }
}

export const DEFAULT_PROJECT: ProjectState = {
  name: "Untitled Recording",
  background: {
    mode: "wallpaper",
    // Gradient default — photo wallpapers decode on demand (import must not OOM).
    wallpaperId: "sunbeam",
    motionId: "ribbon-field",
    gradientFrom: "#6d28d9",
    gradientTo: "#0ea5e9",
    gradientAngle: 135,
    color: "#111114",
    imageUrl: null,
    blur: 0,
  },
  frame: {
    ratio: "16:9",
    padding: 34,
    radius: 26,
    shadow: 62,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    chrome: "browser",
    chromeTheme: "dark",
    windowTitle: "",
    nativeChromeCrop: 0.11,
    taskbarCrop: 0,
    browserUrl: "example.com",
    browserSiteName: "",
    deviceFrameId: "none",
    deviceColorId: "black",
  },
  camera: {
    enabled: true,
    shape: "circle",
    roundness: 100,
    size: 18,
    sizeDuringZoom: 11,
    shrinkDuringZoom: true,
    avoidCursor: true,
    position: "bottom-left",
    corner: "bottom-left",
    mirror: true,
    shadow: true,
    backgroundMode: "none",
    backgroundColor: "#1f2937",
    backgroundImageUrl: null,
  },
  cursor: {
    visible: true,
    smoothing: 72,
    size: 100,
    clickRipple: true,
    autoHideIdle: true,
    style: "auto",
  },
  zoom: {
    enabled: true,
    mode: "auto",
    autoScale: 1.85,
  },
  captions: {
    enabled: true,
    burnIn: true,
    fontSize: 36,
    cues: [],
  },
  keystrokes: {
    enabled: true,
    burnIn: true,
    size: 100,
    position: "bottom",
    cues: [],
  },
  voiceover: {
    enabled: false,
    speakLang: "en-US",
    targetLang: "en-US",
    voice: "en-US-JennyNeural",
    clips: [],
  },
  music: {
    enabled: false,
    url: null,
    title: "",
    creator: "",
    license: "",
    volume: 0.16,
    loop: true,
  },
  zooms: [],
  moves: [],
  effects: [],
  sounds: [],
  speed: 1,
  trim: { start: 0, end: 0 },
};

/** Tiny external store so 60fps playback doesn't re-render the whole editor. */
class Clock {
  private t = 0;
  private isPlaying = false;
  private listeners = new Set<() => void>();
  private lastEmitMs = 0;
  snapshot = { time: 0, playing: false };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = { time: this.t, playing: this.isPlaying };
    this.listeners.forEach((l) => l());
  }
  set(time: number) {
    this.t = Math.max(0, time);
    // Keep this.t fresh for the canvas rAF loop, but only notify React ~20fps while playing.
    if (this.isPlaying) {
      const now = performance.now();
      if (now - this.lastEmitMs < 50) return;
      this.lastEmitMs = now;
    } else {
      this.lastEmitMs = performance.now();
    }
    this.emit();
  }
  setPlaying(p: boolean) {
    if (this.isPlaying === p) return;
    this.isPlaying = p;
    this.lastEmitMs = 0;
    this.emit();
  }
  get time() {
    return this.t;
  }
  get playing() {
    return this.isPlaying;
  }
}

export type InspectorTab =
  | "background"
  | "motion"
  | "effects"
  | "cursor"
  | "zoom"
  | "camera"
  | "captions"
  | "voiceover"
  | "audio"
  | "clip"
  | "shortcuts"
  | "export";

type HistoryState = {
  present: ProjectState;
  past: ProjectState[];
  future: ProjectState[];
  coalesceKey: string | null;
};

type HistoryAction =
  | { type: "commit"; updater: (p: ProjectState) => ProjectState; coalesce?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "replace"; project: ProjectState }
  | { type: "clearHistory" }
  | { type: "endCoalesce" };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "commit": {
      const next = action.updater(state.present);
      if (Object.is(next, state.present)) return state;
      const key = action.coalesce ?? null;
      if (key != null && key === state.coalesceKey) {
        return { ...state, present: next };
      }
      return {
        present: next,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present],
        future: [],
        coalesceKey: key,
      };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1]!;
      return {
        present: prev,
        past: state.past.slice(0, -1),
        future: [...state.future, state.present],
        coalesceKey: null,
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1]!;
      return {
        present: next,
        past: [...state.past, state.present],
        future: state.future.slice(0, -1),
        coalesceKey: null,
      };
    }
    case "replace":
      return { present: action.project, past: [], future: [], coalesceKey: null };
    case "clearHistory":
      return { ...state, past: [], future: [], coalesceKey: null };
    case "endCoalesce":
      return state.coalesceKey == null ? state : { ...state, coalesceKey: null };
    default:
      return state;
  }
}

function coalesceKeys(prefix: string, patch: object): string {
  return `${prefix}:${Object.keys(patch).sort().join(",")}`;
}

interface StudioContextValue {
  project: ProjectState;
  setProject: (patch: Partial<ProjectState>) => void;
  /**
   * Hard replace the whole project (clears undo/redo history).
   * Useful for opening/importing a saved project.
   */
  replaceProject: (project: ProjectState) => void;
  patchBackground: (patch: Partial<BackgroundSettings>) => void;
  patchFrame: (patch: Partial<FrameSettings>) => void;
  patchCamera: (patch: Partial<CameraSettings>) => void;
  patchCursor: (patch: Partial<CursorSettings>) => void;
  patchZoom: (patch: Partial<ZoomSettings>) => void;
  patchCaptions: (patch: Partial<CaptionSettings>) => void;
  setCaptionCues: (cues: CaptionSettings["cues"]) => void;
  addCaptionCue: (cue: CaptionCue) => void;
  updateCaptionCue: (id: string, patch: Partial<CaptionCue>) => void;
  removeCaptionCue: (id: string) => void;
  patchKeystrokes: (patch: Partial<KeystrokeSettings>) => void;
  setKeystrokeCues: (cues: KeystrokeCue[]) => void;
  updateKeystrokeCue: (id: string, patch: Partial<KeystrokeCue>) => void;
  removeKeystrokeCue: (id: string) => void;
  patchVoiceover: (patch: Partial<VoiceoverSettings>) => void;
  setVoiceoverClips: (clips: VoiceoverClip[]) => void;
  clearVoiceoverClips: () => void;
  patchMusic: (patch: Partial<BackgroundMusicSettings>) => void;
  addZoom: (z: ZoomKeyframe) => void;
  updateZoom: (id: string, patch: Partial<ZoomKeyframe>) => void;
  removeZoom: (id: string) => void;
  addMove: (m: CameraMove) => void;
  updateMove: (id: string, patch: Partial<CameraMove>) => void;
  removeMove: (id: string) => void;
  addEffect: (e: SceneEffect) => void;
  updateEffect: (id: string, patch: Partial<SceneEffect>) => void;
  removeEffect: (id: string) => void;
  setEffects: (effects: SceneEffect[]) => void;
  addSound: (s: SoundClip) => void;
  updateSound: (id: string, patch: Partial<SoundClip>) => void;
  removeSound: (id: string) => void;
  setSounds: (sounds: SoundClip[]) => void;
  patchTrim: (patch: Partial<ProjectState["trim"]>) => void;
  regenerateAutoZooms: () => void;
  take: RecordingTake | null;
  setTake: (t: RecordingTake | null) => void;
  clock: Clock;
  inspector: InspectorTab;
  setInspector: (t: InspectorTab) => void;
  selectedZoom: string | null;
  setSelectedZoom: (id: string | null) => void;
  selectedMove: string | null;
  setSelectedMove: (id: string | null) => void;
  selectedSound: string | null;
  setSelectedSound: (id: string | null) => void;
  selectedCaption: string | null;
  setSelectedCaption: (id: string | null) => void;
  selectedEffect: string | null;
  setSelectedEffect: (id: string | null) => void;
  selectedVideoSegment: string | null;
  setSelectedVideoSegment: (id: string | null) => void;
  /** When true, next click on the stage sets the selected zoom's focus. */
  pickingFocus: boolean;
  setPickingFocus: (v: boolean) => void;
  screenRef: React.RefObject<HTMLVideoElement | null>;
  cameraRef: React.RefObject<HTMLVideoElement | null>;
  micRef: React.RefObject<HTMLAudioElement | null>;
  /**
   * Split the selected timeline clip (or the video under the playhead) into two at `time`.
   * Returns whether the cut succeeded and a short status message.
   */
  splitSelectedAt: (time: number) => { ok: boolean; message: string };
  removeVideoSegment: (id: string) => void;
  patchVideoSegment: (
    id: string,
    patch: { speed?: number; in?: number; out?: number },
  ) => { ok: boolean; message: string };
  reorderVideoSegment: (id: string, toIndex: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Group multiple commits into a single undo step (supports nesting). */
  beginHistoryBatch: () => void;
  endHistoryBatch: () => void;
  /** Keep the current project as the baseline (e.g. after importing a take). */
  clearHistory: () => void;
  reset: () => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [history, dispatch] = useReducer(historyReducer, {
    present: DEFAULT_PROJECT,
    past: [],
    future: [],
    coalesceKey: null,
  });
  const project = history.present;
  const projectRef = useRef(project);
  projectRef.current = project;

  const batchDepthRef = useRef(0);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeRef = useRef<RecordingTake | null>(null);

  const [take, setTakeState] = useState<RecordingTake | null>(null);
  takeRef.current = take;
  const [inspector, setInspector] = useState<InspectorTab>("background");
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null);
  const [selectedMove, setSelectedMove] = useState<string | null>(null);
  const [selectedSound, setSelectedSound] = useState<string | null>(null);
  const [selectedCaption, setSelectedCaption] = useState<string | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<string | null>(null);
  const [selectedVideoSegment, setSelectedVideoSegment] = useState<string | null>(null);
  const [pickingFocus, setPickingFocus] = useState(false);
  const clockRef = useRef<Clock | null>(null);
  if (!clockRef.current) clockRef.current = new Clock();
  const screenRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const micRef = useRef<HTMLAudioElement | null>(null);

  const commit = useCallback((updater: (p: ProjectState) => ProjectState, coalesce?: string) => {
    const key = batchDepthRef.current > 0 ? "__batch__" : coalesce;
    dispatch({ type: "commit", updater, coalesce: key });
    if (coalesceTimerRef.current != null) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
    // End coalesce shortly after continuous gestures (timeline drag, slider scrub) go idle
    // so the next edit becomes its own undo step.
    if (key != null && batchDepthRef.current === 0) {
      coalesceTimerRef.current = setTimeout(() => {
        dispatch({ type: "endCoalesce" });
        coalesceTimerRef.current = null;
      }, 400);
    }
  }, []);

  const setProject = useCallback(
    (patch: Partial<ProjectState>) => {
      commit((p) => ({ ...p, ...patch }));
    },
    [commit],
  );

  const undo = useCallback(() => {
    if (coalesceTimerRef.current != null) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
    dispatch({ type: "undo" });
  }, []);
  const redo = useCallback(() => {
    if (coalesceTimerRef.current != null) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
    dispatch({ type: "redo" });
  }, []);
  const clearHistory = useCallback(() => dispatch({ type: "clearHistory" }), []);
  const beginHistoryBatch = useCallback(() => {
    if (coalesceTimerRef.current != null) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
    batchDepthRef.current += 1;
  }, []);
  const endHistoryBatch = useCallback(() => {
    batchDepthRef.current = Math.max(0, batchDepthRef.current - 1);
    if (batchDepthRef.current === 0) dispatch({ type: "endCoalesce" });
  }, []);

  const setTake = useCallback((t: RecordingTake | null) => {
    setTakeState(t);
  }, []);

  const replaceProject = useCallback(
    (next: ProjectState) => {
      // Keep voiceover blob URLs alive only for the current session.
      // If we are replacing, revoke current session URLs to avoid leaks.
      revokeVoiceoverUrls(projectRef.current.voiceover?.clips ?? []);
      dispatch({ type: "replace", project: next });

      // Clear selection so UI doesn't reference missing clip ids.
      setSelectedZoom(null);
      setSelectedMove(null);
      setSelectedSound(null);
      setSelectedCaption(null);
      setSelectedEffect(null);
      setPickingFocus(false);
      batchDepthRef.current = 0;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch],
  );

  const value = useMemo<StudioContextValue>(
    () => ({
      project,
      setProject,
      replaceProject,
      patchBackground: (patch) =>
        commit((p) => ({ ...p, background: { ...p.background, ...patch } }), coalesceKeys("bg", patch)),
      patchFrame: (patch) =>
        commit((p) => ({ ...p, frame: { ...p.frame, ...patch } }), coalesceKeys("frame", patch)),
      patchCamera: (patch) =>
        commit((p) => {
          const next = { ...p.camera, ...patch };
          // Keep corner in sync when position is a corner cell (for arc choreography).
          if (patch.position) {
            if (patch.position === "top-left" || patch.position === "top-right") {
              next.corner = patch.position;
            } else if (patch.position === "bottom-left" || patch.position === "bottom-right") {
              next.corner = patch.position;
            } else if (patch.position.startsWith("top")) next.corner = "top-left";
            else if (patch.position.startsWith("bottom")) next.corner = "bottom-left";
          }
          if (patch.roundness != null) {
            next.shape =
              patch.roundness >= 85 ? "circle" : patch.roundness <= 15 ? "square" : "rounded";
          }
          return { ...p, camera: next };
        }, coalesceKeys("camera", patch)),
      patchCursor: (patch) =>
        commit((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }), coalesceKeys("cursor", patch)),
      patchZoom: (patch) =>
        commit((p) => ({ ...p, zoom: { ...p.zoom, ...patch } }), coalesceKeys("zoomSettings", patch)),
      patchCaptions: (patch) =>
        commit(
          (p) => ({
            ...p,
            captions: { ...(p.captions ?? DEFAULT_PROJECT.captions), ...patch },
          }),
          coalesceKeys("captions", patch),
        ),
      setCaptionCues: (cues) =>
        commit((p) => ({
          ...p,
          captions: { ...(p.captions ?? DEFAULT_PROJECT.captions), cues },
        })),
      addCaptionCue: (cue) =>
        commit((p) => {
          const caps = p.captions ?? DEFAULT_PROJECT.captions;
          return { ...p, captions: { ...caps, cues: [...caps.cues, cue] } };
        }),
      updateCaptionCue: (id, patch) =>
        commit(
          (p) => {
            const caps = p.captions ?? DEFAULT_PROJECT.captions;
            return {
              ...p,
              captions: {
                ...caps,
                cues: caps.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)),
              },
            };
          },
          coalesceKeys(`cap:${id}`, patch),
        ),
      removeCaptionCue: (id) =>
        commit((p) => {
          const caps = p.captions ?? DEFAULT_PROJECT.captions;
          return {
            ...p,
            captions: { ...caps, cues: caps.cues.filter((c) => c.id !== id) },
          };
        }),
      patchKeystrokes: (patch) =>
        commit(
          (p) => ({
            ...p,
            keystrokes: { ...(p.keystrokes ?? DEFAULT_PROJECT.keystrokes), ...patch },
          }),
          coalesceKeys("keystrokes", patch),
        ),
      setKeystrokeCues: (cues) =>
        commit((p) => ({
          ...p,
          keystrokes: { ...(p.keystrokes ?? DEFAULT_PROJECT.keystrokes), cues },
        })),
      updateKeystrokeCue: (id, patch) =>
        commit(
          (p) => {
            const ks = p.keystrokes ?? DEFAULT_PROJECT.keystrokes;
            return {
              ...p,
              keystrokes: {
                ...ks,
                cues: ks.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)),
              },
            };
          },
          coalesceKeys(`key:${id}`, patch),
        ),
      removeKeystrokeCue: (id) =>
        commit((p) => {
          const ks = p.keystrokes ?? DEFAULT_PROJECT.keystrokes;
          return {
            ...p,
            keystrokes: { ...ks, cues: ks.cues.filter((c) => c.id !== id) },
          };
        }),
      patchVoiceover: (patch) =>
        commit(
          (p) => ({
            ...p,
            voiceover: { ...(p.voiceover ?? DEFAULT_PROJECT.voiceover), ...patch },
          }),
          coalesceKeys("voiceover", patch),
        ),
      // Keep blob URLs alive so undo can restore prior voiceover clips.
      setVoiceoverClips: (clips) =>
        commit((p) => {
          const prev = p.voiceover ?? DEFAULT_PROJECT.voiceover;
          return { ...p, voiceover: { ...prev, clips, enabled: clips.length > 0 ? true : prev.enabled } };
        }),
      clearVoiceoverClips: () =>
        commit((p) => {
          const prev = p.voiceover ?? DEFAULT_PROJECT.voiceover;
          return { ...p, voiceover: { ...prev, clips: [] } };
        }),
      patchMusic: (patch) =>
        commit(
          (p) => ({
            ...p,
            music: { ...(p.music ?? DEFAULT_PROJECT.music), ...patch },
          }),
          coalesceKeys("music", patch),
        ),
      addZoom: (z) => commit((p) => ({ ...p, zooms: [...p.zooms, z] })),
      updateZoom: (id, patch) =>
        commit(
          (p) => ({
            ...p,
            zooms: p.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z)),
          }),
          coalesceKeys(`zoom:${id}`, patch),
        ),
      removeZoom: (id) => commit((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== id) })),
      addMove: (m) => commit((p) => ({ ...p, moves: [...p.moves, m] })),
      updateMove: (id, patch) =>
        commit(
          (p) => ({
            ...p,
            moves: p.moves.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          }),
          coalesceKeys(`move:${id}`, patch),
        ),
      removeMove: (id) => commit((p) => ({ ...p, moves: p.moves.filter((m) => m.id !== id) })),
      addEffect: (e) => commit((p) => ({ ...p, effects: [...(p.effects ?? []), e] })),
      updateEffect: (id, patch) =>
        commit(
          (p) => ({
            ...p,
            effects: (p.effects ?? []).map((e) => (e.id === id ? { ...e, ...patch } : e)),
          }),
          coalesceKeys(`effect:${id}`, patch),
        ),
      removeEffect: (id) =>
        commit((p) => ({
          ...p,
          effects: (p.effects ?? []).filter((e) => e.id !== id),
        })),
      setEffects: (effects) => commit((p) => ({ ...p, effects })),
      addSound: (s) => commit((p) => ({ ...p, sounds: [...(p.sounds ?? []), s] })),
      updateSound: (id, patch) =>
        commit(
          (p) => ({
            ...p,
            sounds: (p.sounds ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)),
          }),
          coalesceKeys(`sound:${id}`, patch),
        ),
      removeSound: (id) =>
        commit((p) => ({
          ...p,
          sounds: (p.sounds ?? []).filter((s) => s.id !== id),
        })),
      setSounds: (sounds) => commit((p) => ({ ...p, sounds })),
      patchTrim: (patch) =>
        commit((p) => ({ ...p, trim: { ...p.trim, ...patch } }), coalesceKeys("trim", patch)),
      regenerateAutoZooms: () => {
        commit((p) => {
          const currentTake = takeRef.current;
          if (!currentTake) return p;
          const track = makeCursorTrack(currentTake, p.cursor.smoothing, p.cursor.autoHideIdle);
          const wantAuto = p.zoom.enabled !== false && (p.zoom.mode ?? "auto") === "auto";
          const manuals = p.zooms.filter((z) => !z.auto);
          const autos = wantAuto
            ? deriveAutoZooms(track, currentTake.duration, p.zoom.autoScale, {
                typingClips: (p.sounds ?? [])
                  .filter((s) => s.kind === "typing")
                  .map((s) => ({ time: s.time, duration: s.duration })),
              })
            : [];
          const zooms =
            p.zoom.enabled === false ? manuals : mergeZoomTracks(manuals, autos);

          const manualMoves = p.moves.filter((m) => !m.auto);
          const autoMoves = wantAuto
            ? deriveAutoCameraMoves(p.camera, zooms, currentTake.duration, manualMoves, track)
            : [];
          const moves = mergeMoveTracks(manualMoves, autoMoves);

          let sounds = p.sounds ?? [];
          if (wantAuto) {
            sounds = ensureClickSounds(track.clicks, sounds);
            sounds = ensureZoomWhooshes(zooms, sounds);
          }
          sounds = ensureEffectShimmers(p.effects ?? [], sounds);

          return { ...p, zooms, moves, sounds };
        });
      },
      take,
      setTake,
      clock: clockRef.current!,
      inspector,
      setInspector,
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
      pickingFocus,
      setPickingFocus,
      screenRef,
      cameraRef,
      micRef,
      splitSelectedAt: (time) => {
        const proj = projectRef.current;
        const takeDur = takeRef.current?.duration ?? 0;
        const hasOther =
          !!(selectedZoom || selectedMove || selectedEffect || selectedSound || selectedCaption);

        // Prefer cutting the video unless another clip type is explicitly selected.
        if (selectedVideoSegment || !hasOther) {
          const videoCut = splitVideoAtTimeline(
            proj,
            takeDur,
            time,
            selectedVideoSegment,
          );
          if (videoCut.ok && videoCut.project) {
            commit(() => videoCut.project!);
            setSelectedVideoSegment(videoCut.selectedSegmentId ?? null);
            setSelectedZoom(null);
            setSelectedMove(null);
            setSelectedEffect(null);
            setSelectedSound(null);
            setSelectedCaption(null);
            return { ok: true, message: videoCut.message };
          }
          if (selectedVideoSegment || !hasOther) {
            return { ok: false, message: videoCut.message };
          }
        }

        const result = splitClipAtTime(
          proj,
          {
            zoom: selectedZoom,
            move: selectedMove,
            effect: selectedEffect,
            sound: selectedSound,
            caption: selectedCaption,
          },
          time,
        );
        if (result.ok && result.project) {
          commit(() => result.project!);
          if (result.selection) {
            setSelectedZoom(result.selection.zoom ?? null);
            setSelectedMove(result.selection.move ?? null);
            setSelectedEffect(result.selection.effect ?? null);
            setSelectedSound(result.selection.sound ?? null);
            setSelectedCaption(result.selection.caption ?? null);
            setSelectedVideoSegment(null);
          }
        }
        return { ok: result.ok, message: result.message };
      },
      removeVideoSegment: (id) => {
        const takeDur = takeRef.current?.duration ?? 0;
        const result = deleteVideoSegment(projectRef.current, takeDur, id);
        if (result.ok && result.project) {
          commit(() => result.project!);
          setSelectedVideoSegment(result.selectedSegmentId ?? null);
        }
      },
      patchVideoSegment: (id, patch) => {
        const takeDur = takeRef.current?.duration ?? 0;
        const result = updateVideoSegment(projectRef.current, takeDur, id, patch);
        if (result.ok && result.project) {
          commit(() => result.project!, coalesceKeys("video-seg", patch));
          setSelectedVideoSegment(result.selectedSegmentId ?? id);
        }
        return { ok: result.ok, message: result.message };
      },
      reorderVideoSegment: (id, toIndex) => {
        const takeDur = takeRef.current?.duration ?? 0;
        const result = reorderVideoSegment(projectRef.current, takeDur, id, toIndex);
        if (!result.ok || !result.project) return;
        // Skip no-op commits while the pointer hovers the same slot.
        if (result.project === projectRef.current) return;
        commit(() => result.project!, "video-reorder");
        setSelectedVideoSegment(result.selectedSegmentId ?? id);
      },
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      undo,
      redo,
      beginHistoryBatch,
      endHistoryBatch,
      clearHistory,
      reset: () => {
        revokeVoiceoverUrls(projectRef.current.voiceover?.clips ?? []);
        dispatch({ type: "replace", project: DEFAULT_PROJECT });
        setTakeState(null);
        setSelectedZoom(null);
        setSelectedMove(null);
        setSelectedSound(null);
        setSelectedCaption(null);
        setSelectedEffect(null);
        setSelectedVideoSegment(null);
        setPickingFocus(false);
        batchDepthRef.current = 0;
        clockRef.current!.set(0);
        clockRef.current!.setPlaying(false);
      },
    }),
    [
      project,
      take,
      inspector,
      selectedZoom,
      selectedMove,
      selectedSound,
      selectedCaption,
      selectedEffect,
      selectedVideoSegment,
      pickingFocus,
      setProject,
      replaceProject,
      commit,
      history.past.length,
      history.future.length,
      undo,
      redo,
      beginHistoryBatch,
      endHistoryBatch,
      clearHistory,
      setTake,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside StudioProvider");
  return ctx;
}

export function useClock() {
  const { clock } = useStudio();
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}

/** Playing flag only — avoids Stage re-rendering on every time tick. */
export function usePlaying() {
  const { clock } = useStudio();
  return useSyncExternalStore(
    clock.subscribe,
    () => clock.getSnapshot().playing,
    () => false,
  );
}

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, "0")}`;
}
