import { getWallpaper } from "./wallpapers";
import { paintMotionBackground } from "./motionBackgrounds";
import { buildCursorTrack, evalCameraPose, evalZoom, zoomMotionStrength, cameraMotionStrength, type CursorTrack } from "./motion";
import { evalScenePose } from "./sceneEffects";
import {
  autoCursorShapeBoost,
  autoCursorZoomCompensation,
  drawCursorShape,
} from "./cursorShapes";
import {
  getDeviceColor,
  getDeviceFrame,
  layoutDeviceInStage,
  paintDeviceShell,
} from "./deviceFrames";
import { drawKeystrokeOverlay } from "./keystrokes";
import type { ChromeTheme, CursorIconBitmap, CursorShape, ProjectState, RecordingTake, WindowChrome } from "./types";

const customIconCache = new Map<string, ImageBitmap | HTMLCanvasElement | null>();
const customHotspots = new Map<string, { hx: number; hy: number }>();

export function primeCursorIcons(icons: Record<string, CursorIconBitmap> | undefined) {
  if (!icons) return;
  for (const [id, icon] of Object.entries(icons)) {
    customHotspots.set(id, { hx: icon.hx, hy: icon.hy });
    if (customIconCache.has(id) && customIconCache.get(id)) continue;
    customIconCache.set(id, null);
    void (async () => {
      try {
        const raw = Uint8Array.from(atob(icon.rgba), (c) => c.charCodeAt(0));
        const imgData = new ImageData(new Uint8ClampedArray(raw), icon.w, icon.h);
        if (typeof createImageBitmap === "function") {
          customIconCache.set(id, await createImageBitmap(imgData));
        } else {
          const c = document.createElement("canvas");
          c.width = icon.w;
          c.height = icon.h;
          c.getContext("2d")!.putImageData(imgData, 0, 0);
          customIconCache.set(id, c);
        }
      } catch {
        customIconCache.set(id, null);
      }
    })();
  }
}

export interface SceneMedia {
  screen: HTMLVideoElement | null;
  camera: HTMLVideoElement | null;
  cameraMask: HTMLCanvasElement | null;
  backgroundImage: HTMLImageElement | null;
  cameraBackgroundImage: HTMLImageElement | null;
}

export interface SceneInput {
  project: ProjectState;
  take: RecordingTake | null;
  media: SceneMedia;
  cursorTrack: CursorTrack | null;
  time: number;
}

export function makeCursorTrack(
  take: RecordingTake | null,
  smoothing: number,
  autoHideIdle = true,
): CursorTrack {
  return buildCursorTrack(take?.cursor ?? [], take?.duration ?? 0, smoothing, autoHideIdle);
}

export function stageAspect(project: ProjectState, take: RecordingTake | null): number {
  switch (project.frame.ratio) {
    case "16:9":
      return 16 / 9;
    case "4:3":
      return 4 / 3;
    case "3:2":
      return 3 / 2;
    case "1:1":
      return 1;
    case "9:16":
      return 9 / 16;
    default:
      return take && take.height > 0 ? take.width / take.height : 16 / 9;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  // Sub-pixel radii fringe under AA when stroked/clipped — snap tiny values to sharp.
  const maxR = Math.min(w, h) / 2;
  const rr = Math.max(0, Math.min(r, maxR));
  ctx.beginPath();
  if (rr < 0.75) {
    ctx.rect(x, y, w, h);
    return;
  }
  // Quadratic corners read cleaner than arcTo at small radii (less “frilled” AA).
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

let bgScratch: HTMLCanvasElement | null = null;
function ensureBgScratch(W: number, H: number) {
  if (!bgScratch) bgScratch = document.createElement("canvas");
  if (bgScratch.width !== W || bgScratch.height !== H) {
    bgScratch.width = W;
    bgScratch.height = H;
  }
  return bgScratch;
}

function paintBackground(ctx: CanvasRenderingContext2D, W: number, H: number, input: SceneInput) {
  const bg = input.project.background;
  ctx.save();
  if (bg.mode === "motion") {
    paintMotionBackground(ctx, W, H, bg.motionId ?? "ribbon-field", input.time);
    if (bg.blur > 0) {
      const cx = W / 2;
      const cy = H / 2;
      const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.8);
      haze.addColorStop(0, `rgba(255,255,255,${(bg.blur / 100) * 0.12})`);
      haze.addColorStop(1, `rgba(0,0,0,${(bg.blur / 100) * 0.08})`);
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, W, H);
    }
  } else if (bg.mode === "color") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else if (
    (bg.mode === "image" && input.media.backgroundImage) ||
    (bg.mode === "wallpaper" && input.media.backgroundImage && getWallpaper(bg.wallpaperId).imageUrl)
  ) {
    const img = input.media.backgroundImage!;
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const blurPx = (bg.blur / 100) * 96;
    if (blurPx > 0.5) ctx.filter = `blur(${blurPx}px)`;
    const pad = (bg.blur / 100) * 80;
    ctx.drawImage(img, (W - dw) / 2 - pad, (H - dh) / 2 - pad, dw + pad * 2, dh + pad * 2);
    ctx.filter = "none";
  } else {
    const paper = getWallpaper(bg.wallpaperId);
    const stops =
      bg.mode === "gradient"
        ? [bg.gradientFrom, bg.gradientTo]
        : (paper.stops ?? ["#334155", "#0f172a"]);
    const angle =
      bg.mode === "gradient" ? bg.gradientAngle : (paper.angle ?? 135);
    const rad = ((angle - 90) * Math.PI) / 180;
    const len = Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad));
    const cx = W / 2;
    const cy = H / 2;
    const blurPx = (bg.blur / 100) * 48;

    const paintGrad = (target: CanvasRenderingContext2D) => {
      const grad = target.createLinearGradient(
        cx - (Math.cos(rad) * len) / 2,
        cy - (Math.sin(rad) * len) / 2,
        cx + (Math.cos(rad) * len) / 2,
        cy + (Math.sin(rad) * len) / 2,
      );
      stops.forEach((color, i) =>
        grad.addColorStop(stops.length === 1 ? 1 : i / (stops.length - 1), color),
      );
      target.fillStyle = grad;
      target.fillRect(0, 0, W, H);
    };

    if (blurPx > 0.5) {
      const tmp = ensureBgScratch(W, H);
      const tctx = tmp.getContext("2d")!;
      tctx.clearRect(0, 0, W, H);
      paintGrad(tctx);
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(tmp, 0, 0);
      ctx.filter = "none";
    } else {
      paintGrad(ctx);
    }
  }
  ctx.restore();
}

function drawMacToolbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  title: string,
  theme: ChromeTheme = "dark",
  /** Full window height — clip must match the outer frame or top corners “frill”. */
  frameH: number,
) {
  const light = theme === "light";
  ctx.save();
  roundRect(ctx, x, y, w, Math.max(frameH, h), radius);
  ctx.clip();
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  if (light) {
    grad.addColorStop(0, "#f6f6f7");
    grad.addColorStop(1, "#ebebed");
  } else {
    grad.addColorStop(0, "#3e3e42");
    grad.addColorStop(1, "#2b2b2e");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.07)";
  ctx.fillRect(x, y + h - 1, w, 1);

  const r = Math.max(3.5, h * 0.155);
  const cy = y + h / 2;
  const dots = [
    { c: "#ff5f57", s: "rgba(0,0,0,0.22)" },
    { c: "#febc2e", s: "rgba(0,0,0,0.22)" },
    { c: "#28c840", s: "rgba(0,0,0,0.22)" },
  ];
  dots.forEach((d, i) => {
    const cx = x + h * 0.55 + i * r * 3.15;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = d.c;
    ctx.fill();
    ctx.strokeStyle = d.s;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  });

  const label = title.trim() || "Window";
  ctx.fillStyle = light ? "rgba(0,0,0,0.72)" : "rgba(255,255,255,0.72)";
  ctx.font = `500 ${Math.max(10, h * 0.34)}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(truncateText(ctx, label, w * 0.5), x + w / 2, cy + 0.5);
  ctx.restore();
}

function drawWindowsToolbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  title: string,
  theme: ChromeTheme = "dark",
  frameH: number,
) {
  const light = theme === "light";
  ctx.save();
  roundRect(ctx, x, y, w, Math.max(frameH, h), radius);
  ctx.clip();
  ctx.fillStyle = light ? "#f3f3f3" : "#202020";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  ctx.fillRect(x, y + h - 1, w, 1);

  const label = title.trim() || "Window";
  ctx.fillStyle = light ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.82)";
  ctx.font = `400 ${Math.max(10, h * 0.32)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(truncateText(ctx, label, w * 0.55), x + h * 0.4, y + h / 2 + 0.5);

  const btnW = h * 1.2;
  const cy = y + h / 2;
  const glyphs = ["—", "□", "×"] as const;
  glyphs.forEach((g, i) => {
    const bx = x + w - btnW * (3 - i);
    ctx.fillStyle = light ? "rgba(0,0,0,0.72)" : "rgba(255,255,255,0.78)";
    ctx.font = `${i === 2 ? 600 : 400} ${h * (i === 2 ? 0.4 : 0.3)}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(g, bx + btnW / 2, cy + (i === 0 ? -1 : 0));
  });
  ctx.restore();
}

/**
 * Clean browser chrome: traffic lights + single editable address pill.
 * No tabs, no clutter — replaces the messy real browser header when paired with nativeChromeCrop.
 */
function drawBrowserToolbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  url: string,
  siteName: string,
  theme: ChromeTheme = "dark",
  frameH: number,
) {
  const light = theme === "light";
  ctx.save();
  // Same path as the outer window — never clip to toolbar-height*2 (that shrinks
  // radius and leaves black “frilled” ears under large corner radii).
  roundRect(ctx, x, y, w, Math.max(frameH, h), radius);
  ctx.clip();

  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  if (light) {
    grad.addColorStop(0, "#f7f7f8");
    grad.addColorStop(1, "#ececef");
  } else {
    grad.addColorStop(0, "#2f2f33");
    grad.addColorStop(1, "#242428");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  ctx.fillRect(x, y + h - 1, w, 1);

  // Traffic lights
  const r = Math.max(3.5, h * 0.12);
  const cy = y + h * 0.42;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(x + h * 0.42 + i * r * 3.1, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // Optional site chip
  let barLeft = x + h * 1.55;
  if (siteName.trim()) {
    const chipH = h * 0.38;
    const chipY = y + h * 0.55;
    ctx.font = `600 ${Math.max(9, h * 0.18)}px system-ui, sans-serif`;
    const tw = ctx.measureText(siteName.trim()).width + chipH * 0.9;
    roundRect(ctx, barLeft, chipY, tw, chipH, chipH / 2);
    ctx.fillStyle = light ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)";
    ctx.fill();
    ctx.fillStyle = light ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.75)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(siteName.trim(), barLeft + chipH * 0.4, chipY + chipH / 2);
    barLeft += tw + h * 0.18;
  }

  // Address / search pill
  const barH = h * 0.42;
  const barY = y + h * 0.52;
  const barW = Math.max(80, x + w - h * 0.45 - barLeft);
  roundRect(ctx, barLeft, barY, barW, barH, barH / 2);
  ctx.fillStyle = light ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.35)";
  ctx.fill();
  ctx.strokeStyle = light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Lock glyph
  const lockX = barLeft + barH * 0.45;
  const lockY = barY + barH / 2;
  ctx.strokeStyle = light ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.45)";
  ctx.lineWidth = Math.max(1, h * 0.035);
  ctx.beginPath();
  ctx.arc(lockX, lockY - barH * 0.12, barH * 0.14, Math.PI, 0);
  ctx.stroke();
  roundRect(ctx, lockX - barH * 0.16, lockY - barH * 0.06, barH * 0.32, barH * 0.28, 2);
  ctx.fillStyle = light ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.45)";
  ctx.fill();

  const display = (url || "example.com").replace(/^https?:\/\//, "");
  ctx.fillStyle = light ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.88)";
  ctx.font = `500 ${Math.max(10, h * 0.2)}px "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    truncateText(ctx, display, barW - barH * 1.4),
    barLeft + barH * 0.85,
    barY + barH / 2 + 0.5,
  );
  ctx.restore();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function chromeHeight(chrome: WindowChrome, availH: number): number {
  if (chrome === "none") return 0;
  if (chrome === "browser") return Math.max(44, availH * 0.085);
  if (chrome === "windows") return Math.max(22, availH * 0.052);
  return Math.max(20, availH * 0.048);
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  pressed: boolean,
  ripple: number,
  opacity = 1,
  shape: CursorShape = "arrow",
  iconId?: string,
) {
  if (opacity <= 0.01) return;
  if (shape === "hidden") return;
  // Beautiful hide: fade + gentle shrink toward the tip
  const hide = Math.min(1, Math.max(0, opacity));
  const hideScale = 0.55 + 0.45 * hide;
  ctx.save();
  ctx.globalAlpha = hide * hide;
  if (ripple > 0) {
    ctx.beginPath();
    ctx.arc(px, py, size * hideScale * (0.5 + ripple * 1.5), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.45 * (1 - ripple) * hide})`;
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${0.16 * (1 - ripple) * hide})`;
    ctx.fill();
  }

  const custom = iconId ? customIconCache.get(iconId) : null;
  if (shape === "custom" && custom) {
    // Prefer crisp upscale; 128² captures stay sharp when drawn large.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const scale = (size / 32) * (pressed ? 0.9 : 1) * 1.15 * hideScale;
    const iw = custom.width;
    const ih = custom.height;
    const hs = customHotspots.get(iconId!) ?? { hx: 0, hy: 0 };
    // Soft outline plate so thin custom cursors read on light UIs
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = Math.max(4, size * 0.12);
    ctx.shadowOffsetY = 2;
    ctx.drawImage(custom, px - hs.hx * scale, py - hs.hy * scale, iw * scale, ih * scale);
    ctx.restore();
    return;
  }

  ctx.translate(px, py);
  // Round scale so vector strokes stay crisp on the canvas grid
  const s = Math.round(((size / 24) * hideScale) * 100) / 100;
  ctx.scale(s, s);
  drawCursorShape(ctx, shape === "custom" ? "hand" : shape, pressed);
  ctx.restore();
}

/** Cached soft blur plate for camera "blur" background mode (refreshed ~10fps). */
let blurPlate: HTMLCanvasElement | null = null;
let blurPlateKey = "";
let blurPlateAt = 0;

function drawBlurredCameraBackdrop(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sx: number,
  sy: number,
  side: number,
  size: number,
  mirror: boolean,
) {
  const blurPx = Math.max(6, Math.round(size * 0.06));
  const plateSize = Math.max(64, Math.min(384, Math.round(size * 0.7)));
  const key = `${video.currentSrc}|${mirror}|${plateSize}|${blurPx}|${(video.currentTime * 4) | 0}`;
  const now = performance.now();
  if (!blurPlate || blurPlateKey !== key || now - blurPlateAt > 100) {
    if (!blurPlate) blurPlate = document.createElement("canvas");
    if (blurPlate.width !== plateSize || blurPlate.height !== plateSize) {
      blurPlate.width = plateSize;
      blurPlate.height = plateSize;
    }
    const bctx = blurPlate.getContext("2d");
    if (bctx) {
      bctx.save();
      if (mirror) {
        bctx.translate(plateSize, 0);
        bctx.scale(-1, 1);
      }
      bctx.filter = `blur(${Math.max(4, Math.round(blurPx * (plateSize / Math.max(1, size))))}px)`;
      const pad = 8;
      bctx.drawImage(
        video,
        sx,
        sy,
        side,
        side,
        -pad,
        -pad,
        plateSize + pad * 2,
        plateSize + pad * 2,
      );
      bctx.filter = "none";
      bctx.restore();
      blurPlateKey = key;
      blurPlateAt = now;
    }
  }
  if (blurPlate) {
    ctx.drawImage(blurPlate, -size / 2, -size / 2, size, size);
  }
}

function drawCamera(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  input: SceneInput,
  zoomWeight: number,
  cursor: { x: number; y: number; active: boolean; opacity: number },
) {
  const cam = input.project.camera;
  const video = input.media.camera;
  if (!cam.enabled || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return;
  }

  const pose = evalCameraPose(cam, input.project.moves, input.time);
  const basePct = cam.size;
  const zoomPct = cam.sizeDuringZoom ?? Math.max(8, basePct * 0.6);
  const shrink = cam.shrinkDuringZoom !== false && zoomWeight > 0.04;
  const sizePct = shrink ? basePct + (zoomPct - basePct) * Math.min(1, zoomWeight) : basePct;
  let size = (sizePct / 100) * W * pose.scale;

  let cx = pose.x * W;
  let cy = pose.y * H;

  // Softly pull away from the cursor so the selfie doesn't cover the pointer
  if (cam.avoidCursor !== false && cursor.active && cursor.opacity > 0.2) {
    const curX = cursor.x * W;
    const curY = cursor.y * H;
    const dx = cx - curX;
    const dy = cy - curY;
    const dist = Math.hypot(dx, dy);
    const minDist = size * 0.72;
    if (dist < minDist && dist > 1) {
      const push = (minDist - dist) * 0.55;
      cx += (dx / dist) * push;
      cy += (dy / dist) * push;
    } else if (dist <= 1) {
      cx += size * 0.35;
      cy -= size * 0.2;
    }
  }

  cx = Math.min(W - size * 0.35, Math.max(size * 0.35, cx));
  cy = Math.min(H - size * 0.35, Math.max(size * 0.35, cy));

  const roundness = cam.roundness ?? (cam.shape === "circle" ? 100 : cam.shape === "square" ? 0 : 40);
  const radius = (roundness / 100) * (size / 2);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(pose.rotate);
  if (cam.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.38)";
    // Cap blur — large shadows dominate GPU time on every frame.
    ctx.shadowBlur = Math.min(28, size * 0.14);
    ctx.shadowOffsetY = size * 0.05;
  }
  // Neutral plate under the video (not pure black — less “dead” while a frame catches up).
  ctx.fillStyle = cam.backgroundMode === "color" ? cam.backgroundColor : "#2a2f38";
  roundRect(ctx, -size / 2, -size / 2, size, size, radius);
  ctx.fill();
  ctx.shadowColor = "transparent";
  roundRect(ctx, -size / 2, -size / 2, size, size, radius);
  ctx.clip();

  const mask = input.media.cameraMask;
  const useMask = cam.backgroundMode !== "none" && !!mask && mask.width > 0;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  if (cam.backgroundMode === "color") {
    ctx.fillStyle = cam.backgroundColor;
    ctx.fillRect(-size / 2, -size / 2, size, size);
  } else if (cam.backgroundMode === "image" && input.media.cameraBackgroundImage) {
    const img = input.media.cameraBackgroundImage;
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else if (cam.backgroundMode === "blur" && useMask) {
    // Only paint the soft plate when we have a real person cutout on top.
    drawBlurredCameraBackdrop(ctx, video, sx, sy, side, size, !!cam.mirror);
  }

  ctx.save();
  if (useMask) {
    // cutoutFrame already baked mirror into the mask canvas — don't flip again
    ctx.drawImage(mask, -size / 2, -size / 2, size, size);
  } else {
    // Raw camera (also the fallback when segmentation isn't ready / rejected).
    if (cam.mirror) ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, side, side, -size / 2, -size / 2, size, size);
  }
  ctx.restore();

  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(pose.rotate);
  roundRect(ctx, -size / 2, -size / 2, size, size, radius);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.stroke();
  ctx.restore();
}

function drawCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, input: SceneInput) {
  const caps = input.project.captions;
  if (!caps?.enabled || !caps.burnIn || !caps.cues?.length) return;
  const cue = caps.cues.find((c) => input.time >= c.start && input.time <= c.end);
  if (!cue?.text.trim()) return;

  const raw = Math.round((caps.fontSize / 36) * Math.min(W, H) * 0.031);
  const fontSize = Math.max(13, Math.min(raw, Math.round(Math.min(W, H) * 0.04)));
  ctx.save();
  ctx.font = `500 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const maxW = W * 0.72;
  const lines = wrapText(ctx, cue.text.trim(), maxW);
  const lineH = fontSize * 1.28;
  const blockH = lines.length * lineH + fontSize * 0.35;
  const bx = W / 2;
  const by = H - Math.max(fontSize * 1.6, H * 0.055);
  const padX = fontSize * 0.65;
  const padY = fontSize * 0.4;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));

  roundRect(
    ctx,
    bx - textW / 2 - padX,
    by - blockH - padY * 0.35,
    textW + padX * 2,
    blockH + padY * 0.5,
    fontSize * 0.4,
  );
  ctx.fillStyle = "rgba(0,0,0,0.48)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  lines.forEach((line, i) => {
    ctx.fillText(line, bx, by - (lines.length - 1 - i) * lineH);
  });
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/**
 * Lay out the framed capture inside the stage.
 * Portrait stages reframe landscape recordings (side-crop + fill) so 9:16
 * doesn't collapse into a short landscape strip.
 */
function layoutFramedCapture(
  W: number,
  H: number,
  vAspect: number,
  paddingPct: number,
  radiusPct: number,
  chrome: WindowChrome,
) {
  const portrait = W / Math.max(1, H) < 0.92;
  const padScale = portrait ? 0.18 : 0.48;
  const pad = (paddingPct / 100) * Math.min(W, H) * padScale;
  const availW = Math.max(16, W - pad * 2);
  const availH = Math.max(16, H - pad * 2);
  const toolbarH = chromeHeight(chrome ?? "none", availH);

  let contentAspect = vAspect;
  /** Fraction of the already-cropped width kept after portrait side-crop (1 = none). */
  let keepW = 1;

  if (portrait && vAspect > 1.02) {
    const targetAspect = availW / Math.max(1, availH - toolbarH);
    // Fill the phone frame; never go skinnier than the stage content slot.
    contentAspect = Math.min(vAspect, Math.max(targetAspect, 9 / 16));
    keepW = Math.min(1, contentAspect / vAspect);
  }

  let dw = availW;
  let dh = dw / contentAspect + toolbarH;
  if (dh > availH) {
    dh = availH;
    dw = (dh - toolbarH) * contentAspect;
  }
  // Portrait: prefer filling the available slot once aspect is reframed.
  if (portrait) {
    const sx = availW / Math.max(1, dw);
    const sy = availH / Math.max(1, dh);
    const grow = Math.min(sx, sy);
    if (grow > 1.001) {
      dw *= grow;
      dh *= grow;
    }
  }

  const dx = (W - dw) / 2;
  // Slightly high in the frame — reads better for social / phone previews.
  const dy = portrait ? (H - dh) * 0.4 : (H - dh) / 2;
  // Radius from the full chrome box so outer corners match fill, clip, and stroke.
  const radius = (radiusPct / 100) * Math.min(dw, dh) * 0.5;

  return { dx, dy, dw, dh, toolbarH, radius, keepW, contentAspect, portrait };
}

/**
 * Single source of truth for what a frame looks like — the live preview and
 * the WebCodecs export both call this, so what you see is what you get.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  input: SceneInput,
) {
  const { project, media, time } = input;
  ctx.clearRect(0, 0, W, H);
  paintBackground(ctx, W, H, input);

  const video = media.screen;
  const crop = project.frame.crop;
  const topCut = Math.min(0.3, Math.max(0, project.frame.nativeChromeCrop ?? 0));
  const bottomCut = Math.min(0.15, Math.max(0, project.frame.taskbarCrop ?? 0));
  const contentCropH = crop.h * Math.max(0.4, 1 - topCut - bottomCut);
  const vw = (video?.videoWidth || input.take?.width || 1600) * crop.w;
  const vh = (video?.videoHeight || input.take?.height || 900) * contentCropH;
  const vAspect = vw / Math.max(1, vh);

  const chromeTheme: ChromeTheme = project.frame.chromeTheme ?? "dark";
  const chromeLight = chromeTheme === "light";
  const deviceFrame = getDeviceFrame(project.frame.deviceFrameId);
  const useDevice = deviceFrame.id !== "none";
  const deviceColor = getDeviceColor(deviceFrame, project.frame.deviceColorId);
  // Device shells replace window chrome.
  const effectiveChrome: WindowChrome = useDevice ? "none" : (project.frame.chrome ?? "none");

  let dx: number;
  let dy: number;
  let dw: number;
  let dh: number;
  let toolbarH: number;
  let radius: number;
  let keepW: number;
  let contentAspect: number;
  let deviceLayout: ReturnType<typeof layoutDeviceInStage> | null = null;

  if (useDevice) {
    deviceLayout = layoutDeviceInStage(
      W,
      H,
      vAspect,
      Math.min(22, Math.max(6, project.frame.padding)),
      deviceFrame,
      deviceColor,
    );
    dx = deviceLayout.sx;
    dy = deviceLayout.sy;
    dw = deviceLayout.sw;
    dh = deviceLayout.sh;
    toolbarH = 0;
    radius = deviceLayout.screenRadius;
    keepW = 1;
    contentAspect = vAspect;
  } else {
    const layout = layoutFramedCapture(
      W,
      H,
      vAspect,
      project.frame.padding,
      project.frame.radius,
      effectiveChrome,
    );
    dx = layout.dx;
    dy = layout.dy;
    dw = layout.dw;
    dh = layout.dh;
    toolbarH = layout.toolbarH;
    radius = layout.radius;
    keepW = layout.keepW;
    contentAspect = layout.contentAspect;
  }
  // Effective view after portrait side-crop (normalized video coords).
  const viewX = crop.x + crop.w * (1 - keepW) * 0.5;
  const viewW = crop.w * keepW;
  const viewY = crop.y + topCut * crop.h;
  const viewH = contentCropH;

  const cursor = input.cursorTrack?.get(time) ?? {
    x: 0.5,
    y: 0.5,
    speed: 0,
    down: false,
    active: false,
    opacity: 0,
    shape: "arrow" as const,
  };
  const stageA = W / Math.max(1, H);
  const zoomOpts = {
    enabled: project.zoom?.enabled !== false,
    stageAspect: stageA,
    contentAspect,
  };
  const zoomRaw = evalZoom(project.zooms, time, cursor, zoomOpts);
  // Map focus through crop + native chrome cut + portrait side-crop
  const zoom = {
    ...zoomRaw,
    x: (zoomRaw.x - viewX) / Math.max(1e-6, viewW),
    y: (zoomRaw.y - viewY) / Math.max(1e-6, viewH),
  };
  const motion =
    Math.max(
      zoomMotionStrength(project.zooms, time, project.zoom?.enabled !== false),
      cameraMotionStrength(project.moves, time),
      evalScenePose(project.effects, time).motion * 0.4,
    ) || 0;
  const scenePose = evalScenePose(project.effects, time);

  ctx.save();
  // Zoom around the focus point in the same space as the big cursor
  // (video content below the window chrome, not the full chrome box).
  const contentH = dh - toolbarH;
  const fx = dx + zoom.x * dw;
  const fy = dy + toolbarH + zoom.y * contentH;
  if (zoom.scale > 1.001) {
    ctx.translate(fx, fy);
    ctx.scale(zoom.scale, zoom.scale);
    ctx.translate(-fx, -fy);
  }

  // 3D mockup / spin (perspective fake on 2D canvas).
  // Camera trucks L/R then dollies in with tilt.
  if (scenePose.weight > 0.01) {
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    const cosY = Math.cos(scenePose.rotateY);
    const cosX = Math.cos(scenePose.rotateX);
    const skewX = Math.sin(scenePose.rotateY) * 0.24;
    const skewY = Math.sin(scenePose.rotateX) * -0.11;
    const lift = 1 + scenePose.lift;
    ctx.translate(scenePose.panX * dw * 0.55, scenePose.panY * dh * 0.45);
    ctx.translate(cx, cy);
    ctx.rotate(scenePose.rotateZ);
    ctx.transform(cosY * lift, skewY, skewX, cosX * lift, 0, 0);
    ctx.translate(-cx, -cy);
  }

  if (project.frame.shadow > 0 && !useDevice) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${(project.frame.shadow / 100) * (chromeLight ? 0.35 : 0.6)})`;
    ctx.shadowBlur = (project.frame.shadow / 100) * Math.min(W, H) * 0.16;
    ctx.shadowOffsetY = (project.frame.shadow / 100) * Math.min(W, H) * 0.045;
    roundRect(ctx, dx, dy, dw, dh, radius);
    ctx.fillStyle = chromeLight ? "rgba(255,255,255,0.98)" : "rgba(10,10,12,0.98)";
    ctx.fill();
    ctx.restore();
  }

  if (useDevice && deviceLayout) {
    paintDeviceShell(ctx, deviceLayout, project.frame.shadow);
  }

  const drawCaptureVideo = () => {
    if (!video || video.readyState < 2) return;
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    ctx.drawImage(
      video,
      viewX * sw,
      viewY * sh,
      viewW * sw,
      viewH * sh,
      dx,
      dy + toolbarH,
      dw,
      dh - toolbarH,
    );
  };

  const drawFramedCapture = () => {
    ctx.save();
    roundRect(ctx, dx, dy, dw, dh, radius);
    ctx.clip();
    ctx.fillStyle = useDevice ? "#000" : chromeLight ? "#f4f4f5" : "#101014";
    ctx.fillRect(dx, dy, dw, dh);
    drawCaptureVideo();
    ctx.restore();
  };

  // Subtle motion smear on ramps only — keep product demos crisp.
  if (motion > 0.14) {
    const ghosts = 1 + Math.round(motion * 1.5);
    const zoomed = zoom.scale > 1.001;
    const applyMotionOffset = (u: number) => {
      if (zoomed) {
        const o = u * motion * 0.022;
        ctx.translate(fx, fy);
        ctx.scale(1 + o, 1 + o);
        ctx.translate(-fx, -fy);
      } else {
        const smear = u * motion * Math.min(W, H) * 0.005;
        ctx.translate(smear, smear * 0.3);
      }
    };

    drawFramedCapture();

    for (let i = 0; i < ghosts; i++) {
      const u = (i / Math.max(1, ghosts - 1) - 0.5) * 2;
      if (Math.abs(u) < 0.12) continue;
      ctx.save();
      applyMotionOffset(u * 0.4);
      roundRect(ctx, dx, dy, dw, dh, radius);
      ctx.clip();
      ctx.globalAlpha = 0.05 + motion * 0.06;
      drawCaptureVideo();
      ctx.restore();
    }
  } else {
    drawFramedCapture();
  }

  if (toolbarH > 0) {
    if (effectiveChrome === "windows") {
      drawWindowsToolbar(
        ctx,
        dx,
        dy,
        dw,
        toolbarH,
        radius,
        project.frame.windowTitle,
        chromeTheme,
        dh,
      );
    } else if (effectiveChrome === "browser") {
      drawBrowserToolbar(
        ctx,
        dx,
        dy,
        dw,
        toolbarH,
        radius,
        project.frame.browserUrl || "example.com",
        project.frame.browserSiteName || "",
        chromeTheme,
        dh,
      );
    } else if (effectiveChrome === "mac") {
      drawMacToolbar(
        ctx,
        dx,
        dy,
        dw,
        toolbarH,
        radius,
        project.frame.windowTitle,
        chromeTheme,
        dh,
      );
    }
  }

  // Inset stroke (clip then double-width) so AA doesn't fray outside the fill.
  if (!useDevice && radius >= 0.75) {
    ctx.save();
    roundRect(ctx, dx, dy, dw, dh, radius);
    ctx.clip();
    roundRect(ctx, dx, dy, dw, dh, radius);
    ctx.strokeStyle = chromeLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  } else if (!useDevice) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    ctx.strokeStyle = chromeLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Specular glare sweep (Ctrl+5 / mockup accents) — screen blend so it never darkens
  if (scenePose.glare > 0.02) {
    ctx.save();
    roundRect(ctx, dx, dy, dw, dh, radius);
    ctx.clip();
    const band = Math.max(dw, dh) * 0.42;
    const gx = dx - band + scenePose.glareT * (dw + band * 2);
    const gy = dy - band * 0.2 + scenePose.glareT * (dh + band * 0.4);
    const grad = ctx.createLinearGradient(gx, gy, gx + band * 0.55, gy + band * 0.85);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.45, `rgba(255,255,255,${0.55 * scenePose.glare})`);
    grad.addColorStop(0.55, `rgba(255,250,240,${0.35 * scenePose.glare})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.fillRect(dx - 4, dy - 4, dw + 8, dh + 8);
    ctx.restore();
  }

  if (
    project.cursor.visible &&
    input.cursorTrack &&
    !input.cursorTrack.isEmpty &&
    cursor.active &&
    cursor.opacity > 0.02
  ) {
    const relX = (cursor.x - viewX) / Math.max(1e-6, viewW);
    const relY = (cursor.y - viewY) / Math.max(1e-6, viewH);
    if (relX >= -0.05 && relX <= 1.05 && relY >= -0.05 && relY <= 1.05) {
      const px = dx + relX * dw;
      const py = dy + toolbarH + relY * (dh - toolbarH);
      let ripple = 0;
      if (project.cursor.clickRipple) {
        for (const c of input.cursorTrack.clicks) {
          const age = time - c.t;
          if (age >= 0 && age < 0.45) ripple = Math.max(ripple, age / 0.45);
        }
      }
      const styleOverride = project.cursor.style ?? "auto";
      const drawShape =
        styleOverride === "auto" ? cursor.shape : (styleOverride as CursorShape);
      // Auto: enlarge thin system cursors (I-beam / cell) and keep screen size stable under zoom.
      const intelligent =
        styleOverride === "auto" || (project.zoom?.mode ?? "auto") === "auto";
      const shapeBoost = intelligent ? autoCursorShapeBoost(drawShape) : 1;
      const zoomComp = intelligent ? autoCursorZoomCompensation(zoom.scale) : 1;
      // 100% ≈ OS cursor + ~10% on a 1080p-tall stage (~27px tip size).
      const size =
        (project.cursor.size / 100) * Math.min(W, H) * 0.025 * shapeBoost * zoomComp;
      drawCursor(
        ctx,
        px,
        py,
        size,
        cursor.down,
        ripple,
        cursor.opacity,
        drawShape,
        styleOverride === "auto" ? cursor.iconId : undefined,
      );
    }
  }

  ctx.restore();

  // Cursor in normalized stage space for camera avoidance (approx content mapping)
  const stageCursor = {
    x: Math.min(
      1,
      Math.max(0, (((cursor.x - viewX) / Math.max(1e-6, viewW)) * dw + dx) / W),
    ),
    y: Math.min(
      1,
      Math.max(
        0,
        (((cursor.y - viewY) / Math.max(1e-6, viewH)) * contentH + dy + toolbarH) / H,
      ),
    ),
    active: cursor.active,
    opacity: cursor.opacity,
  };

  drawCamera(ctx, W, H, input, zoom.weight, stageCursor);
  drawCaptions(ctx, W, H, input);
  const ks = input.project.keystrokes;
  if (ks) drawKeystrokeOverlay(ctx, W, H, ks, input.time);
}
