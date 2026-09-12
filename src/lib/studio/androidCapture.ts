/**
 * USB Android capture via portable ADB + scrcpy (desktop only).
 * Tools install into %LOCALAPPDATA%/screen-weaver — no system USB filter.
 */
import type { CaptionCue, KeystrokeCue, RecordingTake } from "./types";
import type { LiveRecording, RecorderMarker, StartOptions } from "./recorder";
import {
  isTauri,
  listenNativeKeystroke,
  startNativePointerHook,
  stopNativePointerHook,
} from "./nativeBridge";
import { importNativeTake, type NativeCaptureStopPayload } from "./nativeTake";
import {
  defaultSoundDuration,
  ensureTypingSounds,
  newSoundId,
  type SoundClip,
} from "./soundTrack";
import { cueFromNativeKeystroke, mergeKeystrokeCues } from "./keystrokes";

export type AndroidRuntimeStatus = {
  ready: boolean;
  version: string;
  runtimeDir: string;
  adbPath: string;
  scrcpyPath: string;
  message: string;
};

export type AndroidDevice = {
  serial: string;
  state: string;
  model: string;
  manufacturer: string;
  product: string;
  transport: string;
  label: string;
};

export type AndroidSessionStarted = {
  serial: string;
  label: string;
  windowTitle: string;
  recordPath: string;
  control: boolean;
};

async function invokeAndroid<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Android USB requires the Screen Beaver desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function supportsAndroidCapture(): boolean {
  return isTauri();
}

export async function androidRuntimeStatus(): Promise<AndroidRuntimeStatus> {
  return invokeAndroid("android_runtime_status");
}

export async function androidEnsureRuntime(): Promise<AndroidRuntimeStatus> {
  return invokeAndroid("android_ensure_runtime");
}

export async function androidListDevices(): Promise<AndroidDevice[]> {
  return invokeAndroid("android_list_devices");
}

export async function androidUsbNote(): Promise<string> {
  return invokeAndroid("android_usb_note");
}

export async function androidStart(serial?: string): Promise<AndroidSessionStarted> {
  return invokeAndroid("android_start", { serial: serial ?? null });
}

export async function androidStop(): Promise<NativeCaptureStopPayload> {
  return invokeAndroid("android_stop");
}

export async function androidSessionActive(): Promise<boolean> {
  return invokeAndroid("android_session_active");
}

/**
 * Start USB Android mirror+control+record as a LiveRecording compatible session.
 */
export async function startAndroidRecording(
  opts: StartOptions & { androidSerial?: string },
): Promise<LiveRecording> {
  await androidEnsureRuntime();
  await androidStart(opts.androidSerial);

  let cameraStream: MediaStream | null = null;
  if (opts.camera) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      cameraStream = null;
    }
  }

  const markers: RecorderMarker[] = [];
  const keystrokeCues: KeystrokeCue[] = [];
  const startedAt = performance.now();
  const emptyScreen = new MediaStream();
  const nativeUnsubs: Array<() => void> = [];
  const now = () => (performance.now() - startedAt) / 1000;

  // System-wide hook: PC keyboard chords while focused on the scrcpy mirror.
  const hasHook = await startNativePointerHook();
  if (hasHook) {
    nativeUnsubs.push(
      await listenNativeKeystroke((ev) => {
        const cue = cueFromNativeKeystroke(now(), ev.label, ev.keys ?? []);
        const merged = mergeKeystrokeCues(keystrokeCues, [cue]);
        keystrokeCues.length = 0;
        keystrokeCues.push(...merged);
      }),
    );
  }

  const cleanupHook = () => {
    nativeUnsubs.forEach((u) => u());
    nativeUnsubs.length = 0;
    void stopNativePointerHook();
  };

  const stop = async () => {
    cameraStream?.getTracks().forEach((t) => t.stop());
    cleanupHook();
    const payload = await androidStop();
    const take: RecordingTake = await importNativeTake(payload, []);
    let sounds: SoundClip[] = [];
    if (payload.typing?.length) {
      sounds = ensureTypingSounds(
        payload.typing.map((b) => ({ t: b.t, duration: b.duration })),
        sounds,
      );
    }
    // Fallback ids if ensure didn't run
    if (!sounds.length && payload.typing?.length) {
      sounds = payload.typing.map((b) => ({
        id: newSoundId("typing", b.t),
        kind: "typing" as const,
        time: b.t,
        duration: Math.max(defaultSoundDuration("typing"), b.duration),
      }));
    }
    const captions: CaptionCue[] = [];
    const elapsed = now();
    if (elapsed > 0.5 && Math.abs(take.duration - elapsed) > 0.4) {
      const scale = take.duration / elapsed;
      for (const k of keystrokeCues) k.time *= scale;
    }
    return {
      take,
      markers: [...markers],
      sounds,
      captions,
      keystrokes: keystrokeCues.slice(),
    };
  };

  return {
    screenStream: emptyScreen,
    cameraStream,
    stop,
    cancel: () => {
      cameraStream?.getTracks().forEach((t) => t.stop());
      cleanupHook();
      void androidStop().catch(() => {});
    },
    startedAt,
    addMarker: (kind, preset) => {
      markers.push({
        kind,
        t: now(),
        x: 0.5,
        y: 0.5,
        preset,
      });
    },
    hasSurfaceCursor: false,
    hasDesktopCursor: true,
    smoothCursor: true,
  };
}
