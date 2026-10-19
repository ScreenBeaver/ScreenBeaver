import type { Wallpaper } from "./types";

/**
 * Built-in backdrops: photo wallpapers first, then a short gradient set.
 */
export const WALLPAPERS: Wallpaper[] = [
  // Aesthetic photos
  {
    id: "aesthetic-laptop",
    label: "Laptop garden",
    imageUrl: "/wallpapers/blog-aesthetic-background-laptop.png",
  },
  {
    id: "aesthetic-cd",
    label: "CD hibiscus",
    imageUrl: "/wallpapers/blog-aesthetic-cd-hibiscus.png",
  },
  {
    id: "aesthetic-chess",
    label: "Chess garden",
    imageUrl: "/wallpapers/blog-aesthetic-chess-garden.png",
  },
  {
    id: "aesthetic-export",
    label: "Export meadow",
    imageUrl: "/wallpapers/blog-aesthetic-export-meadow.png",
  },
  {
    id: "aesthetic-light-ring",
    label: "Light ring",
    imageUrl: "/wallpapers/blog-aesthetic-light-ring.png",
  },
  {
    id: "aesthetic-mcp",
    label: "MCP nodes",
    imageUrl: "/wallpapers/blog-aesthetic-mcp-nodes.png",
  },
  {
    id: "aesthetic-meadow-mac",
    label: "Meadow Mac",
    imageUrl: "/wallpapers/blog-aesthetic-meadow-mac.png",
  },
  {
    id: "aesthetic-phone",
    label: "Phone hibiscus",
    imageUrl: "/wallpapers/blog-aesthetic-phone-hibiscus.png",
  },
  {
    id: "aesthetic-pointer",
    label: "Pointer flowers",
    imageUrl: "/wallpapers/blog-aesthetic-pointer-flowers.png",
  },
  {
    id: "aesthetic-portal",
    label: "Portal walk",
    imageUrl: "/wallpapers/blog-aesthetic-portal-walk.png",
  },
  {
    id: "aesthetic-sfx",
    label: "SFX garden",
    imageUrl: "/wallpapers/blog-aesthetic-sfx-garden.png",
  },
  {
    id: "aesthetic-sky-hoop",
    label: "Sky hoop",
    imageUrl: "/wallpapers/blog-aesthetic-sky-hoop.png",
  },
  {
    id: "aesthetic-timeline",
    label: "Timeline meadow",
    imageUrl: "/wallpapers/blog-aesthetic-timeline-meadow.png",
  },
  {
    id: "aesthetic-windows",
    label: "Windows garden",
    imageUrl: "/wallpapers/blog-aesthetic-windows-garden.png",
  },
  // Gradients (kept short)
  { id: "arctic", angle: 150, stops: ["#e0f2fe", "#93c5fd", "#60a5fa"] },
  { id: "sky", angle: 145, stops: ["#a1c4fd", "#c2e9fb"] },
  { id: "sunbeam", angle: 135, stops: ["#ff9a3c", "#ff5f6d", "#c644fc"] },
  { id: "midnight", angle: 150, stops: ["#0f172a", "#1e3a8a", "#0b1120"] },
  { id: "slate", angle: 145, stops: ["#334155", "#0f172a"] },
  { id: "dawn", angle: 120, stops: ["#fff7ed", "#fdba74", "#fb923c"] },
  { id: "mint", angle: 140, stops: ["#00c9a7", "#92fe9d"] },
  { id: "carbon", angle: 155, stops: ["#161616", "#262626", "#525252"] },
  { id: "linear", angle: 135, stops: ["#5e6ad2", "#8b5cf6", "#1b1b2e"] },
  { id: "notion", angle: 145, stops: ["#f7f6f3", "#e8e4dc", "#d4cfc4"] },
];

export function getWallpaper(id: string): Wallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]!;
}

/** Resolve `/public` paths for Vite web + Tauri (`base: "./"`). */
export function publicAssetUrl(absPath: string): string {
  const clean = absPath.replace(/^\//, "");
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  return `${base}${clean}`;
}

export function wallpaperImageUrl(id: string): string | null {
  const raw = getWallpaper(id).imageUrl ?? null;
  return raw ? publicAssetUrl(raw) : null;
}

/** URL to load for canvas paint / export (built-in photo or custom upload). */
export function resolveBackgroundImageUrl(bg: {
  mode: string;
  wallpaperId: string;
  imageUrl: string | null;
}): string | null {
  if (bg.mode === "image") return bg.imageUrl;
  if (bg.mode === "wallpaper" || bg.mode === "motion") {
    return wallpaperImageUrl(bg.wallpaperId) ?? bg.imageUrl;
  }
  return null;
}

/** CSS representation, used for the swatch grid only. */
export function wallpaperCss(w: Wallpaper): string {
  if (w.imageUrl) return `url(${publicAssetUrl(w.imageUrl)})`;
  const angle = w.angle ?? 135;
  const stops = w.stops ?? ["#334155", "#0f172a"];
  return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}

/** Lightweight swatch for the inspector grid — never point at full-res photos. */
export function wallpaperSwatchCss(w: Wallpaper, thumbDataUrl?: string | null): string {
  if (w.imageUrl) {
    if (thumbDataUrl) return `url(${thumbDataUrl})`;
    // Prefer gradient placeholder until thumb loads (avoids broken absolute /wallpapers in Tauri).
    return "linear-gradient(145deg, #1e293b, #0f172a 55%, #334155)";
  }
  return wallpaperCss(w);
}

const THUMB_MAX = 96;
const thumbCache = new Map<string, string>();
/** Serialize full-image decodes so import → studio open doesn't OOM. */
let thumbQueue: Promise<void> = Promise.resolve();

/**
 * Build a tiny JPEG swatch for inspector tiles.
 * Full wallpapers stay for Stage/export only — loading all 14 at once crashed Store certification.
 */
export function ensureWallpaperThumb(imageUrl: string): Promise<string | null> {
  const loadUrl =
    imageUrl.startsWith("data:") || imageUrl.startsWith("blob:") || imageUrl.startsWith("./") || imageUrl.startsWith("http")
      ? imageUrl
      : publicAssetUrl(imageUrl);

  const cached = thumbCache.get(loadUrl);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    thumbQueue = thumbQueue
      .then(async () => {
        const hit = thumbCache.get(loadUrl);
        if (hit) {
          resolve(hit);
          return;
        }
        try {
          const img = new Image();
          img.decoding = "async";
          await new Promise<void>((res, rej) => {
            img.onload = () => res();
            img.onerror = () => rej(new Error("thumb failed"));
            img.src = loadUrl;
          });
          const scale = THUMB_MAX / Math.max(img.naturalWidth || img.width || 1, 1);
          const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
          const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          thumbCache.set(loadUrl, dataUrl);
          img.src = "";
          resolve(dataUrl);
        } catch {
          resolve(null);
        }
      })
      .catch(() => resolve(null));
  });
}
