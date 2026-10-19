import { useCallback, useEffect, useState } from "react";
import { Copy, RefreshCw, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  fetchRemoteMcpStatus,
  regenerateRemoteMcpToken,
  refreshRemoteMcpTunnel,
  syncRemoteMcp,
  type RemoteMcpStatus,
} from "@/lib/studio/remoteMcp";

export function RemoteMcpPanel({ light }: { light: boolean }) {
  const [status, setStatus] = useState<RemoteMcpStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await fetchRemoteMcpStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u1 = await listen<{ publicUrl?: string }>("remote-mcp://url", (ev) => {
          setStatus((prev) =>
            prev
              ? { ...prev, publicUrl: ev.payload.publicUrl ?? prev.publicUrl, running: true }
              : prev,
          );
        });
        const u2 = await listen<RemoteMcpStatus>("remote-mcp://status", (ev) => {
          setStatus(ev.payload);
        });
        unlisten = () => {
          u1();
          u2();
        };
      } catch {
        /* not in Tauri */
      }
    })();
    return () => {
      window.clearInterval(id);
      unlisten?.();
    };
  }, [refresh]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Could not copy");
    }
  };

  const onRegenerate = async () => {
    setBusy(true);
    try {
      const next = await regenerateRemoteMcpToken();
      if (next) setStatus(next);
      toast.success("Token regenerated");
    } finally {
      setBusy(false);
    }
  };

  const onRefreshTunnel = async () => {
    setBusy(true);
    try {
      if (!status?.running) {
        const next = await syncRemoteMcp(true);
        if (next) setStatus(next);
        toast.message("Restarting Remote MCP…");
        return;
      }
      const next = await refreshRemoteMcpTunnel();
      if (next) setStatus(next);
      else await refresh();
      toast.message("Refreshing tunnel…");
    } finally {
      setBusy(false);
    }
  };

  const running = status?.running === true;
  const publicUrl = status?.publicUrl ?? null;
  const token = status?.token ?? null;
  const onlineAiUrl = publicUrl;
  const agentUrl = publicUrl
    ? publicUrl.replace(/\?token=[^&#]+/, "").replace(/\?$/, "")
    : null;

  return (
    <div
      className={cn(
        "mb-4 rounded-2xl border p-4",
        light ? "border-hairline bg-shell" : "border-white/10 bg-white/[0.03]",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold">Remote MCP</p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
            running
              ? "bg-teal-400/20 text-teal-800 dark:text-teal-200"
              : "bg-amber-500/15 text-amber-900 dark:text-amber-100",
          )}
        >
          {running ? "Online" : status?.lastError ? "Offline" : "Starting…"}
        </span>
      </div>

      {status?.lastError ? (
        <p className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-100/90">
          {status.lastError}
        </p>
      ) : null}

      <div className="space-y-2">
        <FieldRow
          label="Online AI URL"
          value={onlineAiUrl ?? "Loading…"}
          canCopy={Boolean(onlineAiUrl)}
          onCopy={() => onlineAiUrl && void copy("Online AI URL", onlineAiUrl)}
        />
        <FieldRow
          label="Remote agent URL"
          value={agentUrl ?? "Loading…"}
          canCopy={Boolean(agentUrl)}
          onCopy={() => agentUrl && void copy("Remote agent URL", agentUrl)}
        />
        <FieldRow
          label="Authorization"
          value={token ? `Bearer ${token}` : "-"}
          canCopy={Boolean(token)}
          onCopy={() => token && void copy("Token", `Bearer ${token}`)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRefreshTunnel()}
          className="inline-flex items-center gap-1.5 rounded-full bg-panel-raised px-3 py-1.5 text-[11px] font-semibold hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" />
          {running ? "Refresh tunnel" : "Retry start"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRegenerate()}
          className="inline-flex items-center gap-1.5 rounded-full bg-panel-raised px-3 py-1.5 text-[11px] font-semibold hover:bg-accent disabled:opacity-50"
        >
          <KeyRound className="h-3 w-3" />
          Regenerate token
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  canCopy,
  onCopy,
}: {
  label: string;
  value: string;
  canCopy: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-panel-raised/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="break-all font-mono text-[11px] leading-snug">{value}</p>
      </div>
      {canCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
