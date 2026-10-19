/** Core project types for the studio recorder + editor. */

export type BackgroundMode = "wallpaper" | "gradient" | "color" | "image" | "motion";

export interface Wallpaper {
  id: string;
  /** Optional display name in the picker. */
  label?: string;
  /** Gradient angle (degrees). Ignored when imageUrl is set. */
  angle?: number;
  /** Gradient color stops. Ignored when imageUrl is set. */
  stops?: string[];
  /** Built-in photo wallpaper served from /public. */
  imageUrl?: string;
}

export interface BackgroundSettings {
  mode: BackgroundMode;
  wallpaperId: string;
  /** Animated motion backdrop id (e.g. ribbon-field). */
  motionId?: string;
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  color: string;
  imageUrl: string | null;
  blur: number; // 0..100
}

export type AspectRatio = "auto" | "16:9" | "4:3" | "1:1" | "9:16" | "3:2";

/** Window chrome drawn above the capture. */
export type WindowChrome = "none" | "mac" | "windows" | "browser";

/** Product-video window chrome appearance (title bar / browser toolbar). */
export type ChromeTheme = "dark" | "light";

export interface FrameSettings {
  ratio: AspectRatio;
  padding: number; // 0..100 → % inset of the shorter stage edge (10 ≈ 10%)
  radius: number; // 0..100 → % corner round of the shorter framed edge (4 ≈ 4%)
  shadow: number; // 0..100
  crop: { x: number; y: number; w: number; h: number }; // normalized source crop
  /** Title-bar style above the recording (or none). */
  chrome: WindowChrome;
  /** Dark or light window chrome for product videos. */
  chromeTheme: ChromeTheme;
  windowTitle: string;
  /**
   * Extra top crop (0..0.3 of the capture) to hide the real browser/OS header
   * so only our studio chrome shows.
   */
  nativeChromeCrop: number;
  /**
   * Extra bottom crop (0..0.15 of the capture) to hide the Windows taskbar
   * on entire-screen recordings.
   */
  taskbarCrop: number;
  /** Address / search text for the clean browser chrome. */
  browserUrl: string;
  /** Optional site label shown left of the address pill. */
  browserSiteName: string;
  /**
   * Physical device shell around the capture (phone / tablet).
   * `"none"` = soft rounded rectangle only.
   */
  deviceFrameId: string;
  /** Finish / colorway for the selected device frame. */
  deviceColorId: string;
}

/** Named cursor glyphs drawn large in the editor/export. */
export type CursorShape =
  | "arrow"
  | "ibeam"
  | "cross"
  | "hand"
  | "wait"
  | "move"
  | "resize-ns"
  | "resize-ew"
  | "resize-nesw"
  | "resize-nwse"
  | "not-allowed"
  | "custom"
  /** OS pointer hidden (e.g. game draws its own) — compositor skips drawing. */
  | "hidden";

/** Captured OS cursor bitmap (custom Excel/app cursors). */
export interface CursorIconBitmap {
  w: number;
  h: number;
  hx: number;
  hy: number;
  /** raw RGBA as base64 */
  rgba: string;
}

export type CameraCorner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

/** 9-cell overlay grid for camera / PiP placement. */
export type CameraPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface CameraSettings {
  enabled: boolean;
  shape: "circle" | "rounded" | "square";
  /** 0 = square corners, 100 = full circle. */
  roundness: number;
  size: number; // 8..40 percent of stage width
  /** Size while the screen is zoomed in (typically smaller). */
  sizeDuringZoom: number;
  /** Shrink the bubble when a zoom is active so it doesn't cover the action. */
  shrinkDuringZoom: boolean;
  /** Nudge the bubble away when it would cover the cursor. */
  avoidCursor: boolean;
  position: CameraPosition;
  /** @deprecated prefer position — kept for choreography arc L/R. */
  corner: CameraCorner;
  mirror: boolean;
  shadow: boolean;
  /** Background handling for the webcam layer. */
  backgroundMode: "none" | "blur" | "color" | "image";
  backgroundColor: string;
  backgroundImageUrl: string | null;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Source-language text before translation (AI Voiceover). */
  originalText?: string;
}

export interface CaptionSettings {
  enabled: boolean;
  /** Draw captions into the preview / export frames. */
  burnIn: boolean;
  fontSize: number;
  cues: CaptionCue[];
}

/** One keyboard shortcut shown as keycaps in the video. */
export interface KeystrokeCue {
  id: string;
  time: number;
  duration: number;
  /** "Ctrl + S" */
  label: string;
  /** Individual keycaps, e.g. ["Ctrl", "S"] */
  keys: string[];
}

export interface KeystrokeSettings {
  /** Master switch — when off, no shortcut overlays. */
  enabled: boolean;
  /** Draw into preview / export. */
  burnIn: boolean;
  /** 50..160 scale. */
  size: number;
  position: "bottom" | "bottom-left" | "bottom-right" | "center";
  cues: KeystrokeCue[];
}

/** One Edge TTS clip aligned to a caption cue. */
export interface VoiceoverClip {
  id: string;
  cueId: string;
  start: number;
  duration: number;
  audioUrl: string;
  voice: string;
  text: string;
}

export interface VoiceoverSettings {
  enabled: boolean;
  /** BCP-47 / Web Speech lang for live ASR while recording. */
  speakLang: string;
  /** Captions + Edge TTS target locale (e.g. en-US). */
  targetLang: string;
  /** Edge Neural voice id (e.g. en-US-JennyNeural). */
  voice: string;
  clips: VoiceoverClip[];
}

/** Soft bed under the take (Openverse CC track or local asset). */
export interface BackgroundMusicSettings {
  enabled: boolean;
  /** Same-origin or blob URL used for preview + export. */
  url: string | null;
  title: string;
  creator: string;
  license: string;
  /** 0..1 — keep low so voiceover stays clear. */
  volume: number;
  loop: boolean;
  /** Openverse / source id when known. */
  sourceId?: string;
}

/** Drawn cursor look — `auto` keeps the recorded system shape per frame. */
export type CursorStyleOverride =
  | "auto"
  | "arrow"
  | "ibeam"
  | "cross"
  | "hand"
  | "wait"
  | "move";

export interface CursorSettings {
  visible: boolean;
  smoothing: number; // 0..100 -> spring stiffness/damping blend
  size: number; // 60..220 percent
  clickRipple: boolean;
  /** Fade + shrink the cursor when it sits still. */
  autoHideIdle: boolean;
  /** Force one glyph in preview/export; omit / auto = recorded OS/CSS shape. */
  style?: CursorStyleOverride;
}

export interface ZoomSettings {
  /** Master switch — when off, no zooms are applied in preview/export. */
  enabled: boolean;
  /** Auto generates zooms from clicks/actions; Manual is user-picked only. */
  mode: "auto" | "manual";
  /** Bias for auto zoom intensity (1.4..3). Each section still picks its own scale. */
  autoScale: number;
}

export interface ZoomKeyframe {
  id: string;
  /** seconds, start of the zoom-in ramp */
  time: number;
  /** total length including ramps */
  duration: number;
  scale: number;
  /** normalized focus point inside the recorded screen */
  x: number;
  y: number;
  /** follows the smoothed cursor instead of a fixed point */
  followCursor: boolean;
  auto: boolean;
  /**
   * Typing tutorials: ease focus.x forward by this amount over the hold
   * so the frame tracks growing text even when the mouse stays still.
   */
  caretProgress?: number;
  /** Text-caret positions (absolute seconds) — typing zooms pan along these. */
  caretPath?: CaretSample[];
}

export interface CaretSample {
  t: number;
  x: number;
  y: number;
}

export type CameraMoveKind = "arc-lr" | "arc-rl" | "orbit" | "dip";

export interface CameraMove {
  id: string;
  time: number;
  duration: number;
  kind: CameraMoveKind;
  /** Generated by auto mode when the face would cover the action. */
  auto?: boolean;
}

/** Cinematic frame effects — 3D tilt/spin/rotate, glare, reveals, zooms. */
export type SceneEffectKind =
  | "hero-zoom"
  | "tilt-3d"
  | "focus-zoom"
  | "spin-3d"
  | "glare"
  | "mockup-tilt"
  | "window-reveal"
  | "rotate-3d"
  | "float-3d"
  | "punch-in";

export interface SceneEffect {
  id: string;
  kind: SceneEffectKind;
  time: number;
  duration: number;
  /** Normalized focus used when the effect also punches a zoom. */
  x: number;
  y: number;
}

/** Re-export timeline SFX types. */
export type { SoundClip, SoundKind } from "./soundTrack";
import type { SoundClip } from "./soundTrack";

export interface CursorSample {
  t: number; // seconds from recording start
  x: number; // normalized 0..1
  y: number;
  down: boolean;
  /** System / CSS cursor kind when known. */
  shape?: CursorShape;
  /** Key into RecordingTake.cursorIcons for custom bitmaps. */
  iconId?: string;
}

export interface RecordingTake {
  screenUrl: string;
  cameraUrl: string | null;
  micUrl: string | null;
  duration: number;
  width: number;
  height: number;
  cursor: CursorSample[];
  /** Text-caret positions while typing (same space as cursor). */
  caret?: CaretSample[];
  /** Custom cursor bitmaps keyed by iconId. */
  cursorIcons?: Record<string, CursorIconBitmap>;
  createdAt: number;
  sourceLabel: string;
  /** Whether a mic track was mixed into micUrl. */
  hasMicrophone?: boolean;
  /** Whether display/system audio was mixed into micUrl. */
  hasSystemAudio?: boolean;
  /** getDisplayMedia surface — used to auto-hide the taskbar on full-screen takes. */
  captureSurface?: "monitor" | "window" | "browser";
}

export interface ProjectState {
  name: string;
  background: BackgroundSettings;
  frame: FrameSettings;
  camera: CameraSettings;
  cursor: CursorSettings;
  zoom: ZoomSettings;
  captions: CaptionSettings;
  /** Keyboard shortcuts recorded during the take and shown as keycaps. */
  keystrokes: KeystrokeSettings;
  voiceover: VoiceoverSettings;
  music: BackgroundMusicSettings;
  zooms: ZoomKeyframe[];
  moves: CameraMove[];
  /** Ctrl+1…6 cinematic effects (tilt, glare, spin, hero zoom). */
  effects: SceneEffect[];
  /** Editable click / whoosh / typing SFX on the timeline. */
  sounds: SoundClip[];
  speed: number;
  trim: { start: number; end: number };
  /**
   * Kept pieces of the screen recording (source in/out).
   * When set, playback/export skips anything outside these ranges.
   * Omit / empty = use trim as a single keep range.
   */
  segments?: VideoSegment[];
}

/** One kept piece of the screen recording (source media times). */
export interface VideoSegment {
  id: string;
  /** Source start (seconds). */
  in: number;
  /** Source end (seconds). */
  out: number;
  /** Playback speed for this clip only (0.5–2). Omit = use project.speed. */
  speed?: number;
}
