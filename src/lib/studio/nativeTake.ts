/**
 * Import a native (picker-free) desktop capture into a RecordingTake.
 * Fetches the MP4 over the local bridge, then uses a blob URL for Stage/export.
 */
import type { CaretSample, CursorSample, RecordingTake } from "./types";
import { isTauri } from "./nativeBridge";

const BRIDGE = "http://127.0.0.1:17355";

export type NativeCaptureStopPayload = {
  path: string;
  mediaUrl?: string;
  width: number;
  height: number;
  durationMs: number;
  sourceLabel: string;
  cursor?: CursorSample[];
  typing?: { t: number; duration: number }[];
  /** Text-caret samples recorded by the desktop app, same clock as `cursor`. */
  caret?: CaretSample[];
  /** The AI drove the mouse/keyboard for this take (MCP demo). */
  agentDriven?: boolean;
  /** Encoder is still writing the MP4 — not playable yet. */
  finalizing?: boolean;
};

/** Poll the bridge until the encoder has finished writing the last capture. */
export async function waitForFinalizedCapture(
  timeoutMs = 10 * 60_000,
): Promise<NativeCaptureStopPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${BRIDGE}/capture/last`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      const meta = (await res.json()) as NativeCaptureStopPayload;
      if (!meta.finalizing) return meta;
    }
    if (Date.now() > deadline) {
      throw new Error("Recording is still being written to disk — try import again in a minute");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function captureMediaUrl(path: string, mediaUrl?: string): string {
  if (mediaUrl && mediaUrl.startsWith("http")) return mediaUrl;
  return `${BRIDGE}/capture/file?path=${encodeURIComponent(path)}`;
}

export async function importNativeTake(
  payload: NativeCaptureStopPayload,
  cursor: CursorSample[],
): Promise<RecordingTake> {
  const httpUrl = captureMediaUrl(payload.path, payload.mediaUrl);
  const durationHint = Math.max(0.1, (payload.durationMs || 0) / 1000);

  await waitForMedia(httpUrl, 20);

  // Large takes (long Canva demos) — stream from the bridge; don't copy multi‑GB into a blob.
  const head = await fetch(httpUrl, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" }).catch(
    () => null,
  );
  const totalHeader =
    head?.headers.get("content-range")?.split("/")[1] ||
    head?.headers.get("content-length") ||
    "";
  const totalBytes = Number(totalHeader) || 0;
  const LARGE = 80 * 1024 * 1024;

  let screenUrl: string;
  if (totalBytes > LARGE) {
    screenUrl = httpUrl;
  } else {
    const res = await fetch(httpUrl);
    if (!res.ok) {
      throw new Error(`Could not download capture (${res.status})`);
    }
    const blob = await res.blob();
    if (blob.size < 64) {
      throw new Error("Capture file is empty — encoder may have failed");
    }
    // Still large after download — prefer bridge URL to avoid WebView OOM.
    screenUrl = blob.size > LARGE ? httpUrl : URL.createObjectURL(blob);
  }
  const probed = await probeVideoDuration(screenUrl).catch(() => durationHint);

  const cursorPath =
    payload.cursor && payload.cursor.length >= 2
      ? payload.cursor.map((c) => ({
          t: c.t,
          x: c.x,
          y: c.y,
          down: !!c.down,
        }))
      : cursor.length
        ? cursor
        : [{ t: 0, x: 0.5, y: 0.5, down: false }];

  return {
    screenUrl,
    cameraUrl: null,
    micUrl: null,
    duration: probed,
    width: Math.max(2, payload.width || 1280),
    height: Math.max(2, payload.height || 720),
    cursor: cursorPath,
    ...(payload.caret?.length ? { caret: payload.caret } : {}),
    createdAt: Date.now(),
    sourceLabel: payload.sourceLabel || "Native capture",
    hasMicrophone: false,
    hasSystemAudio: false,
  };
}

export async function importLastNativeCapture(
  cursor: CursorSample[] = [],
): Promise<{ take: RecordingTake; meta: NativeCaptureStopPayload }> {
  let meta = await fetch(`${BRIDGE}/capture/last`, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error("No last capture on bridge");
    return r.json() as Promise<NativeCaptureStopPayload & { ok?: boolean }>;
  });
  if (meta.finalizing) meta = await waitForFinalizedCapture();
  return { take: await importNativeTake(meta, cursor), meta };
}

async function waitForMedia(url: string, attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      if (res.ok) {
        // Don't drain the body here — just confirm the endpoint is up.
        // Caller will fetch again for the real blob.
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function probeVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const d = v.duration;
      v.removeAttribute("src");
      v.load();
      if (Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error("bad duration"));
    };
    v.onerror = () => reject(new Error("Could not probe video"));
    v.src = url;
  });
}

export async function listCaptureTargets(): Promise<
  {
    id: string;
    kind: string;
    title: string;
    processName: string;
    width: number;
    height: number;
  }[]
> {
  if (!isTauri()) throw new Error("listCaptureTargets requires the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("capture_list_targets");
}

export async function startNativeCapture(opts: {
  windowId?: string;
  titleContains?: string;
}): Promise<unknown> {
  if (!isTauri()) throw new Error("startNativeCapture requires the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("capture_start", {
    windowId: opts.windowId ?? null,
    titleContains: opts.titleContains ?? null,
  });
}

export async function stopNativeCapture(): Promise<NativeCaptureStopPayload> {
  if (!isTauri()) throw new Error("stopNativeCapture requires the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  const stopped = await invoke<NativeCaptureStopPayload>("capture_stop");
  if (!stopped.finalizing) return stopped;
  const done = await waitForFinalizedCapture();
  return { ...done, cursor: done.cursor?.length ? done.cursor : stopped.cursor };
}

export async function openCaptureUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url.startsWith("http") ? url : `https://${url}`, "_blank");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("capture_open_url", { url });
}

export async function openCapturePath(path: string): Promise<void> {
  if (!isTauri()) throw new Error("openCapturePath requires the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("capture_open_path", { path });
}
