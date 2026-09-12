import { useMemo, useState } from "react";
import { Download, Loader2, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { exportCanvasSize, exportProject, exportSupported } from "@/lib/studio/exporter";
import { useStudio } from "@/lib/studio/store";
import { useAccount } from "@/lib/account/AccountProvider";
import { shareVideoToChannel } from "@/lib/account/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { resolveBackgroundImageUrl } from "@/lib/studio/wallpapers";
import { logHomeActivity } from "@/lib/studio/homeActivity";

const LANDSCAPE: { label: string; edge: number }[] = [
  { label: "720p", edge: 1280 },
  { label: "1080p", edge: 1920 },
  { label: "1440p", edge: 2560 },
  { label: "4K", edge: 3840 },
];
const PORTRAIT: { label: string; edge: number }[] = [
  { label: "720×1280", edge: 1280 },
  { label: "1080×1920", edge: 1920 },
  { label: "1440×2560", edge: 2560 },
];
const FPS = [24, 30, 60];
const QUALITY = [
  { value: "web", label: "Web" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { project, take } = useStudio();
  const { signedIn, signIn, requireFeature, features } = useAccount();
  const vertical = project.frame.ratio === "9:16";
  const sizes = vertical ? PORTRAIT : LANDSCAPE;
  const watermark = !(features.watermarkFree ?? false);
  const [edge, setEdge] = useState(1280);
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<(typeof QUALITY)[number]["value"]>("high");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<"download" | "share">("download");
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const dims = useMemo(() => {
    if (!take) return null;
    return exportCanvasSize(project, take, edge);
  }, [project, take, edge]);

  const pickEdge = (next: number) => {
    setEdge(next);
  };

  const renderBlob = async () => {
    if (!take) return null;
    if (!exportSupported()) {
      toast.error("This browser can't encode video. Try Chrome or Edge.");
      return null;
    }
    if (edge > 1280 && !requireFeature("export4k", "HD and 4K export")) {
      return null;
    }
    const bgUrl = resolveBackgroundImageUrl(project.background);
    const bgImage = bgUrl ? await loadImage(bgUrl) : null;
    const camImage = project.camera.backgroundImageUrl
      ? await loadImage(project.camera.backgroundImageUrl)
      : null;
    return exportProject(
      project,
      take,
      { backgroundImage: bgImage, cameraBackgroundImage: camImage },
      {
        width: edge,
        fps,
        quality,
        watermark,
        onProgress: setProgress,
      },
    );
  };

  const runDownload = async () => {
    setBusy(true);
    setProgress(0);
    setShareUrl(null);
    try {
      const blob = await renderBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        vertical
          ? "Vertical export finished"
          : watermark
            ? "Export finished (with watermark)"
            : "Export finished",
      );
      logHomeActivity(
        "export",
        vertical ? "Exported vertical MP4" : "Exported MP4",
        project.name,
      );
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const runShare = async () => {
    if (!signedIn) {
      toast.message("Sign in to share", {
        description: "Opens your browser to sign in.",
        action: { label: "Sign in", onClick: () => void signIn() },
      });
      return;
    }
    if (!requireFeature("shareLinks", "Sharing")) return;

    setBusy(true);
    setProgress(0);
    setShareUrl(null);
    try {
      const blob = await renderBlob();
      if (!blob) return;
      const result = await shareVideoToChannel({
        blob,
        title: project.name,
        slug: project.name,
      });
      setShareUrl(result.channelUrl);
      try {
        await navigator.clipboard.writeText(result.channelUrl);
        toast.success("Shared — link copied");
      } catch {
        toast.success("Shared to your channel");
      }
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Share failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? null : onOpenChange(v))}>
      <DialogContent className="max-w-[420px] border-hairline bg-panel">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            Export{vertical ? " · Vertical" : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {vertical && (
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Portrait export — zooms are reframed for vertical video.
            </p>
          )}
          <Group label="Destination">
            <Chip active={mode === "download"} onClick={() => setMode("download")}>
              Download
            </Chip>
            <Chip active={mode === "share"} onClick={() => setMode("share")}>
              Share online
            </Chip>
          </Group>
          {mode === "share" ? (
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Optional cloud share (requires sign-in). Local download always works offline.
            </p>
          ) : null}
          <Group label="Resolution">
            {sizes.map((s) => (
              <Chip
                key={s.edge}
                active={edge === s.edge}
                onClick={() => pickEdge(s.edge)}
              >
                {s.label}
              </Chip>
            ))}
          </Group>
          {dims && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              Output {dims.width}×{dims.height}
            </p>
          )}
          <Group label="Frame rate">
            {FPS.map((f) => (
              <Chip key={f} active={fps === f} onClick={() => setFps(f)}>
                {f} fps
              </Chip>
            ))}
          </Group>
          <Group label="Quality">
            {QUALITY.map((q) => (
              <Chip key={q.value} active={quality === q.value} onClick={() => setQuality(q.value)}>
                {q.label}
              </Chip>
            ))}
          </Group>

          {busy && (
            <div className="space-y-2">
              <Progress value={progress * 100} />
              <p className="text-[11px] text-muted-foreground">
                {mode === "share" ? "Rendering & uploading" : "Rendering frame-by-frame"} ·{" "}
                {Math.round(progress * 100)}%
              </p>
            </div>
          )}

          {shareUrl ? (
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              className="block break-all rounded-md bg-panel-raised px-3 py-2 font-mono text-[11px] text-ember hover:underline"
            >
              {shareUrl}
            </a>
          ) : null}

          <button
            onClick={() => void (mode === "share" ? runShare() : runDownload())}
            disabled={busy || !take}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-royal-grad py-2.5 text-[13px] font-semibold disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "share" ? (
              <Share2 className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {busy
              ? mode === "share"
                ? "Sharing…"
                : "Rendering…"
              : mode === "share"
                ? "Share to channel"
                : "Render MP4"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  muted,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-royal-grad"
          : muted
            ? "bg-panel-raised text-muted-foreground/60 hover:text-muted-foreground"
            : "bg-panel-raised text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
