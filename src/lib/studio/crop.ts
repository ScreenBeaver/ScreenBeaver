/** Normalized source crop helpers (0..1 in recording pixel space). */

export type SourceCrop = { x: number; y: number; w: number; h: number };

export const FULL_CROP: SourceCrop = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_CROP = 0.08;

export function clampCrop(c: SourceCrop): SourceCrop {
  const w = Math.min(1, Math.max(MIN_CROP, c.w));
  const h = Math.min(1, Math.max(MIN_CROP, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  return { x, y, w, h };
}

export function isFullCrop(c: SourceCrop | undefined | null): boolean {
  if (!c) return true;
  return c.x <= 0.002 && c.y <= 0.002 && c.w >= 0.998 && c.h >= 0.998;
}

/** Pixel size of the crop inside the source recording. */
export function cropPixelSize(
  c: SourceCrop,
  videoW: number,
  videoH: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(c.w * videoW)),
    height: Math.max(1, Math.round(c.h * videoH)),
  };
}

/** Normalized w/h ratio for a target content aspect (width/height). */
export function normAspectForContent(contentAspect: number, videoW: number, videoH: number): number {
  return contentAspect * (videoH / Math.max(1, videoW));
}

/** Refit crop to a content aspect ratio, keeping center when possible. */
export function fitCropAspect(
  c: SourceCrop,
  contentAspect: number,
  videoW: number,
  videoH: number,
): SourceCrop {
  const ratio = normAspectForContent(contentAspect, videoW, videoH);
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;

  // Prefer keeping the larger current dimension so we don't shrink more than needed.
  let w = c.w;
  let h = w / ratio;
  if (h > 1) {
    h = 1;
    w = h * ratio;
  }
  if (w > 1) {
    w = 1;
    h = w / ratio;
  }
  if (w < MIN_CROP) {
    w = MIN_CROP;
    h = w / ratio;
  }
  if (h < MIN_CROP) {
    h = MIN_CROP;
    w = h * ratio;
  }
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
}

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Apply a pointer delta (in normalized video coords) to a crop via a handle.
 * When `lockRatio` is set (normalized w/h), aspect is preserved from corners / edges.
 */
export function applyCropDelta(
  start: SourceCrop,
  handle: CropHandle,
  dx: number,
  dy: number,
  lockRatio: number | null,
): SourceCrop {
  let { x, y, w, h } = start;

  if (handle === "move") {
    return clampCrop({ x: x + dx, y: y + dy, w, h });
  }

  const left = handle.includes("w");
  const right = handle.includes("e");
  const top = handle.includes("n");
  const bottom = handle.includes("s");
  // Edge-only: 'n','s','e','w'
  const onlyN = handle === "n";
  const onlyS = handle === "s";
  const onlyE = handle === "e";
  const onlyW = handle === "w";

  if (left || onlyW) {
    const nx = x + dx;
    const nw = w - dx;
    if (nw >= MIN_CROP) {
      x = nx;
      w = nw;
    }
  }
  if (right || onlyE) {
    w = w + dx;
  }
  if (top || onlyN) {
    const ny = y + dy;
    const nh = h - dy;
    if (nh >= MIN_CROP) {
      y = ny;
      h = nh;
    }
  }
  if (bottom || onlyS) {
    h = h + dy;
  }

  if (lockRatio && lockRatio > 0) {
    // Anchor opposite corner / edge center.
    if (handle === "se" || handle === "e" || handle === "s") {
      h = w / lockRatio;
    } else if (handle === "sw" || handle === "w") {
      const rightEdge = start.x + start.w;
      h = w / lockRatio;
      x = rightEdge - w;
    } else if (handle === "ne" || handle === "n") {
      const bottomEdge = start.y + start.h;
      if (handle === "n") {
        w = h * lockRatio;
        x = start.x + start.w / 2 - w / 2;
      } else {
        h = w / lockRatio;
      }
      y = bottomEdge - h;
    } else if (handle === "nw") {
      const rightEdge = start.x + start.w;
      const bottomEdge = start.y + start.h;
      h = w / lockRatio;
      x = rightEdge - w;
      y = bottomEdge - h;
    }
  }

  return clampCrop({ x, y, w, h });
}
