/**
 * In-app Remote MCP (Streamable HTTP) — Pro/Team only.
 * Prefers mcp.screenbeaver.com relay; falls back to Cloudflare quick tunnel.
 */

import { isTauri } from "@/lib/studio/nativeBridge";

export type RemoteMcpStatus = {
  enabled: boolean;
  running: boolean;
  port: number;
  localUrl: string;
  publicUrl: string | null;
  token: string | null;
  mcpPid: number | null;
  tunnelPid: number | null;
  /** "relay" | "quick" | null */
  tunnelMode: string | null;
  lastError: string | null;
  nodeFound: boolean;
};

export function isRemoteMcpPlan(planSlug: string | null | undefined): boolean {
  const s = (planSlug ?? "").toLowerCase().trim();
  return s === "pro" || s === "team";
}

export async function fetchRemoteMcpStatus(): Promise<RemoteMcpStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RemoteMcpStatus>("remote_mcp_status");
  } catch {
    return null;
  }
}

export async function syncRemoteMcp(enabled: boolean): Promise<RemoteMcpStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RemoteMcpStatus>("remote_mcp_sync", { enabled });
  } catch (err) {
    console.warn("remote_mcp_sync", err);
    return null;
  }
}

export async function regenerateRemoteMcpToken(): Promise<RemoteMcpStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RemoteMcpStatus>("remote_mcp_regenerate_token");
  } catch (err) {
    console.warn("remote_mcp_regenerate_token", err);
    return null;
  }
}

export async function refreshRemoteMcpTunnel(): Promise<RemoteMcpStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RemoteMcpStatus>("remote_mcp_refresh_tunnel");
  } catch (err) {
    console.warn("remote_mcp_refresh_tunnel", err);
    return null;
  }
}
