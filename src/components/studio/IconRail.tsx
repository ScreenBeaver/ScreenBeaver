import {
  Frame,
  MousePointer2,
  Search,
  Video,
  MessageSquare,
  AudioLines,
  Volume2,
  Command,
  Share2,
  Clapperboard,
  Waves,
  Film,
} from "lucide-react";
import { useStudio, type InspectorTab } from "@/lib/studio/store";
import { playClick } from "@/lib/studio/sounds";
import { cn } from "@/lib/utils";

const ITEMS: { tab: InspectorTab; icon: typeof Frame; label: string; short: string }[] = [
  { tab: "background", icon: Frame,          label: "Background & frame", short: "BG"   },
  { tab: "motion",     icon: Waves,           label: "Motion backgrounds", short: "Motion"},
  { tab: "effects",    icon: Clapperboard,    label: "Effects library",    short: "FX"   },
  { tab: "cursor",     icon: MousePointer2,   label: "Cursor",             short: "Cursor"},
  { tab: "zoom",       icon: Search,          label: "Zoom",               short: "Zoom" },
  { tab: "camera",     icon: Video,           label: "Camera",             short: "Cam"  },
  { tab: "clip",       icon: Film,            label: "Clip",               short: "Clip" },
  { tab: "captions",   icon: MessageSquare,   label: "Captions",           short: "Caps" },
  { tab: "voiceover",  icon: AudioLines,      label: "AI Voiceover",       short: "VO"   },
  { tab: "audio",      icon: Volume2,         label: "Audio",              short: "Audio"},
  { tab: "shortcuts",  icon: Command,         label: "Shortcuts",          short: "Keys" },
  { tab: "export",     icon: Share2,          label: "Export settings",    short: "Out"  },
];

export function IconRail() {
  const { inspector, setInspector, project } = useStudio();

  return (
    <nav className="flex w-[64px] shrink-0 flex-col items-stretch gap-px bg-rail py-1 hairline-r">
      {ITEMS.map(({ tab, icon: Icon, label, short }) => {
        const active = inspector === tab;
        const badge =
          (tab === "cursor"    && project.cursor.visible) ||
          (tab === "zoom"      && project.zoom?.enabled !== false && project.zooms.length > 0) ||
          (tab === "camera"    && project.camera.enabled) ||
          (tab === "motion"    && project.background.mode === "motion") ||
          (tab === "effects"   && (project.effects?.length ?? 0) > 0) ||
          (tab === "background" && (project.frame.deviceFrameId || "none") !== "none") ||
          (tab === "voiceover" && !!(project.voiceover?.enabled && project.voiceover?.clips?.length));

        return (
          <button
            key={tab}
            onClick={() => { playClick(); setInspector(tab); }}
            aria-label={label}
            title={label}
            className={cn(
              "group relative flex flex-col items-center gap-1 py-2.5 transition-colors",
              active
                ? "bg-panel text-ember"
                : "text-muted-foreground hover:bg-panel/50 hover:text-foreground",
            )}
          >
            {/* Active indicator bar — left edge, full height */}
            {active && (
              <span className="absolute inset-y-0 left-0 w-[2px] rounded-r bg-ember" />
            )}

            <Icon
              className={cn("h-[16px] w-[16px]", active ? "text-ember" : "")}
              strokeWidth={active ? 2 : 1.75}
            />

            <span
              className={cn(
                "text-[9px] font-semibold uppercase tracking-[0.08em] leading-none",
                active ? "text-ember" : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {short}
            </span>

            {badge && !active && (
              <span className="absolute right-2 top-2 h-[5px] w-[5px] rounded-full bg-ember" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
