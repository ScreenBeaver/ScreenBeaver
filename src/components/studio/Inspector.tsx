import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Image as ImageIcon,
  MousePointer2,
  Search,
  Video,
  Volume2,
  MessageSquare,
  AudioLines,
  Command,
  Share2,
  RotateCcw,
  Upload,
  Sparkles,
  SlidersHorizontal,
  Clapperboard,
  Crop,
  Film,
} from "lucide-react";
import { WALLPAPERS, ensureWallpaperThumb, wallpaperSwatchCss } from "@/lib/studio/wallpapers";
import { MOTION_BACKGROUNDS } from "@/lib/studio/motionBackgrounds";
import {
  DEVICE_FRAMES,
  getDeviceFrame,
  getDeviceColor,
} from "@/lib/studio/deviceFrames";
import { useAccount } from "@/lib/account/AccountProvider";
import {
  SCENE_EFFECT_KINDS,
  SCENE_EFFECT_META,
  createEffectBundle,
} from "@/lib/studio/sceneEffects";
import {
  defaultSoundDuration,
  effectUsesShimmer,
  newSoundId,
} from "@/lib/studio/soundTrack";
import { playClick, playEdit, playToggle, playSoundKind } from "@/lib/studio/sounds";
import { useStudio, DEFAULT_PROJECT, formatTimecode } from "@/lib/studio/store";
import { getVideoSegments, segmentSpeed } from "@/lib/studio/videoEdit";
import { segmentationFailed } from "@/lib/studio/segmenter";
import type {
  BackgroundMode,
  CameraPosition,
  CursorStyleOverride,
  SceneEffectKind,
} from "@/lib/studio/types";
import { downloadSrt, supportsBrowserSpeech, transcribeLocalAudio, normalizeCaptionCues } from "@/lib/studio/transcript";
import {
  defaultVoiceForLang,
  fetchEdgeVoices,
  filterVoicesForLang,
  localesFromVoices,
  type EdgeLangOption,
  type EdgeVoiceOption,
} from "@/lib/studio/edgeTts";
import { translateCaptionCues, VOICEOVER_LANGS } from "@/lib/studio/translate";
import { generateVoiceoverFromCaptions } from "@/lib/studio/voiceoverGenerate";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CropEditor } from "@/components/studio/CropEditor";
import { FULL_CROP, cropPixelSize, isFullCrop } from "@/lib/studio/crop";

function PanelHeader({
  icon: Icon,
  title,
  trailing,
}: {
  icon: typeof ImageIcon;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2.5 border-b border-hairline bg-shell/80 backdrop-blur-sm px-3 py-2">
      <Icon className="h-[13px] w-[13px] shrink-0 text-ember" strokeWidth={2} />
      <h2 className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/80">
        {title}
      </h2>
      {trailing}
    </div>
  );
}

function Row({
  label,
  children,
  onReset,
}: {
  label: string;
  children: ReactNode;
  onReset?: () => void;
}) {
  return (
    <div className="min-w-0 px-3 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        {onReset && (
          <button
            onClick={onReset}
            className="shrink-0 text-[10px] text-muted-foreground transition-colors hover:text-ember"
          >
            Reset
          </button>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium leading-snug">{label}</p>
        {hint && <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={(v) => {
          playToggle(v);
          onChange(v);
        }}
        className="shrink-0"
      />
    </div>
  );
}

function SegTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mx-3 flex gap-0 border-b border-hairline">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => {
            playClick();
            onChange(o.value);
          }}
          className={cn(
            "relative px-2.5 py-1.5 text-[11px] font-medium transition-colors",
            value === o.value
              ? "text-ember"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {value === o.value && (
            <span className="absolute inset-x-1 -bottom-px h-[2px] rounded-t bg-ember" />
          )}
        </button>
      ))}
    </div>
  );
}

function WallpaperSwatch({
  wallpaper,
  active,
  onPick,
}: {
  wallpaper: (typeof WALLPAPERS)[number];
  active: boolean;
  onPick: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    const url = wallpaper.imageUrl;
    if (!url) return;
    let cancelled = false;
    void ensureWallpaperThumb(url).then((data) => {
      if (!cancelled && data) setThumb(data);
    });
    return () => {
      cancelled = true;
    };
  }, [wallpaper.imageUrl]);

  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={wallpaper.label ?? wallpaper.id}
      title={wallpaper.label ?? wallpaper.id}
      className={cn(
        "aspect-square rounded-sm bg-cover bg-center transition-shadow ring-1 ring-hairline",
        active ? "clip-selected" : "hover:ring-ember/40",
      )}
      style={{ backgroundImage: wallpaperSwatchCss(wallpaper, thumb) }}
    />
  );
}

function BackgroundPanel() {
  const { project, patchBackground, patchFrame, take, clock } = useStudio();
  const bg = project.background;
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const crop = project.frame.crop;
  const cropPx =
    take && !isFullCrop(crop) ? cropPixelSize(crop, take.width, take.height) : null;

  return (
    <>
      <PanelHeader
        icon={ImageIcon}
        title="Background"
        trailing={
          <div className="flex items-center gap-1 text-muted-foreground">
            <button type="button" className="rounded p-1 hover:bg-accent hover:text-ember" title="Filters">
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="rounded p-1 hover:bg-accent hover:text-ember" title="Search">
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />
      <SegTabs<BackgroundMode>
        value={bg.mode === "motion" ? "wallpaper" : bg.mode}
        onChange={(mode) => {
          // Always leave motion when picking a static backdrop mode.
          if (mode === "wallpaper") {
            patchBackground({
              mode: "wallpaper",
              wallpaperId: bg.wallpaperId || "sunbeam",
            });
          } else {
            patchBackground({ mode });
          }
        }}
        options={[
          { value: "wallpaper", label: "Wallpaper" },
          { value: "gradient", label: "Gradient" },
          { value: "color", label: "Color" },
          { value: "image", label: "Image" },
        ]}
      />

      <div className="mx-4 mt-3 rounded-lg bg-panel-raised px-3 py-3">
        <p className="text-[12px] font-semibold tracking-tight text-foreground">Crop your recording</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          Focus on a specific part of your screen or hide parts of the UI.
        </p>
        <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
          {cropPx
            ? `Active · ${cropPx.width}×${cropPx.height}px`
            : take
              ? "Full frame"
              : "Record or import a take first"}
        </p>
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            disabled={!take}
            onClick={() => setCropOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-background px-2.5 py-1.5 text-[11.5px] font-medium ring-1 ring-hairline transition-colors hover:bg-accent disabled:opacity-40"
          >
            <Crop className="h-3.5 w-3.5" />
            {isFullCrop(crop) ? "Open crop tool" : "Edit crop"}
          </button>
          {!isFullCrop(crop) && (
            <button
              type="button"
              onClick={() => {
                patchFrame({ crop: { ...FULL_CROP } });
                toast.message("Crop reset to full frame");
              }}
              className="rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {take && (
        <CropEditor
          open={cropOpen}
          onOpenChange={setCropOpen}
          videoUrl={take.screenUrl}
          videoWidth={take.width}
          videoHeight={take.height}
          currentTime={clock.time}
          initialCrop={crop}
          onApply={(next) => {
            patchFrame({ crop: next });
            toast.success(
              isFullCrop(next)
                ? "Crop reset to full frame"
                : `Cropped to ${Math.round(next.w * take.width)}×${Math.round(next.h * take.height)}`,
            );
          }}
        />
      )}

      {bg.mode === "motion" && (
        <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Motion background is on — open Motion to change it, or pick a wallpaper below.
        </p>
      )}

      {(bg.mode === "wallpaper" || bg.mode === "motion") && (
        <div className="px-3.5 pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">Media</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {WALLPAPERS.length} items
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {WALLPAPERS.map((w) => (
              <WallpaperSwatch
                key={w.id}
                wallpaper={w}
                active={bg.mode === "wallpaper" && bg.wallpaperId === w.id}
                onPick={() => patchBackground({ wallpaperId: w.id, mode: "wallpaper" })}
              />
            ))}
          </div>
          <p className="mt-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
            Photo wallpapers and a few soft gradients. Animated ones are under Motion.
          </p>
        </div>
      )}

      {bg.mode === "gradient" && (
        <div className="space-y-1 pt-3">
          <div className="flex items-center gap-3 px-4 py-2">
            <label className="flex-1 text-[12px] text-muted-foreground">From</label>
            <input
              type="color"
              value={bg.gradientFrom}
              onChange={(e) => patchBackground({ gradientFrom: e.target.value })}
              className="h-7 w-12 cursor-pointer rounded-md border border-border bg-transparent"
            />
          </div>
          <div className="flex items-center gap-3 px-4 py-2">
            <label className="flex-1 text-[12px] text-muted-foreground">To</label>
            <input
              type="color"
              value={bg.gradientTo}
              onChange={(e) => patchBackground({ gradientTo: e.target.value })}
              className="h-7 w-12 cursor-pointer rounded-md border border-border bg-transparent"
            />
          </div>
          <Row label={`Angle · ${bg.gradientAngle}°`}>
            <Slider
              value={[bg.gradientAngle]}
              max={360}
              step={1}
              onValueChange={([v]) => patchBackground({ gradientAngle: v })}
            />
          </Row>
        </div>
      )}

      {bg.mode === "color" && (
        <div className="flex items-center gap-3 px-4 pt-4">
          <span className="flex-1 text-[12px] text-muted-foreground">Solid color</span>
          <input
            type="color"
            value={bg.color}
            onChange={(e) => patchBackground({ color: e.target.value })}
            className="h-8 w-16 cursor-pointer rounded-md border border-border bg-transparent"
          />
        </div>
      )}

      {bg.mode === "image" && (
        <div className="space-y-1 px-4 pt-4">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-input py-6 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Upload className="h-4 w-4" />
            {bg.imageUrl ? "Replace image" : "Choose an image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) patchBackground({ imageUrl: URL.createObjectURL(f) });
            }}
          />
          <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
            Use the blur slider below to soften the image.
          </p>
        </div>
      )}

      <Row
        label={`Background blur · ${bg.blur}%`}
        onReset={() => patchBackground({ blur: 0 })}
      >
        <Slider
          value={[bg.blur]}
          max={100}
          step={1}
          onValueChange={([v]) => patchBackground({ blur: v })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Softens the background. Stronger on images.
        </p>
      </Row>

      <div className="mx-4 my-2 h-px bg-hairline" />

      <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Device frame
      </p>
      <p className="px-4 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        Phone or tablet frame around the recording. Chosen automatically for Android takes — change anytime.
      </p>
      <div className="mx-4 mb-2 max-h-[160px] space-y-1 overflow-y-auto rounded-lg bg-panel-raised p-1">
        {DEVICE_FRAMES.map((f) => {
          const active = (project.frame.deviceFrameId || "none") === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                playToggle(true);
                patchFrame({
                  deviceFrameId: f.id,
                  deviceColorId: f.defaultColor,
                  ...(f.id !== "none"
                    ? {
                        chrome: "none" as const,
                        nativeChromeCrop: 0,
                        taskbarCrop: 0,
                        ratio: f.kind === "tablet" ? ("4:3" as const) : ("9:16" as const),
                        padding: Math.min(project.frame.padding, 18),
                      }
                    : {}),
                });
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate font-medium">{f.name}</span>
              {f.brand ? (
                <span className="shrink-0 text-[10px] opacity-60">{f.brand}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {(project.frame.deviceFrameId || "none") !== "none" && (
        <>
          <Row label="Frame color">
            <div className="flex flex-wrap gap-1.5">
              {getDeviceFrame(project.frame.deviceFrameId).colors.map((c) => {
                const active = (project.frame.deviceColorId || "black") === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.name}
                    onClick={() => {
                      playToggle(true);
                      patchFrame({ deviceColorId: c.id });
                    }}
                    className={cn(
                      "h-7 w-7 rounded-full border-2 transition-transform",
                      active ? "scale-110 border-ember" : "border-transparent hover:scale-105",
                    )}
                    style={{ background: c.body, boxShadow: `inset 0 0 0 1px ${c.rim}` }}
                  />
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {getDeviceColor(
                getDeviceFrame(project.frame.deviceFrameId),
                project.frame.deviceColorId,
              ).name}
            </p>
          </Row>
        </>
      )}

      <div className="mx-4 my-2 h-px bg-hairline" />

      <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Shape
      </p>
      <Row
        label={`Padding · ${project.frame.padding}%`}
        onReset={() => patchFrame({ padding: DEFAULT_PROJECT.frame.padding })}
      >
        <Slider
          value={[project.frame.padding]}
          max={100}
          step={1}
          onValueChange={([v]) => patchFrame({ padding: v })}
        />
      </Row>
      <Row
        label={`Corner radius · ${project.frame.radius}%`}
        onReset={() => patchFrame({ radius: DEFAULT_PROJECT.frame.radius })}
      >
        <Slider
          value={[project.frame.radius]}
          max={100}
          step={1}
          onValueChange={([v]) => patchFrame({ radius: v })}
        />
      </Row>
      <Row
        label={`Shadow · ${project.frame.shadow}%`}
        onReset={() => patchFrame({ shadow: DEFAULT_PROJECT.frame.shadow })}
      >
        <Slider
          value={[project.frame.shadow]}
          max={100}
          step={1}
          onValueChange={([v]) => patchFrame({ shadow: v })}
        />
      </Row>
      <p className="px-4 pb-1 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Window header
      </p>
      <div className="mx-4 mb-2 grid grid-cols-2 gap-1 rounded-lg bg-panel-raised p-1">
        {(
          [
            ["dark", "Dark"],
            ["light", "Light"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              playToggle(true);
              patchFrame({ chromeTheme: value });
            }}
            className={cn(
              "rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              (project.frame.chromeTheme ?? "dark") === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="px-4 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        Light for daytime demos, dark for a night look.
      </p>
      <div className="mx-4 mb-2 grid grid-cols-2 gap-1 rounded-lg bg-panel-raised p-1 sm:grid-cols-4">
        {(
          [
            ["none", "None"],
            ["browser", "Browser"],
            ["mac", "macOS"],
            ["windows", "Windows"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              playToggle(true);
              const patch: Partial<typeof project.frame> = { chrome: value };
              // Switching to clean browser chrome: hide the real tabs/URL by default
              if (value === "browser" && (project.frame.nativeChromeCrop ?? 0) < 0.04) {
                patch.nativeChromeCrop = 0.11;
              }
              if (value === "none") patch.nativeChromeCrop = project.frame.nativeChromeCrop;
              patchFrame(patch);
            }}
            className={cn(
              "rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              project.frame.chrome === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="px-4 pb-1 text-[11px] leading-relaxed text-muted-foreground">
        {project.frame.chrome === "none"
          ? "No window chrome — only the recording."
          : project.frame.chrome === "browser"
            ? "Address bar only — no tabs. Crop real browser chrome below if needed."
            : "Title bar drawn above your recording."}
      </p>

      {project.frame.chrome === "browser" && (
        <div className="space-y-2 px-4 pb-3">
          <label className="block text-[11px] text-muted-foreground">Address / search</label>
          <input
            value={project.frame.browserUrl ?? ""}
            onChange={(e) => patchFrame({ browserUrl: e.target.value })}
            onBlur={() => playEdit()}
            placeholder="yoursite.com/demo"
            className="w-full rounded-md bg-panel-raised px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          <label className="block text-[11px] text-muted-foreground">Site label (optional)</label>
          <input
            value={project.frame.browserSiteName ?? ""}
            onChange={(e) => patchFrame({ browserSiteName: e.target.value })}
            onBlur={() => playEdit()}
            placeholder="Acme"
            className="w-full rounded-md bg-panel-raised px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      {(project.frame.chrome === "mac" || project.frame.chrome === "windows") && (
        <div className="px-4 pb-3">
          <input
            value={project.frame.windowTitle}
            onChange={(e) => patchFrame({ windowTitle: e.target.value })}
            onBlur={() => playEdit()}
            placeholder="Window title"
            className="w-full rounded-md bg-panel-raised px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      <Row
        label={`Hide native header · ${Math.round((project.frame.nativeChromeCrop ?? 0) * 100)}%`}
        onReset={() => patchFrame({ nativeChromeCrop: 0 })}
      >
        <Slider
          value={[Math.round((project.frame.nativeChromeCrop ?? 0) * 100)]}
          max={30}
          step={1}
          onValueChange={([v]) => patchFrame({ nativeChromeCrop: v / 100 })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Crops real browser tabs or the OS title bar so only your frame chrome shows.
        </p>
      </Row>
      <Row
        label={`Hide taskbar · ${Math.round((project.frame.taskbarCrop ?? 0) * 100)}%`}
        onReset={() => patchFrame({ taskbarCrop: 0 })}
      >
        <Slider
          value={[Math.round((project.frame.taskbarCrop ?? 0) * 100)]}
          max={12}
          step={1}
          onValueChange={([v]) => patchFrame({ taskbarCrop: v / 100 })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Crops the Windows taskbar from full-screen recordings.
        </p>
      </Row>
    </>
  );
}

function MotionPanel() {
  const { project, patchBackground } = useStudio();
  const bg = project.background;
  const active = bg.mode === "motion";
  return (
    <>
      <PanelHeader icon={Sparkles} title="Motion" />
      <Toggle
        label="Use motion background"
        hint="Moving color backgrounds synced to the timeline"
        checked={active}
        onChange={(on) =>
          patchBackground({
            mode: on ? "motion" : "wallpaper",
            motionId: bg.motionId ?? "ribbon-field",
          })
        }
      />
      <div className="px-3.5 pb-4 pt-2">
        <div className="grid grid-cols-2 gap-1.5">
          {MOTION_BACKGROUNDS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                playToggle(true);
                patchBackground({ motionId: m.id, mode: "motion" });
              }}
              className={cn(
                "overflow-hidden rounded-sm border text-left transition-shadow",
                active && (bg.motionId ?? "ribbon-field") === m.id
                  ? "clip-selected border-transparent"
                  : "border-hairline hover:ring-1 hover:ring-ember/40",
              )}
            >
              <div className="h-14 w-full" style={{ backgroundImage: m.previewCss }} />
              <p className="px-2 py-1.5 text-[10.5px] font-medium">{m.label}</p>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Soft moving color backgrounds.
        </p>
      </div>
    </>
  );
}

function EffectsPanel() {
  const { requireFeature } = useAccount();
  const {
    take,
    project,
    clock,
    addEffect,
    addZoom,
    addMove,
    addSound,
    beginHistoryBatch,
    endHistoryBatch,
    setSelectedEffect,
    setSelectedZoom,
    setSelectedMove,
    setSelectedSound,
    setSelectedCaption,
  } = useStudio();

  const groups = ["3D", "Zoom", "Light"] as const;

  const insertEffect = (kind: SceneEffectKind) => {
    if (!requireFeature("effects", "Effects")) return;
    if (!take) {
      toast.message("Add a recording first", {
        description: "Effects need a screen recording on the timeline.",
      });
      return;
    }
    const meta = SCENE_EFFECT_META[kind];
    const trimStart = project.trim.start || 0;
    const trimEnd = project.trim.end > 0 ? project.trim.end : take.duration;
    const t = Math.min(
      Math.max(clock.time, trimStart),
      Math.max(trimStart, trimEnd - meta.duration),
    );
    const cursor = take.cursor;
    let fx = 0.5;
    let fy = 0.42;
    if (cursor.length) {
      let best = cursor[0]!;
      let bestD = Math.abs(best.t - t);
      for (const s of cursor) {
        const d = Math.abs(s.t - t);
        if (d < bestD) {
          best = s;
          bestD = d;
        }
      }
      fx = best.x;
      fy = best.y;
    }
    const bundle = createEffectBundle(kind, t, { x: fx, y: fy }, project.zoom?.autoScale ?? 2.15);
    beginHistoryBatch();
    addEffect(bundle.effect);
    for (const z of bundle.zooms) addZoom(z);
    for (const m of bundle.moves) addMove(m);
    endHistoryBatch();
    playSoundKind(effectUsesShimmer(kind) ? "shimmer" : "whoosh", {
      duration: effectUsesShimmer(kind) ? 2.8 : 0.55,
    });
    if (effectUsesShimmer(kind)) {
      addSound({
        id: newSoundId("shimmer", t),
        kind: "shimmer",
        time: t,
        duration: defaultSoundDuration("shimmer"),
      });
    }
    setSelectedEffect(bundle.effect.id);
    setSelectedZoom(bundle.zooms[0]?.id ?? null);
    setSelectedMove(null);
    setSelectedSound(null);
    setSelectedCaption(null);
    playClick();
    toast.success(`${meta.label} added`, {
      description: `At ${t.toFixed(1)}s on the effects track`,
    });
  };

  return (
    <>
      <PanelHeader icon={Clapperboard} title="Effects" />
      <p className="px-4 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        Drop an effect at the playhead — 3D moves, light, and zoom punches.
      </p>
      {groups.map((group) => {
        const items = SCENE_EFFECT_KINDS.filter((k) => SCENE_EFFECT_META[k].group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="px-3.5 pb-3">
            <p className="mb-1.5 px-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              {group}
            </p>
            <div className="space-y-1">
              {items.map((kind) => {
                const meta = SCENE_EFFECT_META[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={!take}
                    onClick={() => insertEffect(kind)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md border border-hairline bg-shell px-2.5 py-2 text-left transition-colors",
                      take
                        ? "hover:border-ember/40 hover:bg-accent"
                        : "cursor-not-allowed opacity-45",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-foreground">{meta.label}</span>
                      {meta.shortcut ? (
                        <span className="font-mono text-[9px] text-muted-foreground">{meta.shortcut}</span>
                      ) : null}
                    </span>
                    <span className="text-[10.5px] leading-snug text-muted-foreground">{meta.blurb}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function CursorPanel() {
  const { project, patchCursor } = useStudio();
  const c = project.cursor;
  const style = c.style ?? "auto";
  const styles: { id: CursorStyleOverride; label: string }[] = [
    { id: "auto", label: "Auto" },
    { id: "arrow", label: "Arrow" },
    { id: "hand", label: "Hand" },
    { id: "ibeam", label: "I-beam" },
    { id: "cross", label: "Cross" },
    { id: "move", label: "Move" },
    { id: "wait", label: "Wait" },
  ];
  return (
    <>
      <PanelHeader icon={MousePointer2} title="Cursor" />
      <Toggle
        label="Show smoothed cursor"
        hint="Uses the recorded system cursor shape, drawn larger in the editor"
        checked={c.visible}
        onChange={(visible) => patchCursor({ visible })}
      />
      <Row label="Cursor style" onReset={() => patchCursor({ style: "auto" })}>
        <div className="grid grid-cols-4 gap-1">
          {styles.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                playToggle(true);
                patchCursor({ style: s.id });
              }}
              className={cn(
                "rounded-md px-1.5 py-1.5 text-[11px] font-medium transition-colors",
                style === s.id
                  ? "bg-background text-foreground shadow-sm ring-1 ring-hairline"
                  : "bg-panel-raised text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Auto follows the recorded cursor. Text and cell cursors stay clearer while typing.
        </p>
      </Row>
      <Row label={`Motion smoothing · ${c.smoothing}%`} onReset={() => patchCursor({ smoothing: 72 })}>
        <Slider
          value={[c.smoothing]}
          max={100}
          step={1}
          onValueChange={([v]) => patchCursor({ smoothing: v })}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Higher values smooth more and trail further behind. Zoom follows this same path.
        </p>
      </Row>
      <Row label={`Size · ${c.size}%`} onReset={() => patchCursor({ size: 100 })}>
        <Slider
          value={[c.size]}
          min={40}
          max={300}
          step={1}
          onValueChange={([v]) => patchCursor({ size: v })}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          100% is about OS size (slightly larger). Drag up for a bold demo cursor.
        </p>
      </Row>
      <Toggle
        label="Click ripple"
        checked={c.clickRipple}
        onChange={(clickRipple) => patchCursor({ clickRipple })}
      />
      <Toggle
        label="Automatically hide static cursor"
        hint="Arrow fades when idle. Text and cell cursors stay visible so typing stays readable"
        checked={c.autoHideIdle}
        onChange={(autoHideIdle) => patchCursor({ autoHideIdle })}
      />
    </>
  );
}

function ZoomPanel() {
  const {
    project,
    patchZoom,
    selectedZoom,
    setSelectedZoom,
    updateZoom,
    removeZoom,
    addZoom,
    clock,
    take,
    regenerateAutoZooms,
    setPickingFocus,
    pickingFocus,
  } = useStudio();
  const zset = project.zoom ?? { enabled: true, mode: "auto" as const, autoScale: 2.15 };
  const selected = project.zooms.find((z) => z.id === selectedZoom) ?? null;

  const addManual = () => {
    if (!take) return;
    const id = `z-${Date.now()}`;
    const t = clock.time;
    addZoom({
      id,
      time: t,
      duration: Math.min(2.8, Math.max(1.5, take.duration - t)),
      scale: zset.autoScale,
      x: 0.5,
      y: 0.5,
      followCursor: false,
      auto: false,
    });
    setSelectedZoom(id);
    setPickingFocus(true);
    patchZoom({ mode: "manual", enabled: true });
  };

  return (
    <>
      <PanelHeader icon={Search} title="Zoom" />
      <Toggle
        label="Enable zoom"
        hint="Turn off to preview or export without zooms"
        checked={zset.enabled}
        onChange={(enabled) => patchZoom({ enabled })}
      />

      <div className="mx-4 mb-3 grid grid-cols-2 gap-1 rounded-lg bg-panel-raised p-1">
        {(["auto", "manual"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => {
              patchZoom({ mode, enabled: true });
              if (mode === "auto" && take) regenerateAutoZooms();
            }}
            className={cn(
              "rounded-md px-2 py-1.5 text-[11px] font-medium capitalize transition-colors",
              zset.mode === mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {mode}
          </button>
        ))}
      </div>

      {zset.mode === "auto" ? (
        <div className="space-y-3 px-4 pb-3">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Soft on clicks; stronger on typing and menus. Nearby zooms merge into one; farther ones stay separate.
          </p>
          <Row
            label={`Intensity bias · ${zset.autoScale.toFixed(1)}×`}
            onReset={() => patchZoom({ autoScale: 1.85 })}
          >
            <Slider
              value={[zset.autoScale * 100]}
              min={150}
              max={260}
              step={5}
              onValueChange={([v]) => patchZoom({ autoScale: v / 100 })}
            />
          </Row>
          <p className="px-0 text-[10.5px] leading-relaxed text-muted-foreground">
            Raises or lowers every auto zoom. Regenerate to apply.
          </p>
          <button
            type="button"
            disabled={!take}
            onClick={() => regenerateAutoZooms()}
            className="w-full rounded-lg bg-panel-raised py-2 text-[12px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
          >
            Regenerate auto zooms &amp; camera
          </button>
        </div>
      ) : (
        <div className="space-y-3 px-4 pb-3">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Place zooms yourself. Switch to Auto if you want them added for you.
          </p>
          <button
            type="button"
            disabled={!take}
            onClick={addManual}
            className="w-full rounded-lg bg-primary py-2 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
          >
            Add zoom at playhead
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => setPickingFocus(true)}
            className={cn(
              "w-full rounded-lg py-2 text-[12px] font-medium transition-colors disabled:opacity-40",
              pickingFocus ? "bg-primary/20 text-foreground ring-1 ring-primary" : "bg-panel-raised hover:bg-accent",
            )}
          >
            {pickingFocus ? "Click the preview to set focus…" : "Pick focus on preview"}
          </button>
        </div>
      )}

      {selected && (
        <div className="mx-4 mb-4 space-y-3 rounded-lg border border-hairline bg-panel-raised/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Selected · {selected.auto ? "Auto" : "Manual"}
            </p>
            <button
              type="button"
              onClick={() => {
                removeZoom(selected.id);
                setSelectedZoom(null);
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Remove
            </button>
          </div>
          <Row label={`Scale · ${selected.scale.toFixed(1)}×`}>
            <Slider
              value={[selected.scale * 100]}
              min={120}
              max={350}
              step={5}
              onValueChange={([v]) => updateZoom(selected.id, { scale: v / 100, auto: false })}
            />
          </Row>
          <Row label={`Duration · ${selected.duration.toFixed(1)}s`}>
            <Slider
              value={[selected.duration * 10]}
              min={8}
              max={80}
              step={1}
              onValueChange={([v]) => updateZoom(selected.id, { duration: v / 10 })}
            />
          </Row>
          <Toggle
            label="Follow cursor"
            hint="Focus follows the cursor; off = fixed point"
            checked={selected.followCursor}
            onChange={(followCursor) => {
              updateZoom(selected.id, { followCursor, auto: false });
              if (!followCursor) setPickingFocus(true);
            }}
          />
          <p className="text-[10.5px] text-muted-foreground">
            Focus {selected.x.toFixed(2)}, {selected.y.toFixed(2)}
            {project.frame.ratio === "9:16" && " · Stronger in vertical export"}
          </p>
        </div>
      )}

      {!selected && project.zooms.length > 0 && (
        <div className="px-4 pb-3">
          <p className="mb-2 text-[11px] text-muted-foreground">
            {project.zooms.length} zoom clip{project.zooms.length === 1 ? "" : "s"} on the timeline
          </p>
          <button
            type="button"
            onClick={() => {
              const first = project.zooms[0];
              setSelectedZoom(first.id);
              clock.set(first.time);
            }}
            className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
          >
            Select first zoom
          </button>
        </div>
      )}

      {project.frame.ratio === "9:16" && (
        <p className="px-4 pb-4 text-[11px] leading-relaxed text-muted-foreground">
          Vertical mode — zooms are reframed for portrait export.
        </p>
      )}
    </>
  );
}

const POSITIONS: CameraPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

function CameraPanel() {
  const { project, patchCamera, addMove, clock, take } = useStudio();
  const cam = project.camera;
  const fileRef = useRef<HTMLInputElement>(null);
  const position = cam.position ?? (cam.corner as CameraPosition) ?? "bottom-left";
  const roundness = cam.roundness ?? (cam.shape === "circle" ? 100 : cam.shape === "square" ? 0 : 40);

  return (
    <>
      <PanelHeader icon={Video} title="Camera" />
      <Toggle
        label="Hide camera"
        hint="Hide the webcam overlay in preview and export"
        checked={!cam.enabled}
        onChange={(hide) => patchCamera({ enabled: !hide })}
      />
      <p className="px-4 pb-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Webcam overlay on the video. It shrinks during zooms so it stays out of the way.
      </p>

      <div className="px-4 py-2.5">
        <p className="mb-2 text-[12px] text-muted-foreground">Position</p>
        <div className="mx-auto grid w-[120px] grid-cols-3 gap-2">
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              type="button"
              aria-label={pos}
              onClick={() => {
                playClick();
                patchCamera({ position: pos });
              }}
              className={cn(
                "h-7 w-7 justify-self-center rounded-full transition-colors",
                position === pos
                  ? "bg-primary shadow-[0_0_0_3px_rgba(99,102,241,0.35)]"
                  : "bg-muted-foreground/35 hover:bg-muted-foreground/55",
              )}
            />
          ))}
        </div>
      </div>

      <Toggle label="Mirror camera" checked={cam.mirror} onChange={(mirror) => patchCamera({ mirror })} />

      <Row
        label={`Roundness · ${roundness}%`}
        onReset={() => patchCamera({ roundness: 100 })}
      >
        <Slider
          value={[roundness]}
          max={100}
          step={1}
          onValueChange={([v]) => patchCamera({ roundness: v })}
        />
      </Row>

      <Row
        label={`Size · ${cam.size}%`}
        onReset={() => patchCamera({ size: 18 })}
      >
        <Slider
          value={[cam.size]}
          min={8}
          max={44}
          step={1}
          onValueChange={([v]) => patchCamera({ size: v })}
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">Size when the recording is not zoomed</p>
      </Row>

      <Toggle
        label="Different size during zoom"
        hint="Camera shrinks during zooms so it doesn’t cover the action"
        checked={cam.shrinkDuringZoom !== false}
        onChange={(shrinkDuringZoom) => patchCamera({ shrinkDuringZoom })}
      />
      {cam.shrinkDuringZoom !== false && (
        <Row
          label={`Zoomed size · ${cam.sizeDuringZoom ?? 11}%`}
          onReset={() => patchCamera({ sizeDuringZoom: 11 })}
        >
          <Slider
            value={[cam.sizeDuringZoom ?? 11]}
            min={6}
            max={Math.max(8, cam.size)}
            step={1}
            onValueChange={([v]) => patchCamera({ sizeDuringZoom: v })}
          />
        </Row>
      )}

      <Toggle
        label="Avoid covering cursor"
        hint="Moves the camera aside when it covers the cursor"
        checked={cam.avoidCursor !== false}
        onChange={(avoidCursor) => patchCamera({ avoidCursor })}
      />
      <Toggle label="Drop shadow" checked={cam.shadow} onChange={(shadow) => patchCamera({ shadow })} />

      <div className="mx-4 my-2 h-px bg-hairline" />
      <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Camera background
      </p>
      <SegTabs
        value={cam.backgroundMode}
        onChange={(backgroundMode) => patchCamera({ backgroundMode })}
        options={[
          { value: "none" as const, label: "None" },
          { value: "blur" as const, label: "Blur" },
          { value: "color" as const, label: "Color" },
          { value: "image" as const, label: "Image" },
        ]}
      />
      {cam.backgroundMode === "color" && (
        <div className="flex items-center gap-3 px-4 pt-3">
          <span className="flex-1 text-[12px] text-muted-foreground">Backdrop</span>
          <input
            type="color"
            value={cam.backgroundColor}
            onChange={(e) => patchCamera({ backgroundColor: e.target.value })}
            className="h-7 w-14 cursor-pointer rounded-md border border-border bg-transparent"
          />
        </div>
      )}
      {cam.backgroundMode === "image" && (
        <div className="px-4 pt-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-lg border border-dashed border-input py-4 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {cam.backgroundImageUrl ? "Replace backdrop" : "Choose a backdrop"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) patchCamera({ backgroundImageUrl: URL.createObjectURL(f) });
            }}
          />
        </div>
      )}
      {cam.backgroundMode !== "none" && segmentationFailed() && (
        <p className="px-4 pt-2 text-[11px] text-destructive">
          Person segmentation could not load in this browser — showing the raw camera instead.
        </p>
      )}

      <div className="mx-4 my-2 h-px bg-hairline" />
      <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Add movement at playhead
      </p>
      <div className="grid grid-cols-2 gap-1.5 px-4 pb-4">
        {(
          [
            { kind: "arc-lr", label: "Arc left → right" },
            { kind: "arc-rl", label: "Arc right → left" },
            { kind: "orbit", label: "Orbit" },
            { kind: "dip", label: "Dip away" },
          ] as const
        ).map((m) => (
          <button
            key={m.kind}
            disabled={!take}
            onClick={() =>
              addMove({
                id: `m-${Date.now()}-${m.kind}`,
                time: clock.time,
                duration: 1.6,
                kind: m.kind,
              })
            }
            className="rounded-md bg-panel-raised px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            {m.label}
          </button>
        ))}
      </div>
    </>
  );
}

function ShortcutsPanel() {
  const {
    project,
    patchKeystrokes,
    setKeystrokeCues,
    updateKeystrokeCue,
    removeKeystrokeCue,
  } = useStudio();
  const ks = project.keystrokes ?? DEFAULT_PROJECT.keystrokes;
  const editorRows = [
    ["Ctrl + 1", "Hero zoom — punch in, hold, pull out"],
    ["Ctrl + 2", "3D tilt — camera from left, zoom in/out"],
    ["Ctrl + 3", "Focus zoom — tight follow on the cursor"],
    ["Ctrl + 4", "3D spin — orbit + zoom in/out"],
    ["Ctrl + 5", "Glare stripe — diagonal white shimmer only"],
    ["Ctrl + 6", "Mockup reveal — camera from right, zoom in/out"],
    ["Ctrl + 7", "Glare stripe — same as Ctrl+5, shimmer only (no 3D)"],
    ["Hold Alt", "Zoom in on the cursor for as long as Alt is held"],
    ["Shift + Click", "Punch in on the cursor (zoom keyframe)"],
    ["Ctrl + Click", "Zoom (desktop app / companion extension)"],
    ["Shift + Space", "Sweep the camera along a circular arc"],
    ["Crop", "Open the crop tool under the preview (or Background → Crop)"],
    ["Space", "Play / pause the timeline"],
    ["← / →", "Nudge the playhead 2 seconds"],
    ["Z", "Add a manual zoom at the playhead"],
    ["C", "Cut the video at the playhead (or the selected zoom / SFX / caption)"],
    ["Ctrl + Z", "Undo the last edit"],
    ["Ctrl + Shift + Z", "Redo the last undone edit"],
    ["Delete", "Remove the selected video clip, zoom, effect, or sound"],
  ];
  return (
    <>
      <PanelHeader icon={Command} title="Shortcuts" />
      <p className="px-4 pb-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Keyboard shortcuts you press while recording can show as keycaps in the video.
      </p>
      <Toggle
        label="Show shortcuts in video"
        checked={ks.enabled}
        onChange={(enabled) => patchKeystrokes({ enabled })}
      />
      <Toggle
        label="Burn into export"
        hint="Draw keycaps in the preview and MP4"
        checked={ks.burnIn}
        onChange={(burnIn) => patchKeystrokes({ burnIn })}
      />
      <Row label={`Size · ${ks.size}%`} onReset={() => patchKeystrokes({ size: 100 })}>
        <Slider
          value={[ks.size]}
          min={50}
          max={160}
          step={5}
          onValueChange={([v]) => patchKeystrokes({ size: v })}
        />
      </Row>
      <div className="px-3 py-1.5">
        <p className="mb-1.5 text-[12px] font-medium leading-snug">Position</p>
        <SegTabs
          value={ks.position}
          options={[
            { value: "bottom", label: "Bottom" },
            { value: "bottom-left", label: "Left" },
            { value: "bottom-right", label: "Right" },
            { value: "center", label: "Center" },
          ]}
          onChange={(position) => patchKeystrokes({ position })}
        />
      </div>

      <div className="mt-2 space-y-2 border-t border-hairline px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-foreground">
            Recorded · {ks.cues.length}
          </p>
          {ks.cues.length > 0 && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setKeystrokeCues([])}
            >
              Clear all
            </button>
          )}
        </div>
        {!ks.cues.length && (
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Record a take and press Ctrl+S, Alt+Tab, F5, Esc, and similar — they show up here.
          </p>
        )}
        {ks.cues.length > 0 && (
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {ks.cues.map((c) => (
              <div key={c.id} className="rounded-lg bg-panel-raised px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    {c.time.toFixed(2)}s · {c.duration.toFixed(1)}s
                  </p>
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => removeKeystrokeCue(c.id)}
                  >
                    Remove
                  </button>
                </div>
                <input
                  value={c.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    const keys = label.split("+").map((s) => s.trim()).filter(Boolean);
                    updateKeystrokeCue(c.id, { label, keys: keys.length ? keys : c.keys });
                  }}
                  className="mt-1 w-full bg-transparent text-[13px] font-medium outline-none"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-1 border-t border-hairline px-4 pb-4 pt-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          Editor cheat sheet
        </p>
        <div className="space-y-1">
          {editorRows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 py-1.5">
              <kbd className="shrink-0 rounded-md bg-panel-raised px-2 py-1 font-sans text-[11px] text-foreground">
                {k}
              </kbd>
              <span className="text-right text-[11.5px] leading-relaxed text-muted-foreground">{v}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Ctrl+1–7 work while recording (desktop app) and in the editor. For menus and right-clicks, use Entire screen.
        </p>
      </div>
    </>
  );
}

function AudioPanel() {
  const { project, setProject, take, patchMusic } = useStudio();
  const music = project.music;
  return (
    <>
      <PanelHeader icon={Volume2} title="Audio" />
      <Row label={`Default speed · ${project.speed.toFixed(2)}×`} onReset={() => setProject({ speed: 1 })}>
        <Slider
          value={[project.speed * 100]}
          min={50}
          max={200}
          step={5}
          onValueChange={([v]) => setProject({ speed: v / 100 })}
        />
      </Row>
      <p className="px-4 pb-1 text-[11px] leading-relaxed text-muted-foreground">
        Default speed for clips that don’t set their own. Select a clip on the timeline to change one clip.
      </p>
      <div className="space-y-2 px-4 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
        {!take?.micUrl && (
          <p>No audio in this take. Enable microphone and/or system audio before recording.</p>
        )}
        {take?.micUrl && (
          <>
            <p>
              {take.hasMicrophone ? "Microphone captured — plays with preview. " : "No microphone. "}
              {take.hasSystemAudio
                ? "System / tab audio was captured."
                : "No system audio — enable it and tick “Share audio” in the browser share dialog."}
            </p>
            <p>Mic and sound effects are mixed into the MP4 on export.</p>
            <audio src={take.micUrl} controls className="mt-1 w-full" />
          </>
        )}
      </div>
      <div className="mt-2 space-y-2 border-t border-hairline px-4 py-3">
        <p className="text-[12px] font-medium text-foreground">Background music</p>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Quiet track under the video. Volume dips under AI voiceover on export.
        </p>
        {music?.enabled && music.url ? (
          <>
            <p className="text-[11.5px] text-foreground">
              {music.title || "Track"}
              {music.creator ? ` · ${music.creator}` : ""}
            </p>
            {music.license ? (
              <p className="text-[10.5px] text-muted-foreground">{music.license}</p>
            ) : null}
            <Row
              label={`Volume · ${Math.round((music.volume ?? 0.16) * 100)}%`}
              onReset={() => patchMusic({ volume: 0.16 })}
            >
              <Slider
                value={[Math.round((music.volume ?? 0.16) * 100)]}
                min={4}
                max={40}
                step={1}
                onValueChange={([v]) => patchMusic({ volume: v / 100 })}
              />
            </Row>
            <button
              type="button"
              className="rounded-md bg-panel-raised px-2 py-1 text-[11px] font-medium hover:bg-accent"
              onClick={() =>
                patchMusic({
                  enabled: false,
                  url: null,
                  title: "",
                  creator: "",
                  license: "",
                  sourceId: undefined,
                })
              }
            >
              Clear music
            </button>
          </>
        ) : (
          <p className="text-[11.5px] text-muted-foreground">
            No music yet — import audio from Home, or drag a track onto the timeline.
          </p>
        )}
      </div>
    </>
  );
}

function CaptionsPanel() {
  const { requireFeature } = useAccount();
  const { project, take, patchCaptions, setCaptionCues } = useStudio();
  const caps = project.captions ?? { enabled: true, burnIn: true, fontSize: 36, cues: [] };
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const speechOk = supportsBrowserSpeech();

  const generate = async () => {
    if (!requireFeature("autoCaptions", "Auto captions")) return;
    setBusy(true);
    setStatus("Checking…");
    try {
      const cues = await transcribeLocalAudio(take?.micUrl || "", (p, label) => {
        setStatus(label || `${Math.round(p * 100)}%`);
      }, caps.cues.length ? caps.cues : undefined);
      setCaptionCues(cues);
      patchCaptions({ enabled: true, burnIn: true });
      toast.success(
        cues.length
          ? `${cues.length} caption${cues.length === 1 ? "" : "s"} from browser speech`
          : "No speech captured yet",
      );
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <>
      <PanelHeader icon={MessageSquare} title="Captions" />
      <p className="px-4 pb-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Captions come from speech recognition while you record with the mic on (Chrome or Edge).
        Language and AI voiceover are under AI Voiceover.
        {!speechOk && " This browser doesn’t support speech recognition."}
      </p>
      <Toggle
        label="Show captions"
        checked={caps.enabled}
        onChange={(enabled) => patchCaptions({ enabled })}
      />
      <Toggle
        label="Burn into video"
        hint="Draw captions in the preview and MP4 export"
        checked={caps.burnIn}
        onChange={(burnIn) => patchCaptions({ burnIn })}
      />
      <Row label={`Size · ${caps.fontSize}`} onReset={() => patchCaptions({ fontSize: 36 })}>
        <Slider
          value={[caps.fontSize]}
          min={22}
          max={64}
          step={1}
          onValueChange={([v]) => patchCaptions({ fontSize: v })}
        />
      </Row>

      <div className="space-y-2 px-4 pb-3 pt-1">
        <button
          type="button"
          disabled={busy || !speechOk}
          onClick={() => void generate()}
          className="w-full rounded-lg bg-primary py-2 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy ? status || "Working…" : caps.cues.length ? "Refresh from session" : "Use live captions"}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!caps.cues.length}
            onClick={() => {
              const dur = take?.duration;
              setCaptionCues(
                normalizeCaptionCues(
                  caps.cues.map((c) => ({
                    ...c,
                    start: c.start - 0.5,
                    end: c.end - 0.5,
                  })),
                  dur,
                ),
              );
              toast.message("Captions nudged 0.5s earlier");
            }}
            className="rounded-lg bg-panel-raised py-2 text-[11.5px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
          >
            ← Earlier 0.5s
          </button>
          <button
            type="button"
            disabled={!caps.cues.length}
            onClick={() => {
              const dur = take?.duration;
              setCaptionCues(
                normalizeCaptionCues(
                  caps.cues.map((c) => ({
                    ...c,
                    start: c.start + 0.5,
                    end: c.end + 0.5,
                  })),
                  dur,
                ),
              );
              toast.message("Captions nudged 0.5s later");
            }}
            className="rounded-lg bg-panel-raised py-2 text-[11.5px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
          >
            Later 0.5s →
          </button>
        </div>
        <button
          type="button"
          disabled={!caps.cues.length}
          onClick={() => downloadSrt(caps.cues, project.name || "captions")}
          className="w-full rounded-lg bg-panel-raised py-2 text-[12px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
        >
          Download .srt
        </button>
        <button
          type="button"
          disabled={!caps.cues.length}
          onClick={() => setCaptionCues([])}
          className="w-full rounded-lg py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Clear captions
        </button>
      </div>

      {caps.cues.length > 0 && (
        <div className="max-h-64 space-y-2.5 overflow-y-auto px-4 pb-4">
          {caps.cues.map((c) => (
            <div key={c.id} className="rounded-lg bg-panel-raised px-3 py-2.5">
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {c.start.toFixed(1)}s – {c.end.toFixed(1)}s
              </p>
              <textarea
                value={c.text}
                rows={2}
                onChange={(e) =>
                  setCaptionCues(
                    caps.cues.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)),
                  )
                }
                className="mt-1.5 w-full resize-none rounded bg-transparent text-[14px] leading-snug outline-none"
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function LangSelect({
  value,
  onChange,
  id,
  options,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  options: EdgeLangOption[];
  busy?: boolean;
}) {
  const list = options.length ? options : VOICEOVER_LANGS;
  const known = list.some((l) => l.code === value);
  return (
    <select
      id={id}
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
      className="w-full max-w-full truncate rounded-md bg-panel-raised px-2.5 py-2 text-[12.5px] outline-none ring-1 ring-transparent focus:ring-primary/40 disabled:opacity-50"
    >
      {busy && !options.length && <option>Loading languages…</option>}
      {!known && <option value={value}>{value}</option>}
      {list.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

function VoiceoverPanel() {
  const { requireFeature } = useAccount();
  const {
    project,
    patchVoiceover,
    setCaptionCues,
    setVoiceoverClips,
    clearVoiceoverClips,
  } = useStudio();
  const vo = project.voiceover ?? DEFAULT_PROJECT.voiceover;
  const cues = project.captions?.cues ?? [];
  const [allVoices, setAllVoices] = useState<EdgeVoiceOption[]>([]);
  const [langOptions, setLangOptions] = useState<EdgeLangOption[]>([]);
  const [voicesBusy, setVoicesBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // Load the full Edge TTS catalog once (every locale + voice).
  useEffect(() => {
    let cancelled = false;
    setVoicesBusy(true);
    void (async () => {
      try {
        const all = await fetchEdgeVoices();
        if (cancelled) return;
        setAllVoices(all);
        setLangOptions(localesFromVoices(all));
        const forLang = filterVoicesForLang(all, vo.targetLang);
        const stillValid = forLang.some((v) => v.shortName === vo.voice);
        if (!stillValid) {
          const next = await defaultVoiceForLang(vo.targetLang);
          if (!cancelled) patchVoiceover({ voice: next });
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setAllVoices([]);
          setLangOptions([]);
          toast.error(
            "Couldn't load Edge TTS voices. Use Microsoft Edge or the desktop app (WebView2).",
          );
        }
      } finally {
        if (!cancelled) setVoicesBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog load once on mount
  }, []);

  const onTargetLang = async (targetLang: string) => {
    patchVoiceover({ targetLang });
    try {
      const voice = await defaultVoiceForLang(targetLang);
      patchVoiceover({ voice });
    } catch {
      /* voices may still be loading */
    }
  };

  const onPickVoice = (shortName: string) => {
    const picked = allVoices.find((v) => v.shortName === shortName);
    patchVoiceover({
      voice: shortName,
      ...(picked ? { targetLang: picked.locale } : {}),
    });
  };

  const translate = async () => {
    if (!requireFeature("translation", "Caption translation")) return;
    if (!cues.length) {
      toast.error("No captions yet — record with the mic on first");
      return;
    }
    setBusy(true);
    setStatus("Translating…");
    try {
      const next = await translateCaptionCues(cues, vo.speakLang, vo.targetLang, (done, total) => {
        setStatus(`Translating ${done}/${total}…`);
      });
      setCaptionCues(next);
      toast.success(`Translated ${next.length} caption${next.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Translation failed");
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  const generate = async () => {
    if (!requireFeature("voiceover", "AI voiceover")) return;
    if (!cues.length) {
      toast.error("No captions to voice — add captions first");
      return;
    }
    setBusy(true);
    try {
      const result = await generateVoiceoverFromCaptions({
        cues,
        speakLang: vo.speakLang,
        targetLang: vo.targetLang,
        voice: vo.voice,
        onStatus: (message) => setStatus(message),
      });
      if (result.translated) setCaptionCues(result.cues);
      setVoiceoverClips(result.clips);
      patchVoiceover({ enabled: true, voice: result.voice, targetLang: result.targetLang });
      toast.success(
        result.clips.length
          ? `Generated ${result.clips.length} AI voiceover clip${result.clips.length === 1 ? "" : "s"}`
          : "No spoken captions to generate",
      );
    } catch (err) {
      console.error(err);
      toast.error(
        err instanceof Error
          ? err.message
          : "Edge TTS failed — try again in Microsoft Edge or the desktop app",
      );
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <>
      <PanelHeader icon={AudioLines} title="AI Voiceover" />
      <p className="px-4 pb-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Translate captions, then generate spoken audio. Mic audio is muted under those parts.
      </p>

      <Toggle
        label="Use AI voiceover"
        hint="Play generated speech instead of mic under captions"
        checked={vo.enabled}
        onChange={(enabled) => patchVoiceover({ enabled })}
      />

      <Row label="Speaking language">
        <LangSelect
          id="vo-speak"
          value={vo.speakLang}
          options={langOptions}
          busy={voicesBusy}
          onChange={(speakLang) => patchVoiceover({ speakLang })}
        />
      </Row>
      <Row label="Translate & speak as">
        <LangSelect
          id="vo-target"
          value={vo.targetLang}
          options={langOptions}
          busy={voicesBusy}
          onChange={(v) => void onTargetLang(v)}
        />
      </Row>
      <Row
        label={
          voicesBusy
            ? "Edge TTS voice"
            : `Voice · ${allVoices.length} · ${langOptions.length} langs`
        }
      >
        <select
          value={vo.voice}
          disabled={voicesBusy || !allVoices.length}
          onChange={(e) => onPickVoice(e.target.value)}
          className="w-full max-w-full truncate rounded-md bg-panel-raised px-2.5 py-2 text-[12.5px] outline-none ring-1 ring-transparent focus:ring-primary/40 disabled:opacity-50"
        >
          {voicesBusy && <option>Loading voices…</option>}
          {!voicesBusy && !allVoices.length && <option value={vo.voice}>{vo.voice}</option>}
          {langOptions.map((lang) => {
            const group = allVoices.filter((v) => v.locale === lang.code);
            if (!group.length) return null;
            const selectedMark = lang.code === vo.targetLang ? " ★" : "";
            return (
              <optgroup key={lang.code} label={`${lang.label}${selectedMark}`}>
                {group.map((v) => (
                  <option key={v.shortName} value={v.shortName}>
                    {v.friendlyName.replace(/^Microsoft\s+/i, "")} ({v.gender})
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </Row>

      <div className="space-y-2 px-4 pb-3 pt-1">
        <button
          type="button"
          disabled={busy || !cues.length}
          onClick={() => void translate()}
          className="w-full rounded-lg bg-panel-raised py-2 text-[12px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
        >
          Translate captions
        </button>
        <button
          type="button"
          disabled={busy || !cues.length}
          onClick={() => void generate()}
          className="w-full rounded-lg bg-primary py-2 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy ? status || "Working…" : "Generate AI voiceover"}
        </button>
        <button
          type="button"
          disabled={busy || !vo.clips.length}
          onClick={() => {
            clearVoiceoverClips();
            toast.message("AI voiceover cleared");
          }}
          className="w-full rounded-lg py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Clear voiceover
        </button>
      </div>

      <p className="px-4 pb-2 text-[11px] text-muted-foreground">
        {cues.length} caption{cues.length === 1 ? "" : "s"} · {vo.clips.length} voice clip
        {vo.clips.length === 1 ? "" : "s"}
      </p>

      {vo.clips.length > 0 && (
        <div className="max-h-48 space-y-1.5 overflow-y-auto px-4 pb-4">
          {vo.clips.map((c) => (
            <div key={c.id} className="rounded-lg bg-panel-raised px-3 py-2">
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {c.start.toFixed(1)}s · {c.duration.toFixed(1)}s
              </p>
              <p className="mt-0.5 truncate text-[12.5px] leading-snug">{c.text}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ExportPanel({ onExport }: { onExport: () => void }) {
  const { take } = useStudio();
  return (
    <>
      <PanelHeader icon={Share2} title="Export" />
      <p className="px-4 text-[11.5px] leading-relaxed text-muted-foreground">
        Export an MP4 on this device — nothing is uploaded unless you choose Share.
      </p>
      <div className="px-4 pt-4">
        <button
          onClick={onExport}
          disabled={!take}
          className="w-full rounded-md bg-royal-grad py-2 text-[12.5px] font-semibold disabled:opacity-40"
        >
          Open export settings
        </button>
      </div>
    </>
  );
}

function ClipPanel() {
  const {
    project,
    take,
    selectedVideoSegment,
    setSelectedVideoSegment,
    patchVideoSegment,
    removeVideoSegment,
    splitSelectedAt,
    clock,
  } = useStudio();
  const segs = take ? getVideoSegments(project, take.duration) : [];
  const idx = selectedVideoSegment
    ? segs.findIndex((s) => s.id === selectedVideoSegment)
    : segs.length === 1
      ? 0
      : -1;
  const seg = idx >= 0 ? segs[idx]! : null;
  const speed = seg ? segmentSpeed(seg, project) : project.speed;

  if (!take) {
    return (
      <>
        <PanelHeader icon={Film} title="Clip" />
        <p className="px-4 text-[11.5px] leading-relaxed text-muted-foreground">
          Record or open a take, then select the Clip lane to edit speed and trim.
        </p>
      </>
    );
  }

  if (!seg) {
    return (
      <>
        <PanelHeader icon={Film} title="Clip" />
        <p className="px-4 text-[11.5px] leading-relaxed text-muted-foreground">
          Click a clip on the timeline to select it. With multiple clips, drag to reorder; use the
          edge handles to trim; set speed below once selected.
        </p>
        {segs.length > 1 && (
          <div className="space-y-1 px-4 pt-2">
            {segs.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className="flex w-full items-center justify-between rounded-md bg-panel-raised px-2 py-1.5 text-left text-[11px] hover:bg-accent"
                onClick={() => setSelectedVideoSegment(s.id)}
              >
                <span>Clip {i + 1}</span>
                <span className="text-muted-foreground">
                  {formatTimecode(s.out - s.in)} · {segmentSpeed(s, project).toFixed(2)}×
                </span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <PanelHeader icon={Film} title={segs.length > 1 ? `Clip ${idx + 1}` : "Clip"} />
      <p className="px-4 text-[11.5px] leading-relaxed text-muted-foreground">
        {formatTimecode(seg.in)} → {formatTimecode(seg.out)} · source length{" "}
        {formatTimecode(seg.out - seg.in)}
      </p>
      <Row
        label={`Speed · ${speed.toFixed(2)}×`}
        onReset={() => patchVideoSegment(seg.id, { speed: 1 })}
      >
        <Slider
          value={[speed * 100]}
          min={50}
          max={200}
          step={5}
          onValueChange={([v]) => {
            if (typeof v !== "number") return;
            patchVideoSegment(seg.id, { speed: v / 100 });
          }}
        />
      </Row>
      <div className="flex flex-wrap gap-1.5 px-4 pb-1">
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => {
          const on = Math.abs(speed - rate) < 0.001;
          return (
            <button
              key={rate}
              type="button"
              onClick={() => patchVideoSegment(seg.id, { speed: rate })}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium tabular-nums",
                on ? "bg-royal-grad text-white" : "bg-panel-raised hover:bg-accent",
              )}
            >
              {rate % 1 ? rate.toFixed(2) : rate}×
            </button>
          );
        })}
      </div>
      <p className="px-4 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        This speed applies only to this clip in preview and export. Other clips keep their own
        rates.
      </p>
      <div className="flex flex-wrap gap-2 px-4 pt-2">
        <button
          type="button"
          className="rounded-md bg-panel-raised px-2 py-1 text-[11px] font-medium hover:bg-accent"
          onClick={() => {
            const result = splitSelectedAt(clock.time);
            if (result.message) toast.message(result.message);
          }}
        >
          Cut at playhead
        </button>
        {segs.length > 1 && (
          <button
            type="button"
            className="rounded-md bg-panel-raised px-2 py-1 text-[11px] font-medium text-ember hover:bg-accent"
            onClick={() => {
              removeVideoSegment(seg.id);
              toast.message("Video clip removed");
            }}
          >
            Delete clip
          </button>
        )}
      </div>
      {segs.length > 1 && (
        <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Drag clips on the Clip lane to reorder. Drag the left/right edges to trim this clip only.
        </p>
      )}
    </>
  );
}

export function Inspector({ onExport }: { onExport: () => void }) {
  const { inspector, reset } = useStudio();
  return (
    <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden bg-panel hairline-l">
      <div
        key={inspector}
        className="sw-inspector-tab flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      >
        {inspector === "background" && <BackgroundPanel />}
        {inspector === "motion" && <MotionPanel />}
        {inspector === "effects" && <EffectsPanel />}
        {inspector === "cursor" && <CursorPanel />}
        {inspector === "zoom" && <ZoomPanel />}
        {inspector === "camera" && <CameraPanel />}
        {inspector === "captions" && <CaptionsPanel />}
        {inspector === "voiceover" && <VoiceoverPanel />}
        {inspector === "audio" && <AudioPanel />}
        {inspector === "clip" && <ClipPanel />}
        {inspector === "shortcuts" && <ShortcutsPanel />}
        {inspector === "export" && <ExportPanel onExport={onExport} />}
      </div>
      <div className="mt-auto shrink-0 border-t border-hairline px-3 py-2">
        <button
          onClick={reset}
          className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground transition-colors hover:text-ember"
        >
          <RotateCcw className="h-3 w-3" />
          Reset styling
        </button>
      </div>
    </aside>
  );
}
