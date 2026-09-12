/**
 * Interactive crop tool — focus on part of the recording or hide UI chrome.
 * Writes normalized `project.frame.crop` used by the compositor / export.
 */
import { useEffect, useRef, useState } from "react";
import { Crop } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  FULL_CROP,
  applyCropDelta,
  clampCrop,
  cropPixelSize,
  fitCropAspect,
  isFullCrop,
  normAspectForContent,
  type CropHandle,
  type SourceCrop,
} from "@/lib/studio/crop";

const ASPECT_PRESETS: { id: string; label: string; aspect: number | null }[] = [
  { id: "free", label: "Free", aspect: null },
  { id: "original", label: "Original", aspect: -1 },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
  { id: "4:3", label: "4:3", aspect: 4 / 3 },
  { id: "1:1", label: "1:1", aspect: 1 },
  { id: "9:16", label: "9:16", aspect: 9 / 16 },
];

const HANDLES: { id: CropHandle; className: string; cursor: string }[] = [
  { id: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { id: "n", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { id: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { id: "e", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
  { id: "s", className: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2", cursor: "ns-resize" },
  { id: "sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { id: "w", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
];

export function CropEditor({
  open,
  onOpenChange,
  videoUrl,
  videoWidth,
  videoHeight,
  currentTime,
  initialCrop,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoUrl: string;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  initialCrop: SourceCrop;
  onApply: (crop: SourceCrop) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<SourceCrop>(() => clampCrop(initialCrop));
  const [preset, setPreset] = useState("free");
  const dragRef = useRef<{
    handle: CropHandle;
    start: SourceCrop;
    originX: number;
    originY: number;
    lockRatio: number | null;
  } | null>(null);

  const vw = Math.max(1, videoWidth);
  const vh = Math.max(1, videoHeight);
  const originalAspect = vw / vh;
  const pixels = cropPixelSize(crop, vw, vh);

  useEffect(() => {
    if (!open) return;
    setCrop(clampCrop(initialCrop));
    setPreset(isFullCrop(initialCrop) ? "free" : "free");
  }, [open, initialCrop]);

  useEffect(() => {
    if (!open) return;
    const v = videoRef.current;
    if (!v) return;
    const seek = () => {
      try {
        v.currentTime = Math.max(0, currentTime);
      } catch {
        /* ignore */
      }
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [open, currentTime, videoUrl]);

  const lockRatioForPreset = (id: string): number | null => {
    const p = ASPECT_PRESETS.find((x) => x.id === id);
    if (!p || p.aspect === null) return null;
    const content = p.aspect < 0 ? originalAspect : p.aspect;
    return normAspectForContent(content, vw, vh);
  };

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = ASPECT_PRESETS.find((x) => x.id === id);
    if (!p || p.aspect === null) return;
    const content = p.aspect < 0 ? originalAspect : p.aspect;
    setCrop((c) => fitCropAspect(c, content, vw, vh));
  };

  const clientToNorm = (clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return { x: 0, y: 0 };
    const box = el.getBoundingClientRect();
    return {
      x: (clientX - box.left) / Math.max(1, box.width),
      y: (clientY - box.top) / Math.max(1, box.height),
    };
  };

  const onPointerDown = (handle: CropHandle, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = clientToNorm(e.clientX, e.clientY);
    dragRef.current = {
      handle,
      start: { ...crop },
      originX: p.x,
      originY: p.y,
      lockRatio: lockRatioForPreset(preset),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = clientToNorm(e.clientX, e.clientY);
    setCrop(
      applyCropDelta(
        drag.start,
        drag.handle,
        p.x - drag.originX,
        p.y - drag.originY,
        drag.lockRatio,
      ),
    );
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const setWidthPx = (width: number) => {
    const w = Math.min(1, Math.max(0.08, width / vw));
    const lock = lockRatioForPreset(preset);
    let h = crop.h;
    if (lock) h = w / lock;
    setCrop(clampCrop({ ...crop, w, h, x: Math.min(crop.x, 1 - w) }));
  };

  const setHeightPx = (height: number) => {
    const h = Math.min(1, Math.max(0.08, height / vh));
    const lock = lockRatioForPreset(preset);
    let w = crop.w;
    if (lock) w = h * lock;
    setCrop(clampCrop({ ...crop, w, h, y: Math.min(crop.y, 1 - h) }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(92vh,900px)] w-[min(960px,94vw)] max-w-none flex-col gap-0 overflow-hidden border-hairline bg-shell p-0 sm:rounded-xl">
        <DialogHeader className="space-y-1 border-b border-hairline px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <Crop className="h-4 w-4 text-ember" />
            Crop your recording
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Focus on a specific part of your screen or hide parts of the UI.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  preset === p.id
                    ? "bg-royal-grad text-foreground"
                    : "bg-panel-raised text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-[11.5px] tabular-nums text-muted-foreground">
              <label className="flex items-center gap-1">
                W
                <input
                  type="number"
                  min={Math.round(vw * 0.08)}
                  max={vw}
                  value={pixels.width}
                  onChange={(e) => setWidthPx(Number(e.target.value) || pixels.width)}
                  className="w-16 rounded-md border border-hairline bg-panel-raised px-1.5 py-0.5 text-[11.5px] text-foreground outline-none"
                />
              </label>
              <label className="flex items-center gap-1">
                H
                <input
                  type="number"
                  min={Math.round(vh * 0.08)}
                  max={vh}
                  value={pixels.height}
                  onChange={(e) => setHeightPx(Number(e.target.value) || pixels.height)}
                  className="w-16 rounded-md border border-hairline bg-panel-raised px-1.5 py-0.5 text-[11.5px] text-foreground outline-none"
                />
              </label>
            </div>
          </div>

          <div
            className="relative mx-auto flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-lg bg-black"
            style={{ maxHeight: "min(58vh, 520px)", minHeight: 220 }}
          >
            <div
              ref={stageRef}
              className="relative max-h-full max-w-full touch-none select-none overflow-hidden"
              style={{ aspectRatio: `${vw} / ${vh}`, width: "100%", height: "auto" }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                muted
                playsInline
                className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              />
              {/* Selection + dim via outer box-shadow */}
              <div
                className="absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                  cursor: "move",
                }}
                onPointerDown={(e) => onPointerDown("move", e)}
              >
                <div className="pointer-events-none absolute inset-0 opacity-40">
                  <div className="absolute left-1/3 top-0 h-full w-px bg-white/50" />
                  <div className="absolute left-2/3 top-0 h-full w-px bg-white/50" />
                  <div className="absolute left-0 top-1/3 h-px w-full bg-white/50" />
                  <div className="absolute left-0 top-2/3 h-px w-full bg-white/50" />
                </div>
                {HANDLES.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    aria-label={`Resize ${h.id}`}
                    className={cn(
                      "absolute z-10 h-3 w-3 rounded-[2px] border border-black/40 bg-white",
                      h.className,
                    )}
                    style={{ cursor: h.cursor }}
                    onPointerDown={(e) => onPointerDown(h.id, e)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3 sm:justify-between">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
            onClick={() => {
              setPreset("free");
              setCrop({ ...FULL_CROP });
            }}
          >
            Reset to full
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md bg-panel-raised px-3.5 py-1.5 text-[12px] font-medium hover:bg-accent"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-royal-grad px-3.5 py-1.5 text-[12px] font-semibold"
              onClick={() => {
                onApply(clampCrop(crop));
                onOpenChange(false);
              }}
            >
              Apply crop
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
