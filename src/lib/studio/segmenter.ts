/**
 * Webcam background handling (blur / replace / none).
 * Lazily loads MediaPipe selfie segmentation and produces a square cutout canvas.
 * Throttled so preview stays smooth; segments the real <video> (VIDEO mode requirement).
 */

type Segmenter = {
  segmentForVideo: (
    input: HTMLVideoElement,
    timestampMs: number,
  ) => {
    categoryMask?: {
      getAsUint8Array(): Uint8Array;
      width: number;
      height: number;
      close(): void;
    };
    close(): void;
  };
};

/** 256 is enough for a PiP bubble and cheaper than 384. */
const SIZE = 384;
/** Cap MediaPipe to ~12 fps — reuse the last mask between ticks. */
const MIN_INTERVAL_MS = 80;

let segmenter: Segmenter | null = null;
let loading: Promise<Segmenter | null> | null = null;
let failed = false;

const work = typeof document !== "undefined" ? document.createElement("canvas") : null;
const out = typeof document !== "undefined" ? document.createElement("canvas") : null;
if (work && out) {
  work.width = work.height = SIZE;
  out.width = out.height = SIZE;
}

let wctx: CanvasRenderingContext2D | null = null;
let octx: CanvasRenderingContext2D | null = null;
let lastMaskAt = 0;
let lastMirror = false;
let lastVideo: HTMLVideoElement | null = null;
let lastVideoTime = -1;

function ensureCtx() {
  if (!work || !out) return false;
  if (!wctx) wctx = work.getContext("2d", { willReadFrequently: true });
  if (!octx) octx = out.getContext("2d");
  return !!(wctx && octx);
}

export function segmentationFailed() {
  return failed;
}

/** Drop cached cutout after seeks / take changes so we don't paint a stale blob. */
export function invalidateCutoutCache() {
  lastMaskAt = 0;
  lastVideo = null;
  lastVideoTime = -1;
}

export async function loadSegmenter(): Promise<boolean> {
  if (segmenter) return true;
  if (failed) return false;
  if (!loading) {
    loading = (async () => {
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const files = await vision.FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
        );
        const s = await vision.ImageSegmenter.createFromOptions(files, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        return s as unknown as Segmenter;
      } catch (err) {
        console.warn("segmentation unavailable", err);
        failed = true;
        return null;
      }
    })();
  }
  segmenter = await loading;
  return !!segmenter;
}

/**
 * Returns a square canvas with the subject cut out (transparent background),
 * or the last good mask / null if segmentation isn't ready.
 * Safe to call every animation frame — internally throttled.
 */
export function cutoutFrame(
  video: HTMLVideoElement,
  timestampMs: number,
  mirror: boolean,
): HTMLCanvasElement | null {
  if (
    !segmenter ||
    !work ||
    !out ||
    !ensureCtx() ||
    video.readyState < 2 ||
    video.seeking ||
    !video.videoWidth
  ) {
    return out && out.width > 0 && lastVideo === video ? out : null;
  }

  const vTime = video.currentTime;
  const jumped = lastVideo === video && Math.abs(vTime - lastVideoTime) > 0.2;

  // Reuse last mask unless enough time passed, mirror flipped, or playhead jumped.
  if (
    !jumped &&
    video === lastVideo &&
    mirror === lastMirror &&
    timestampMs - lastMaskAt < MIN_INTERVAL_MS &&
    out.width > 0
  ) {
    return out;
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  wctx!.save();
  if (mirror) {
    wctx!.translate(SIZE, 0);
    wctx!.scale(-1, 1);
  }
  wctx!.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);
  wctx!.restore();

  let result;
  try {
    // VIDEO mode expects the real <video> element (not a canvas).
    result = segmenter.segmentForVideo(video, timestampMs);
  } catch {
    return out.width > 0 && lastVideo === video ? out : null;
  }
  const mask = result.categoryMask;
  if (!mask) {
    result.close?.();
    return out.width > 0 && lastVideo === video ? out : null;
  }
  const maskData = mask.getAsUint8Array();
  const mw = mask.width;
  const mh = mask.height;

  const frame = wctx!.getImageData(0, 0, SIZE, SIZE);
  const px = frame.data;
  const mSide = Math.min(mw, mh) | 0;
  const mOffX = ((mw - mSide) / 2) | 0;
  const mOffY = ((mh - mSide) / 2) | 0;
  const xStep = mSide / SIZE;
  const yStep = mSide / SIZE;

  let opaque = 0;
  for (let y = 0; y < SIZE; y++) {
    const my = Math.min(mh - 1, Math.max(0, (mOffY + y * yStep) | 0));
    const row = my * mw;
    const outRow = y * SIZE;
    for (let x = 0; x < SIZE; x++) {
      const srcX = mirror ? SIZE - 1 - x : x;
      const mx = Math.min(mw - 1, Math.max(0, (mOffX + srcX * xStep) | 0));
      const cat = maskData[row + mx] ?? 0;
      // selfie_segmenter: low = person, high = background.
      const isPerson = cat < 128;
      if (isPerson) opaque += 1;
      px[(outRow + x) * 4 + 3] = isPerson ? 255 : 0;
    }
  }
  mask.close?.();
  result.close?.();

  // Reject empty/inverted masks — fall back to raw camera instead of a grey blob.
  if (opaque < SIZE * SIZE * 0.02 || opaque > SIZE * SIZE * 0.98) {
    return null;
  }

  octx!.clearRect(0, 0, SIZE, SIZE);
  octx!.putImageData(frame, 0, 0);
  lastMaskAt = timestampMs;
  lastMirror = mirror;
  lastVideo = video;
  lastVideoTime = vTime;
  return out;
}
