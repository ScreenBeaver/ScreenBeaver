/** Classify imported files by MIME and extension (Windows often leaves File.type empty). */

export type MediaKind = "video" | "audio" | "image" | "project" | "unknown";

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "m4v", "avi", "wmv", "mpg", "mpeg"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "wma"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function classifyMediaFile(file: { name: string; type?: string }): MediaKind {
  const t = (file.type || "").toLowerCase();
  const name = file.name || "";
  const ext = extOf(name);

  if (ext === "yasharka" || t.includes("yasharka")) return "project";
  if (t.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
  if (t.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (t.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  // Loose JSON project exports
  if (t.includes("json") && name.toLowerCase().endsWith(".json")) return "project";
  return "unknown";
}

export function isVideoFile(file: { name: string; type?: string }): boolean {
  return classifyMediaFile(file) === "video";
}
