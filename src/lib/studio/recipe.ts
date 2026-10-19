/**
 * Screen Beaver "recipe" — the agent-facing project patch format.
 * AI clients (Cursor / Claude / etc.) produce recipes via MCP; the desktop
 * studio applies them onto the current recording and exports MP4.
 */

import type {
  BackgroundSettings,
  CameraMove,
  CaptionCue,
  FrameSettings,
  ProjectState,
  SceneEffect,
  SceneEffectKind,
  VoiceoverSettings,
  ZoomKeyframe,
} from "./types";
import type { SoundClip, SoundKind } from "./soundTrack";

export const RECIPE_VERSION = 1 as const;

export type StylePresetId = "clean" | "day" | "vivid" | "night" | "tight";

export interface RecipeCaption {
  start: number;
  end: number;
  text: string;
  originalText?: string;
}

export interface RecipeZoom {
  time: number;
  duration?: number;
  scale?: number;
  x?: number;
  y?: number;
  followCursor?: boolean;
}

export interface RecipeEffect {
  kind: SceneEffectKind;
  time: number;
  duration?: number;
  x?: number;
  y?: number;
}

export interface RecipeSound {
  kind: SoundKind;
  time: number;
  duration?: number;
}

export interface RecipeExport {
  width?: number;
  fps?: number;
  quality?: "web" | "high" | "max";
}

/** Declarative video plan an agent can author and the studio can apply. */
export interface ScreenWeaverRecipe {
  version: typeof RECIPE_VERSION;
  name?: string;
  /** Named look — applied before finer background/frame patches. */
  preset?: StylePresetId;
  background?: Partial<BackgroundSettings>;
  frame?: Partial<FrameSettings>;
  voiceover?: Partial<Pick<VoiceoverSettings, "enabled" | "speakLang" | "targetLang" | "voice">>;
  captions?: RecipeCaption[];
  /** Replace zoom keyframes. Pass [] to clear manual zooms. */
  zooms?: RecipeZoom[];
  /** When true, regenerate auto-zooms from the cursor track after apply. */
  regenerateAutoZooms?: boolean;
  effects?: RecipeEffect[];
  sounds?: RecipeSound[];
  moves?: Array<{ kind: CameraMove["kind"]; time: number; duration?: number }>;
  speed?: number;
  trim?: { start?: number; end?: number };
  export?: RecipeExport;
  /** Freeform notes for humans / later agent turns. */
  notes?: string;
}

export const STYLE_PRESETS: Record<
  StylePresetId,
  {
    label: string;
    wallpaperId: string;
    padding: number;
    radius: number;
    chromeTheme: "dark" | "light";
  }
> = {
  // Padding / radius are % of the shorter stage edge (see FrameSettings).
  // ~10% pad + ~4% radius keeps the capture readable without a tiny letterbox.
  clean: { label: "Clean Demo", wallpaperId: "arctic", padding: 10, radius: 4, chromeTheme: "light" },
  day: { label: "Day Product", wallpaperId: "aesthetic-laptop", padding: 10, radius: 4, chromeTheme: "light" },
  vivid: { label: "Vivid Launch", wallpaperId: "aesthetic-pointer", padding: 10, radius: 4, chromeTheme: "dark" },
  night: { label: "Night Product", wallpaperId: "aesthetic-portal", padding: 10, radius: 4, chromeTheme: "dark" },
  tight: { label: "Tight Tutorial", wallpaperId: "slate", padding: 8, radius: 3, chromeTheme: "dark" },
};

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function validateRecipe(input: unknown): { ok: true; recipe: ScreenWeaverRecipe } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Recipe must be an object" };
  const r = input as Record<string, unknown>;
  if (r.version !== 1 && r.version !== RECIPE_VERSION) {
    return { ok: false, error: `Unsupported recipe version (expected ${RECIPE_VERSION})` };
  }
  if (r.preset != null && !STYLE_PRESETS[r.preset as StylePresetId]) {
    return { ok: false, error: `Unknown preset "${String(r.preset)}". Use clean|day|vivid|night|tight` };
  }
  if (r.captions != null && !Array.isArray(r.captions)) {
    return { ok: false, error: "captions must be an array" };
  }
  return { ok: true, recipe: input as ScreenWeaverRecipe };
}

export function applyPreset(project: ProjectState, preset: StylePresetId): ProjectState {
  const p = STYLE_PRESETS[preset];
  return {
    ...project,
    background: {
      ...project.background,
      mode: "wallpaper",
      wallpaperId: p.wallpaperId,
    },
    frame: {
      ...project.frame,
      padding: p.padding,
      radius: p.radius,
      chromeTheme: p.chromeTheme,
    },
  };
}

export function applyRecipe(project: ProjectState, recipe: ScreenWeaverRecipe): ProjectState {
  let next = { ...project };

  if (recipe.name) next = { ...next, name: recipe.name };
  if (recipe.preset) next = applyPreset(next, recipe.preset);

  if (recipe.background) {
    next = { ...next, background: { ...next.background, ...recipe.background } };
  }
  if (recipe.frame) {
    next = { ...next, frame: { ...next.frame, ...recipe.frame } };
  }
  if (recipe.voiceover) {
    const base = next.voiceover;
    next = {
      ...next,
      voiceover: {
        ...base,
        ...recipe.voiceover,
        clips: base.clips,
      },
    };
  }
  if (recipe.captions) {
    const cues: CaptionCue[] = recipe.captions.map((c, i) => ({
      id: uid("cap"),
      start: Math.max(0, c.start),
      end: Math.max(c.start + 0.2, c.end),
      text: String(c.text || "").trim() || `Caption ${i + 1}`,
      originalText: c.originalText,
    }));
    next = {
      ...next,
      captions: { ...next.captions, enabled: true, burnIn: next.captions.burnIn, cues },
    };
  }
  // Auto mode: keep zoom.mode=auto and let regenerateAutoZooms
  // derive punches from the cursor/typing track. Agent-authored zooms are manuals
  // that *merge* with autos — never flip the project into manual-only mode when
  // regenerateAutoZooms is requested (that wiped real auto zooms before).
  if (recipe.regenerateAutoZooms) {
    next = {
      ...next,
      zoom: {
        ...next.zoom,
        enabled: true,
        mode: "auto",
        // Stronger punches for product tutorials (Screen Studio–like readability).
        autoScale: Math.max(next.zoom.autoScale ?? 1.85, 2.35),
      },
      // Drop prior auto punches; manuals from this recipe (if any) stay below.
      zooms: next.zooms.filter((z) => !z.auto),
    };
  }
  if (recipe.zooms) {
    const zooms: ZoomKeyframe[] = recipe.zooms.map((z) => ({
      id: uid("zoom"),
      time: Math.max(0, z.time),
      duration: Math.max(0.4, z.duration ?? 1.6),
      scale: Math.min(3.5, Math.max(1.2, z.scale ?? 2.1)),
      x: clamp01(z.x ?? 0.5),
      y: clamp01(z.y ?? 0.5),
      followCursor: z.followCursor ?? false,
      auto: false,
    }));
    if (recipe.regenerateAutoZooms) {
      // Manual accents only — autos are filled in after apply.
      next = {
        ...next,
        zooms: [...next.zooms.filter((z) => !z.auto), ...zooms],
        zoom: { ...next.zoom, enabled: true, mode: "auto" },
      };
    } else {
      next = { ...next, zooms, zoom: { ...next.zoom, enabled: true, mode: "manual" } };
    }
  }
  if (recipe.effects) {
    const effects: SceneEffect[] = recipe.effects.map((e) => ({
      id: uid("fx"),
      kind: e.kind,
      time: Math.max(0, e.time),
      duration: Math.max(0.35, e.duration ?? 1.2),
      x: clamp01(e.x ?? 0.5),
      y: clamp01(e.y ?? 0.5),
    }));
    next = { ...next, effects };
  }
  if (recipe.sounds) {
    // Merge — never replace recorded click/typing SFX from the take.
    const extra: SoundClip[] = recipe.sounds.map((s) => ({
      id: uid("sfx"),
      kind: s.kind,
      time: Math.max(0, s.time),
      duration: Math.max(0.08, s.duration ?? 0.25),
    }));
    next = { ...next, sounds: [...(next.sounds ?? []), ...extra] };
  }
  if (recipe.moves) {
    const moves: CameraMove[] = recipe.moves.map((m) => ({
      id: uid("cam"),
      kind: m.kind,
      time: Math.max(0, m.time),
      duration: Math.max(0.4, m.duration ?? 1.4),
    }));
    next = { ...next, moves };
  }
  if (typeof recipe.speed === "number" && recipe.speed > 0) {
    next = { ...next, speed: recipe.speed };
  }
  if (recipe.trim) {
    next = {
      ...next,
      trim: {
        start: recipe.trim.start ?? next.trim.start,
        end: recipe.trim.end ?? next.trim.end,
      },
    };
  }

  return next;
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** Example recipe agents can clone when generating product tutorials. */
export function exampleLaunchRecipe(productUrl = "example.com"): ScreenWeaverRecipe {
  return {
    version: 1,
    name: "Product Launch",
    preset: "vivid",
    frame: {
      chrome: "browser",
      browserUrl: productUrl,
      nativeChromeCrop: 0.11,
    },
    captions: [
      { start: 0.3, end: 2.8, text: "Meet the product" },
      { start: 3.0, end: 5.5, text: "Here's the core workflow" },
      { start: 6.0, end: 8.5, text: "Ship faster with less friction" },
    ],
    voiceover: {
      enabled: true,
      targetLang: "en-US",
      voice: "en-US-JennyNeural",
    },
    regenerateAutoZooms: true,
    effects: [{ kind: "hero-zoom", time: 0.2, duration: 1.4 }],
    export: { width: 1920, fps: 30, quality: "high" },
    notes: "Record the product UI first, then apply this recipe and export.",
  };
}
