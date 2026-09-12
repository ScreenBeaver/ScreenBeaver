/**
 * Caption translation via MyMemory (no API key).
 * Used by AI Voiceover before Edge TTS generation.
 */

import type { CaptionCue } from "./types";

/** BCP-47 / Edge locale → MyMemory language code. */
export function toMyMemoryCode(lang: string): string {
  const base = (lang || "en").split("-")[0].toLowerCase();
  return base || "en";
}

async function translateOne(text: string, from: string, to: string): Promise<string> {
  const q = text.trim();
  if (!q) return text;
  if (from === to) return text;

  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", q.slice(0, 450));
  url.searchParams.set("langpair", `${from}|${to}`);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const data = (await res.json()) as {
    responseStatus?: number;
    responseData?: { translatedText?: string };
  };
  if (data.responseStatus && data.responseStatus !== 200) {
    throw new Error(data.responseData?.translatedText || "Translation rejected");
  }
  const out = data.responseData?.translatedText?.trim();
  if (!out) throw new Error("Empty translation response");
  // MyMemory sometimes echoes QUERY LENGTH LIMIT messages
  if (/MYMEMORY WARNING/i.test(out)) return text;
  return out;
}

/**
 * Translate cue texts from speakLang → targetLang.
 * Stashes originalText on first translate so re-translate uses the source.
 */
export async function translateCaptionCues(
  cues: CaptionCue[],
  speakLang: string,
  targetLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<CaptionCue[]> {
  const from = toMyMemoryCode(speakLang);
  const to = toMyMemoryCode(targetLang);
  const out: CaptionCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const source = (c.originalText ?? c.text).trim();
    if (!source) {
      out.push(c);
      onProgress?.(i + 1, cues.length);
      continue;
    }
    if (from === to) {
      out.push({ ...c, originalText: c.originalText ?? c.text, text: source });
      onProgress?.(i + 1, cues.length);
      continue;
    }
    const translated = await translateOne(source, from, to);
    out.push({
      ...c,
      originalText: c.originalText ?? c.text,
      text: translated,
    });
    onProgress?.(i + 1, cues.length);
    // Gentle throttle to avoid free-tier rate limits
    if (i < cues.length - 1) await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

/** Common speak / caption language options for the Voiceover panel. */
export const VOICEOVER_LANGS: { code: string; label: string }[] = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "bn-IN", label: "Bengali" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
  { code: "mr-IN", label: "Marathi" },
  { code: "gu-IN", label: "Gujarati" },
  { code: "kn-IN", label: "Kannada" },
  { code: "ml-IN", label: "Malayalam" },
  { code: "pa-IN", label: "Punjabi" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "it-IT", label: "Italian" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "ar-SA", label: "Arabic" },
  { code: "ru-RU", label: "Russian" },
  { code: "tr-TR", label: "Turkish" },
  { code: "nl-NL", label: "Dutch" },
  { code: "pl-PL", label: "Polish" },
  { code: "sv-SE", label: "Swedish" },
  { code: "id-ID", label: "Indonesian" },
  { code: "th-TH", label: "Thai" },
  { code: "vi-VN", label: "Vietnamese" },
];
