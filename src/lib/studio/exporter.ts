import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { renderScene, makeCursorTrack, stageAspect, type SceneMedia } from "./compositor";
import type { ProjectState, RecordingTake, VoiceoverClip } from "./types";
import { exportSfxEnabled, getSoundBuffers } from "./sounds";
import type { SoundClip, SoundKind } from "./soundTrack";
import { editDuration, timelineToSource } from "./videoEdit";

export interface ExportOptions {
  /** Long edge in pixels (width for landscape, height for portrait). */
  width: number;
  fps: number;
  quality: "web" | "high" | "max";
  /** Burn Screen Beaver logo when Free / watermarkFree is false. */
  watermark?: boolean;
  onProgress?: (p: number) => void;
}

export function exportSupported(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window;
}

/** Resolve even canvas size from project aspect + long-edge preset. */
export function exportCanvasSize(
  project: ProjectState,
  take: RecordingTake,
  longEdge: number,
): { width: number; height: number } {
  const aspect = stageAspect(project, take);
  const edge = Math.round(longEdge / 2) * 2;
  if (aspect < 1) {
    const height = edge;
    const width = Math.max(2, Math.round((height * aspect) / 2) * 2);
    return { width, height };
  }
  const width = edge;
  const height = Math.max(2, Math.round(width / aspect / 2) * 2);
  return { width, height };
}

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

let watermarkLogoPromise: Promise<HTMLImageElement | null> | null = null;

function loadWatermarkLogo(): Promise<HTMLImageElement | null> {
  if (!watermarkLogoPromise) {
    watermarkLogoPromise = loadImageEl("/logo.png").catch(() => null);
  }
  return watermarkLogoPromise;
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  logo: HTMLImageElement,
) {
  const maxW = Math.max(72, Math.round(width * 0.12));
  const scale = maxW / logo.naturalWidth;
  const w = maxW;
  const h = logo.naturalHeight * scale;
  const pad = Math.max(12, Math.round(width * 0.018));
  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.drawImage(logo, width - w - pad, height - h - pad, w, h);
  ctx.restore();
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("Could not decode the recording"));
  });
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.min(t, Math.max(0, (v.duration || t) - 0.001));
    if (Math.abs(v.currentTime - target) < 1e-4) return resolve();
    const done = () => {
      v.removeEventListener("seeked", done);
      resolve();
    };
    v.addEventListener("seeked", done);
    v.currentTime = target;
  });
}

function mixSfxInto(
  dest: Float32Array,
  channels: number,
  sampleRate: number,
  destStartSample: number,
  sounds: SoundClip[],
  buffers: Partial<Record<SoundKind, AudioBuffer>>,
  trimStart: number,
) {
  for (const s of sounds) {
    const buf = buffers[s.kind];
    if (!buf) continue;
    const rel = s.time - trimStart;
    if (rel < -0.05) continue;
    const at = Math.floor(rel * sampleRate) - destStartSample;
    const src = buf.getChannelData(0);
    const clipSamples = Math.max(1, Math.floor(Math.max(0.04, s.duration) * sampleRate));
    const gain =
      s.kind === "typing" ? 0.65 : s.kind === "shimmer" ? 0.72 : 0.85;

    if (s.kind === "typing") {
      // Loop a short usable window of the typing bed for clip.duration only
      const loopLen = Math.min(src.length, Math.floor(sampleRate * 1.2));
      for (let i = 0; i < clipSamples; i++) {
        const frame = at + i;
        if (frame < 0) continue;
        if (frame * channels + (channels - 1) >= dest.length) break;
        const sample = src[i % loopLen] * gain;
        // Soft fade out in last 40ms
        const fade =
          i > clipSamples - sampleRate * 0.04
            ? Math.max(0, (clipSamples - i) / (sampleRate * 0.04))
            : 1;
        for (let c = 0; c < channels; c++) {
          dest[frame * channels + c] = Math.max(
            -1,
            Math.min(1, (dest[frame * channels + c] ?? 0) + sample * fade),
          );
        }
      }
      continue;
    }

    const n = Math.min(src.length, clipSamples);
    for (let i = 0; i < n; i++) {
      const frame = at + i;
      if (frame < 0) continue;
      if (frame * channels + (channels - 1) >= dest.length) break;
      const sample = src[i] * gain;
      for (let c = 0; c < channels; c++) {
        dest[frame * channels + c] = Math.max(
          -1,
          Math.min(1, (dest[frame * channels + c] ?? 0) + sample),
        );
      }
    }
  }
}

function muteMicUnderVoiceover(
  dest: Float32Array,
  channels: number,
  sampleRate: number,
  trimStart: number,
  clips: VoiceoverClip[],
) {
  for (const clip of clips) {
    const relStart = clip.start - trimStart;
    const relEnd = clip.start + clip.duration - trimStart;
    const from = Math.max(0, Math.floor(relStart * sampleRate));
    const to = Math.min(
      Math.floor(dest.length / channels),
      Math.ceil(relEnd * sampleRate),
    );
    for (let i = from; i < to; i++) {
      for (let c = 0; c < channels; c++) {
        dest[i * channels + c] = 0;
      }
    }
  }
}

function mixVoiceoverInto(
  dest: Float32Array,
  channels: number,
  sampleRate: number,
  trimStart: number,
  clips: VoiceoverClip[],
  buffers: Map<string, AudioBuffer>,
) {
  for (const clip of clips) {
    const buf = buffers.get(clip.id);
    if (!buf) continue;
    const rel = clip.start - trimStart;
    const at = Math.floor(rel * sampleRate);
    const src = buf.getChannelData(0);
    const n = Math.min(src.length, Math.floor(Math.max(0.05, clip.duration) * sampleRate));
    for (let i = 0; i < n; i++) {
      const frame = at + i;
      if (frame < 0) continue;
      if (frame * channels + (channels - 1) >= dest.length) break;
      const sample = src[i];
      for (let c = 0; c < channels; c++) {
        dest[frame * channels + c] = Math.max(
          -1,
          Math.min(1, (dest[frame * channels + c] ?? 0) + sample),
        );
      }
    }
  }
}

async function encodeMixedAudio(
  muxer: Muxer<ArrayBufferTarget>,
  micUrl: string | null,
  start: number,
  end: number,
  sounds: SoundClip[],
  voiceover?: { enabled: boolean; clips: VoiceoverClip[] } | null,
  music?: { enabled: boolean; url: string | null; volume: number; loop: boolean } | null,
): Promise<void> {
  const ctx = new AudioContext();
  try {
    const sfxBuffers = await getSoundBuffers();
    let sampleRate = 48000;
    let channels = 2;
    let mic: AudioBuffer | null = null;

    if (micUrl) {
      const raw = await fetch(micUrl).then((r) => r.arrayBuffer());
      mic = await ctx.decodeAudioData(raw.slice(0));
      sampleRate = mic.sampleRate;
      channels = Math.min(2, mic.numberOfChannels);
    }

    const voClips =
      voiceover?.enabled && voiceover.clips?.length
        ? voiceover.clips.filter(
            (c) => c.start + c.duration >= start - 0.05 && c.start <= end + 0.5,
          )
        : [];

    const voBuffers = new Map<string, AudioBuffer>();
    for (const clip of voClips) {
      try {
        const raw = await fetch(clip.audioUrl).then((r) => r.arrayBuffer());
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        voBuffers.set(clip.id, decoded);
      } catch (err) {
        console.warn("voiceover decode failed", clip.id, err);
      }
    }

    let musicBuf: AudioBuffer | null = null;
    const musicVol = Math.min(1, Math.max(0, music?.volume ?? 0.16));
    if (music?.enabled && music.url) {
      try {
        const raw = await fetch(music.url).then((r) => r.arrayBuffer());
        musicBuf = await ctx.decodeAudioData(raw.slice(0));
        sampleRate = musicBuf.sampleRate || sampleRate;
      } catch (err) {
        console.warn("background music decode failed", err);
      }
    }

    const totalFrames = Math.max(1, Math.floor((end - start) * sampleRate));
    const interleaved = new Float32Array(totalFrames * channels);

    if (mic) {
      const from = Math.floor(start * sampleRate);
      for (let i = 0; i < totalFrames; i++) {
        const src = from + i;
        for (let c = 0; c < channels; c++) {
          const ch = mic.getChannelData(Math.min(c, mic.numberOfChannels - 1));
          interleaved[i * channels + c] = src < ch.length ? ch[src] : 0;
        }
      }
    }

    if (musicBuf) {
      const src = musicBuf.getChannelData(0);
      const loop = music?.loop !== false;
      for (let i = 0; i < totalFrames; i++) {
        let si = i;
        if (loop) si = i % src.length;
        else if (si >= src.length) break;
        // Duck bed under voiceover windows.
        let duck = 1;
        const t = start + i / sampleRate;
        for (const clip of voClips) {
          if (t >= clip.start && t <= clip.start + clip.duration) {
            duck = 0.22;
            break;
          }
        }
        const sample = src[si]! * musicVol * duck;
        for (let c = 0; c < channels; c++) {
          interleaved[i * channels + c] = Math.max(
            -1,
            Math.min(1, (interleaved[i * channels + c] ?? 0) + sample),
          );
        }
      }
    }

    if (voClips.length) {
      muteMicUnderVoiceover(interleaved, channels, sampleRate, start, voClips);
      mixVoiceoverInto(interleaved, channels, sampleRate, start, voClips, voBuffers);
    }

    // Respect Account → Click & SFX sounds: off = silent export (clips stay on timeline).
    if (exportSfxEnabled()) {
      const inRange = sounds.filter((s) => s.time >= start - 0.05 && s.time <= end + 0.5);
      mixSfxInto(interleaved, channels, sampleRate, 0, inRange, sfxBuffers, start);
    }

    const encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: () => {},
    });
    encoder.configure({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate: 160_000,
    });

    const chunkFrames = 4096;
    for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
      const count = Math.min(chunkFrames, totalFrames - offset);
      const slice = interleaved.subarray(offset * channels, (offset + count) * channels);
      const audioData = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset / sampleRate) * 1e6),
        data: slice,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
    encoder.close();
  } finally {
    void ctx.close();
  }
}

/**
 * Frame-accurate in-browser render: the same compositor that paints the live
 * preview is stepped frame by frame and fed to a hardware VideoEncoder, then
 * muxed to MP4 alongside re-encoded AAC audio. No server round trip.
 */
export async function exportProject(
  project: ProjectState,
  take: RecordingTake,
  media: Pick<SceneMedia, "backgroundImage" | "cameraBackgroundImage">,
  options: ExportOptions,
): Promise<Blob> {
  if (!exportSupported()) throw new Error("This browser cannot encode video (WebCodecs missing)");

  const { width, height } = exportCanvasSize(project, take, options.width);
  const fps = options.fps;

  const screen = await loadVideo(take.screenUrl);
  const camera = take.cameraUrl && project.camera.enabled ? await loadVideo(take.cameraUrl) : null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const target = new ArrayBufferTarget();
  const hasAudio = !!(
    take.micUrl ||
    (exportSfxEnabled() && project.sounds && project.sounds.length > 0) ||
    (project.voiceover?.enabled && project.voiceover.clips?.length) ||
    (project.music?.enabled && project.music.url)
  );
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    audio: hasAudio ? { codec: "aac", numberOfChannels: 2, sampleRate: 48000 } : undefined,
    fastStart: "in-memory",
  });

  const bitrate = options.quality === "web" ? 6e6 : options.quality === "high" ? 16e6 : 34e6;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error(e),
  });
  encoder.configure({
    codec: "avc1.640028",
    width,
    height,
    bitrate,
    framerate: fps,
    latencyMode: "quality",
  });

  const cursorTrack = makeCursorTrack(take, project.cursor.smoothing, project.cursor.autoHideIdle);
  const editDur = editDuration(project, take.duration);
  const total = Math.max(1, Math.round(editDur * fps));
  const watermarkLogo =
    options.watermark === true ? await loadWatermarkLogo() : null;

  for (let i = 0; i < total; i++) {
    const outT = i / fps;
    const srcT = timelineToSource(project, take.duration, outT);
    await seek(screen, srcT);
    if (camera) await seek(camera, srcT);

    renderScene(ctx, width, height, {
      project,
      take,
      time: srcT,
      cursorTrack,
      media: {
        screen,
        camera,
        cameraMask: null,
        backgroundImage: media.backgroundImage,
        cameraBackgroundImage: media.cameraBackgroundImage,
      },
    });

    if (watermarkLogo) {
      drawWatermark(ctx, width, height, watermarkLogo);
    }

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(outT * 1e6),
      duration: Math.round(1e6 / fps),
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    if (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }
    options.onProgress?.((i + 1) / total);
  }

  await encoder.flush();
  encoder.close();

  if (hasAudio) {
    try {
      // Audio still spans the outer keep bounds; gaps are short skips in video.
      const segsStart = timelineToSource(project, take.duration, 0);
      const segsEnd = timelineToSource(project, take.duration, Math.max(0, editDur - 1e-3));
      await encodeMixedAudio(
        muxer,
        take.micUrl,
        Math.min(segsStart, segsEnd),
        Math.max(segsStart, segsEnd),
        project.sounds ?? [],
        project.voiceover,
        project.music,
      );
    } catch (err) {
      console.warn("audio encode skipped", err);
    }
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}
