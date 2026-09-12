import type { CursorShape } from "./types";

/** Map CSS `cursor` values (browser / extension) to our glyph set. */
export function shapeFromCssCursor(css: string): CursorShape {
  const c = css.toLowerCase().split(",")[0]?.trim() ?? "default";
  if (c === "text" || c === "vertical-text") return "ibeam";
  if (c === "crosshair") return "cross";
  if (c === "pointer" || c === "grab" || c === "grabbing") return "hand";
  if (c === "wait" || c === "progress") return "wait";
  if (c === "move" || c === "all-scroll") return "move";
  if (c === "ns-resize" || c === "row-resize" || c === "n-resize" || c === "s-resize") {
    return "resize-ns";
  }
  if (c === "ew-resize" || c === "col-resize" || c === "e-resize" || c === "w-resize") {
    return "resize-ew";
  }
  if (c === "nesw-resize" || c === "ne-resize" || c === "sw-resize") return "resize-nesw";
  if (c === "nwse-resize" || c === "nw-resize" || c === "se-resize") return "resize-nwse";
  if (c === "not-allowed" || c === "no-drop") return "not-allowed";
  if (c === "cell" || c === "copy") return "cross";
  return "arrow";
}

/**
 * Thin OS cursors (I-beam, cell cross, resize) read as tiny on video.
 * Auto mode boosts those glyphs so typing / cell work stays readable.
 */
export function autoCursorShapeBoost(shape: CursorShape): number {
  switch (shape) {
    case "ibeam":
      return 1.55;
    case "cross":
      return 1.4;
    case "resize-ns":
    case "resize-ew":
    case "resize-nesw":
    case "resize-nwse":
      return 1.35;
    case "hand":
      return 1.65;
    case "wait":
    case "move":
      return 1.22;
    case "custom":
      return 1.45;
    case "hidden":
      return 1;
    case "not-allowed":
      return 1.15;
    default:
      return 1.12;
  }
}

/**
 * Cursor is drawn inside the zoomed frame — without compensation it grows with
 * punch-ins. Soft inverse keeps screen size stable while still feeling present.
 */
export function autoCursorZoomCompensation(zoomScale: number): number {
  const z = Math.max(1, zoomScale);
  if (z <= 1.02) return 1;
  return 1 / Math.pow(z, 0.72);
}

/** Shapes that should stay on-screen while the pointer sits still (typing / cells). */
export function cursorStaysVisibleWhenIdle(shape: CursorShape | undefined): boolean {
  return shape === "ibeam" || shape === "cross";
}

function strokeFill(
  ctx: CanvasRenderingContext2D,
  fill = "#ffffff",
  stroke = "rgba(0,0,0,0.55)",
  line = 1.55,
) {
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2.5;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = line;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawIbeam(ctx: CanvasRenderingContext2D) {
  // Video-friendly text cursor: soft dark halo + bright stem, serifs that read at size.
  // Hotspot at center of the stem.
  const h = 26;
  const serif = 7.5;
  ctx.save();
  ctx.translate(0, -h / 2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Outer halo for contrast on light and dark UIs
  ctx.beginPath();
  ctx.moveTo(-serif, 0);
  ctx.lineTo(serif, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, h);
  ctx.moveTo(-serif, h);
  ctx.lineTo(serif, h);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 4.2;
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1.5;
  ctx.stroke();

  // Bright core
  ctx.shadowColor = "transparent";
  ctx.beginPath();
  ctx.moveTo(-serif, 0);
  ctx.lineTo(serif, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, h);
  ctx.moveTo(-serif, h);
  ctx.lineTo(serif, h);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.15;
  ctx.stroke();

  // Soft blue tint on the stem so it reads as a caret, not a scratch
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.lineTo(0, h - 2);
  ctx.strokeStyle = "rgba(186, 220, 255, 0.55)";
  ctx.lineWidth = 1.05;
  ctx.stroke();
  ctx.restore();
}

/** Draw a large, readable cursor glyph. Tip / hotspot at (0,0) in local space unless noted. */
export function drawCursorShape(
  ctx: CanvasRenderingContext2D,
  shape: CursorShape,
  pressed: boolean,
) {
  const press = pressed ? 0.92 : 1;
  ctx.scale(press, press);

  if (shape === "ibeam") {
    drawIbeam(ctx);
    return;
  }
  if (shape === "hidden") {
    return;
  }

  if (shape === "cross") {
    // Thick plus / cell crosshair — chunkier for tutorial readability
    ctx.translate(-12, -12);
    const arm = 4.6;
    ctx.beginPath();
    ctx.moveTo(12 - arm, 1.5);
    ctx.lineTo(12 + arm, 1.5);
    ctx.lineTo(12 + arm, 12 - arm);
    ctx.lineTo(22.5, 12 - arm);
    ctx.lineTo(22.5, 12 + arm);
    ctx.lineTo(12 + arm, 12 + arm);
    ctx.lineTo(12 + arm, 22.5);
    ctx.lineTo(12 - arm, 22.5);
    ctx.lineTo(12 - arm, 12 + arm);
    ctx.lineTo(1.5, 12 + arm);
    ctx.lineTo(1.5, 12 - arm);
    ctx.lineTo(12 - arm, 12 - arm);
    ctx.closePath();
    strokeFill(ctx);
    return;
  }

  if (shape === "hand") {
    // Larger pointing hand — hotspot near tip of index finger.
    ctx.scale(1.35, 1.35);
    ctx.translate(-5, -3);
    ctx.beginPath();
    ctx.moveTo(9, 26);
    ctx.lineTo(1.5, 15.5);
    ctx.quadraticCurveTo(-0.2, 13.2, 2.8, 12.6);
    ctx.lineTo(7.5, 16);
    ctx.lineTo(7, 3.2);
    ctx.quadraticCurveTo(7, 0.8, 9.4, 0.8);
    ctx.quadraticCurveTo(11.8, 0.8, 11.8, 3.2);
    ctx.lineTo(12.2, 12.5);
    ctx.lineTo(12.4, 2.2);
    ctx.quadraticCurveTo(12.4, 0.2, 14.6, 0.2);
    ctx.quadraticCurveTo(16.8, 0.2, 16.8, 2.2);
    ctx.lineTo(16.9, 12.5);
    ctx.lineTo(17.2, 3.5);
    ctx.quadraticCurveTo(17.2, 1.5, 19.2, 1.5);
    ctx.quadraticCurveTo(21.2, 1.5, 21.2, 3.5);
    ctx.lineTo(20.8, 14.5);
    ctx.lineTo(21.8, 8.2);
    ctx.quadraticCurveTo(22.2, 6.2, 24.2, 6.6);
    ctx.quadraticCurveTo(26, 7.1, 25.2, 9.8);
    ctx.lineTo(21.5, 26);
    ctx.closePath();
    strokeFill(ctx, "#ffffff", "rgba(0,0,0,0.55)", 1.7);
    return;
  }

  if (shape === "wait") {
    ctx.translate(-10, -10);
    ctx.beginPath();
    ctx.arc(10, 10, 8.5, 0, Math.PI * 2);
    strokeFill(ctx, "#ffffff", "rgba(0,0,0,0.5)", 1.5);
    ctx.beginPath();
    ctx.moveTo(10, 10);
    ctx.lineTo(10, 4.5);
    ctx.moveTo(10, 10);
    ctx.lineTo(14.5, 12.5);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.stroke();
    return;
  }

  if (shape === "move") {
    ctx.translate(-12, -12);
    ctx.beginPath();
    // plus arrows
    ctx.moveTo(12, 2);
    ctx.lineTo(15, 6);
    ctx.lineTo(13, 6);
    ctx.lineTo(13, 11);
    ctx.lineTo(18, 11);
    ctx.lineTo(18, 9);
    ctx.lineTo(22, 12);
    ctx.lineTo(18, 15);
    ctx.lineTo(18, 13);
    ctx.lineTo(13, 13);
    ctx.lineTo(13, 18);
    ctx.lineTo(15, 18);
    ctx.lineTo(12, 22);
    ctx.lineTo(9, 18);
    ctx.lineTo(11, 18);
    ctx.lineTo(11, 13);
    ctx.lineTo(6, 13);
    ctx.lineTo(6, 15);
    ctx.lineTo(2, 12);
    ctx.lineTo(6, 9);
    ctx.lineTo(6, 11);
    ctx.lineTo(11, 11);
    ctx.lineTo(11, 6);
    ctx.lineTo(9, 6);
    ctx.closePath();
    strokeFill(ctx);
    return;
  }

  if (
    shape === "resize-ns" ||
    shape === "resize-ew" ||
    shape === "resize-nesw" ||
    shape === "resize-nwse"
  ) {
    if (shape === "resize-ew") ctx.rotate(Math.PI / 2);
    if (shape === "resize-nesw") ctx.rotate(-Math.PI / 4);
    if (shape === "resize-nwse") ctx.rotate(Math.PI / 4);
    ctx.translate(-6, -12);
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(10, 5);
    ctx.lineTo(7.2, 5);
    ctx.lineTo(7.2, 19);
    ctx.lineTo(10, 19);
    ctx.lineTo(6, 24);
    ctx.lineTo(2, 19);
    ctx.lineTo(4.8, 19);
    ctx.lineTo(4.8, 5);
    ctx.lineTo(2, 5);
    ctx.closePath();
    strokeFill(ctx);
    return;
  }

  if (shape === "not-allowed") {
    ctx.translate(-11, -11);
    ctx.beginPath();
    ctx.arc(11, 11, 9, 0, Math.PI * 2);
    strokeFill(ctx, "#ffffff", "rgba(0,0,0,0.5)", 1.5);
    ctx.beginPath();
    ctx.moveTo(5, 5);
    ctx.lineTo(17, 17);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "#e11d48";
    ctx.stroke();
    return;
  }

  // Default arrow (hotspot at tip) — slightly larger for video readability
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 24);
  ctx.lineTo(6, 18.2);
  ctx.lineTo(10.2, 27.5);
  ctx.lineTo(13.8, 26);
  ctx.lineTo(9.6, 16.6);
  ctx.lineTo(17.5, 16.6);
  ctx.closePath();
  strokeFill(ctx);
}
