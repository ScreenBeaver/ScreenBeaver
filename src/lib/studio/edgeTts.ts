/**
 * Edge TTS helpers.
 * Prefer Tauri / local desktop bridge (Rust msedge-tts) — browser WebSockets
 * often fail with NoAudioReceived because Microsoft blocks non-Edge clients.
 */

import { EdgeTTS, listVoices, type Voice } from "edge-tts-universal/browser";
import { isTauri } from "./nativeBridge";

export type EdgeVoiceOption = {
  shortName: string;
  locale: string;
  gender: string;
  friendlyName: string;
};

export type EdgeLangOption = {
  code: string;
  label: string;
};

const BRIDGE = "http://127.0.0.1:17355";

let voicesCache: EdgeVoiceOption[] | null = null;

function toOption(v: Voice): EdgeVoiceOption {
  const shortName = v.ShortName || "";
  const locale = v.Locale || shortName.split("-").slice(0, 2).join("-") || "en-US";
  const gender = v.Gender || "";
  const friendly =
    v.FriendlyName || shortName.replace(/Neural$/i, "").replace(/-/g, " ");
  return { shortName, locale, gender, friendlyName: friendly };
}

function displayLocaleName(locale: string): string {
  try {
    const dn = new Intl.DisplayNames(undefined, { type: "language" });
    const lang = locale.split("-")[0];
    const language = dn.of(lang) || lang;
    try {
      const rn = new Intl.DisplayNames(undefined, { type: "region" });
      const region = locale.includes("-") ? rn.of(locale.split("-")[1]) : null;
      return region ? `${language} (${region})` : language;
    } catch {
      return language;
    }
  } catch {
    return locale;
  }
}

function normalizeVoiceDto(raw: Record<string, unknown>): EdgeVoiceOption | null {
  const shortName = String(raw.shortName ?? raw.ShortName ?? "").trim();
  if (!shortName) return null;
  return {
    shortName,
    locale: String(raw.locale ?? raw.Locale ?? shortName.split("-").slice(0, 2).join("-")),
    gender: String(raw.gender ?? raw.Gender ?? ""),
    friendlyName: String(
      raw.friendlyName ?? raw.FriendlyName ?? shortName.replace(/Neural$/i, ""),
    ),
  };
}

async function listVoicesViaTauri(): Promise<EdgeVoiceOption[] | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<Record<string, unknown>[]>("edge_tts_list_voices");
    return raw.map(normalizeVoiceDto).filter((v): v is EdgeVoiceOption => !!v);
  } catch (err) {
    console.warn("Tauri edge_tts_list_voices failed", err);
    return null;
  }
}

async function listVoicesViaBridge(): Promise<EdgeVoiceOption[] | null> {
  try {
    const res = await fetch(`${BRIDGE}/voices`, { method: "GET" });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(raw)) return null;
    return raw.map(normalizeVoiceDto).filter((v): v is EdgeVoiceOption => !!v);
  } catch {
    return null;
  }
}

async function listVoicesViaBrowser(): Promise<EdgeVoiceOption[]> {
  const raw = await listVoices();
  return raw
    .map(toOption)
    .filter((v) => v.shortName && /Neural/i.test(v.shortName));
}

export async function fetchEdgeVoices(): Promise<EdgeVoiceOption[]> {
  if (voicesCache) return voicesCache;

  const fromNative = (await listVoicesViaTauri()) || (await listVoicesViaBridge());
  const list = fromNative?.length ? fromNative : await listVoicesViaBrowser();

  voicesCache = list.sort((a, b) => {
    const loc = a.locale.localeCompare(b.locale);
    if (loc !== 0) return loc;
    return a.friendlyName.localeCompare(b.friendlyName);
  });
  return voicesCache;
}

/** Every locale Edge TTS ships, for language dropdowns. */
export function localesFromVoices(voices: EdgeVoiceOption[]): EdgeLangOption[] {
  const seen = new Map<string, EdgeLangOption>();
  for (const v of voices) {
    const code = v.locale;
    if (!code || seen.has(code)) continue;
    seen.set(code, { code, label: displayLocaleName(code) });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function filterVoicesForLang(
  voices: EdgeVoiceOption[],
  targetLang: string,
): EdgeVoiceOption[] {
  const t = (targetLang || "").toLowerCase();
  if (!t) return voices;
  const exact = voices.filter((v) => v.locale.toLowerCase() === t);
  if (exact.length) return exact;
  const lang = t.split("-")[0];
  const byLang = voices.filter((v) => v.locale.toLowerCase().split("-")[0] === lang);
  return byLang.length ? byLang : voices;
}

export async function defaultVoiceForLang(targetLang: string): Promise<string> {
  const voices = await fetchEdgeVoices();
  const filtered = filterVoicesForLang(voices, targetLang);
  const preferred =
    filtered.find((v) =>
      /Jenny|Emma|Aria|Guy|Davis|Swara|Madhur|Tanishaa|Bashkar/i.test(v.shortName),
    ) || filtered[0];
  return preferred?.shortName || voices[0]?.shortName || "en-US-JennyNeural";
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/mpeg" });
}

async function synthesizeViaTauri(
  text: string,
  voice: string,
): Promise<{ blob: Blob; url: string } | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ audioBase64: string; mime: string }>("edge_tts_synthesize", {
      text,
      voice,
    });
    if (!result?.audioBase64) return null;
    const blob = base64ToBlob(result.audioBase64, result.mime || "audio/mpeg");
    return { blob, url: URL.createObjectURL(blob) };
  } catch (err) {
    console.warn("Tauri edge_tts_synthesize failed", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function synthesizeViaBridge(
  text: string,
  voice: string,
): Promise<{ blob: Blob; url: string } | null> {
  try {
    const res = await fetch(`${BRIDGE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    const data = (await res.json()) as { audioBase64?: string; mime?: string; error?: string };
    if (!res.ok || data.error) {
      throw new Error(data.error || `TTS bridge failed (${res.status})`);
    }
    if (!data.audioBase64) return null;
    const blob = base64ToBlob(data.audioBase64, data.mime || "audio/mpeg");
    return { blob, url: URL.createObjectURL(blob) };
  } catch (err) {
    if (err instanceof TypeError) return null; // bridge not running
    throw err;
  }
}

async function synthesizeViaBrowser(
  text: string,
  voice: string,
): Promise<{ blob: Blob; url: string; durationHint: number }> {
  const tts = new EdgeTTS(text, voice);
  const result = await tts.synthesize();
  const blob = result.audio;
  if (!blob || blob.size === 0) {
    throw new Error("No audio was received");
  }
  const url = URL.createObjectURL(blob);
  let durationHint = Math.max(0.6, text.length * 0.055);
  if (result.subtitle?.length) {
    const last = result.subtitle[result.subtitle.length - 1];
    const end100ns = (last.offset || 0) + (last.duration || 0);
    if (end100ns > 0) durationHint = Math.max(0.4, end100ns / 1e7);
  }
  return { blob, url, durationHint };
}

/**
 * Synthesize text to an audio Blob (MPEG) and a blob: URL.
 * Caller owns revoking the URL.
 */
export async function synthesizeToBlobUrl(
  text: string,
  voice: string,
): Promise<{ blob: Blob; url: string; durationHint: number }> {
  const cleaned = text.trim();
  if (!cleaned) throw new Error("Empty text for TTS");

  // 1) Desktop app (Tauri) — reliable
  try {
    const native = await synthesizeViaTauri(cleaned, voice);
    if (native) {
      return {
        ...native,
        durationHint: Math.max(0.6, cleaned.length * 0.055),
      };
    }
  } catch (err) {
    // Fall through to bridge / browser; keep message if all fail.
    console.warn(err);
  }

  // 2) Local bridge if desktop app is running beside the browser
  try {
    const bridged = await synthesizeViaBridge(cleaned, voice);
    if (bridged) {
      return {
        ...bridged,
        durationHint: Math.max(0.6, cleaned.length * 0.055),
      };
    }
  } catch (err) {
    console.warn(err);
  }

  // 3) Browser Edge TTS (often blocked outside Microsoft Edge)
  try {
    return await synthesizeViaBrowser(cleaned, voice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no audio/i.test(msg) || /websocket/i.test(msg)) {
      throw new Error(
        "Couldn’t generate voiceover audio. Try again in the Screen Beaver desktop app or Microsoft Edge.",
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}

/** Probe decoded audio duration via Web Audio (more accurate than word boundaries). */
export async function probeAudioDuration(url: string): Promise<number> {
  const ctx = new AudioContext();
  try {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    return Math.max(0.2, decoded.duration);
  } finally {
    await ctx.close().catch(() => {});
  }
}
