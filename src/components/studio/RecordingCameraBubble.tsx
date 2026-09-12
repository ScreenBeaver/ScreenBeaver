import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Corner = "bottom-left" | "bottom-right";

/**
 * Large camera bubble shown while recording — not a tiny HUD thumbnail.
 */
export function RecordingCameraBubble({
  stream,
  corner = "bottom-right",
  onCornerChange,
}: {
  stream: MediaStream;
  corner?: Corner;
  onCornerChange?: (c: Corner) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [side, setSide] = useState<Corner>(corner);

  useEffect(() => {
    setSide(corner);
  }, [corner]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    // Do not applyConstraints here — same stream is recorded; downscaling
    // the track would pixelate the camera take for the whole session.
    void v.play();
  }, [stream]);

  const toggle = () => {
    const next: Corner = side === "bottom-right" ? "bottom-left" : "bottom-right";
    setSide(next);
    onCornerChange?.(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title="Click to flip left / right"
      className={cn(
        "fixed z-[60] overflow-hidden rounded-full border border-white/20 bg-black shadow-[0_20px_50px_-12px_rgba(0,0,0,0.75)] ring-2 ring-white/10 transition-all hover:ring-primary/50",
        "h-[132px] w-[132px] sm:h-[152px] sm:w-[152px]",
        side === "bottom-right" ? "bottom-24 right-6" : "bottom-24 left-6",
      )}
    >
      <video
        ref={ref}
        muted
        playsInline
        className="h-full w-full object-cover"
        style={{ transform: "scaleX(-1)" }}
      />
      <span className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[10px] font-medium text-white/80">
        Flip side
      </span>
    </button>
  );
}
