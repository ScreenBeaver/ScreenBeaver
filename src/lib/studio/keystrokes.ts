/**
 * Keyboard shortcut overlays — recorded during capture, burned into preview/export.
 */

import type { KeystrokeCue, KeystrokeSettings } from "./types";

export const DEFAULT_KEYSTROKE_DURATION = 1.35;

export function newKeystrokeId(t: number) {
  return `key-${Math.round(t * 1000)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** True when this press is a “shortcut” worth showing (not plain typing). */
export function isShortcutEvent(opts: {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
  code: string;
}): boolean {
  const { ctrl, meta, alt, shift, key, code } = opts;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta" || key === "OS") {
    return false;
  }
  // Function keys, Escape always show.
  if (/^F([1-9]|1[0-2])$/.test(key) || code.startsWith("F") && /^F\d+$/.test(code)) return true;
  if (key === "Escape" || code === "Escape") return true;
  // Modifier chords (Ctrl/Cmd/Alt/Win + something). Shift alone + letter is typing.
  const mod = ctrl || meta || alt;
  if (!mod) {
    // Shift+Space / arrows without mods — skip arrows alone (nav noise).
    if (shift && (key === " " || code === "Space")) return true;
    return false;
  }
  // Ctrl/Cmd+letter/digit/symbol
  return true;
}

export function formatShortcutParts(opts: {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
  code: string;
}): string[] {
  const parts: string[] = [];
  if (opts.ctrl) parts.push("Ctrl");
  if (opts.meta) parts.push("⌘");
  if (opts.alt) parts.push("Alt");
  if (opts.shift) parts.push("Shift");

  let main = opts.key;
  if (opts.code.startsWith("Key") && opts.code.length === 4) {
    main = opts.code.slice(3);
  } else if (opts.code.startsWith("Digit") && opts.code.length === 6) {
    main = opts.code.slice(5);
  } else if (opts.code.startsWith("Numpad") && opts.code.length > 6) {
    main = opts.code.slice(6);
  } else if (opts.code === "Space" || opts.key === " ") {
    main = "Space";
  } else if (opts.key === "Escape") {
    main = "Esc";
  } else if (opts.key === "ArrowUp") main = "↑";
  else if (opts.key === "ArrowDown") main = "↓";
  else if (opts.key === "ArrowLeft") main = "←";
  else if (opts.key === "ArrowRight") main = "→";
  else if (opts.key === "Enter") main = "Enter";
  else if (opts.key === "Backspace") main = "⌫";
  else if (opts.key === "Tab") main = "Tab";
  else if (opts.key === "Delete") main = "Del";
  else if (opts.key.length === 1) main = opts.key.toUpperCase();
  else if (opts.key.startsWith("F") && opts.key.length <= 3) main = opts.key;

  // Avoid duplicating Shift in "Shift + @" etc. when key already shifted — still OK.
  if (!parts.includes(main)) parts.push(main);
  return parts;
}

export function formatShortcutLabel(parts: string[]): string {
  return parts.join(" + ");
}

export function cueFromShortcutEvent(
  t: number,
  opts: {
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
    code: string;
  },
): KeystrokeCue | null {
  if (!isShortcutEvent(opts)) return null;
  const keys = formatShortcutParts(opts);
  if (keys.length === 0) return null;
  return {
    id: newKeystrokeId(t),
    time: Math.max(0, t),
    duration: DEFAULT_KEYSTROKE_DURATION,
    label: formatShortcutLabel(keys),
    keys,
  };
}

export function cueFromNativeKeystroke(
  t: number,
  label: string,
  keys: string[],
): KeystrokeCue {
  const parts = keys.length ? keys : label.split(" + ").map((s) => s.trim()).filter(Boolean);
  return {
    id: newKeystrokeId(t),
    time: Math.max(0, t),
    duration: DEFAULT_KEYSTROKE_DURATION,
    label: label || formatShortcutLabel(parts),
    keys: parts,
  };
}

/** Dedupe rapid repeats of the same chord. */
export function mergeKeystrokeCues(existing: KeystrokeCue[], next: KeystrokeCue[]): KeystrokeCue[] {
  const out = [...existing];
  for (const c of next) {
    const dup = out.find(
      (o) => o.label === c.label && Math.abs(o.time - c.time) < 0.35,
    );
    if (dup) {
      dup.duration = Math.max(dup.duration, c.duration);
      continue;
    }
    out.push({ ...c });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function activeKeystroke(
  cues: KeystrokeCue[],
  t: number,
): { cue: KeystrokeCue; opacity: number } | null {
  let best: { cue: KeystrokeCue; opacity: number } | null = null;
  for (const cue of cues) {
    if (t < cue.time || t > cue.time + cue.duration) continue;
    const local = t - cue.time;
    const fadeIn = 0.12;
    const fadeOut = 0.28;
    let opacity = 1;
    if (local < fadeIn) opacity = local / fadeIn;
    else if (local > cue.duration - fadeOut) {
      opacity = Math.max(0, (cue.duration - local) / fadeOut);
    }
    if (!best || cue.time >= best.cue.time) best = { cue, opacity };
  }
  return best;
}

export function drawKeystrokeOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  settings: KeystrokeSettings,
  t: number,
) {
  if (!settings.enabled || !settings.burnIn || !settings.cues?.length) return;
  const active = activeKeystroke(settings.cues, t);
  if (!active || active.opacity < 0.02) return;

  const { cue, opacity } = active;
  const scale = (settings.size ?? 100) / 100;
  const keyH = Math.max(22, Math.min(W, H) * 0.042 * scale);
  const padX = keyH * 0.42;
  const gap = keyH * 0.18;
  const font = `600 ${Math.round(keyH * 0.48)}px ui-sans-serif, system-ui, Segoe UI, sans-serif`;
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const parts = cue.keys.length ? cue.keys : cue.label.split(" + ");
  const widths = parts.map((p) => Math.max(keyH * 1.1, ctx.measureText(p).width + padX * 2));
  const totalW = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, parts.length - 1);
  const totalH = keyH;

  let x = (W - totalW) / 2;
  let y = H * 0.88 - totalH / 2;
  const pos = settings.position ?? "bottom";
  if (pos === "bottom-left") {
    x = W * 0.06;
    y = H * 0.88 - totalH / 2;
  } else if (pos === "bottom-right") {
    x = W - totalW - W * 0.06;
    y = H * 0.88 - totalH / 2;
  } else if (pos === "center") {
    y = H * 0.5 - totalH / 2;
  }

  ctx.globalAlpha = opacity;

  // Soft backdrop pill
  const bgPad = keyH * 0.28;
  roundPath(ctx, x - bgPad, y - bgPad, totalW + bgPad * 2, totalH + bgPad * 2, (totalH + bgPad * 2) / 2);
  ctx.fillStyle = "rgba(8,10,14,0.55)";
  ctx.fill();

  let cx = x;
  for (let i = 0; i < parts.length; i++) {
    const w = widths[i]!;
    const r = Math.min(10, keyH * 0.28);
    // Keycap
    roundPath(ctx, cx, y, w, keyH, r);
    const g = ctx.createLinearGradient(cx, y, cx, y + keyH);
    g.addColorStop(0, "#2a2e36");
    g.addColorStop(1, "#16181e");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // Top highlight
    roundPath(ctx, cx + 1, y + 1, w - 2, keyH * 0.38, r * 0.8);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();

    ctx.fillStyle = "#f4f5f7";
    ctx.fillText(parts[i]!, cx + w / 2, y + keyH / 2 + 0.5);
    cx += w + gap;
  }
  ctx.restore();
}

function roundPath(
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
