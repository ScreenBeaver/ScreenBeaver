import type { CursorIconBitmap, CursorSample, RecordingTake } from "./types";

const DB_NAME = "sw-project-media-v1";
const STORE = "media";
const DB_VERSION = 1;

export type StoredProjectMedia = {
  id: string;
  updatedAt: number;
  sourceLabel: string;
  duration: number;
  width: number;
  height: number;
  screenBlob: Blob;
  cameraBlob?: Blob | null;
  micBlob?: Blob | null;
  cursor: CursorSample[];
  cursorIcons?: Record<string, CursorIconBitmap>;
  hasMicrophone?: boolean;
  hasSystemAudio?: boolean;
  captureSurface?: RecordingTake["captureSurface"];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export async function putProjectMedia(media: StoredProjectMedia): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(media);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to store project media"));
  });
  db.close();
}

export async function getProjectMedia(id: string): Promise<StoredProjectMedia | null> {
  try {
    const db = await openDb();
    const row = await new Promise<StoredProjectMedia | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as StoredProjectMedia | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("Failed to read project media"));
    });
    db.close();
    return row;
  } catch {
    return null;
  }
}

/** List all cached takes (newest first). Used to recover projects when mediaId is stale. */
export async function listProjectMedia(): Promise<StoredProjectMedia[]> {
  try {
    const db = await openDb();
    const rows = await new Promise<StoredProjectMedia[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as StoredProjectMedia[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("Failed to list project media"));
    });
    db.close();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function findProjectMediaMatch(opts: {
  mediaIds?: Array<string | null | undefined>;
  sourceLabel?: string;
  duration?: number;
  width?: number;
  height?: number;
}): Promise<StoredProjectMedia | null> {
  for (const id of opts.mediaIds ?? []) {
    if (!id) continue;
    const hit = await getProjectMedia(id);
    if (hit?.screenBlob) return hit;
  }

  const all = await listProjectMedia();
  if (!all.length) return null;

  const label = (opts.sourceLabel || "").trim().toLowerCase();
  const duration = opts.duration ?? 0;
  const width = opts.width ?? 0;
  const height = opts.height ?? 0;

  const scored = all
    .map((row) => {
      let score = 0;
      if (label && row.sourceLabel.trim().toLowerCase() === label) score += 4;
      if (duration > 0 && Math.abs(row.duration - duration) < 0.35) score += 3;
      if (width > 0 && row.width === width) score += 1;
      if (height > 0 && row.height === height) score += 1;
      return { row, score };
    })
    .filter((x) => x.score >= 5)
    .sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt);

  return scored[0]?.row ?? null;
}

export async function deleteProjectMedia(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete project media"));
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export async function blobFromUrl(url: string | null | undefined): Promise<Blob | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

export type TakeMediaBlobs = {
  screenBlob: Blob;
  cameraBlob: Blob | null;
  micBlob: Blob | null;
};

export async function takeMediaBlobs(take: RecordingTake): Promise<TakeMediaBlobs | null> {
  const screenBlob = await blobFromUrl(take.screenUrl);
  if (!screenBlob || screenBlob.size < 16) return null;
  const cameraBlob = await blobFromUrl(take.cameraUrl);
  const micBlob = await blobFromUrl(take.micUrl);
  return {
    screenBlob,
    cameraBlob,
    micBlob,
  };
}

/** Persist the current take's media under `mediaId` for later reopen. */
export async function persistTakeMedia(mediaId: string, take: RecordingTake): Promise<boolean> {
  const blobs = await takeMediaBlobs(take);
  if (!blobs) return false;
  await putProjectMedia({
    id: mediaId,
    updatedAt: Date.now(),
    sourceLabel: take.sourceLabel,
    duration: take.duration,
    width: take.width,
    height: take.height,
    screenBlob: blobs.screenBlob,
    cameraBlob: blobs.cameraBlob,
    micBlob: blobs.micBlob,
    cursor: take.cursor ?? [],
    cursorIcons: take.cursorIcons,
    hasMicrophone: take.hasMicrophone,
    hasSystemAudio: take.hasSystemAudio,
    captureSurface: take.captureSurface,
  });
  return true;
}

export function takeFromStoredMedia(media: StoredProjectMedia): RecordingTake {
  return {
    screenUrl: URL.createObjectURL(media.screenBlob),
    cameraUrl: media.cameraBlob ? URL.createObjectURL(media.cameraBlob) : null,
    micUrl: media.micBlob ? URL.createObjectURL(media.micBlob) : null,
    duration: media.duration,
    width: media.width,
    height: media.height,
    cursor: media.cursor ?? [],
    cursorIcons: media.cursorIcons,
    createdAt: media.updatedAt,
    sourceLabel: media.sourceLabel,
    hasMicrophone: media.hasMicrophone,
    hasSystemAudio: media.hasSystemAudio,
    captureSurface: media.captureSurface,
  };
}

export function takeFromMediaBlobs(
  meta: {
    sourceLabel: string;
    duration: number;
    width: number;
    height: number;
    cursor?: CursorSample[];
    cursorIcons?: Record<string, CursorIconBitmap>;
    hasMicrophone?: boolean;
    hasSystemAudio?: boolean;
    captureSurface?: RecordingTake["captureSurface"];
  },
  blobs: TakeMediaBlobs,
): RecordingTake {
  return {
    screenUrl: URL.createObjectURL(blobs.screenBlob),
    cameraUrl: blobs.cameraBlob ? URL.createObjectURL(blobs.cameraBlob) : null,
    micUrl: blobs.micBlob ? URL.createObjectURL(blobs.micBlob) : null,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    cursor: meta.cursor ?? [],
    cursorIcons: meta.cursorIcons,
    createdAt: Date.now(),
    sourceLabel: meta.sourceLabel,
    hasMicrophone: meta.hasMicrophone,
    hasSystemAudio: meta.hasSystemAudio,
    captureSurface: meta.captureSurface,
  };
}
