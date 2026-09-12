/**
 * Shared caption → (optional translate) → Edge TTS voiceover pipeline.
 * Used by the Voiceover panel and by the agent MCP (`generate_voiceover`).
 */

import type { CaptionCue, VoiceoverClip } from "./types";
import {
  defaultVoiceForLang,
  probeAudioDuration,
  synthesizeToBlobUrl,
} from "./edgeTts";
import { toMyMemoryCode, translateCaptionCues } from "./translate";

export type GenerateVoiceoverOpts = {
  cues: CaptionCue[];
  speakLang: string;
  targetLang: string;
  voice?: string;
  /** When true (default if speak≠target), translate cue text before TTS. */
  translate?: boolean;
  onStatus?: (message: string) => void;
};

export type GenerateVoiceoverResult = {
  cues: CaptionCue[];
  clips: VoiceoverClip[];
  voice: string;
  targetLang: string;
  translated: boolean;
};

export async function generateVoiceoverFromCaptions(
  opts: GenerateVoiceoverOpts,
): Promise<GenerateVoiceoverResult> {
  const speakLang = opts.speakLang || "en-US";
  const targetLang = opts.targetLang || "en-US";
  const shouldTranslate =
    opts.translate ?? toMyMemoryCode(speakLang) !== toMyMemoryCode(targetLang);

  let cues = opts.cues;
  if (!cues.length) {
    throw new Error("No captions to voice — add captions first");
  }

  if (shouldTranslate) {
    opts.onStatus?.("Translating captions…");
    cues = await translateCaptionCues(cues, speakLang, targetLang, (done, total) => {
      opts.onStatus?.(`Translating ${done}/${total}…`);
    });
  }

  const voice = (opts.voice || (await defaultVoiceForLang(targetLang))).trim();
  if (!voice) throw new Error("No Edge TTS voice available");

  const clips: VoiceoverClip[] = [];
  try {
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const text = c.text.trim();
      opts.onStatus?.(`Generating voiceover ${i + 1}/${cues.length}…`);
      if (!text) continue;
      const { url, durationHint } = await synthesizeToBlobUrl(text, voice);
      let duration = durationHint;
      try {
        duration = await probeAudioDuration(url);
      } catch {
        /* keep hint */
      }
      const cueLen = Math.max(0.4, c.end - c.start);
      clips.push({
        id: `vo-${c.id}-${Date.now()}-${i}`,
        cueId: c.id,
        start: c.start,
        duration: Math.max(0.4, duration || cueLen),
        audioUrl: url,
        voice,
        text,
      });
    }
  } catch (err) {
    for (const c of clips) {
      if (c.audioUrl.startsWith("blob:")) URL.revokeObjectURL(c.audioUrl);
    }
    throw err;
  }

  return {
    cues,
    clips,
    voice,
    targetLang,
    translated: shouldTranslate,
  };
}
