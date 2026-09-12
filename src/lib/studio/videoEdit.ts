/**
 * Multi-segment screen edit: cut / delete / reorder pieces of the recording.
 * Timeline time is the sum of kept segments (each divided by its speed).
 * Marker times stay in source media time; playback maps timeline → source.
 */

import type { ProjectState, VideoSegment } from "./types";

const MIN_SEG = 0.2;

export function newSegmentId(t: number) {
  return `vid-${Math.round(t * 1000)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function segmentSpeed(seg: VideoSegment, project: ProjectState): number {
  const s = seg.speed ?? project.speed ?? 1;
  return Math.min(2, Math.max(0.5, s));
}

/** Effective keep-list. Falls back to trim / full take when none stored. Order is preserved. */
export function getVideoSegments(
  project: ProjectState,
  takeDuration: number,
): VideoSegment[] {
  const raw = project.segments;
  if (raw?.length) {
    return raw
      .map((s) => ({
        ...s,
        in: Math.max(0, Math.min(s.in, takeDuration)),
        out: Math.max(0, Math.min(s.out, takeDuration)),
      }))
      .filter((s) => s.out - s.in >= MIN_SEG * 0.5);
  }
  const start = Math.max(0, project.trim?.start ?? 0);
  const end =
    project.trim?.end && project.trim.end > start
      ? Math.min(takeDuration, project.trim.end)
      : takeDuration;
  return [
    {
      id: "vid-full",
      in: start,
      out: Math.max(start + MIN_SEG, end),
    },
  ];
}

export type SegmentSpan = {
  id: string;
  in: number;
  out: number;
  speed: number;
  /** Packed edit-timeline start (seconds of output). */
  timelineStart: number;
  /** Packed edit-timeline end (seconds of output). */
  timelineEnd: number;
};

/** Pack segments left-to-right in array order (edit timeline). */
export function layoutVideoSegments(
  project: ProjectState,
  takeDuration: number,
): SegmentSpan[] {
  const segs = getVideoSegments(project, takeDuration);
  let acc = 0;
  return segs.map((s) => {
    const speed = segmentSpeed(s, project);
    const tlLen = (s.out - s.in) / speed;
    const span: SegmentSpan = {
      id: s.id,
      in: s.in,
      out: s.out,
      speed,
      timelineStart: acc,
      timelineEnd: acc + tlLen,
    };
    acc += tlLen;
    return span;
  });
}

export function editDuration(project: ProjectState, takeDuration: number): number {
  const spans = layoutVideoSegments(project, takeDuration);
  return spans.length ? spans[spans.length - 1]!.timelineEnd : 0;
}

/** Timeline seconds (output) → source media seconds. */
export function timelineToSource(
  project: ProjectState,
  takeDuration: number,
  timelineT: number,
): number {
  const spans = layoutVideoSegments(project, takeDuration);
  let t = Math.max(0, timelineT);
  for (const s of spans) {
    const len = s.timelineEnd - s.timelineStart;
    if (t <= len + 1e-6) {
      return s.in + Math.min(s.out - s.in, t * s.speed);
    }
    t -= len;
  }
  const last = spans[spans.length - 1];
  return last ? last.out : 0;
}

/** Source media seconds → timeline seconds (null if that source was cut out). */
export function sourceToTimeline(
  project: ProjectState,
  takeDuration: number,
  sourceT: number,
): number | null {
  const spans = layoutVideoSegments(project, takeDuration);
  for (const s of spans) {
    if (sourceT >= s.in - 1e-4 && sourceT <= s.out + 1e-4) {
      return s.timelineStart + Math.max(0, sourceT - s.in) / s.speed;
    }
  }
  return null;
}

/** Playback rate for the segment covering this source time. */
export function speedAtSource(
  project: ProjectState,
  takeDuration: number,
  sourceT: number,
): number {
  const segs = getVideoSegments(project, takeDuration);
  for (const s of segs) {
    if (sourceT >= s.in - 1e-4 && sourceT < s.out + 1e-4) {
      return segmentSpeed(s, project);
    }
  }
  return Math.min(2, Math.max(0.5, project.speed || 1));
}

export function ensureMaterializedSegments(
  project: ProjectState,
  takeDuration: number,
): VideoSegment[] {
  return getVideoSegments(project, takeDuration);
}

/** Resolve a timeline selection id against the current keep-list. */
export function resolveVideoSegmentIndex(
  segs: VideoSegment[],
  selectedSegmentId: string | null,
): number {
  if (!selectedSegmentId || !segs.length) return -1;
  const exact = segs.findIndex((s) => s.id === selectedSegmentId);
  if (exact >= 0) return exact;
  if (selectedSegmentId === "vid-full" && segs.length === 1) return 0;
  return -1;
}

export type VideoSplitResult = {
  ok: boolean;
  message: string;
  project?: ProjectState;
  selectedSegmentId?: string;
};

function syncTrimFromSegments(segs: VideoSegment[], takeDuration: number) {
  const ins = segs.map((s) => s.in);
  const outs = segs.map((s) => s.out);
  return {
    start: ins.length ? Math.min(...ins) : 0,
    end: outs.length ? Math.max(...outs) : takeDuration,
  };
}

function withSegments(
  project: ProjectState,
  takeDuration: number,
  segs: VideoSegment[],
): ProjectState {
  return {
    ...project,
    segments: segs,
    trim: syncTrimFromSegments(segs, takeDuration),
  };
}

/** Blade the video at the playhead (source media time). */
export function splitVideoAtTimeline(
  project: ProjectState,
  takeDuration: number,
  sourceT: number,
  selectedSegmentId: string | null,
): VideoSplitResult {
  const segs = ensureMaterializedSegments(project, takeDuration);
  if (!segs.length) return { ok: false, message: "No video to cut" };

  let targetIdx = -1;
  let cutSource = 0;

  if (selectedSegmentId) {
    targetIdx = resolveVideoSegmentIndex(segs, selectedSegmentId);
    if (targetIdx < 0) return { ok: false, message: "Selected video clip not found" };
    const s = segs[targetIdx]!;
    const len = s.out - s.in;
    if (len < MIN_SEG * 2) {
      return { ok: false, message: "Video clip is too short to split" };
    }
    if (sourceT >= s.in + MIN_SEG && sourceT <= s.out - MIN_SEG) {
      cutSource = sourceT;
    } else {
      cutSource = s.in + len / 2;
    }
  } else {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (sourceT >= s.in + MIN_SEG && sourceT <= s.out - MIN_SEG) {
        targetIdx = i;
        cutSource = sourceT;
        break;
      }
    }
    if (targetIdx < 0) {
      return {
        ok: false,
        message: "Move the playhead onto the video clip, then cut",
      };
    }
  }

  const s = segs[targetIdx]!;
  if (cutSource < s.in + MIN_SEG || cutSource > s.out - MIN_SEG) {
    return { ok: false, message: "Video clip is too short to split here" };
  }

  const left: VideoSegment = { ...s, out: cutSource };
  const rightId = newSegmentId(cutSource);
  const right: VideoSegment = {
    id: rightId,
    in: cutSource,
    out: s.out,
    speed: s.speed,
  };
  const next = [...segs.slice(0, targetIdx), left, right, ...segs.slice(targetIdx + 1)];

  return {
    ok: true,
    message: "Video split into two clips",
    project: withSegments(project, takeDuration, next),
    selectedSegmentId: rightId,
  };
}

function overlapsRange(start: number, end: number, a: number, b: number) {
  return start < b && end > a;
}

/** Remove a kept segment. Later markers keep source times; playback skips the hole. */
export function deleteVideoSegment(
  project: ProjectState,
  takeDuration: number,
  segmentId: string,
): VideoSplitResult {
  const segs = ensureMaterializedSegments(project, takeDuration);
  const idx = resolveVideoSegmentIndex(segs, segmentId);
  if (idx < 0) return { ok: false, message: "Video clip not found" };
  if (segs.length <= 1) {
    return { ok: false, message: "Can't delete the only video clip — trim the ends instead" };
  }

  const removed = segs[idx]!;
  const a = removed.in;
  const b = removed.out;
  const keepSegs = segs.filter((_, i) => i !== idx);

  const keepTimed = <T extends { time: number; duration: number }>(m: T): boolean => {
    const end = m.time + m.duration;
    if (m.time >= a && end <= b) return false;
    return true;
  };

  const zooms = project.zooms.filter(keepTimed);
  const moves = project.moves.filter(keepTimed);
  const effects = (project.effects ?? []).filter(keepTimed);
  const sounds = (project.sounds ?? []).filter(keepTimed);
  const cues = (project.captions?.cues ?? []).filter((c) => {
    if (c.start >= a && c.end <= b) return false;
    return true;
  });

  return {
    ok: true,
    message: "Video clip removed",
    project: {
      ...withSegments(project, takeDuration, keepSegs),
      zooms,
      moves,
      effects,
      sounds,
      captions: project.captions ? { ...project.captions, cues } : project.captions,
    },
    selectedSegmentId: keepSegs[Math.min(idx, keepSegs.length - 1)]?.id,
  };
}

/** Reorder a clip in the keep-list (packed edit order). */
export function reorderVideoSegment(
  project: ProjectState,
  takeDuration: number,
  segmentId: string,
  toIndex: number,
): VideoSplitResult {
  const segs = ensureMaterializedSegments(project, takeDuration);
  const from = resolveVideoSegmentIndex(segs, segmentId);
  if (from < 0) return { ok: false, message: "Video clip not found" };
  if (segs.length <= 1) return { ok: false, message: "Need at least two clips to reorder" };

  const clamped = Math.max(0, Math.min(segs.length - 1, toIndex));
  if (clamped === from) {
    return { ok: true, message: "", project, selectedSegmentId: segs[from]!.id };
  }

  const next = [...segs];
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item!);

  return {
    ok: true,
    message: "Clip moved",
    project: withSegments(project, takeDuration, next),
    selectedSegmentId: item!.id,
  };
}

/** Update speed / trim on one clip. */
export function updateVideoSegment(
  project: ProjectState,
  takeDuration: number,
  segmentId: string,
  patch: { speed?: number; in?: number; out?: number },
): VideoSplitResult {
  const segs = ensureMaterializedSegments(project, takeDuration);
  const idx = resolveVideoSegmentIndex(segs, segmentId);
  if (idx < 0) return { ok: false, message: "Video clip not found" };

  const cur = segs[idx]!;
  let nextIn = patch.in ?? cur.in;
  let nextOut = patch.out ?? cur.out;
  nextIn = Math.max(0, Math.min(nextIn, takeDuration));
  nextOut = Math.max(0, Math.min(nextOut, takeDuration));
  if (nextOut - nextIn < MIN_SEG) {
    return { ok: false, message: "Clip is too short" };
  }

  // Don't expand into another segment's source range.
  for (let i = 0; i < segs.length; i++) {
    if (i === idx) continue;
    const o = segs[i]!;
    if (overlapsRange(nextIn, nextOut, o.in, o.out)) {
      if (patch.in != null && nextIn < o.out && nextIn >= o.in) {
        nextIn = o.out;
      }
      if (patch.out != null && nextOut > o.in && nextOut <= o.out) {
        nextOut = o.in;
      }
      if (nextOut - nextIn < MIN_SEG) {
        return { ok: false, message: "Can't trim into another clip" };
      }
    }
  }

  const speed =
    patch.speed != null ? Math.min(2, Math.max(0.5, patch.speed)) : cur.speed;

  const next = segs.map((s, i) => {
    if (i !== idx) return s;
    const updated: VideoSegment = { ...s, in: nextIn, out: nextOut };
    if (patch.speed != null) updated.speed = speed!;
    return updated;
  });

  // Always persist segments when editing so per-clip speed sticks.
  let proj = withSegments(project, takeDuration, next);
  if (next.length === 1 && patch.speed != null) {
    proj = { ...proj, speed: patch.speed };
  }

  return {
    ok: true,
    message: "Clip updated",
    project: proj,
    selectedSegmentId: next[idx]!.id,
  };
}

/** Insert index under an edit-timeline x position (for drag-reorder). */
export function reorderIndexAtTimeline(
  project: ProjectState,
  takeDuration: number,
  editT: number,
  draggingId: string,
): number {
  const segs = getVideoSegments(project, takeDuration);
  const from = resolveVideoSegmentIndex(segs, draggingId);
  if (from < 0 || segs.length <= 1) return Math.max(0, from);
  const spans = layoutVideoSegments(project, takeDuration);

  let to = spans.length - 1;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (editT <= span.timelineEnd + 1e-6) {
      const mid = (span.timelineStart + span.timelineEnd) / 2;
      to = editT < mid ? i : Math.min(spans.length - 1, i + 1);
      break;
    }
  }
  // Account for removing `from` before inserting
  if (from < to) to -= 1;
  return Math.max(0, Math.min(segs.length - 1, to));
}

export function nextKeptSource(
  project: ProjectState,
  takeDuration: number,
  sourceT: number,
): number | null {
  const segs = getVideoSegments(project, takeDuration);
  if (!segs.length) return null;

  const containing = segs.findIndex(
    (s) => sourceT >= s.in - 1e-3 && sourceT < s.out - 1e-3,
  );
  if (containing >= 0) return sourceT;

  // Hit the end of a clip → jump to the next clip in edit order
  const atEnd = segs.findIndex((s) => Math.abs(sourceT - s.out) <= 0.06);
  if (atEnd >= 0) {
    const next = segs[atEnd + 1];
    return next ? next.in : null;
  }

  // Source gap (deleted middle) — advance to the next clip that starts after
  for (const s of segs) {
    if (sourceT < s.in) return s.in;
  }
  return null;
}

export function lastKeptSource(project: ProjectState, takeDuration: number): number {
  const segs = getVideoSegments(project, takeDuration);
  if (!segs.length) return takeDuration;
  // End of the last clip in edit order
  return segs[segs.length - 1]!.out;
}

/** True when the project has more than one keep-segment (real cuts exist). */
export function hasVideoCuts(project: ProjectState): boolean {
  return (project.segments?.length ?? 0) > 1;
}

export { overlapsRange };
