import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Square, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  agentDemoAvailable,
  detectedProviders,
  fetchAgentCliCapabilities,
  fetchAgentCliStatus,
  listenAgentCliExit,
  listenAgentCliOutput,
  startAgentDemo,
  stopAgentDemo,
  type AgentCliCapabilities,
  type AgentCliProvider,
} from "@/lib/studio/agentCli";
import { logHomeActivity, logMcpActivity } from "@/lib/studio/homeActivity";
import { playClick } from "@/lib/studio/sounds";

type Props = {
  light?: boolean;
  mcpEntitled?: boolean;
  onEnterStudio?: () => void;
  className?: string;
};

export function AgentDemoLauncher({
  light = false,
  mcpEntitled = true,
  onEnterStudio,
  className,
}: Props) {
  const [caps, setCaps] = useState<AgentCliCapabilities | null>(null);
  const [checking, setChecking] = useState(true);
  const [url, setUrl] = useState("");
  const [productName, setProductName] = useState("");
  const [providerId, setProviderId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const providers = useMemo(() => detectedProviders(caps), [caps]);
  const available = agentDemoAvailable(caps) && mcpEntitled;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setChecking(true);
      const next = await fetchAgentCliCapabilities();
      if (cancelled) return;
      setCaps(next);
      const detected = detectedProviders(next);
      if (detected.length > 0) setProviderId((prev) => prev || detected[0].id);
      const status = await fetchAgentCliStatus();
      if (cancelled) return;
      if (status?.running) {
        setRunning(true);
        setOutput(status.outputTail || "");
        if (status.url) setUrl(status.url);
        if (status.providerId) setProviderId(status.providerId);
        setExpanded(true);
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!available) return;
    let unOut: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    void (async () => {
      unOut = await listenAgentCliOutput((ev) => {
        setOutput((prev) => {
          const next = prev + ev.chunk;
          return next.length > 48_000 ? next.slice(-48_000) : next;
        });
      });
      unExit = await listenAgentCliExit((ev) => {
        setRunning(false);
        setOutput(ev.outputTail || "");
        logMcpActivity("Agent session finished", `exit ${ev.exitCode}`);
        if (ev.exitCode === 0) {
          toast.success("Agent finished", {
            description: "Check Screen Beaver for the built demo. Click Export when ready.",
          });
          onEnterStudio?.();
        } else {
          toast.message("Agent session ended", {
            description: ev.error || `Exit code ${ev.exitCode}`,
          });
        }
      });
    })();
    return () => {
      unOut?.();
      unExit?.();
    };
  }, [available, onEnterStudio]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  if (checking || !available) return null;

  const start = async () => {
    playClick();
    const trimmed = url.trim();
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      toast.error("Enter a valid product URL (https://…)");
      return;
    }
    if (!providerId) {
      toast.error("Choose an agent CLI");
      return;
    }
    setExpanded(true);
    setOutput("");
    setRunning(true);
    try {
      const status = await startAgentDemo({
        providerId,
        url: trimmed,
        productName: productName.trim() || undefined,
      });
      setOutput(status.outputTail || "");
      const label = providers.find((p) => p.id === providerId)?.label ?? providerId;
      logHomeActivity("create", "Agent demo started", trimmed);
      logMcpActivity("Agent CLI started", `${label} · ${trimmed}`);
      toast.message("Agent is researching and building", {
        description: `${label} is running in a local terminal. Watch Screen Beaver for capture.`,
      });
    } catch (err) {
      setRunning(false);
      toast.error(err instanceof Error ? err.message : "Could not start agent");
    }
  };

  const stop = async () => {
    playClick();
    await stopAgentDemo();
    setRunning(false);
    logMcpActivity("Agent session stopped", "User stopped");
    toast.message("Agent stopped");
  };

  return (
    <div
      className={cn(
        "rounded-2xl border backdrop-blur-md",
        light ? "border-hairline bg-panel/90" : "border-white/15 bg-black/45",
        className,
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            light ? "bg-teal-400/15 text-teal-700" : "bg-teal-400/15 text-teal-200",
          )}
        >
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-teal-600 dark:text-teal-300/90">
              Agent demo
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              Paste a product URL — your installed CLI researches the site and builds the demo via
              MCP. No paste into Cursor needed.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-product.com"
              disabled={running}
              className={cn(
                "w-full rounded-xl border px-3 py-2 text-[13px] outline-none ring-teal-500/30 focus:ring-2",
                light
                  ? "border-hairline bg-shell text-foreground"
                  : "border-white/10 bg-white/5 text-white placeholder:text-white/35",
              )}
            />
            <ProviderSelect
              providers={providers}
              value={providerId}
              onChange={setProviderId}
              disabled={running}
              light={light}
            />
          </div>

          <input
            type="text"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Product name (optional)"
            disabled={running}
            className={cn(
              "w-full rounded-xl border px-3 py-2 text-[12px] outline-none ring-teal-500/30 focus:ring-2",
              light
                ? "border-hairline bg-shell text-foreground"
                : "border-white/10 bg-white/5 text-white placeholder:text-white/35",
            )}
          />

          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <button
                type="button"
                onClick={() => void stop()}
                className="inline-flex items-center gap-2 rounded-full bg-red-500/90 px-4 py-2 text-[12px] font-bold text-white hover:bg-red-500"
              >
                <Square className="h-3 w-3 fill-current" />
                Stop agent
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                className="inline-flex items-center gap-2 rounded-full bg-[#9ef0d2] px-4 py-2 text-[12px] font-bold text-black hover:brightness-105"
              >
                <Bot className="h-3.5 w-3.5" />
                Build demo with agent
              </button>
            )}
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-teal-600 dark:text-teal-300/80">
                <Loader2 className="h-3 w-3 animate-spin" />
                Agent running…
              </span>
            ) : null}
            {(output.length > 0 || expanded) && !running ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                {expanded ? "Hide terminal" : "Show terminal"}
              </button>
            ) : null}
          </div>

          <InstalledHint providers={providers} light={light} />
        </div>
      </div>

      {(expanded || running) && output.length > 0 ? (
        <div
          className={cn(
            "border-t px-4 py-3",
            light ? "border-hairline bg-shell/80" : "border-white/10 bg-black/60",
          )}
        >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Agent terminal
          </p>
          <pre
            ref={outputRef}
            className={cn(
              "max-h-44 overflow-auto rounded-xl border p-3 font-mono text-[10.5px] leading-relaxed",
              light
                ? "border-hairline bg-background text-foreground/90"
                : "border-white/10 bg-black/80 text-teal-100/90",
            )}
          >
            {output || (running ? "Waiting for agent output…" : "")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ProviderSelect({
  providers,
  value,
  onChange,
  disabled,
  light,
}: {
  providers: AgentCliProvider[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  light: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "rounded-xl border px-3 py-2 text-[12px] font-semibold outline-none",
        light
          ? "border-hairline bg-shell text-foreground"
          : "border-white/10 bg-white/5 text-white",
      )}
    >
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

function InstalledHint({
  providers,
  light,
}: {
  providers: AgentCliProvider[];
  light: boolean;
}) {
  return (
    <p className={cn("text-[10px]", light ? "text-muted-foreground" : "text-white/40")}>
      Detected:{" "}
      {providers.map((p) => p.label).join(", ")}. Install Claude Code, Codex, or Cursor Agent CLI
      if yours is missing.
    </p>
  );
}
