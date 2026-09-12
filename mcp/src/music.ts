/**
 * Openverse CC audio search + local cache for Screen Beaver background beds.
 * No API key — anonymous Openverse is enough for demo picks.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENVERSE = "https://api.openverse.org/v1/audio/";

export type MusicHit = {
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
};

function mcpPackageRoot(): string {
  // mcp/src or mcp/dist → mcp/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function musicCacheDir(): string {
  const monorepoBg = path.join(mcpPackageRoot(), "..", "public", "sounds", "bg");
  if (existsSync(path.join(mcpPackageRoot(), "..", "public", "sounds"))) {
    return monorepoBg;
  }
  return path.join(homedir(), ".screen-beaver", "music-cache");
}

export async function searchOpenverseMusic(
  query: string,
  limit = 8,
): Promise<MusicHit[]> {
  const q = query.trim() || "upbeat corporate instrumental";
  const pageSize = Math.min(20, Math.max(1, limit));
  const params = new URLSearchParams({
    q,
    page_size: String(pageSize),
    unstable__include_sensitive_results: "false",
  });
  const res = await fetch(`${OPENVERSE}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Openverse search failed (${res.status})`);
  const json = (await res.json()) as { results?: OpenverseResult[] };
  const out: MusicHit[] = [];
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

/** Download remote audio into cache and return a studio-usable URL + absolute path. */
export async function cacheMusicLocally(hit: MusicHit): Promise<{
  localUrl: string;
  filePath: string;
}> {
  const res = await fetch(hit.url);
  if (!res.ok) throw new Error(`Music download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash("sha1").update(hit.id).digest("hex").slice(0, 12);
  const ext = hit.url.toLowerCase().includes(".ogg")
    ? "ogg"
    : hit.url.toLowerCase().includes(".wav")
      ? "wav"
      : "mp3";
  const dir = musicCacheDir();
  await mkdir(dir, { recursive: true });
  const fileName = `${hash}.${ext}`;
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, buf);
  const monorepoSounds = existsSync(
    path.join(mcpPackageRoot(), "..", "public", "sounds"),
  );
  const localUrl = monorepoSounds
    ? `/sounds/bg/${fileName}`
    : pathToFileUrl(filePath);
  return { localUrl, filePath };
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/")
    ? `file://${normalized}`
    : `file:///${normalized}`;
}

export function defaultMusicQuery(productName?: string): string {
  const base = "upbeat corporate instrumental background";
  if (!productName?.trim()) return base;
  return `${base} soft`;
}

/** Prefer mid-length instrumentals (avoid very short one-shots). */
export function pickBestMusicHit(hits: MusicHit[]): MusicHit | null {
  if (!hits.length) return null;
  const scored = hits.map((h) => {
    let score = 0;
    const d = h.duration ?? 90;
    if (d >= 45 && d <= 240) score += 3;
    else if (d >= 20) score += 1;
    const t = `${h.title} ${h.creator}`.toLowerCase();
    if (/instrumental|corporate|ambient|lofi|lo-fi|background|bed/.test(t)) score += 2;
    if (/vocal|rap|metal|scream/.test(t)) score -= 2;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.h;
}
