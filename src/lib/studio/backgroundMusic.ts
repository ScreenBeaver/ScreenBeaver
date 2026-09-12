/**
 * Soft background bed for product demos (Openverse CC tracks via MCP).
 */

import type { BackgroundMusicSettings } from "./types";

export const DEFAULT_MUSIC: BackgroundMusicSettings = {
  enabled: false,
  url: null,
  title: "",
  creator: "",
  license: "",
  volume: 0.16,
  loop: true,
};

export type OpenverseAudioHit = {
  id: string;
  title: string;
  creator: string;
  url: string;
  duration: number | null;
  license: string;
  source: string;
};

type OpenverseResult = {
  id?: string;
  title?: string;
  creator?: string;
  url?: string;
  duration?: number | null;
  license?: string;
  license_version?: string;
  source?: string;
  foreign_landing_url?: string;
};

/**
 * Search Creative Commons audio on Openverse (no API key required).
 * Prefer instrumental / corporate beds for product demos.
 */
export async function searchOpenverseAudio(
  query: string,
  limit = 8,
): Promise<OpenverseAudioHit[]> {
  const q = query.trim() || "upbeat corporate instrumental";
  const pageSize = Math.min(20, Math.max(1, limit));
  const params = new URLSearchParams({
    q,
    page_size: String(pageSize),
    unstable__include_sensitive_results: "false",
  });
  const res = await fetch(`https://api.openverse.org/v1/audio/?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Openverse search failed (${res.status})`);
  }
  const json = (await res.json()) as { results?: OpenverseResult[] };
  const out: OpenverseAudioHit[] = [];
  for (const r of json.results ?? []) {
    if (!r.url || !r.id) continue;
    out.push({
      id: r.id,
      title: (r.title || "Untitled").trim(),
      creator: (r.creator || "Unknown").trim(),
      url: r.url,
      duration: typeof r.duration === "number" ? r.duration : null,
      license: [r.license, r.license_version].filter(Boolean).join(" ").trim() || "cc",
      source: r.source || "openverse",
    });
  }
  return out;
}

/** Download remote audio → blob URL (works in desktop when CORS allows). */
export async function cacheMusicAsBlobUrl(remoteUrl: string): Promise<string> {
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Music download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const type = res.headers.get("content-type") || "audio/mpeg";
  return URL.createObjectURL(new Blob([buf], { type }));
}

export function pickDemoMusicQuery(productName?: string): string {
  const base = "upbeat corporate instrumental background";
  if (!productName?.trim()) return base;
  return `${base} ${productName.trim().slice(0, 40)}`;
}
