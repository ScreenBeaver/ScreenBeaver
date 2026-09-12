/**
 * Listens for MCP / agent commands from the desktop bridge (127.0.0.1:17355)
 * and mutates the live studio step-by-step so the user can watch edits appear.
 */
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  listenAgentCommand,
  listenNativeCaptureStarted,
  listenNativeCaptureStopped,
  listenNativeCursor,
  listenNativeKeystroke,
  reportAgentResult,
  type AgentCommandEvent,
} from "@/lib/studio/nativeBridge";
import {
  applyPreset,
  applyRecipe,
  STYLE_PRESETS,
  validateRecipe,
  type StylePresetId,
} from "@/lib/studio/recipe";
import { exportProject, exportSupported } from "@/lib/studio/exporter";
import { SCENE_EFFECT_META } from "@/lib/studio/sceneEffects";
import { defaultSoundDuration, ensureTypingSounds } from "@/lib/studio/soundTrack";
import { useStudio, type InspectorTab } from "@/lib/studio/store";
import {
  importLastNativeCapture,
  importNativeTake,
  listCaptureTargets,
  openCapturePath,
  openCaptureUrl,
  startNativeCapture,
  stopNativeCapture,
  type NativeCaptureStopPayload,
} from "@/lib/studio/nativeTake";
import {
  androidEnsureRuntime,
  androidListDevices,
  androidSessionActive,
  androidStart,
  androidStop,
  androidUsbNote,
} from "@/lib/studio/androidCapture";
import { matchDeviceFrame } from "@/lib/studio/deviceFrames";
import { resolveBackgroundImageUrl } from "@/lib/studio/wallpapers";
import { focusStudioWindow } from "@/lib/studio/nativeBridge";
import { emitAgentUi, sleep as uiSleep } from "@/lib/studio/agentUi";
import type { CameraMoveKind, CursorSample, KeystrokeCue, SceneEffectKind, SoundKind } from "@/lib/studio/types";
import { generateVoiceoverFromCaptions } from "@/lib/studio/voiceoverGenerate";
import { translateCaptionCues } from "@/lib/studio/translate";
import { DEFAULT_PROJECT } from "@/lib/studio/store";
import { cueFromNativeKeystroke, mergeKeystrokeCues } from "@/lib/studio/keystrokes";
import { enqueueMcpEvent } from "@/lib/account/client";
import { useAccount } from "@/lib/account/AccountProvider";
import { logHomeActivity, logMcpActivity } from "@/lib/studio/homeActivity";

type Activity = { label: string; at: number };

/** Cursor samples collected while a native capture is running. */
const nativeCursorBuf: {
  active: boolean;
  startMs: number;
  samples: CursorSample[];
  lastEnded: CursorSample[];
  keystrokes: KeystrokeCue[];
  lastKeystrokes: KeystrokeCue[];
} = {
  active: false,
  startMs: 0,
  samples: [],
  lastEnded: [],
  keystrokes: [],
  lastKeystrokes: [],
};

function beginCursorBuffer() {
  nativeCursorBuf.active = true;
  nativeCursorBuf.startMs = performance.now();
  nativeCursorBuf.samples = [];
  nativeCursorBuf.keystrokes = [];
}

function endCursorBuffer(): { cursor: CursorSample[]; keystrokes: KeystrokeCue[] } {
  if (nativeCursorBuf.active) {
    nativeCursorBuf.active = false;
    nativeCursorBuf.lastEnded = [...nativeCursorBuf.samples];
    nativeCursorBuf.lastKeystrokes = [...nativeCursorBuf.keystrokes];
  }
  return {
    cursor: [...nativeCursorBuf.lastEnded],
    keystrokes: [...nativeCursorBuf.lastKeystrokes],
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function applyImportedTake(
  studio: ReturnType<typeof useStudio>,
  take: Awaited<ReturnType<typeof importNativeTake>>,
  keystrokes?: KeystrokeCue[],
  opts?: { typing?: { t: number; duration: number }[] },
) {
  const isAndroid = (take.sourceLabel || "").toLowerCase().includes("android");
  const deviceMatch = isAndroid ? matchDeviceFrame(take.sourceLabel || "") : null;
  const nextRatio = isAndroid
    ? take.height >= take.width
      ? ("9:16" as const)
      : ("16:9" as const)
    : studio.project.frame.ratio;

  let sounds = studio.project.sounds ?? [];
  if (opts?.typing?.length) {
    sounds = ensureTypingSounds(
      opts.typing.map((b) => ({ t: b.t, duration: b.duration })),
      sounds,
    );
  }

  studio.setTake(take);
  studio.setProject({
    name: take.sourceLabel || "Native capture",
    trim: { start: 0, end: take.duration },
    ...(sounds.length ? { sounds } : {}),
    ...(keystrokes?.length
      ? {
          keystrokes: {
            ...(studio.project.keystrokes ?? DEFAULT_PROJECT.keystrokes),
            cues: mergeKeystrokeCues([], keystrokes),
            enabled: true,
            burnIn: true,
          },
        }
      : {}),
    ...(isAndroid
      ? {
          frame: {
            ...studio.project.frame,
            taskbarCrop: 0,
            nativeChromeCrop: 0,
            ratio: nextRatio,
            chrome: "none",
            padding: Math.min(studio.project.frame.padding, 16),
            deviceFrameId: deviceMatch?.frameId ?? studio.project.frame.deviceFrameId ?? "none",
            deviceColorId: deviceMatch?.colorId ?? studio.project.frame.deviceColorId ?? "black",
          },
          cursor: {
            ...(studio.project.cursor ?? DEFAULT_PROJECT.cursor),
            visible: take.cursor.length >= 2,
            size: 100,
          },
        }
      : {}),
  });
  studio.clock.setPlaying(false);
  studio.clock.set(0);
}

async function importStoppedPayload(
  studio: ReturnType<typeof useStudio>,
  payload: NativeCaptureStopPayload,
  cursor: CursorSample[],
  keystrokes?: KeystrokeCue[],
) {
  const take = await importNativeTake(payload, cursor);
  applyImportedTake(studio, take, keystrokes, { typing: payload.typing });
  return take;
}

export function AgentHost() {
  const studio = useStudio();
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const { features } = useAccount();
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const [activity, setActivity] = useState<Activity | null>(null);

  useEffect(() => {
    if (!activity) return;
    const t = window.setTimeout(() => setActivity(null), 2800);
    return () => window.clearTimeout(t);
  }, [activity]);

  useEffect(() => {
    let dead = false;
    const unsubs: Array<() => void> = [];

    const handle = async (ev: AgentCommandEvent) => {
      if (dead) return;
      const { id, action, payload } = ev;
      try {
        if (action !== "status" && action !== "notify") {
          const feats = featuresRef.current;
          const mcpOk = feats?.mcp === true;
          if (!mcpOk) {
            logMcpActivity(`Blocked · ${action}`, "MCP not entitled");
            await reportAgentResult(id, {
              ok: false,
              error: "MCP is not entitled in this session. Restart the desktop app.",
            });
            toast.message("MCP unavailable", {
              description: "Restart Screen Beaver and try again.",
            });
            return;
          }
        }
        const result = await runAgentAction(action, payload, studioRef.current);
        await reportAgentResult(id, result);
        if (result.ok && action !== "status") {
          const label =
            typeof result.message === "string" ? result.message : `Agent · ${action}`;
          setActivity({ label, at: Date.now() });
          if (action !== "seek" && action !== "notify") {
            toast.message(label);
          }
          logMcpActivity(label, studioRef.current.project.name);
          enqueueMcpEvent({
            tool: action,
            projectTitle: studioRef.current.project.name,
            summary: {
              ok: true,
              message: typeof result.message === "string" ? result.message : undefined,
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await reportAgentResult(id, { ok: false, error: message });
        toast.error(`Agent failed: ${message}`);
      }
    };

    void listenAgentCommand(handle).then((u) => {
      if (dead) u();
      else unsubs.push(u);
    });

    void listenNativeCursor((ev) => {
      if (!nativeCursorBuf.active) return;
      const t = (performance.now() - nativeCursorBuf.startMs) / 1000;
      nativeCursorBuf.samples.push({
        t,
        x: ev.x,
        y: ev.y,
        down: ev.down,
        shape: ev.shape,
      });
    }).then((u) => {
      if (dead) u();
      else unsubs.push(u);
    });

    void listenNativeKeystroke((ev) => {
      if (!nativeCursorBuf.active) return;
      const t = (performance.now() - nativeCursorBuf.startMs) / 1000;
      const cue = cueFromNativeKeystroke(t, ev.label, ev.keys ?? []);
      const merged = mergeKeystrokeCues(nativeCursorBuf.keystrokes, [cue]);
      nativeCursorBuf.keystrokes.length = 0;
      nativeCursorBuf.keystrokes.push(...merged);
    }).then((u) => {
      if (dead) u();
      else unsubs.push(u);
    });

    void listenNativeCaptureStarted(() => {
      beginCursorBuffer();
      emitAgentUi({ type: "native-recording", active: true });
      setActivity({ label: "Native capture recording…", at: Date.now() });
    }).then((u) => {
      if (dead) u();
      else unsubs.push(u);
    });

    void listenNativeCaptureStopped((ev) => {
      void (async () => {
        try {
          emitAgentUi({ type: "native-recording", active: false });
          const { cursor, keystrokes } = endCursorBuffer();
          const take = await importStoppedPayload(
            studioRef.current,
            ev as NativeCaptureStopPayload,
            cursor,
            keystrokes,
          );
          toast.success(
            `Recording imported · ${take.duration.toFixed(1)}s` +
              (keystrokes.length ? ` · ${keystrokes.length} shortcuts` : ""),
          );
          setActivity({ label: "Recording imported", at: Date.now() });
          logHomeActivity(
            "record",
            "Finished screen recording",
            `${take.duration.toFixed(1)}s`,
          );
          await focusStudioWindow();
        } catch (err) {
          console.error("[native import]", err);
          toast.error(err instanceof Error ? err.message : "Import failed");
        }
      })();
    }).then((u) => {
      if (dead) u();
      else unsubs.push(u);
    });

    return () => {
      dead = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  return activity ? (
    <div className="pointer-events-none fixed left-1/2 top-14 z-[60] -translate-x-1/2">
      <div className="flex items-center gap-2 rounded bg-panel px-3.5 py-1.5 text-[12px] font-medium ring-1 ring-ember/50">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-ember" />
        <span className="max-w-[min(70vw,420px)] truncate">{activity.label}</span>
      </div>
    </div>
  ) : null;
}

async function runAgentAction(
  action: string,
  payload: unknown,
  studio: ReturnType<typeof useStudio>,
): Promise<Record<string, unknown>> {
  switch (action) {
    case "status": {
      const { project, take } = studio;
      return {
        ok: true,
        hasTake: !!take,
        duration: take?.duration ?? 0,
        name: project.name,
        captions: project.captions?.cues?.length ?? 0,
        zooms: project.zooms.length,
        effects: project.effects?.length ?? 0,
        sounds: project.sounds?.length ?? 0,
        voiceoverClips: project.voiceover?.clips?.length ?? 0,
        time: studio.clock.time,
        nativeRecording: nativeCursorBuf.active,
        exportSupported: exportSupported(),
        presets: Object.keys(STYLE_PRESETS),
        note: "User should click Export in the app when the build looks right. Do not auto-export unless asked.",
      };
    }
    case "list_windows":
    case "list_capture_targets": {
      const targets = await listCaptureTargets();
      return { ok: true, targets, count: targets.length, message: `${targets.length} capture targets` };
    }
    case "open_url": {
      const url = String((payload as { url?: string })?.url || "").trim();
      if (!url) return { ok: false, error: "url required" };
      await openCaptureUrl(url);
      return { ok: true, message: `Opened ${url}` };
    }
    case "open_path": {
      const path = String((payload as { path?: string })?.path || "").trim();
      if (!path) return { ok: false, error: "path required" };
      await openCapturePath(path);
      return { ok: true, message: `Opened ${path}` };
    }
    case "focus_studio": {
      await focusStudioWindow();
      return { ok: true, message: "Screen Beaver brought to front" };
    }
    case "open_record_picker": {
      await focusStudioWindow();
      const surface = (payload as { surface?: "screen" | "application" | "tab" })?.surface ?? "application";
      emitAgentUi({ type: "open-picker", surface });
      return {
        ok: true,
        message: "Opened Start a new recording (share options)",
        surface,
      };
    }
    case "start_capture": {
      const p = payload as {
        windowId?: string;
        titleContains?: string;
        showPicker?: boolean;
        surface?: "screen" | "application" | "tab";
      };
      await focusStudioWindow();
      // Flash the same “Start a new recording → share” UI the user expects, then
      // start native capture (no OS share dialog — agents can’t click that).
      if (p.showPicker !== false) {
        emitAgentUi({ type: "open-picker", surface: p.surface ?? "application" });
        await uiSleep(750);
      }
      emitAgentUi({ type: "close-picker" });
      emitAgentUi({ type: "native-recording", active: true });
      const started = await startNativeCapture({
        windowId: p.windowId,
        titleContains: p.titleContains,
      });
      return {
        ok: true,
        message: "Recording started (application window, native — no OS Share dialog)",
        started,
      };
    }
    case "stop_capture": {
      const phone = await androidSessionActive().catch(() => false);
      const stopped = phone ? await androidStop() : await stopNativeCapture();
      emitAgentUi({ type: "native-recording", active: false });
      const { cursor, keystrokes } = endCursorBuffer();
      try {
        const mergedCursor =
          stopped.cursor && stopped.cursor.length >= 2 ? stopped.cursor : cursor;
        const take = await importStoppedPayload(studio, stopped, mergedCursor, keystrokes);
        await focusStudioWindow();
        return {
          ok: true,
          message: phone
            ? `Android capture imported · ${take.duration.toFixed(1)}s`
            : `Capture imported · ${take.duration.toFixed(1)}s`,
          durationMs: stopped.durationMs,
          width: stopped.width,
          height: stopped.height,
          sourceLabel: stopped.sourceLabel,
          path: stopped.path,
          mediaUrl: stopped.mediaUrl,
          hasTake: true,
          android: phone,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          path: stopped.path,
          mediaUrl: stopped.mediaUrl,
        };
      }
    }
    case "android_ensure_runtime": {
      const status = await androidEnsureRuntime();
      return { ok: true, ...status, message: status.message || "Android runtime ready" };
    }
    case "android_list_devices": {
      await androidEnsureRuntime().catch(() => null);
      const devices = await androidListDevices();
      const note = await androidUsbNote();
      const ready = devices.filter((d) => d.state === "device");
      return {
        ok: true,
        devices,
        readyCount: ready.length,
        note,
        message:
          ready.length === 0
            ? "No Android devices in 'device' state — enable USB debugging and tap Allow"
            : `${ready.length} Android device(s) ready`,
      };
    }
    case "android_start": {
      const serial = (payload as { serial?: string })?.serial?.trim() || undefined;
      await focusStudioWindow();
      emitAgentUi({ type: "open-picker", surface: "android" });
      await uiSleep(400);
      emitAgentUi({ type: "close-picker" });
      await androidEnsureRuntime();
      const started = await androidStart(serial);
      beginCursorBuffer();
      emitAgentUi({ type: "native-recording", active: true });
      return {
        ok: true,
        message: `Android mirroring · ${started.label} — use demo_* on the mirror, then stop_capture / android_stop`,
        started,
        windowTitle: started.windowTitle,
      };
    }
    case "android_stop": {
      const stopped = await androidStop();
      emitAgentUi({ type: "native-recording", active: false });
      const { cursor, keystrokes } = endCursorBuffer();
      try {
        const mergedCursor =
          stopped.cursor && stopped.cursor.length >= 2 ? stopped.cursor : cursor;
        const take = await importStoppedPayload(studio, stopped, mergedCursor, keystrokes);
        await focusStudioWindow();
        return {
          ok: true,
          message: `Android capture imported · ${take.duration.toFixed(1)}s`,
          durationMs: stopped.durationMs,
          width: stopped.width,
          height: stopped.height,
          sourceLabel: stopped.sourceLabel,
          path: stopped.path,
          mediaUrl: stopped.mediaUrl,
          hasTake: true,
          android: true,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          path: stopped.path,
          mediaUrl: stopped.mediaUrl,
        };
      }
    }
    case "import_last_capture": {
      const { cursor, keystrokes } = endCursorBuffer();
      const take = await importLastNativeCapture(cursor);
      applyImportedTake(studio, take, keystrokes);
      return {
        ok: true,
        message: `Imported last capture · ${take.duration.toFixed(1)}s`,
        hasTake: true,
        duration: take.duration,
      };
    }
    case "notify": {
      const message = String((payload as { message?: string })?.message || "Agent update");
      return { ok: true, message };
    }
    case "seek": {
      const t = Number((payload as { time?: number })?.time ?? 0);
      const dur = studio.take?.duration ?? 12;
      const time = Math.min(dur, Math.max(0, t));
      studio.clock.setPlaying(false);
      studio.clock.set(time);
      return { ok: true, message: `Playhead → ${time.toFixed(1)}s`, time };
    }
    case "open_tab": {
      const tab = (payload as { tab?: InspectorTab })?.tab;
      const allowed: InspectorTab[] = [
        "background",
        "motion",
        "effects",
        "cursor",
        "zoom",
        "camera",
        "captions",
        "voiceover",
        "audio",
        "shortcuts",
        "export",
      ];
      if (!tab || !allowed.includes(tab)) {
        return { ok: false, error: `tab must be one of ${allowed.join("|")}` };
      }
      studio.setInspector(tab);
      return { ok: true, message: `Opened ${tab} panel` };
    }
    case "apply_preset": {
      const preset = (payload as { preset?: string })?.preset as StylePresetId | undefined;
      if (!preset || !STYLE_PRESETS[preset]) {
        return { ok: false, error: "payload.preset must be clean|day|vivid|night|tight" };
      }
      studio.setProject(applyPreset(studio.project, preset));
      studio.setInspector("background");
      return { ok: true, message: `Look · ${STYLE_PRESETS[preset].label}` };
    }
    case "patch_frame": {
      const patch = (payload as { frame?: Record<string, unknown> })?.frame ?? payload;
      if (!patch || typeof patch !== "object") return { ok: false, error: "frame patch required" };
      studio.patchFrame(patch as Parameters<typeof studio.patchFrame>[0]);
      return { ok: true, message: "Updated window frame" };
    }
    case "set_name": {
      const name = String((payload as { name?: string })?.name || "").trim();
      if (!name) return { ok: false, error: "name required" };
      studio.setProject({ name });
      return { ok: true, message: `Project · ${name}` };
    }
    case "apply_recipe": {
      const raw = (payload as { recipe?: unknown })?.recipe ?? payload;
      const checked = validateRecipe(raw);
      if (!checked.ok) return { ok: false, error: checked.error };
      const next = applyRecipe(studio.project, checked.recipe);
      studio.setProject(next);
      if (checked.recipe.regenerateAutoZooms) studio.regenerateAutoZooms();
      return {
        ok: true,
        message: `Applied recipe${checked.recipe.name ? ` “${checked.recipe.name}”` : ""}`,
        captions: next.captions.cues.length,
        zooms: next.zooms.length,
      };
    }
    case "add_caption": {
      const p = payload as { start?: number; end?: number; text?: string };
      const text = String(p.text || "").trim();
      if (!text) return { ok: false, error: "text required" };
      const start = Math.max(0, Number(p.start) || 0);
      const end = Math.max(start + 0.4, Number(p.end) || start + 2.4);
      const cue = { id: uid("cap"), start, end, text };
      studio.addCaptionCue(cue);
      studio.patchCaptions({ enabled: true, burnIn: true });
      studio.setInspector("captions");
      studio.setSelectedCaption(cue.id);
      studio.clock.setPlaying(false);
      studio.clock.set(start);
      return { ok: true, message: `Caption · “${text.slice(0, 42)}${text.length > 42 ? "…" : ""}”`, id: cue.id };
    }
    case "add_zoom": {
      const p = payload as {
        time?: number;
        duration?: number;
        scale?: number;
        x?: number;
        y?: number;
        followCursor?: boolean;
      };
      const time = Math.max(0, Number(p.time) || 0);
      const z = {
        id: uid("zoom"),
        time,
        duration: Math.max(0.5, Number(p.duration) || 1.6),
        scale: Math.min(3.5, Math.max(1.25, Number(p.scale) || 2.15)),
        x: clamp01(Number(p.x) || 0.5),
        y: clamp01(Number(p.y) || 0.5),
        followCursor: !!p.followCursor,
        auto: false,
      };
      studio.addZoom(z);
      studio.patchZoom({ enabled: true });
      studio.setInspector("zoom");
      studio.setSelectedZoom(z.id);
      studio.clock.setPlaying(false);
      studio.clock.set(time);
      return { ok: true, message: `Zoom · ${z.scale.toFixed(1)}x @ ${time.toFixed(1)}s`, id: z.id };
    }
    case "add_effect": {
      const p = payload as {
        kind?: SceneEffectKind;
        time?: number;
        duration?: number;
        x?: number;
        y?: number;
      };
      const kind = p.kind;
      if (!kind || !SCENE_EFFECT_META[kind]) {
        return { ok: false, error: "kind must be a scene effect (hero-zoom, tilt-3d, …)" };
      }
      const time = Math.max(0, Number(p.time) || 0);
      const e = {
        id: uid("fx"),
        kind,
        time,
        duration: Math.max(0.4, Number(p.duration) || SCENE_EFFECT_META[kind].duration),
        x: clamp01(Number(p.x) || 0.5),
        y: clamp01(Number(p.y) || 0.5),
      };
      studio.addEffect(e);
      studio.setSelectedEffect(e.id);
      studio.clock.setPlaying(false);
      studio.clock.set(time);
      return { ok: true, message: `Effect · ${SCENE_EFFECT_META[kind].label}`, id: e.id };
    }
    case "add_sound": {
      const p = payload as { kind?: SoundKind; time?: number; duration?: number };
      const kind = p.kind;
      if (!kind || !["click", "right-click", "whoosh", "typing", "shimmer"].includes(kind)) {
        return { ok: false, error: "kind must be click|right-click|whoosh|typing|shimmer" };
      }
      const time = Math.max(0, Number(p.time) || 0);
      const s = {
        id: uid("sfx"),
        kind,
        time,
        duration: Math.max(0.08, Number(p.duration) || defaultSoundDuration(kind)),
      };
      studio.addSound(s);
      studio.setSelectedSound(s.id);
      studio.clock.set(time);
      return { ok: true, message: `SFX · ${kind} @ ${time.toFixed(1)}s`, id: s.id };
    }
    case "add_camera_move": {
      const p = payload as { kind?: CameraMoveKind; time?: number; duration?: number };
      const kind = p.kind ?? "arc-lr";
      const time = Math.max(0, Number(p.time) || 0);
      const m = {
        id: uid("cam"),
        kind,
        time,
        duration: Math.max(0.4, Number(p.duration) || 1.4),
      };
      studio.addMove(m);
      studio.setSelectedMove(m.id);
      studio.clock.set(time);
      return { ok: true, message: `Camera · ${kind}`, id: m.id };
    }
    case "set_captions": {
      const cuesIn = (payload as { captions?: unknown })?.captions;
      if (!Array.isArray(cuesIn)) return { ok: false, error: "payload.captions must be an array" };
      const checked = validateRecipe({ version: 1, captions: cuesIn });
      if (!checked.ok) return { ok: false, error: checked.error };
      const next = applyRecipe(studio.project, checked.recipe);
      studio.setCaptionCues(next.captions.cues);
      studio.patchCaptions({ enabled: true, burnIn: true });
      studio.setInspector("captions");
      return {
        ok: true,
        message: `Set ${next.captions.cues.length} captions`,
        count: next.captions.cues.length,
      };
    }
    case "regenerate_zooms": {
      if (!studio.take) return { ok: false, error: "No recording loaded" };
      studio.regenerateAutoZooms();
      studio.setInspector("zoom");
      return { ok: true, message: "Auto-zooms from your cursor clicks" };
    }
    case "translate_captions": {
      const p = payload as { speakLang?: string; targetLang?: string };
      const vo = studio.project.voiceover ?? DEFAULT_PROJECT.voiceover;
      const cues = studio.project.captions?.cues ?? [];
      if (!cues.length) return { ok: false, error: "No captions to translate" };
      const speakLang = p.speakLang || vo.speakLang || "en-US";
      const targetLang = p.targetLang || vo.targetLang || "en-US";
      studio.setInspector("voiceover");
      const next = await translateCaptionCues(cues, speakLang, targetLang);
      studio.setCaptionCues(next);
      studio.patchVoiceover({ speakLang, targetLang });
      return {
        ok: true,
        message: `Translated ${next.length} caption${next.length === 1 ? "" : "s"} → ${targetLang}`,
        count: next.length,
        targetLang,
      };
    }
    case "generate_voiceover": {
      const p = payload as {
        speakLang?: string;
        targetLang?: string;
        voice?: string;
        translate?: boolean;
      };
      const vo = studio.project.voiceover ?? DEFAULT_PROJECT.voiceover;
      const cues = studio.project.captions?.cues ?? [];
      if (!cues.length) {
        return { ok: false, error: "No captions to voice — apply captions first" };
      }
      const speakLang = p.speakLang || vo.speakLang || "en-US";
      const targetLang = p.targetLang || vo.targetLang || "en-US";
      studio.setInspector("voiceover");
      studio.patchVoiceover({ speakLang, targetLang, enabled: true });
      try {
        const result = await generateVoiceoverFromCaptions({
          cues,
          speakLang,
          targetLang,
          voice: p.voice || vo.voice,
          translate: p.translate,
          onStatus: (message) => {
            toast.message(message);
          },
        });
        if (result.translated) {
          studio.setCaptionCues(result.cues);
        }
        studio.setVoiceoverClips(result.clips);
        studio.patchVoiceover({
          enabled: true,
          speakLang,
          targetLang: result.targetLang,
          voice: result.voice,
        });
        return {
          ok: true,
          message: result.translated
            ? `Translated → ${result.targetLang} and generated ${result.clips.length} voiceover clip${result.clips.length === 1 ? "" : "s"}`
            : `Generated ${result.clips.length} English voiceover clip${result.clips.length === 1 ? "" : "s"}`,
          clips: result.clips.length,
          voice: result.voice,
          targetLang: result.targetLang,
          translated: result.translated,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "set_background_music": {
      const p = payload as {
        url?: string;
        title?: string;
        creator?: string;
        license?: string;
        volume?: number;
        enabled?: boolean;
        loop?: boolean;
        sourceId?: string;
      };
      if (!p.url?.trim()) return { ok: false, error: "url required" };
      const prev = studio.project.music?.url;
      if (prev?.startsWith("blob:") && prev !== p.url) {
        try {
          URL.revokeObjectURL(prev);
        } catch {
          /* ignore */
        }
      }
      studio.patchMusic({
        enabled: p.enabled !== false,
        url: p.url.trim(),
        title: p.title?.trim() || studio.project.music?.title || "Background",
        creator: p.creator?.trim() || studio.project.music?.creator || "",
        license: p.license?.trim() || studio.project.music?.license || "",
        volume:
          typeof p.volume === "number"
            ? Math.min(1, Math.max(0.02, p.volume))
            : studio.project.music?.volume ?? 0.16,
        loop: p.loop !== false,
        sourceId: p.sourceId,
      });
      studio.setInspector("audio");
      return {
        ok: true,
        message: `Background music · ${p.title || "track"}`,
        title: p.title,
      };
    }
    case "clear_background_music": {
      const prev = studio.project.music?.url;
      if (prev?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(prev);
        } catch {
          /* ignore */
        }
      }
      studio.patchMusic({
        enabled: false,
        url: null,
        title: "",
        creator: "",
        license: "",
        sourceId: undefined,
      });
      return { ok: true, message: "Background music cleared" };
    }
    case "ready_for_export": {
      studio.setInspector("export");
      return {
        ok: true,
        message: "Build complete — click Export when you’re happy",
        hint: "Do not call export unless the user explicitly asks. They click the Export button.",
      };
    }
    case "export": {
      // Kept for power users; skill tells agents not to call this by default.
      const take = studio.take;
      if (!take) return { ok: false, error: "No recording loaded" };
      if (!exportSupported()) {
        return { ok: false, error: "WebCodecs not available — use the desktop app" };
      }
      const opts =
        (payload as { width?: number; fps?: number; quality?: "web" | "high" | "max" }) ?? {};
      const width = opts.width ?? 1920;
      const fps = opts.fps ?? 30;
      const quality = opts.quality ?? "high";
      const bgUrl = resolveBackgroundImageUrl(studio.project.background);
      const bgImage = bgUrl ? await loadImage(bgUrl) : null;
      const camImage = studio.project.camera.backgroundImageUrl
        ? await loadImage(studio.project.camera.backgroundImageUrl)
        : null;
      const blob = await exportProject(
        studio.project,
        take,
        { backgroundImage: bgImage, cameraBackgroundImage: camImage },
        { width, fps, quality },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${studio.project.name.replace(/\s+/g, "-").toLowerCase() || "screen-weaver"}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
      return {
        ok: true,
        message: `Exported ${a.download}`,
        bytes: blob.size,
        fileName: a.download,
      };
    }
    default:
      return {
        ok: false,
        error:
          `Unknown action "${action}". Use status|list_windows|focus_studio|open_record_picker|open_url|open_path|start_capture|stop_capture|` +
          `android_ensure_runtime|android_list_devices|android_start|android_stop|` +
          `notify|seek|open_tab|apply_preset|patch_frame|set_name|apply_recipe|add_caption|add_zoom|` +
          `add_effect|add_sound|add_camera_move|set_captions|regenerate_zooms|translate_captions|generate_voiceover|set_background_music|clear_background_music|ready_for_export|export`,
      };
  }
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
}
