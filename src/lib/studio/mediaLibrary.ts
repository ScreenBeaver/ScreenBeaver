/** Session media library for the home sidebar. */

import { classifyMediaFile, type MediaKind } from "./mediaKind";

export type { MediaKind };

export type MediaItem = {
  id: string;
  name: string;
  kind: MediaKind;
  size: number;
  addedAt: number;
  /** Object URL for preview / drag — only valid in this session. */
  url?: string;
  /** Project library id when kind === project */
  projectId?: string;
};

const META_KEY = "sw-media-library-meta-v1";
const blobs = new Map<string, string>();

function loadMeta(): MediaItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as MediaItem[];
    return list.map((m) => ({ ...m, url: blobs.get(m.id) }));
  } catch {
    return [];
  }
}

function saveMeta(items: MediaItem[]) {
  if (typeof window === "undefined") return;
  try {
    const slim = items.map(({ id, name, kind, size, addedAt, projectId }) => ({
      id,
      name,
      kind,
      size,
      addedAt,
      projectId,
    }));
    window.localStorage.setItem(META_KEY, JSON.stringify(slim));
  } catch {
    /* quota / private mode — keep in-memory only */
  }
}

export function listMediaItems(): MediaItem[] {
  return loadMeta().sort((a, b) => b.addedAt - a.addedAt);
}

export function addMediaFile(file: File): MediaItem {
  const kind = classifyMediaFile(file);
  const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = URL.createObjectURL(file);
  blobs.set(id, url);
  const item: MediaItem = {
    id,
    name: file.name,
    kind: kind === "unknown" ? "video" : kind,
    size: file.size,
    addedAt: Date.now(),
    url,
  };
  const next = [item, ...loadMeta().filter((m) => m.id !== id)];
  saveMeta(next);
  return item;
}

export function removeMediaItem(id: string) {
  const url = blobs.get(id);
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    blobs.delete(id);
  }
  saveMeta(loadMeta().filter((m) => m.id !== id));
}

export function getMediaBlobUrl(id: string): string | undefined {
  return blobs.get(id);
}
