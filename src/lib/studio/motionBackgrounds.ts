/**
 * Lag-free animated motion backgrounds.
 * Soft blob / ribbon layers via canvas gradients (no per-pixel ImageData).
 */

export interface MotionBackground {
  id: string;
  label: string;
  previewCss: string;
}

export const MOTION_BACKGROUNDS: MotionBackground[] = [
  {
    id: "ribbon-field",
    label: "Ribbon Field",
    previewCss: "linear-gradient(38deg, #FFFFFF 18%, #78B8F9 57%, #5667FF 60%, #4D2FF9 100%)",
  },
  {
    id: "aurora",
    label: "Aurora",
    previewCss: "linear-gradient(125deg, #0f172a 0%, #22d3ee 45%, #a78bfa 75%, #0f172a 100%)",
  },
  {
    id: "sunset-mesh",
    label: "Sunset Mesh",
    previewCss: "linear-gradient(140deg, #ff7a59 0%, #ff5c8a 40%, #7c3aed 100%)",
  },
  {
    id: "linear-glow",
    label: "Linear Glow",
    previewCss: "linear-gradient(135deg, #5e6ad2 0%, #8b5cf6 50%, #11101c 100%)",
  },
];

export function getMotionBackground(id: string | undefined): MotionBackground {
  return MOTION_BACKGROUNDS.find((m) => m.id === id) ?? MOTION_BACKGROUNDS[0]!;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex: string, a: number) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Soft animated orb — cheap radial fill. */
function paintOrb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number,
) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.55, rgba(color, alpha * 0.45));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function paintRibbonField(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const ph = t;
  // Zero at t=0: cos(x)-1 style offsets
  const sway = Math.sin(ph * 0.6) - Math.sin(0); // 0 at ph=0
  const wave = (Math.sin(ph * 1.2 + 20.75) - Math.sin(20.75)) * 0.5;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);

  const angle = ((38 + sway * 8) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const len = Math.hypot(W, H);
  const cx = W / 2 + wave * W * 0.04;
  const cy = H / 2;
  const grad = ctx.createLinearGradient(
    cx - cos * len * 0.55,
    cy - sin * len * 0.55,
    cx + cos * len * 0.55,
    cy + sin * len * 0.55,
  );
  grad.addColorStop(0.0, "#FFFFFF");
  grad.addColorStop(0.18, "#FFFFFF");
  grad.addColorStop(0.57, "#78B8F9");
  grad.addColorStop(0.6, "#5667FF");
  grad.addColorStop(1, "#4D2FF9");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Soft living ribbons (blurred orbs) — no pixel loops
  paintOrb(ctx, W * (0.25 + sway * 0.03), H * (0.35 + wave * 0.05), Math.max(W, H) * 0.42, "#78B8F9", 0.35);
  paintOrb(ctx, W * (0.7 - wave * 0.04), H * (0.55 + sway * 0.04), Math.max(W, H) * 0.38, "#5667FF", 0.4);
  paintOrb(ctx, W * (0.55 + sway * 0.02), H * (0.8 - wave * 0.03), Math.max(W, H) * 0.35, "#4D2FF9", 0.32);
}

function paintAurora(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const ph = t;
  const a = Math.sin(ph * 0.7) - Math.sin(0);
  const b = Math.cos(ph * 0.5) - 1;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  paintOrb(ctx, W * (0.3 + a * 0.05), H * 0.4, Math.max(W, H) * 0.5, "#22d3ee", 0.45);
  paintOrb(ctx, W * (0.7 + b * 0.04), H * 0.55, Math.max(W, H) * 0.48, "#a78bfa", 0.4);
  paintOrb(ctx, W * 0.5, H * (0.7 + a * 0.03), Math.max(W, H) * 0.4, "#38bdf8", 0.28);
}

function paintSunsetMesh(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const ph = t;
  const a = Math.sin(ph * 0.55) - Math.sin(0);
  ctx.fillStyle = "#1a0b16";
  ctx.fillRect(0, 0, W, H);
  paintOrb(ctx, W * (0.35 + a * 0.04), H * 0.35, Math.max(W, H) * 0.55, "#ff7a59", 0.5);
  paintOrb(ctx, W * 0.65, H * (0.5 - a * 0.03), Math.max(W, H) * 0.5, "#ff5c8a", 0.42);
  paintOrb(ctx, W * 0.45, H * 0.75, Math.max(W, H) * 0.45, "#7c3aed", 0.4);
}

function paintLinearGlow(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const ph = t;
  const a = Math.sin(ph * 0.45) - Math.sin(0);
  ctx.fillStyle = "#11101c";
  ctx.fillRect(0, 0, W, H);
  paintOrb(ctx, W * (0.4 + a * 0.03), H * 0.4, Math.max(W, H) * 0.55, "#5e6ad2", 0.5);
  paintOrb(ctx, W * 0.65, H * (0.6 - a * 0.04), Math.max(W, H) * 0.48, "#8b5cf6", 0.4);
  paintOrb(ctx, W * 0.3, H * 0.7, Math.max(W, H) * 0.35, "#a78bfa", 0.25);
}

export function paintMotionBackground(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  id: string | undefined,
  t: number,
) {
  ctx.save();
  const motion = getMotionBackground(id);
  switch (motion.id) {
    case "aurora":
      paintAurora(ctx, W, H, t);
      break;
    case "sunset-mesh":
      paintSunsetMesh(ctx, W, H, t);
      break;
    case "linear-glow":
      paintLinearGlow(ctx, W, H, t);
      break;
    case "ribbon-field":
    default:
      paintRibbonField(ctx, W, H, t);
      break;
  }
  ctx.restore();
}
