import { Folder, Redo2, Trash2, Undo2, Wand2, PanelRight, ArrowUpFromLine, Circle, Save, Sun, Moon, House } from "lucide-react";
import { useEffect, useState } from "react";
import { useStudio } from "@/lib/studio/store";
import { playClick } from "@/lib/studio/sounds";
import { applyTheme, getStoredTheme, toggleTheme, type AppTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AccountMenu } from "@/components/studio/AccountMenu";
import { useAccount } from "@/lib/account/AccountProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PRESETS = [
  { id: "clean", label: "Clean Demo", wallpaperId: "arctic", padding: 26, radius: 22, chromeTheme: "light" as const },
  { id: "day", label: "Day Product", wallpaperId: "aesthetic-laptop", padding: 36, radius: 26, chromeTheme: "light" as const },
  { id: "vivid", label: "Vivid Launch", wallpaperId: "aesthetic-pointer", padding: 40, radius: 30, chromeTheme: "dark" as const },
  { id: "night", label: "Night Product", wallpaperId: "aesthetic-portal", padding: 32, radius: 18, chromeTheme: "dark" as const },
  { id: "tight", label: "Tight Tutorial", wallpaperId: "slate", padding: 12, radius: 10, chromeTheme: "dark" as const },
];

function TbBtn({
  label,
  disabled,
  onClick,
  active,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center rounded px-2 py-1.5 transition-colors",
        active
          ? "bg-panel-raised text-ember"
          : "text-muted-foreground hover:bg-panel-raised hover:text-foreground",
        disabled && "pointer-events-none opacity-30",
      )}
    >
      {children}
    </button>
  );
}

export function TopBar({
  onExport,
  onRecord,
  onSave,
  onGoHome,
  recording,
  inspectorOpen,
  onToggleInspector,
}: {
  onExport: () => void;
  onRecord: () => void;
  onSave: () => void;
  onGoHome: () => void;
  recording: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  const {
    project,
    patchBackground,
    patchFrame,
    take,
    reset,
    canUndo,
    canRedo,
    undo,
    redo,
    beginHistoryBatch,
    endHistoryBatch,
  } = useStudio();

  const { planName, signedIn } = useAccount();

  const [theme, setTheme] = useState<AppTheme>("dark");
  useEffect(() => {
    applyTheme(getStoredTheme());
    setTheme(getStoredTheme());
  }, []);

  return (
    <header className="relative z-20 flex h-[38px] shrink-0 items-center gap-0 bg-shell hairline-b">

      {/* ── Brand mark ──────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => {
          playClick();
          onGoHome();
        }}
        className="flex h-full shrink-0 items-center gap-2 border-r border-hairline px-4 text-left transition-colors hover:bg-panel-raised"
        title="Back to home"
      >
        <img
          src="/logo.png"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 rounded-[5px] object-cover ring-1 ring-white/10"
        />
        <span className="text-[12px] font-semibold tracking-tight text-foreground">
          Screen Beaver
        </span>
        <span className="hidden rounded bg-ember/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-ember sm:block">
          {signedIn ? planName || "Free" : "Guest"}
        </span>
      </button>

      {/* ── Left — file controls ─────────────────────────────────────── */}
      <div className="flex h-full items-center gap-0 border-r border-hairline px-1">
        <TbBtn
          label="Back to home"
          onClick={() => {
            playClick();
            onGoHome();
          }}
        >
          <House className="h-[15px] w-[15px]" />
        </TbBtn>
        <TbBtn label="New recording" onClick={() => { playClick(); onRecord(); }}>
          <Folder className="h-[15px] w-[15px]" />
        </TbBtn>
        <TbBtn
          label="Save project (.yasharka)"
          onClick={() => {
            playClick();
            onSave();
          }}
        >
          <Save className="h-[15px] w-[15px]" />
        </TbBtn>
        <TbBtn label="Discard recording" onClick={() => { playClick(); reset(); }}>
          <Trash2 className="h-[15px] w-[15px]" />
        </TbBtn>
      </div>

      {/* ── Center — project name ────────────────────────────────────── */}
      <p className="hidden min-w-0 flex-1 truncate text-center text-[12px] font-medium text-muted-foreground md:block">
        {project.name}
      </p>
      <div className="flex-1 md:hidden" />

      {/* ── Right — undo / tools / export ────────────────────────────── */}
      <div className="flex h-full items-center gap-0 border-l border-hairline px-1">
        <TbBtn label="Undo" disabled={!canUndo} onClick={() => { playClick(); undo(); }}>
          <Undo2 className="h-[15px] w-[15px]" />
        </TbBtn>
        <TbBtn label="Redo" disabled={!canRedo} onClick={() => { playClick(); redo(); }}>
          <Redo2 className="h-[15px] w-[15px]" />
        </TbBtn>
      </div>

      <div className="flex h-full items-center border-l border-hairline px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center justify-center rounded px-2 py-1.5 text-muted-foreground transition-colors hover:bg-panel-raised hover:text-foreground">
              <Wand2 className="h-[15px] w-[15px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Look presets</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PRESETS.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => {
                  beginHistoryBatch();
                  patchBackground({ mode: "wallpaper", wallpaperId: p.wallpaperId });
                  patchFrame({ padding: p.padding, radius: p.radius, chromeTheme: p.chromeTheme });
                  endHistoryBatch();
                  playClick();
                }}
              >
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <TbBtn label="Toggle inspector" active={inspectorOpen} onClick={() => { playClick(); onToggleInspector(); }}>
          <PanelRight className="h-[15px] w-[15px]" />
        </TbBtn>

        <TbBtn
          label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => {
            playClick();
            setTheme(toggleTheme());
          }}
        >
          {theme === "dark" ? <Sun className="h-[15px] w-[15px]" /> : <Moon className="h-[15px] w-[15px]" />}
        </TbBtn>

        <AccountMenu />
      </div>

      {/* ── Primary action ───────────────────────────────────────────── */}
      <div className="flex h-full items-center border-l border-hairline pl-2 pr-2">
        {recording ? (
          <button
            onClick={() => { playClick(); onRecord(); }}
            className="flex items-center gap-1.5 rounded bg-record px-3 py-1 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Circle className="h-2 w-2 fill-current" />
            Stop
          </button>
        ) : (
          <button
            onClick={() => { playClick(); onExport(); }}
            disabled={!take}
            className="flex items-center gap-1.5 rounded bg-royal-grad px-3 py-1 text-[12px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <ArrowUpFromLine className="h-3 w-3" />
            Export
          </button>
        )}
      </div>
    </header>
  );
}
