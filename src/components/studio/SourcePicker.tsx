import { useEffect, useState } from "react";
import {
  AppWindow,
  Monitor,
  Chrome,
  Video,
  Mic,
  MousePointerClick,
  Volume2,
  Smartphone,
  RefreshCw,
  Download,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { StartOptions, SurfaceKind } from "@/lib/studio/recorder";
import { playClick, unlockUiSounds } from "@/lib/studio/sounds";
import { useStudio } from "@/lib/studio/store";
import { isTauri } from "@/lib/studio/nativeBridge";
import {
  androidEnsureRuntime,
  androidListDevices,
  androidRuntimeStatus,
  androidUsbNote,
  type AndroidDevice,
} from "@/lib/studio/androidCapture";
import { useAccount } from "@/lib/account/AccountProvider";

const SURFACES: {
  value: SurfaceKind;
  label: string;
  hint: string;
  icon: typeof AppWindow;
  desktopOnly?: boolean;
}[] = [
  {
    value: "screen",
    label: "Entire screen",
    hint: "Includes menus and pop-ups outside the app",
    icon: Monitor,
  },
  {
    value: "application",
    label: "Application window",
    hint: "One app window — OS menus outside it won’t appear",
    icon: AppWindow,
  },
  {
    value: "tab",
    label: "Browser tab",
    hint: "One browser tab only",
    icon: Chrome,
  },
  {
    value: "android",
    label: "Android phone (USB)",
    hint: "Mirror and control the phone over USB",
    icon: Smartphone,
    desktopOnly: true,
  },
];

export function SourcePicker({
  open,
  onOpenChange,
  onStart,
  preferredSurface,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onStart: (opts: StartOptions) => void;
  preferredSurface?: SurfaceKind;
}) {
  const desktop = isTauri();
  const { requireFeature } = useAccount();
  const [surface, setSurface] = useState<SurfaceKind>(preferredSurface ?? "screen");
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [smoothCursor, setSmoothCursor] = useState(true);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, setSerial] = useState<string>("");
  const [androidBusy, setAndroidBusy] = useState(false);
  const [androidMsg, setAndroidMsg] = useState<string>("");
  const [usbNote, setUsbNote] = useState<string>("");
  const { project } = useStudio();
  const speakLang = project.voiceover?.speakLang || navigator.language || "en-US";

  useEffect(() => {
    if (open && preferredSurface) setSurface(preferredSurface);
  }, [open, preferredSurface]);

  useEffect(() => {
    if (!open || surface !== "android" || !desktop) return;
    let cancelled = false;
    (async () => {
      setAndroidBusy(true);
      try {
        const note = await androidUsbNote();
        if (!cancelled) setUsbNote(note);
        const status = await androidRuntimeStatus();
        if (!cancelled) setAndroidMsg(status.message);
        if (!status.ready) {
          const installed = await androidEnsureRuntime();
          if (!cancelled) setAndroidMsg(installed.message);
        }
        const list = await androidListDevices();
        if (cancelled) return;
        setDevices(list);
        const ready = list.filter((d) => d.state === "device");
        if (ready.length === 1) setSerial(ready[0]!.serial);
        else if (ready.length > 1 && !ready.some((d) => d.serial === serial)) setSerial("");
      } catch (err) {
        if (!cancelled) {
          setAndroidMsg(err instanceof Error ? err.message : String(err));
          setDevices([]);
        }
      } finally {
        if (!cancelled) setAndroidBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when opening Android pane
  }, [open, surface, desktop]);

  const refreshDevices = async () => {
    setAndroidBusy(true);
    try {
      await androidEnsureRuntime();
      const list = await androidListDevices();
      setDevices(list);
      setAndroidMsg(list.length ? `${list.length} device(s) found` : "No devices — check USB debugging");
    } catch (err) {
      setAndroidMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setAndroidBusy(false);
    }
  };

  const androidReady = devices.filter((d) => d.state === "device");
  const canStartAndroid =
    surface !== "android" ||
    (desktop && !androidBusy && (serial ? androidReady.some((d) => d.serial === serial) : androidReady.length === 1));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px] gap-0 overflow-hidden border-hairline bg-panel p-0">
        <DialogHeader className="min-w-0 px-5 pb-1 pt-5">
          <DialogTitle className="text-[15px]">New recording</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-1.5 px-5 pt-2">
          {SURFACES.filter((s) => !s.desktopOnly || desktop).map((s) => (
            <button
              key={s.value}
              onClick={() => {
                if (s.value === "android" && !requireFeature("androidUsb", "Android USB recording")) {
                  return;
                }
                setSurface(s.value);
              }}
              className={cn(
                "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                surface === s.value ? "bg-primary/15 ring-1 ring-primary" : "bg-panel-raised hover:bg-accent",
              )}
            >
              <s.icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  surface === s.value ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 overflow-hidden">
                <span className="block truncate text-[13px] font-medium">{s.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{s.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {surface === "android" && desktop && (
          <div className="mt-3 min-w-0 space-y-2 border-t border-hairline px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium">Connected phones</p>
              <button
                type="button"
                onClick={() => void refreshDevices()}
                disabled={androidBusy}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {androidBusy ? <Download className="h-3 w-3 animate-pulse" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>
            {androidReady.length === 0 ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {androidMsg ||
                  "Plug in USB · enable Developer options → USB debugging · unlock phone and tap Allow."}
              </p>
            ) : (
              <div className="space-y-1">
                {androidReady.map((d) => (
                  <button
                    key={d.serial}
                    type="button"
                    onClick={() => setSerial(d.serial)}
                    className={cn(
                      "flex w-full min-w-0 flex-col rounded-md px-2.5 py-2 text-left text-[12px]",
                      serial === d.serial || androidReady.length === 1
                        ? "bg-primary/15 ring-1 ring-primary"
                        : "bg-panel-raised hover:bg-accent",
                    )}
                  >
                    <span className="truncate font-medium">{d.label}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {d.transport === "usb" ? "USB" : "Network"} · {d.serial}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-[10px] leading-snug text-muted-foreground">
              {usbNote ||
                "A small USB helper installs once into app data. Only your debug phone is used."}
            </p>
          </div>
        )}

        <div className="mt-3 min-w-0 space-y-0.5 border-t border-hairline px-5 py-3">
          {(
            [
              ["Camera", Video, camera, setCamera, "Webcam overlay on the recording", surface !== "android"],
              ["Microphone", Mic, microphone, setMicrophone, "Voice for narration and captions", true],
              [
                "System audio",
                Volume2,
                systemAudio,
                setSystemAudio,
                surface === "android"
                  ? "Phone audio is captured when available"
                  : "App or tab sound — turn on Share audio in the next dialog",
                surface !== "android",
              ],
              [
                "Smooth cursor in editor",
                MousePointerClick,
                smoothCursor,
                setSmoothCursor,
                surface === "android"
                  ? "Control the phone from the mirror window"
                  : "Shows a smoothed cursor in the final video",
                surface !== "android",
              ],
            ] as const
          )
            .filter((row) => row[5])
            .map(([label, Icon, value, set, hint]) => (
              <div key={label} className="flex min-w-0 items-center justify-between gap-3 py-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="truncate text-[12.5px]">{label}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
                  </div>
                </div>
                <Switch checked={value} onCheckedChange={set} className="shrink-0" />
              </div>
            ))}
          {surface === "android" && (
            <p className="pt-1 text-[11px] text-muted-foreground">
              Mouse & keyboard control the phone in the mirror window while recording.
            </p>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-between gap-3 border-t border-hairline px-5 py-4">
          <p className="min-w-0 flex-1 text-[11px] leading-tight text-muted-foreground">
            {surface === "android"
              ? androidBusy
                ? "Preparing Android tools…"
                : "Press Stop in Screen Beaver when you’re done"
              : systemAudio
                ? "Turn on Share audio in the next dialog for system sound"
                : "Your cursor stays visible while recording"}
          </p>
          <button
            disabled={surface === "android" && !canStartAndroid}
            onClick={() => {
              unlockUiSounds();
              playClick();
              const picked =
                serial ||
                (androidReady.length === 1 ? androidReady[0]!.serial : undefined);
              onStart({
                surface,
                camera: surface === "android" ? false : camera,
                microphone,
                systemAudio: surface === "android" ? false : systemAudio,
                smoothCursor: surface === "android" ? false : smoothCursor,
                speakLang,
                androidSerial: surface === "android" ? picked : undefined,
              });
            }}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {surface === "android" ? "Start Android" : "Start recording"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
