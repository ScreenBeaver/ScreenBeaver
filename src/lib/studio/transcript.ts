/**
 * Browser-native speech → text via the Web Speech API (Chrome / Edge).
 * No model downloads. Chrome may use cloud ASR; Edge on Windows can stay on-device.
 *
 * Limitation: the API only listens to the live microphone — it cannot read a
 * finished audio file. Captions are captured while you record.
 *
 * Timing note: SpeechRecognition delivers interim/final results *after* you speak.
 * We compensate with lag + speech-duration estimates so cues sit on the video.
 */

import type { CaptionCue } from "./types";

type ProgressFn = (p: number, label?: string) => void;

// Minimal typing so we don't depend on DOM lib SpeechRecognition variants.
type RecResult = { 0?: { transcript?: string }; isFinal: boolean; length: number };
type RecEvent = { resultIndex: number; results: ArrayLike<RecResult> };
type RecLike = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onresult: ((ev: RecEvent) => void) | null;
  onerror: ((ev?: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

/**
 * How late finals/interims typically arrive vs when audio was spoken.
 * Tuned for Chrome/Edge continuous recognition (cloud or on-device).
 */
const ASR_RESULT_LAG_SEC = 0.75;
/** Extra pull-back when we only saw a late interim (no early onset). */
const ASR_ONSET_PAD_SEC = 0.25;

function getSpeechCtor(): (new () => RecLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => RecLike;
    webkitSpeechRecognition?: new () => RecLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function supportsBrowserSpeech(): boolean {
  return !!getSpeechCtor();
}

function makeRecognizer(lang?: string): RecLike | null {
  const Ctor = getSpeechCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang =
    lang?.trim() ||
    (typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US");
  return rec;
}

/** Approximate how long `text` takes to speak aloud. */
export function estimateSpeechSeconds(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0.5;
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const chars = cleaned.replace(/\s/g, "").length;
  // Blend word rate (~2.4 w/s) with character rate for CJK / short phrases
  const byWords = words / 2.4;
  const byChars = chars / 12;
  return Math.min(14, Math.max(0.5, Math.max(byWords, byChars * 0.85)));
}

/**
 * Map late ASR timestamps onto the video timeline.
 * Prefer text-derived duration anchored to a lag-corrected end time.
 */
export function refineCueTiming(
  text: string,
  reportedStart: number,
  reportedEnd: number,
): { start: number; end: number } {
  const spoken = estimateSpeechSeconds(text);
  // Results arrive after speech — shift earlier
  let end = Math.max(0.05, reportedEnd - ASR_RESULT_LAG_SEC);
  let start = Math.max(0, reportedStart - ASR_RESULT_LAG_SEC - ASR_ONSET_PAD_SEC);

  const span = Math.max(0, end - start);
  // If ASR window is way off vs natural speech length, rebuild from the end
  if (span < spoken * 0.5 || span > spoken * 1.75 || start >= end) {
    start = Math.max(0, end - spoken);
  } else {
    // Keep onset if we caught it early enough; otherwise open earlier to fit speech
    const needStart = end - spoken;
    start = Math.max(0, Math.min(start, needStart));
  }

  if (end - start < 0.4) {
    end = start + Math.max(0.4, spoken * 0.5);
  }
  return { start, end };
}

/**
 * Live captions while recording. Timestamps are relative to `startedAt`
 * (performance.now()) — pass the MediaRecorder start time so cues line up
 * with the video timeline.
 */
export function startLiveBrowserTranscription(
  startedAt: number,
  speakLang?: string,
): {
  stop: () => CaptionCue[];
  getCues: () => CaptionCue[];
} {
  const cues: CaptionCue[] = [];
  let cueSeq = 0;
  /** First interim clock time for the current utterance (still late vs speech). */
  let utteranceStart: number | null = null;
  let running = false;
  let active = true;

  const rec = makeRecognizer(speakLang);
  if (!rec) {
    return {
      stop: () => cues,
      getCues: () => cues,
    };
  }

  const pushFinal = (text: string, reportedStart: number, reportedEnd: number) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    const { start: s, end: e } = refineCueTiming(cleaned, reportedStart, reportedEnd);

    const prev = cues[cues.length - 1];
    // Merge only when it's clearly a continuation of the same line
    if (
      prev &&
      s <= prev.end + 0.2 &&
      (cleaned.startsWith(prev.text) || prev.text.startsWith(cleaned.slice(0, Math.min(12, cleaned.length))))
    ) {
      prev.end = Math.max(prev.end, e);
      prev.text = cleaned.length >= prev.text.length ? cleaned : prev.text;
      return;
    }

    cues.push({
      id: `cap-live-${cueSeq++}-${Math.round(s * 1000)}`,
      start: s,
      end: e,
      text: cleaned,
    });
  };

  const clock = () => Math.max(0, (performance.now() - startedAt) / 1000);

  rec.onresult = (ev) => {
    const now = clock();
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      const text = result[0]?.transcript || "";
      if (!result.isFinal) {
        // Lock onset on first interim only — don't keep sliding it later
        if (utteranceStart == null) utteranceStart = now;
        continue;
      }
      const reportedStart =
        utteranceStart ?? Math.max(0, now - estimateSpeechSeconds(text));
      utteranceStart = null;
      pushFinal(text, reportedStart, now);
    }
  };

  const safeStart = () => {
    if (!active) return;
    try {
      rec.start();
      running = true;
    } catch {
      /* InvalidStateError when already running */
    }
  };

  rec.onerror = (ev) => {
    running = false;
    const err = ev?.error || "";
    if (err === "not-allowed" || err === "service-not-allowed") {
      active = false;
      return;
    }
    // Keep utteranceStart across recoverable errors so we don't lose onset
    setTimeout(safeStart, 280);
  };

  rec.onend = () => {
    running = false;
    if (!active) return;
    setTimeout(safeStart, 80);
  };

  safeStart();

  const keepAlive = setInterval(() => {
    if (!active) return;
    if (!running) safeStart();
  }, 2000);

  return {
    getCues: () => cues.slice(),
    stop: () => {
      active = false;
      clearInterval(keepAlive);
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      utteranceStart = null;
      return normalizeCaptionCues(cues.slice());
    },
  };
}

/** Clamp / sort / gently de-overlap cues so they sit cleanly on the timeline. */
export function normalizeCaptionCues(
  cues: CaptionCue[],
  duration?: number,
): CaptionCue[] {
  const maxEnd = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const sorted = [...cues]
    .map((c) => {
      const start = Math.max(0, Math.min(c.start, maxEnd - 0.2));
      const end = Math.max(start + 0.35, Math.min(c.end, maxEnd));
      return { ...c, start, end };
    })
    .filter((c) => c.text.trim())
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 0.05) {
      const overlap = sorted[i - 1].end - sorted[i].start;
      if (overlap > 0.05 && overlap < 0.8) {
        const mid = (sorted[i - 1].end + sorted[i].start) / 2;
        sorted[i - 1] = { ...sorted[i - 1], end: mid };
        sorted[i] = { ...sorted[i], start: mid };
      } else if (overlap >= 0.8) {
        sorted[i] = {
          ...sorted[i],
          start: sorted[i - 1].end,
          end: Math.max(sorted[i - 1].end + 0.35, sorted[i].end),
        };
      }
      if (sorted[i].end > maxEnd) {
        sorted[i].end = maxEnd;
        if (sorted[i].start >= sorted[i].end) {
          sorted[i].start = Math.max(0, maxEnd - 0.4);
        }
      }
    }
  }
  return sorted;
}

/**
 * Post-recording: browser speech cannot decode a finished file.
 * Returns existing live cues if present; otherwise explains the limitation.
 */
export async function transcribeLocalAudio(
  _audioUrl: string,
  onProgress?: ProgressFn,
  existingLiveCues?: CaptionCue[],
): Promise<CaptionCue[]> {
  if (existingLiveCues && existingLiveCues.length > 0) {
    onProgress?.(1, "Using captions from this recording");
    return normalizeCaptionCues(existingLiveCues);
  }
  if (!supportsBrowserSpeech()) {
    throw new Error(
      "This browser has no built-in speech recognition. Use Chrome or Edge, and enable the microphone while recording.",
    );
  }
  throw new Error(
    "Browser speech only works live while you record (Chrome/Edge mic). Re-record with the microphone on — captions are captured automatically. File transcription would need a downloadable model.",
  );
}

export function cuesToSrt(cues: CaptionCue[]): string {
  const fmt = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const frac = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(frac).padStart(3, "0")}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
    .join("\n");
}

export function downloadSrt(cues: CaptionCue[], filename: string) {
  const blob = new Blob([cuesToSrt(cues)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".srt") ? filename : `${filename}.srt`;
  a.click();
  URL.revokeObjectURL(url);
}
