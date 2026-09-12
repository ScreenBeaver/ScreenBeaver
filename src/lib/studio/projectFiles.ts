import type { CursorSample, ProjectState, RecordingTake } from "./types";
import {
  findProjectMediaMatch,
  persistTakeMedia,
  putProjectMedia,
  takeFromMediaBlobs,
  takeFromStoredMedia,
  takeMediaBlobs,
  type TakeMediaBlobs,
} from "./projectMedia";

export const YASHARKA_EXT = ".yasharka";
export const YASHARKA_MIME = "application/x-yasharka+json";
export const YASHARKA_BINARY_MIME = "application/x-yasharka";

const MAGIC = new TextEncoder().encode("YASHARKA");
const BINARY_VERSION = 2;

export type YasharkaTakeMeta = {
  sourceLabel: string;
  duration: number;
  width: number;
  height: number;
  /** IndexedDB key for screen/camera/mic blobs on this machine. */
  mediaId?: string;
  /** True when screen video bytes are packed into this .yasharka file. */
  mediaEmbedded?: boolean;
  screenMime?: string;
  cameraMime?: string;
  micMime?: string;
  cursor?: CursorSample[];
  hasMicrophone?: boolean;
  hasSystemAudio?: boolean;
  captureSurface?: RecordingTake["captureSurface"];
};

export type YasharkaProjectFileV1 = {
  version: 1;
  fileType: "screen-weaver-project";
  savedAt: number;
  project: ProjectState;
  take?: YasharkaTakeMeta | null;
};

const LIB_KEY = "sw-project-library-v1";
const LIB_DB = "sw-project-library-files-v1";
const LIB_STORE = "files";

export type ProjectLibraryEntry = {
  id: string;
  name: string;
  updatedAt: number;
  sourceLabel?: string;
  duration?: number;
  /** Slim project snapshot (cursor stripped) for reopen; full file may live in IndexedDB. */
  file: YasharkaProjectFileV1;
};

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function safeProjectFileName(name: string) {
  const base = (name || "Untitled Project").replace(/[\\/:*?"<>|]+/g, "_").trim() || "Untitled Project";
  return base.toLowerCase().endsWith(YASHARKA_EXT) ? base : `${base}${YASHARKA_EXT}`;
}

export function serializeProjectFile(
  project: ProjectState,
  take?: RecordingTake | null,
  mediaId?: string | null,
  opts?: {
    mediaEmbedded?: boolean;
    screenMime?: string;
    cameraMime?: string;
    micMime?: string;
  },
): YasharkaProjectFileV1 {
  return {
    version: 1,
    fileType: "screen-weaver-project",
    savedAt: Date.now(),
    project,
    take: take
      ? {
          sourceLabel: take.sourceLabel,
          duration: take.duration,
          width: take.width,
          height: take.height,
          mediaId: mediaId || undefined,
          mediaEmbedded: opts?.mediaEmbedded || undefined,
          screenMime: opts?.screenMime,
          cameraMime: opts?.cameraMime,
          micMime: opts?.micMime,
          cursor: take.cursor,
          hasMicrophone: take.hasMicrophone,
          hasSystemAudio: take.hasSystemAudio,
          captureSurface: take.captureSurface,
        }
      : null,
  };
}

export function deserializeProjectFile(input: unknown): YasharkaProjectFileV1 {
  if (!input || typeof input !== "object") throw new Error("Invalid project file");
  const v = input as Partial<YasharkaProjectFileV1>;
  if (v.version !== 1) throw new Error("Unsupported project file version");
  if (v.fileType !== "screen-weaver-project") throw new Error("Not a Screen Beaver project file");
  if (!v.project) throw new Error("Missing project payload");
  return v as YasharkaProjectFileV1;
}

function isBinaryYasharka(buf: ArrayBuffer): boolean {
  if (buf.byteLength < MAGIC.length + 8) return false;
  const head = new Uint8Array(buf, 0, MAGIC.length);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC[i]) return false;
  }
  return true;
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeU32(out: number[], value: number) {
  out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

async function blobToBytes(blob: Blob | null | undefined): Promise<Uint8Array<ArrayBuffer>> {
  if (!blob || blob.size <= 0) return new Uint8Array();
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function copyBytes(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

/** Pack project JSON + media into a portable .yasharka blob. */
export async function packYasharkaFile(
  file: YasharkaProjectFileV1,
  blobs?: TakeMediaBlobs | null,
): Promise<Blob> {
  if (!blobs?.screenBlob) {
    return new Blob([JSON.stringify(file, null, 2)], { type: YASHARKA_MIME });
  }

  const jsonBytes = copyBytes(new TextEncoder().encode(JSON.stringify(file)));
  const screen = await blobToBytes(blobs.screenBlob);
  const camera = await blobToBytes(blobs.cameraBlob);
  const mic = await blobToBytes(blobs.micBlob);

  const header: number[] = [];
  for (const b of MAGIC) header.push(b);
  writeU32(header, BINARY_VERSION);
  writeU32(header, jsonBytes.length);

  const parts: BlobPart[] = [
    new Uint8Array(header),
    jsonBytes,
    new Uint8Array(u32Bytes(screen.length)),
    screen,
    new Uint8Array(u32Bytes(camera.length)),
    camera,
    new Uint8Array(u32Bytes(mic.length)),
    mic,
  ];
  return new Blob(parts, { type: YASHARKA_BINARY_MIME });
}

function u32Bytes(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

export type UnpackedYasharka = {
  file: YasharkaProjectFileV1;
  blobs: TakeMediaBlobs | null;
};

export async function unpackYasharkaBuffer(buf: ArrayBuffer): Promise<UnpackedYasharka> {
  // Hard cap — packing full takes into RAM twice can OOM the WebView on import.
  const MAX_BYTES = 1_500_000_000; // ~1.5 GB
  if (buf.byteLength > MAX_BYTES) {
    throw new Error("Project file is too large to open in one go");
  }

  if (!isBinaryYasharka(buf)) {
    const text = new TextDecoder().decode(buf);
    return { file: deserializeProjectFile(JSON.parse(text)), blobs: null };
  }

  const view = new DataView(buf);
  let offset = MAGIC.length;
  const formatVersion = readU32(view, offset);
  offset += 4;
  if (formatVersion !== BINARY_VERSION) {
    throw new Error(`Unsupported .yasharka format (${formatVersion})`);
  }
  const jsonLen = readU32(view, offset);
  offset += 4;
  if (jsonLen <= 0 || offset + jsonLen > buf.byteLength) {
    throw new Error("Corrupt .yasharka project file");
  }
  const jsonBytes = new Uint8Array(buf, offset, jsonLen);
  offset += jsonLen;
  const file = deserializeProjectFile(JSON.parse(new TextDecoder().decode(jsonBytes)));

  const readPart = (): Uint8Array => {
    if (offset + 4 > buf.byteLength) return new Uint8Array();
    const len = readU32(view, offset);
    offset += 4;
    if (len <= 0) return new Uint8Array();
    if (offset + len > buf.byteLength) throw new Error("Corrupt .yasharka media section");
    const slice = new Uint8Array(buf, offset, len);
    offset += len;
    return slice;
  };

  const screenBytes = readPart();
  const cameraBytes = readPart();
  const micBytes = readPart();
  if (screenBytes.length < 16) {
    return { file, blobs: null };
  }

  const screenMime = file.take?.screenMime || "video/webm";
  const cameraMime = file.take?.cameraMime || "video/webm";
  const micMime = file.take?.micMime || "audio/webm";

  return {
    file,
    blobs: {
      screenBlob: new Blob([copyBytes(screenBytes)], { type: screenMime }),
      cameraBlob: cameraBytes.length
        ? new Blob([copyBytes(cameraBytes)], { type: cameraMime })
        : null,
      micBlob: micBytes.length ? new Blob([copyBytes(micBytes)], { type: micMime }) : null,
    },
  };
}

export async function readProjectFile(file: File): Promise<YasharkaProjectFileV1> {
  const unpacked = await unpackYasharkaBuffer(await file.arrayBuffer());
  // Stash blobs on the file object for applyProjectFile callers that only have JSON today.
  (file as File & { __yasharkaBlobs?: TakeMediaBlobs | null }).__yasharkaBlobs = unpacked.blobs;
  return unpacked.file;
}

export async function readProjectFileFull(file: File): Promise<UnpackedYasharka> {
  return unpackYasharkaBuffer(await file.arrayBuffer());
}

export function downloadProjectFile(file: YasharkaProjectFileV1, filename: string, blob?: Blob) {
  const name = safeProjectFileName(filename);
  const out =
    blob ??
    new Blob([JSON.stringify(file, null, 2)], {
      type: YASHARKA_MIME,
    });
  const url = URL.createObjectURL(out);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.type = out.type || YASHARKA_MIME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

type SavePicker = {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: string | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/** Opens a real Save As dialog with Screen Beaver Project (.yasharka) as the type. */
export async function saveProjectAsYasharka(
  file: YasharkaProjectFileV1,
  suggestedName: string,
  packed?: Blob,
): Promise<{ ok: boolean; cancelled?: boolean; method: "picker" | "download" }> {
  const name = safeProjectFileName(suggestedName);
  const out =
    packed ??
    new Blob([JSON.stringify(file, null, 2)], {
      type: YASHARKA_MIME,
    });
  const win = window as unknown as SavePicker;

  if (typeof win.showSaveFilePicker === "function") {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: "Screen Beaver Project",
            accept: {
              [YASHARKA_MIME]: [YASHARKA_EXT],
              [YASHARKA_BINARY_MIME]: [YASHARKA_EXT],
              "application/octet-stream": [YASHARKA_EXT],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(out);
      await writable.close();
      return { ok: true, method: "picker" };
    } catch (err) {
      const nameErr = err instanceof Error ? err.name : "";
      if (nameErr === "AbortError") return { ok: false, cancelled: true, method: "picker" };
      // Fall through to download if picker fails (e.g. insecure context)
    }
  }

  downloadProjectFile(file, name, out);
  return { ok: true, method: "download" };
}

/**
 * Persist take media (if any), then build a project file ready to write.
 * Returns the file + whether video bytes were stored for reopen.
 */
export async function prepareProjectSave(
  project: ProjectState,
  take: RecordingTake | null,
  mediaId: string,
): Promise<{
  file: YasharkaProjectFileV1;
  mediaSaved: boolean;
  packed: Blob;
  blobs: TakeMediaBlobs | null;
}> {
  let blobs: TakeMediaBlobs | null = null;
  let mediaSaved = false;

  if (take?.screenUrl) {
    try {
      blobs = await takeMediaBlobs(take);
      if (blobs) {
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
        mediaSaved = true;
      }
    } catch {
      mediaSaved = false;
      blobs = null;
    }
  }

  const file = serializeProjectFile(project, take, mediaSaved ? mediaId : null, {
    mediaEmbedded: Boolean(blobs?.screenBlob),
    screenMime: blobs?.screenBlob.type || undefined,
    cameraMime: blobs?.cameraBlob?.type || undefined,
    micMime: blobs?.micBlob?.type || undefined,
  });
  const packed = await packYasharkaFile(file, blobs);
  return { file, mediaSaved, packed, blobs };
}

export type ApplyProjectResult = {
  hasVideo: boolean;
  mediaId?: string;
  sourceLabel?: string;
};

export type PendingRelink = {
  sourceLabel?: string;
  cursor: CursorSample[];
  mediaId?: string;
};

let pendingRelink: PendingRelink | null = null;

export function getPendingRelink(): PendingRelink | null {
  return pendingRelink;
}

export function clearPendingRelink() {
  pendingRelink = null;
}

async function cacheTake(mediaId: string, take: RecordingTake) {
  try {
    await persistTakeMedia(mediaId, take);
  } catch {
    /* ignore cache failures */
  }
}

/** Load project settings and restore the recording from the file and/or IndexedDB. */
export async function applyProjectFile(
  file: YasharkaProjectFileV1,
  actions: {
    replaceProject: (project: ProjectState) => void;
    setTake: (take: RecordingTake | null) => void;
  },
  opts?: {
    fallbackMediaId?: string | null;
    embeddedBlobs?: TakeMediaBlobs | null;
  },
): Promise<ApplyProjectResult> {
  actions.replaceProject(file.project);
  const meta = file.take ?? null;
  const mediaId = meta?.mediaId || opts?.fallbackMediaId || undefined;

  // 1) Media packed inside the .yasharka file (portable)
  if (opts?.embeddedBlobs?.screenBlob && meta) {
    try {
      const take = takeFromMediaBlobs(
        {
          sourceLabel: meta.sourceLabel,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          cursor: meta.cursor,
          hasMicrophone: meta.hasMicrophone,
          hasSystemAudio: meta.hasSystemAudio,
          captureSurface: meta.captureSurface,
        },
        opts.embeddedBlobs,
      );
      actions.setTake(take);
      pendingRelink = null;
      if (mediaId) void cacheTake(mediaId, take);
      return { hasVideo: true, mediaId, sourceLabel: take.sourceLabel };
    } catch {
      /* fall through to IndexedDB / relink */
    }
  }

  // 2) IndexedDB by mediaId / library id / fuzzy match
  const stored = await findProjectMediaMatch({
    mediaIds: [meta?.mediaId, opts?.fallbackMediaId],
    sourceLabel: meta?.sourceLabel,
    duration: meta?.duration,
    width: meta?.width,
    height: meta?.height,
  });

  if (stored?.screenBlob) {
    const take = takeFromStoredMedia(stored);
    if (meta?.cursor?.length && (!take.cursor || take.cursor.length < 2)) {
      take.cursor = meta.cursor;
    }
    actions.setTake(take);
    pendingRelink = null;
    const resolvedId = mediaId || stored.id;
    if (resolvedId && resolvedId !== stored.id) {
      void cacheTake(resolvedId, take);
    }
    return { hasVideo: true, mediaId: resolvedId, sourceLabel: take.sourceLabel };
  }

  actions.setTake(null);
  pendingRelink = {
    sourceLabel: meta?.sourceLabel,
    cursor: meta?.cursor ?? [],
    mediaId,
  };
  return {
    hasVideo: false,
    mediaId,
    sourceLabel: meta?.sourceLabel,
  };
}

function getLibrary(): ProjectLibraryEntry[] {
  if (typeof window === "undefined") return [];
  return safeJsonParse<ProjectLibraryEntry[]>(window.localStorage.getItem(LIB_KEY)) ?? [];
}

function setLibrary(entries: ProjectLibraryEntry[]) {
  if (typeof window === "undefined") return;
  const slim = entries.map(slimLibraryEntry);
  try {
    window.localStorage.setItem(LIB_KEY, JSON.stringify(slim));
  } catch {
    // Quota: drop oldest until it fits, keep the newest 12.
    const trimmed = slim.slice(0, 12).map((e) => ({
      ...e,
      file: {
        ...e.file,
        take: e.file.take
          ? {
              ...e.file.take,
              cursor: [],
            }
          : null,
      },
    }));
    try {
      window.localStorage.setItem(LIB_KEY, JSON.stringify(trimmed));
    } catch {
      /* last resort: keep index rows; full reopen uses IndexedDB when available */
      const meta = trimmed.map(({ id, name, updatedAt, sourceLabel, duration, file }) => ({
        id,
        name,
        updatedAt,
        sourceLabel,
        duration,
        file: slimProjectFile({
          ...file,
          project: {
            ...file.project,
            zooms: [],
            moves: [],
            effects: [],
            sounds: [],
            captions: { ...file.project.captions, cues: [] },
            keystrokes: { ...file.project.keystrokes, cues: [] },
          },
        }),
      }));
      try {
        window.localStorage.setItem(LIB_KEY, JSON.stringify(meta));
      } catch {
        /* ignore */
      }
    }
  }
}

/** Strip heavy cursor samples so localStorage can hold recent projects. */
export function slimProjectFile(file: YasharkaProjectFileV1): YasharkaProjectFileV1 {
  return {
    ...file,
    take: file.take
      ? {
          ...file.take,
          cursor: [],
        }
      : file.take,
  };
}

function slimLibraryEntry(entry: ProjectLibraryEntry): ProjectLibraryEntry {
  return {
    ...entry,
    name: entry.name || entry.file.project?.name || "Untitled Project",
    sourceLabel: entry.sourceLabel ?? entry.file.take?.sourceLabel,
    duration: entry.duration ?? entry.file.take?.duration,
    file: slimProjectFile(entry.file),
  };
}

function openLibraryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(LIB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Library DB open failed"));
  });
}

async function putLibraryFile(id: string, file: YasharkaProjectFileV1): Promise<void> {
  try {
    const db = await openLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LIB_STORE, "readwrite");
      tx.objectStore(LIB_STORE).put({ id, updatedAt: Date.now(), file });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to store library file"));
    });
    db.close();
  } catch {
    /* localStorage slim snapshot is the fallback */
  }
}

async function getLibraryFile(id: string): Promise<YasharkaProjectFileV1 | null> {
  try {
    const db = await openLibraryDb();
    const row = await new Promise<{ file: YasharkaProjectFileV1 } | undefined>((resolve, reject) => {
      const tx = db.transaction(LIB_STORE, "readonly");
      const req = tx.objectStore(LIB_STORE).get(id);
      req.onsuccess = () => resolve(req.result as { file: YasharkaProjectFileV1 } | undefined);
      req.onerror = () => reject(req.error ?? new Error("Failed to read library file"));
    });
    db.close();
    return row?.file ?? null;
  } catch {
    return null;
  }
}

async function deleteLibraryFile(id: string): Promise<void> {
  try {
    const db = await openLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LIB_STORE, "readwrite");
      tx.objectStore(LIB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete library file"));
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export function listProjectLibraryEntries(): ProjectLibraryEntry[] {
  const entries = getLibrary().map(slimLibraryEntry);
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertProjectLibraryEntry(entry: ProjectLibraryEntry) {
  const next = slimLibraryEntry({
    ...entry,
    updatedAt: entry.updatedAt || Date.now(),
  });
  const entries = getLibrary();
  const idx = entries.findIndex((e) => e.id === next.id);
  if (idx >= 0) entries[idx] = next;
  else entries.unshift(next);
  setLibrary(entries);
  void putLibraryFile(next.id, entry.file);
}

/** Resolve the best project payload for reopen (IndexedDB full file, else slim entry). */
export async function resolveProjectLibraryFile(
  entry: ProjectLibraryEntry,
): Promise<YasharkaProjectFileV1> {
  const full = await getLibraryFile(entry.id);
  return full ?? entry.file;
}

export function removeProjectLibraryEntry(id: string) {
  const entries = getLibrary().filter((e) => e.id !== id);
  setLibrary(entries);
  void deleteLibraryFile(id);
}

export function getProjectLibraryEntry(id: string): ProjectLibraryEntry | null {
  const entries = getLibrary();
  return entries.find((e) => e.id === id) ?? null;
}

export function newLibraryId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p_${Date.now()}`;
}
