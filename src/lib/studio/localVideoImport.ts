import type { CursorSample, RecordingTake } from "./types";
import { isVideoFile } from "./mediaKind";

const META_TIMEOUT_MS = 20_000;

function readVideoMeta(
  url: string,
): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      fn();
    };

    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("Timed out reading video metadata")));
    }, META_TIMEOUT_MS);

    v.onloadedmetadata = () => {
      finish(() => {
        const duration = Number.isFinite(v.duration) ? v.duration : 0;
        const width = v.videoWidth || 1280;
        const height = v.videoHeight || 720;
        resolve({ duration, width, height });
      });
    };
    v.onerror = () => {
      finish(() => reject(new Error("Could not read video metadata")));
    };
    v.src = url;
  });
}

export async function makeTakeFromLocalVideoFile(
  file: File,
  cursor: CursorSample[] = [],
): Promise<RecordingTake> {
  if (!isVideoFile(file)) throw new Error("Not a video file");
  const url = URL.createObjectURL(file);

  try {
    const meta = await readVideoMeta(url);
    const duration = Math.max(0.1, meta.duration);
    const defaultCursor: CursorSample[] = cursor.length
      ? cursor
      : [
          {
            t: 0,
            x: 0.5,
            y: 0.5,
            down: false,
          },
        ];

    return {
      screenUrl: url,
      cameraUrl: null,
      micUrl: null,
      duration,
      width: meta.width,
      height: meta.height,
      cursor: defaultCursor,
      createdAt: Date.now(),
      sourceLabel: file.name || "Local video",
      hasMicrophone: false,
      hasSystemAudio: false,
    };
  } catch (err) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
