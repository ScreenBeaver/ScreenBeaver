import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FolderOpen,
  Film,
  MonitorPlay,
  Sun,
  Moon,
  Trash2,
  FilePlus2,
  Activity,
  Bot,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useStudio } from "@/lib/studio/store";
import {
  listProjectLibraryEntries,
  readProjectFileFull,
  removeProjectLibraryEntry,
  applyProjectFile,
  resolveProjectLibraryFile,
  upsertProjectLibraryEntry,
  newLibraryId,
  type ApplyProjectResult,
  type ProjectLibraryEntry,
  type YasharkaProjectFileV1,
} from "@/lib/studio/projectFiles";
import { type TakeMediaBlobs } from "@/lib/studio/projectMedia";
import { applyTheme, getStoredTheme, toggleTheme, type AppTheme } from "@/lib/theme";
import { toast } from "sonner";
import { classifyMediaFile } from "@/lib/studio/mediaKind";
import { cn } from "@/lib/utils";
import {
  playClick,
  setUiSoundsEnabled,
  uiSoundsEnabled,
} from "@/lib/studio/sounds";
import {
  getWeeklyActivity,
  listHomeActivity,
  listMcpActivity,
  logHomeActivity,
  weekActivityTotal,
  type HomeActivityEntry,
  type WeeklyActivityDay,
} from "@/lib/studio/homeActivity";
import { useAccount } from "@/lib/account/AccountProvider";
import { AgentDemoLauncher } from "@/components/studio/AgentDemoLauncher";
import { RemoteMcpPanel } from "@/components/studio/RemoteMcpPanel";
import { isRemoteMcpPlan } from "@/lib/studio/remoteMcp";

type SideTab = "home" | "projects" | "activity" | "mcp";
type HeroMode = "create" | "record";

const HERO = {
  create: {
    eyebrow: "Product demos",
    title: "Create a demo",
    subtitle: "Open the studio and polish a SaaS walkthrough — zooms, captions, export.",
    cta: "Create",
    image: "/home/hero-create-demo.png?v=3",
  },
  record: {
    eyebrow: "Screen capture",
    title: "Record screen",
    subtitle: "Capture your product UI, then turn the take into a launch-ready demo.",
    cta: "Record",
    image: "/home/hero-record-screen.png?v=3",
  },
} as const;

export function StartPage({
  onRecordClick,
  onEnterStudio,
  onProjectOpened,
}: {
  onRecordClick: () => void;
  onEnterStudio: () => void;
  onProjectOpened?: (result: ApplyProjectResult) => void;
}) {
  const studio = useStudio();
  const { reset, replaceProject, setTake } = studio;
  const { features, planName, planSlug, signedIn, me, upgrade, openAccount, signIn } = useAccount();
  const mcpEntitled = features?.mcp === true;
  const remoteMcp = isRemoteMcpPlan(planSlug);
  const [uiSoundsOn, setUiSoundsOn] = useState(() => uiSoundsEnabled());

  const openIntoStudio = () => onEnterStudio();

  const openLibraryEntry = async (entry: ProjectLibraryEntry) => {
    const file = await resolveProjectLibraryFile(entry);
    await openProject(file, entry.id);
  };

  const openProject = async (
    file: YasharkaProjectFileV1,
    preferredMediaId?: string,
    embeddedBlobs?: TakeMediaBlobs | null,
  ) => {
    try {
      const result = await applyProjectFile(
        file,
        { replaceProject, setTake },
        { fallbackMediaId: preferredMediaId, embeddedBlobs },
      );
      onProjectOpened?.({
        ...result,
        mediaId: result.mediaId ?? preferredMediaId,
      });
      logHomeActivity("open", file.project?.name || "Opened project", ".yasharka");
      const id = preferredMediaId || file.take?.mediaId || newLibraryId();
      upsertProjectLibraryEntry({
        id,
        name: file.project?.name || "Untitled Project",
        updatedAt: Date.now(),
        sourceLabel: file.take?.sourceLabel,
        duration: file.take?.duration,
        file,
      });
      setTick((n) => n + 1);
      openIntoStudio();
      if (result.hasVideo) {
        toast.success("Project opened", {
          description: result.sourceLabel ? `Recording · ${result.sourceLabel}` : undefined,
        });
      } else {
        toast.message("Project settings loaded", {
          description: result.sourceLabel
            ? `Link “${result.sourceLabel}” (or any video) to restore the recording.`
            : "Link a screen recording to restore the video.",
        });
      }
      return result;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open project");
      return null;
    }
  };

  const projectFileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<SideTab>("home");
  const [hero, setHero] = useState<HeroMode>("create");
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [tick, setTick] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    applyTheme(getStoredTheme());
    setTheme(getStoredTheme());
  }, []);

  const library = useMemo(() => listProjectLibraryEntries(), [studio.project, tick]);
  const activity = useMemo(() => listHomeActivity(), [tick]);
  const mcpLog = useMemo(() => listMcpActivity(), [tick]);
  const week = useMemo(() => getWeeklyActivity(activity), [activity]);
  const weekTotal = useMemo(() => weekActivityTotal(week), [week]);
  const demoStats = useMemo(() => {
    const recordings = activity.filter((e) => e.kind === "record").length;
    const exports = activity.filter((e) => e.kind === "export").length;
    const creates = activity.filter((e) => e.kind === "create").length;
    return { recordings, exports, creates, projects: library.length };
  }, [activity, library.length]);

  const openProjectFile = async (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files);
    const project = arr.find((f) => classifyMediaFile(f) === "project");
    if (!project) {
      toast.message("Open a .yasharka project", {
        description: "Drop or choose a Screen Beaver project file.",
      });
      return;
    }
    try {
      const unpacked = await readProjectFileFull(project);
      await openProject(unpacked.file, undefined, unpacked.blobs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open project");
    }
  };

  const startCreate = () => {
    playClick();
    reset();
    logHomeActivity("create", "Created a new video");
    setTick((n) => n + 1);
    openIntoStudio();
    toast.message("New project", { description: "Record from the studio when you’re ready." });
  };

  const startRecord = () => {
    playClick();
    logHomeActivity("record", "Started screen recording");
    setTick((n) => n + 1);
    onRecordClick();
  };

  const runHero = () => {
    if (hero === "create") startCreate();
    else startRecord();
  };

  const h = HERO[hero];
  const light = theme === "light";

  return (
    <div
      className={cn(
        "relative flex h-screen overflow-hidden bg-background text-foreground",
        light ? "home-light" : "home-dark",
      )}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        void openProjectFile(e.dataTransfer.files);
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background: light
            ? "radial-gradient(ellipse 70% 50% at 75% 30%, rgba(45, 212, 191, 0.12), transparent 55%), radial-gradient(ellipse 45% 35% at 15% 85%, rgba(99, 102, 241, 0.08), transparent 50%)"
            : "radial-gradient(ellipse 80% 60% at 70% 35%, rgba(45, 212, 191, 0.08), transparent 55%), radial-gradient(ellipse 50% 40% at 20% 80%, rgba(168, 85, 247, 0.07), transparent 50%)",
        }}
      />

      <aside className="relative z-20 flex shrink-0 flex-col items-center py-5 pl-4">
        <div
          className={cn(
            "flex h-full w-[72px] flex-col items-center gap-2 rounded-[28px] border px-2 py-3 shadow-[var(--shadow-panel)] backdrop-blur-xl",
            light
              ? "border-hairline bg-panel/90"
              : "border-white/10 bg-black/55",
          )}
        >
          <div className="mb-2 flex h-11 w-11 items-center justify-center overflow-hidden rounded-full ring-1 ring-hairline">
            <img src="/logo.png" alt="Screen Beaver" className="h-11 w-11 object-cover" />
          </div>

          <RailButton
            light={light}
            active={tab === "home" && hero === "create"}
            title="Create a video"
            onClick={() => {
              playClick();
              setTab("home");
              setHero("create");
            }}
          >
            <FilePlus2 className="h-4 w-4" />
          </RailButton>
          <RailButton
            light={light}
            active={tab === "home" && hero === "record"}
            title="Record screen"
            highlight
            onClick={() => {
              playClick();
              setTab("home");
              setHero("record");
            }}
          >
            <MonitorPlay className="h-4 w-4" />
          </RailButton>

          <div className={cn("my-1 h-px w-8", light ? "bg-hairline" : "bg-white/10")} />

          <RailButton
            light={light}
            active={false}
            title="Open .yasharka"
            onClick={() => {
              playClick();
              projectFileRef.current?.click();
            }}
          >
            <FolderOpen className="h-4 w-4" />
          </RailButton>
          <RailButton
            light={light}
            active={tab === "projects"}
            title="Projects"
            onClick={() => {
              playClick();
              setTab("projects");
            }}
          >
            <Film className="h-4 w-4" />
          </RailButton>
          <RailButton
            light={light}
            active={tab === "activity"}
            title="Activity"
            onClick={() => {
              playClick();
              setTab("activity");
              setTick((n) => n + 1);
            }}
          >
            <Activity className="h-4 w-4" />
          </RailButton>
          <RailButton
            light={light}
            active={tab === "mcp"}
            title="MCP activity"
            onClick={() => {
              playClick();
              setTab("mcp");
              setTick((n) => n + 1);
            }}
          >
            <Bot className="h-4 w-4" />
          </RailButton>

          <div className="mt-auto flex flex-col items-center gap-2 pb-1">
            <RailButton
              light={light}
              active={false}
              title={
                uiSoundsOn
                  ? "Mute click & SFX (preview + export)"
                  : "Enable click & SFX (preview + export)"
              }
              onClick={() => {
                const next = !uiSoundsOn;
                setUiSoundsEnabled(next);
                setUiSoundsOn(next);
                if (next) playClick();
              }}
            >
              {uiSoundsOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </RailButton>
            <RailButton
              light={light}
              active={false}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => {
                playClick();
                setTheme(toggleTheme());
              }}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </RailButton>
            <button
              type="button"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full text-[9px] font-bold ring-1 transition",
                light
                  ? "bg-panel-raised text-muted-foreground ring-hairline hover:bg-accent hover:text-foreground"
                  : "bg-white/5 text-white/50 ring-white/10 hover:bg-white/10 hover:text-white",
              )}
              title={signedIn ? "Open dashboard" : "Sign in"}
              onClick={() => {
                playClick();
                if (signedIn) void openAccount();
                else void signIn();
              }}
            >
              {(signedIn
                ? me?.user.name || me?.user.email || planName || "Free"
                : "Guest"
              )
                .slice(0, 1)
                .toUpperCase()}
            </button>
          </div>
        </div>
        <input
          ref={projectFileRef}
          type="file"
          accept=".yasharka,application/x-yasharka+json,application/json"
          hidden
          onChange={(e) => {
            void openProjectFile(e.target.files);
            e.currentTarget.value = "";
          }}
        />
      </aside>

      <main className="relative z-10 flex min-w-0 flex-1 flex-col p-4 pl-3 pr-5 pb-5">
        {tab === "home" ? (
          <section
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border shadow-[var(--shadow-panel)]",
              light ? "border-hairline bg-panel" : "border-white/10 bg-[#0c0e14]",
            )}
          >
            <img
              key={h.image}
              src={h.image}
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-[78%_center]"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/55 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/30" />

            {/* Top status row */}
            <div className="relative z-10 flex items-start justify-between gap-4 px-8 pt-6 md:px-10">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                {h.eyebrow}
              </p>
              <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full ring-1 ring-white/20">
                <img src="/logo.png" alt="" className="h-9 w-9 object-cover" />
              </div>
            </div>

            {/* Hero title + compact PLAY-style CTA */}
            <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-center px-8 pb-6 md:px-10">
              <h1 className="max-w-[12ch] text-[clamp(2.6rem,5.5vw,4.6rem)] font-black uppercase leading-[0.92] tracking-tight text-white drop-shadow-[0_10px_40px_rgba(0,0,0,0.7)]">
                {h.title}
              </h1>
              <p className="mt-3 max-w-md text-[13px] leading-relaxed text-white/65 md:text-[14px]">
                {h.subtitle}
              </p>
              <button
                type="button"
                onClick={runHero}
                className="mt-5 inline-flex w-fit items-center gap-2 rounded-full bg-[#9ef0d2] px-6 py-2.5 text-[13px] font-bold tracking-wide text-black shadow-[0_10px_30px_rgba(158,240,210,0.28)] transition hover:brightness-105 active:scale-[0.98]"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                {h.cta}
              </button>

              {hero === "create" ? (
                <div className="mt-6 max-w-xl">
                  <AgentDemoLauncher
                    light={false}
                    mcpEntitled={mcpEntitled}
                    onEnterStudio={openIntoStudio}
                  />
                </div>
              ) : null}
            </div>

            {/* Bottom glass widgets over splash — LoL dashboard essence */}
            <div className="relative z-10 grid shrink-0 gap-3 px-4 pb-4 md:grid-cols-3 md:px-5 md:pb-5">
              <GlassCard
                light={false}
                overlay
                title="Weekly activity"
                actionLabel="View full activity"
                onAction={() => {
                  playClick();
                  setTab("activity");
                  setTick((n) => n + 1);
                }}
              >
                <WeeklyBars days={week} light={false} />
                <p className="mt-2 text-[10.5px] text-white/45">
                  {weekTotal === 0
                    ? "No demo actions yet this week."
                    : `${weekTotal} demo action${weekTotal === 1 ? "" : "s"} this week`}
                </p>
              </GlassCard>

              <GlassCard
                light={false}
                overlay
                title="Your demo stats"
                actionLabel="View activity"
                onAction={() => {
                  playClick();
                  setTab("activity");
                  setTick((n) => n + 1);
                }}
              >
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <StatBlock
                    value={String(demoStats.recordings)}
                    label="Recordings"
                  />
                  <StatBlock
                    value={String(demoStats.exports)}
                    label="Exports"
                  />
                  <StatBlock
                    value={String(demoStats.projects)}
                    label="Projects"
                  />
                  <StatBlock
                    value={String(demoStats.creates)}
                    label="New demos"
                  />
                </div>
              </GlassCard>

              <GlassCard
                light={false}
                overlay
                title="Recent projects"
                actionLabel="View projects"
                onAction={() => {
                  playClick();
                  setTab("projects");
                }}
              >
                {library.length === 0 ? (
                  <EmptyLine light={false}>Save with Ctrl+S — demos show up here.</EmptyLine>
                ) : (
                  <ul className="space-y-1.5">
                    {library.slice(0, 3).map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left hover:bg-white/5"
                          onClick={() => void openLibraryEntry(e)}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-400/15 text-teal-200 ring-1 ring-white/10">
                            <Film className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-semibold text-white">
                              {e.name}
                            </span>
                            <span className="block truncate text-[10px] text-white/45">
                              {e.sourceLabel ? `${e.sourceLabel} · ` : ""}
                              {e.duration
                                ? `${e.duration.toFixed(1)}s · `
                                : ""}
                              {new Date(e.updatedAt).toLocaleDateString()}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </GlassCard>
            </div>
          </section>
        ) : (
          <PanelView
            light={light}
            tab={tab}
            library={library}
            activity={activity}
            week={week}
            mcpLog={mcpLog}
            mcpEntitled={mcpEntitled}
            remoteMcp={remoteMcp}
            onBack={() => {
              playClick();
              setTab("home");
            }}
            onOpen={(e) => void openLibraryEntry(e)}
            onDelete={(id) => {
              removeProjectLibraryEntry(id);
              setTick((n) => n + 1);
            }}
            onUpgrade={() => void upgrade()}
            onOpenFile={() => projectFileRef.current?.click()}
          />
        )}
      </main>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-panel px-10 py-8 text-center shadow-lg">
            <FolderOpen className="mx-auto mb-2 h-8 w-8 text-primary" />
            <p className="text-[15px] font-semibold text-foreground">Drop a .yasharka project</p>
            <p className="text-[12px] text-muted-foreground">Open an existing Screen Beaver project file</p>
          </div>
        </div>
      )}
    </div>
  );
}

function RailButton({
  active,
  title,
  onClick,
  children,
  highlight,
  light,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
  highlight?: boolean;
  light: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-full transition",
        active
          ? highlight
            ? "bg-[#9ef0d2] text-black shadow-[0_0_24px_rgba(158,240,210,0.35)]"
            : light
              ? "bg-primary/15 text-primary ring-1 ring-primary/30"
              : "bg-white/15 text-white ring-1 ring-white/25"
          : light
            ? "text-muted-foreground hover:bg-accent hover:text-foreground"
            : "text-white/55 hover:bg-white/8 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function ModeChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-[11px] font-semibold tracking-wide transition",
        active
          ? "bg-white text-black"
          : "border border-white/15 bg-black/30 text-white/65 hover:bg-white/10",
      )}
    >
      {label}
    </button>
  );
}

function GlassCard({
  title,
  actionLabel,
  onAction,
  children,
  light,
  overlay,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  children: ReactNode;
  light: boolean;
  overlay?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[158px] flex-col rounded-[22px] border p-4 shadow-[var(--shadow-panel)] backdrop-blur-xl",
        overlay || !light
          ? "border-white/10 bg-black/50"
          : "border-hairline bg-panel/95",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.14em]",
            overlay || !light ? "text-white/55" : "text-muted-foreground",
          )}
        >
          {title}
        </h2>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onAction}
        className={cn(
          "mt-3 w-full rounded-full border py-2 text-[11px] font-semibold uppercase tracking-wide transition",
          overlay || !light
            ? "border-white/12 bg-white/5 text-white/80 hover:bg-white/10"
            : "border-hairline bg-panel-raised text-foreground hover:bg-accent",
        )}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function StatBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-2">
      <p className="text-[18px] font-black tracking-tight text-white">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-white/45">{label}</p>
    </div>
  );
}

function EmptyLine({ children, light }: { children: ReactNode; light: boolean }) {
  return (
    <p className={cn("text-[11.5px] leading-relaxed", light ? "text-muted-foreground" : "text-white/45")}>
      {children}
    </p>
  );
}

function WeeklyBars({ days, light }: { days: WeeklyActivityDay[]; light: boolean }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="flex h-[72px] items-end gap-1.5 pt-1">
      {days.map((d) => {
        const h = d.count === 0 ? 4 : Math.max(10, Math.round((d.count / max) * 56));
        const today = new Date();
        const isToday =
          d.date.getFullYear() === today.getFullYear() &&
          d.date.getMonth() === today.getMonth() &&
          d.date.getDate() === today.getDate();
        return (
          <div key={d.key} className="flex flex-1 flex-col items-center gap-1" title={`${d.count} action${d.count === 1 ? "" : "s"}`}>
            <div
              className={cn(
                "w-full rounded-sm transition-all",
                d.count === 0
                  ? light
                    ? "bg-muted"
                    : "bg-white/8"
                  : isToday
                    ? "bg-[#9ef0d2]"
                    : light
                      ? "bg-teal-500/55"
                      : "bg-teal-300/55",
              )}
              style={{ height: `${h}px` }}
            />
            <span
              className={cn(
                "text-[9px]",
                isToday
                  ? light
                    ? "font-semibold text-foreground"
                    : "font-semibold text-white"
                  : light
                    ? "text-muted-foreground"
                    : "text-white/35",
              )}
            >
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityList({
  entries,
  light,
}: {
  entries: HomeActivityEntry[];
  light: boolean;
}) {
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start gap-2">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500 dark:bg-teal-300/80" />
          <span className="min-w-0">
            <span className="block truncate text-[11.5px] font-medium text-foreground/90">{e.label}</span>
            <span
              className={cn("block text-[10px]", light ? "text-muted-foreground" : "text-white/40")}
            >
              {e.detail ? `${e.detail} · ` : ""}
              {new Date(e.at).toLocaleString()}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PanelView({
  tab,
  library,
  activity,
  week,
  mcpLog,
  mcpEntitled,
  remoteMcp,
  onBack,
  onOpen,
  onDelete,
  onUpgrade,
  onOpenFile,
  light,
}: {
  tab: Exclude<SideTab, "home">;
  library: ReturnType<typeof listProjectLibraryEntries>;
  activity: HomeActivityEntry[];
  week: WeeklyActivityDay[];
  mcpLog: HomeActivityEntry[];
  mcpEntitled: boolean;
  remoteMcp: boolean;
  onBack: () => void;
  onOpen: (e: (typeof library)[number]) => void;
  onDelete: (id: string) => void;
  onUpgrade: () => void;
  onOpenFile: () => void;
  light: boolean;
}) {
  const title =
    tab === "projects" ? "Projects" : tab === "activity" ? "Activity" : "MCP activity";

  return (
    <section
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border shadow-[var(--shadow-panel)] backdrop-blur-xl",
        light ? "border-hairline bg-panel" : "border-white/10 bg-black/50",
      )}
    >
      <header
        className={cn(
          "flex items-center justify-between border-b px-6 py-4",
          light ? "border-hairline" : "border-white/10",
        )}
      >
        <div>
          <button
            type="button"
            onClick={onBack}
            className="mb-1 text-[11px] font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300/90 dark:hover:text-teal-200"
          >
            ← Back to home
          </button>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">{title}</h1>
        </div>
        {tab === "projects" ? (
          <button
            type="button"
            onClick={onOpenFile}
            className="inline-flex items-center gap-2 rounded-full bg-[#9ef0d2] px-4 py-2 text-[12px] font-bold text-black"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open .yasharka
          </button>
        ) : tab === "mcp" && !mcpEntitled ? (
          <button
            type="button"
            onClick={onUpgrade}
            className="rounded-full bg-[#9ef0d2] px-4 py-2 text-[12px] font-bold text-black"
          >
            Enable MCP
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === "projects" ? (
          library.length === 0 ? (
            <EmptyPanel light={light}>
              No projects yet. Create a video, then press <strong>Ctrl+S</strong> to save a{" "}
              <strong>.yasharka</strong> file — or open one from disk.
            </EmptyPanel>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {library.map((e) => (
                <div
                  key={e.id}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl border p-3",
                    light ? "border-hairline bg-shell" : "border-white/10 bg-white/[0.03]",
                  )}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-400/15 text-teal-700 dark:text-teal-200">
                    <Film className="h-4 w-4" />
                  </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold">{e.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {e.sourceLabel ? `${e.sourceLabel} · ` : ""}
                        {typeof e.duration === "number" ? `${e.duration.toFixed(1)}s · ` : ""}
                        {new Date(e.updatedAt).toLocaleString()}
                      </p>
                    </div>
                  <button
                    type="button"
                    className="rounded-lg bg-panel-raised px-2.5 py-1.5 text-[11px] font-semibold hover:bg-accent"
                    onClick={() => onOpen(e)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="rounded p-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(e.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )
        ) : tab === "activity" ? (
          <div className="space-y-6">
            <div
              className={cn(
                "rounded-2xl border p-4",
                light ? "border-hairline bg-shell" : "border-white/10 bg-white/[0.03]",
              )}
            >
              <p className="mb-3 text-[12px] font-semibold">This week</p>
              <WeeklyBars days={week} light={light} />
              <p className="mt-2 text-[11px] text-muted-foreground">
                Counts create, record, open, save, and export actions stored on this device.
              </p>
            </div>
            {activity.length === 0 ? (
              <EmptyPanel light={light}>
                No activity yet. Create a video, record, save, or export to build your trail.
              </EmptyPanel>
            ) : (
              <ActivityList entries={activity} light={light} />
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {remoteMcp ? <RemoteMcpPanel light={light} /> : null}
            {mcpLog.length === 0 ? (
              <EmptyPanel light={light}>
                {mcpEntitled
                  ? "No MCP commands logged yet."
                  : "MCP activity will appear here when the agent runs tools."}
              </EmptyPanel>
            ) : (
              <>
                {!mcpEntitled ? (
                  <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-100/90">
                    Showing local MCP log.
                  </p>
                ) : null}
                <ActivityList entries={mcpLog} light={light} />
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyPanel({ children, light }: { children: ReactNode; light: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed px-5 py-10 text-center text-[13px] leading-relaxed",
        light ? "border-hairline text-muted-foreground" : "border-white/12 text-white/50",
      )}
    >
      {children}
    </div>
  );
}
