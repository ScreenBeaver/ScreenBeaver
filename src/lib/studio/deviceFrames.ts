/**
 * Device frame catalog — phone/tablet shells drawn in the compositor.
 * Colors are marketing finishes; model matching is best-effort from ADB labels.
 */

export type DeviceBezelStyle = "flat" | "island" | "punch" | "teardrop" | "tablet";

export type DeviceFrameDef = {
  id: string;
  name: string;
  brand: string;
  kind: "phone" | "tablet";
  /** Outer body aspect (W/H), including bezels. */
  bodyAspect: number;
  /** Insets as fraction of outer body size (content screen). */
  inset: { left: number; right: number; top: number; bottom: number };
  /** Screen corner radius relative to screen short side (0..0.5). */
  screenRadius: number;
  /** Outer body corner radius relative to body short side. */
  bodyRadius: number;
  bezel: DeviceBezelStyle;
  /** Punch/island horizontal position in screen (0..1). */
  cameraX?: number;
  /** Draw iOS-style home indicator bar. */
  homeIndicator?: boolean;
  /** Default color id from `colors`. */
  defaultColor: string;
  colors: DeviceColorDef[];
  /** Substrings matched against manufacturer+model (lowercase). */
  match?: string[];
};

export type DeviceColorDef = {
  id: string;
  name: string;
  /** Body fill */
  body: string;
  /** Slightly darker rim / edge */
  rim: string;
  /** Side buttons */
  button: string;
  /** Island / speaker accent */
  accent: string;
};

const NEUTRALS: DeviceColorDef[] = [
  { id: "black", name: "Black", body: "#1a1a1c", rim: "#0c0c0e", button: "#2a2a2e", accent: "#111114" },
  { id: "graphite", name: "Graphite", body: "#2c2c30", rim: "#161618", button: "#3a3a40", accent: "#1c1c20" },
  { id: "silver", name: "Silver", body: "#d8d8dc", rim: "#a8a8b0", button: "#c0c0c6", accent: "#e8e8ec" },
  { id: "white", name: "White", body: "#f2f2f4", rim: "#c8c8ce", button: "#e0e0e4", accent: "#ffffff" },
];

const PIXEL_COLORS: DeviceColorDef[] = [
  ...NEUTRALS,
  { id: "porcelain", name: "Porcelain", body: "#ebe6df", rim: "#c9c2b8", button: "#ddd6cc", accent: "#f5f1eb" },
  { id: "bay", name: "Bay", body: "#7a9eab", rim: "#5a7a86", button: "#8aaeb8", accent: "#6a8e9b" },
  { id: "obsidian", name: "Obsidian", body: "#1e1f22", rim: "#0e0f12", button: "#2e2f34", accent: "#141518" },
  { id: "hazel", name: "Hazel", body: "#8b7355", rim: "#6a5640", button: "#9a8466", accent: "#7a6348" },
];

const SAMSUNG_COLORS: DeviceColorDef[] = [
  ...NEUTRALS,
  { id: "violet", name: "Violet", body: "#5b4b7a", rim: "#3d3254", button: "#6d5a8e", accent: "#4a3c64" },
  { id: "cream", name: "Cream", body: "#e8dfd0", rim: "#c4b8a4", button: "#d8cfc0", accent: "#f2ebe0" },
  { id: "green", name: "Green", body: "#3d5c4a", rim: "#2a4034", button: "#4e705c", accent: "#334d3e" },
  { id: "yellow", name: "Yellow", body: "#e6c84a", rim: "#b89a2e", button: "#f0d45e", accent: "#d4b63a" },
];

const XIAOMI_COLORS: DeviceColorDef[] = [
  ...NEUTRALS,
  { id: "blue", name: "Blue", body: "#3b6ea5", rim: "#2a4f78", button: "#4a80b8", accent: "#2f5a88" },
  { id: "mint", name: "Mint", body: "#9ec9b8", rim: "#6f9a8a", button: "#b0d6c6", accent: "#88b8a6" },
  { id: "gold", name: "Gold", body: "#c9a86c", rim: "#9a7e48", button: "#d8b87c", accent: "#b89858" },
];

const IPHONE_COLORS: DeviceColorDef[] = [
  ...NEUTRALS.filter((c) => c.id !== "graphite"),
  { id: "natural", name: "Natural Titanium", body: "#8a857c", rim: "#6a665e", button: "#9a958c", accent: "#7a766e" },
  { id: "blue-ti", name: "Blue Titanium", body: "#3a4558", rim: "#262e3c", button: "#4a5568", accent: "#303848" },
  { id: "black-ti", name: "Black Titanium", body: "#2a2a2c", rim: "#141416", button: "#3a3a3e", accent: "#1c1c1e" },
  { id: "white-ti", name: "White Titanium", body: "#e4e2dc", rim: "#b8b6b0", button: "#f0eee8", accent: "#f8f6f0" },
  { id: "pink", name: "Pink", body: "#e8b4c4", rim: "#c48a9c", button: "#f0c4d2", accent: "#d8a0b2" },
];

export const DEVICE_FRAMES: DeviceFrameDef[] = [
  {
    id: "none",
    name: "No device frame",
    brand: "",
    kind: "phone",
    bodyAspect: 9 / 19.5,
    inset: { left: 0, right: 0, top: 0, bottom: 0 },
    screenRadius: 0.06,
    bodyRadius: 0.06,
    bezel: "flat",
    defaultColor: "black",
    colors: NEUTRALS,
  },
  {
    id: "android-generic",
    name: "Android Phone",
    brand: "Android",
    kind: "phone",
    bodyAspect: 9 / 19.5,
    inset: { left: 0.028, right: 0.028, top: 0.022, bottom: 0.028 },
    screenRadius: 0.08,
    bodyRadius: 0.12,
    bezel: "punch",
    defaultColor: "black",
    colors: NEUTRALS,
    match: ["android"],
  },
  {
    id: "xiaomi-phone",
    name: "Xiaomi / Redmi",
    brand: "Xiaomi",
    kind: "phone",
    bodyAspect: 9 / 20,
    inset: { left: 0.024, right: 0.024, top: 0.018, bottom: 0.024 },
    screenRadius: 0.09,
    bodyRadius: 0.13,
    bezel: "punch",
    cameraX: 0.5,
    defaultColor: "black",
    colors: XIAOMI_COLORS,
    match: ["xiaomi", "redmi", "poco", "220333qbi", "220333"],
  },
  {
    id: "pixel-8",
    name: "Pixel 8 / 8 Pro",
    brand: "Google",
    kind: "phone",
    bodyAspect: 9 / 19.5,
    inset: { left: 0.028, right: 0.028, top: 0.022, bottom: 0.028 },
    screenRadius: 0.095,
    bodyRadius: 0.145,
    bezel: "punch",
    cameraX: 0.5,
    defaultColor: "obsidian",
    colors: PIXEL_COLORS,
    match: ["pixel 8", "pixel8", "gkws6", "google pixel"],
  },
  {
    id: "pixel-9",
    name: "Pixel 9 / 9 Pro",
    brand: "Google",
    kind: "phone",
    bodyAspect: 9 / 19.6,
    inset: { left: 0.028, right: 0.028, top: 0.022, bottom: 0.028 },
    screenRadius: 0.105,
    bodyRadius: 0.155,
    bezel: "punch",
    cameraX: 0.5,
    defaultColor: "obsidian",
    colors: PIXEL_COLORS,
    match: ["pixel 9", "pixel9"],
  },
  {
    id: "samsung-s24",
    name: "Galaxy S24 / S25",
    brand: "Samsung",
    kind: "phone",
    bodyAspect: 9 / 19.3,
    inset: { left: 0.018, right: 0.018, top: 0.014, bottom: 0.018 },
    screenRadius: 0.11,
    bodyRadius: 0.14,
    bezel: "punch",
    cameraX: 0.5,
    defaultColor: "black",
    colors: SAMSUNG_COLORS,
    match: ["samsung", "sm-s9", "sm-s8", "galaxy", "sm-a"],
  },
  {
    id: "oneplus",
    name: "OnePlus / Oppo",
    brand: "OnePlus",
    kind: "phone",
    bodyAspect: 9 / 19.8,
    inset: { left: 0.025, right: 0.025, top: 0.018, bottom: 0.025 },
    screenRadius: 0.095,
    bodyRadius: 0.135,
    bezel: "punch",
    cameraX: 0.5,
    defaultColor: "black",
    colors: [
      ...NEUTRALS,
      { id: "emerald", name: "Emerald", body: "#1f6b4a", rim: "#134530", button: "#2a8058", accent: "#185a3e" },
    ],
    match: ["oneplus", "oppo", "realme", "cph"],
  },
  {
    id: "iphone-15",
    name: "iPhone 15 / 15 Pro",
    brand: "Apple",
    kind: "phone",
    bodyAspect: 9 / 19.5,
    inset: { left: 0.03, right: 0.03, top: 0.026, bottom: 0.03 },
    screenRadius: 0.125,
    bodyRadius: 0.165,
    bezel: "island",
    cameraX: 0.5,
    homeIndicator: true,
    defaultColor: "black-ti",
    colors: IPHONE_COLORS,
    match: ["iphone 15", "iphone15"],
  },
  {
    id: "iphone-16",
    name: "iPhone 16 / 16 Pro",
    brand: "Apple",
    kind: "phone",
    bodyAspect: 9 / 19.6,
    inset: { left: 0.03, right: 0.03, top: 0.026, bottom: 0.03 },
    screenRadius: 0.125,
    bodyRadius: 0.165,
    bezel: "island",
    cameraX: 0.5,
    homeIndicator: true,
    defaultColor: "black-ti",
    colors: IPHONE_COLORS,
    match: ["iphone 16", "iphone16", "iphone"],
  },
  {
    id: "android-tablet",
    name: "Android Tablet",
    brand: "Android",
    kind: "tablet",
    bodyAspect: 10 / 16,
    inset: { left: 0.035, right: 0.035, top: 0.03, bottom: 0.035 },
    screenRadius: 0.04,
    bodyRadius: 0.06,
    bezel: "tablet",
    defaultColor: "silver",
    colors: NEUTRALS,
    match: ["tablet", "tab ", "sm-x", "sm-t"],
  },
];

export function getDeviceFrame(id: string | undefined | null): DeviceFrameDef {
  return DEVICE_FRAMES.find((f) => f.id === id) ?? DEVICE_FRAMES[0]!;
}

export function getDeviceColor(frame: DeviceFrameDef, colorId: string | undefined | null): DeviceColorDef {
  return frame.colors.find((c) => c.id === colorId) ?? frame.colors.find((c) => c.id === frame.defaultColor) ?? frame.colors[0]!;
}

/** Pick the best frame from ADB manufacturer/model / source label. */
export function matchDeviceFrame(hint: string): { frameId: string; colorId: string } {
  const h = hint.toLowerCase();
  // Prefer specific matches over generic (skip "none").
  let best: DeviceFrameDef | null = null;
  let bestScore = 0;
  for (const f of DEVICE_FRAMES) {
    if (f.id === "none" || !f.match) continue;
    for (const m of f.match) {
      if (h.includes(m)) {
        const score = m.length;
        if (score > bestScore) {
          bestScore = score;
          best = f;
        }
      }
    }
  }
  if (!best) {
    if (h.includes("android") || h.includes("xiaomi") || h.includes("pixel") || h.includes("samsung")) {
      best = getDeviceFrame("android-generic");
    } else {
      best = getDeviceFrame("android-generic");
    }
  }
  return { frameId: best.id, colorId: best.defaultColor };
}

export type DeviceLayout = {
  /** Outer device body */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  bodyRadius: number;
  /** Inner screen where video is drawn */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  screenRadius: number;
  frame: DeviceFrameDef;
  color: DeviceColorDef;
};

/**
 * Fit a device body into the stage with padding, then compute screen inset.
 * `contentAspect` is the video aspect (W/H).
 */
export function layoutDeviceInStage(
  W: number,
  H: number,
  contentAspect: number,
  paddingPct: number,
  frame: DeviceFrameDef,
  color: DeviceColorDef,
): DeviceLayout {
  const pad = (paddingPct / 100) * Math.min(W, H) * 0.22;
  const availW = Math.max(16, W - pad * 2);
  const availH = Math.max(16, H - pad * 2);

  const inset = frame.inset;
  const insetW = 1 - inset.left - inset.right;
  const insetH = 1 - inset.top - inset.bottom;
  // Body aspect chosen so the *screen* matches the video aspect.
  const screenAspect = contentAspect;
  const bodyAspect = (screenAspect * insetW) / Math.max(0.2, insetH);

  let bw = availW;
  let bh = bw / bodyAspect;
  if (bh > availH) {
    bh = availH;
    bw = bh * bodyAspect;
  }
  // Prefer filling the stage for portrait demos.
  const grow = Math.min(availW / bw, availH / bh);
  if (grow > 1.001) {
    bw *= grow;
    bh *= grow;
  }

  const bx = (W - bw) / 2;
  const by = (H - bh) * 0.42;
  const sx = bx + bw * inset.left;
  const sy = by + bh * inset.top;
  const sw = bw * insetW;
  const sh = bh * insetH;

  return {
    bx,
    by,
    bw,
    bh,
    bodyRadius: frame.bodyRadius * Math.min(bw, bh),
    sx,
    sy,
    sw,
    sh,
    screenRadius: frame.screenRadius * Math.min(sw, sh),
    frame,
    color,
  };
}

/** Draw the physical shell around an already-reserved screen rect. */
export function paintDeviceShell(
  ctx: CanvasRenderingContext2D,
  layout: DeviceLayout,
  shadow: number,
) {
  const { bx, by, bw, bh, bodyRadius, sx, sy, sw, sh, screenRadius, frame, color } = layout;

  if (shadow > 0) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0," + String((shadow / 100) * 0.58) + ")";
    ctx.shadowBlur = (shadow / 100) * Math.min(bw, bh) * 0.24;
    ctx.shadowOffsetY = (shadow / 100) * Math.min(bw, bh) * 0.07;
    round(ctx, bx, by, bw, bh, bodyRadius);
    ctx.fillStyle = color.body;
    ctx.fill();
    ctx.restore();
  }

  round(ctx, bx, by, bw, bh, bodyRadius);
  const bodyGrad = ctx.createLinearGradient(bx, by, bx + bw, by);
  bodyGrad.addColorStop(0, color.rim);
  bodyGrad.addColorStop(0.12, color.body);
  bodyGrad.addColorStop(0.88, color.body);
  bodyGrad.addColorStop(1, color.rim);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  round(ctx, bx, by, bw, bh, bodyRadius);
  ctx.strokeStyle = color.rim;
  ctx.lineWidth = Math.max(1.25, Math.min(bw, bh) * 0.007);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx + bw * 0.18, by + 1);
  ctx.lineTo(bx + bw * 0.32, by + 1);
  ctx.moveTo(bx + bw * 0.68, by + 1);
  ctx.lineTo(bx + bw * 0.82, by + 1);
  ctx.stroke();

  const btnW = Math.max(2.5, bw * 0.014);
  const btnR = btnW * 0.45;
  ctx.fillStyle = color.button;
  round(ctx, bx - btnW * 0.65, by + bh * 0.2, btnW, bh * 0.055, btnR);
  ctx.fill();
  round(ctx, bx - btnW * 0.65, by + bh * 0.275, btnW, bh * 0.1, btnR);
  ctx.fill();
  round(ctx, bx + bw - btnW * 0.35, by + bh * 0.26, btnW, bh * 0.09, btnR);
  ctx.fill();
  if (frame.bezel === 'island') {
    round(ctx, bx - btnW * 0.55, by + bh * 0.42, btnW * 0.85, bh * 0.045, btnR);
    ctx.fill();
  }

  const bezelPad = Math.min(sw, sh) * 0.01;
  round(ctx, sx - bezelPad, sy - bezelPad, sw + bezelPad * 2, sh + bezelPad * 2, screenRadius + bezelPad);
  ctx.fillStyle = '#050506';
  ctx.fill();

  round(ctx, sx, sy, sw, sh, screenRadius);
  ctx.fillStyle = '#000';
  ctx.fill();

  const camX = sx + sw * (frame.cameraX ?? 0.5);

  if (frame.bezel === 'island') {
    const iw = sw * 0.36;
    const ih = Math.max(10, sh * 0.032);
    const ix = sx + (sw - iw) / 2;
    const iy = sy + sh * 0.015;
    round(ctx, ix, iy, iw, ih, ih / 2);
    ctx.fillStyle = '#0a0a0c';
    ctx.fill();
    const lensR = ih * 0.28;
    ctx.beginPath();
    ctx.arc(ix + iw * 0.28, iy + ih / 2, lensR, 0, Math.PI * 2);
    ctx.arc(ix + iw * 0.42, iy + ih / 2, lensR * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = '#1a2230';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ix + iw * 0.72, iy + ih / 2, lensR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#152018';
    ctx.fill();
  } else if (frame.bezel === 'punch' || frame.bezel === 'teardrop') {
    const r = Math.min(sw, sh) * (frame.bezel === 'teardrop' ? 0.017 : 0.015);
    const cy = sy + sh * 0.032;
    ctx.beginPath();
    ctx.arc(camX, cy, r * 1.15, 0, Math.PI * 2);
    ctx.fillStyle = '#0c0c0e';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(camX, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color.accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(camX, cy, r * 0.42, 0, Math.PI * 2);
    const lens = ctx.createRadialGradient(camX - r * 0.15, cy - r * 0.15, 0, camX, cy, r * 0.42);
    lens.addColorStop(0, '#4a7ab0');
    lens.addColorStop(1, '#1a3048');
    ctx.fillStyle = lens;
    ctx.fill();
  }

  if (frame.homeIndicator) {
    const barW = sw * 0.36;
    const barH = Math.max(3, sh * 0.006);
    const barX = sx + (sw - barW) / 2;
    const barY = sy + sh - sh * 0.022 - barH;
    round(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
  }

  ctx.save();
  round(ctx, bx, by, bw, bh, bodyRadius);
  ctx.clip();
  const gloss = ctx.createLinearGradient(bx, by, bx, by + bh * 0.12);
  gloss.addColorStop(0, 'rgba(255,255,255,0.14)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(bx, by, bw, bh * 0.12);
  ctx.restore();
}

function round(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
