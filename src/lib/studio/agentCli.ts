/**
 * Host coding-agent CLIs in a PTY from the desktop app.
 * Detects Claude Code, Codex, and Cursor Agent on PATH before offering the feature.
 */

import { isTauri } from "./nativeBridge";

export type AgentCliProvider = {
  id: string;
  label: string;
  command: string;
  detected: boolean;
  path?: string | null;
};

export type AgentCliCapabilities = {
  ptyAvailable: boolean;
  providers: AgentCliProvider[];
};

export type AgentCliStatus = {
  running: boolean;
  sessionId?: string | null;
  providerId?: string | null;
  url?: string | null;
  startedAt?: number | null;
  outputTail: string;
};

export type AgentCliOutputEvent = {
  sessionId: string;
  chunk: string;
};

export type AgentCliExitEvent = {
  sessionId: string;
  exitCode: number;
  error?: string;
  outputTail: string;
};

export type AgentCliStartedEvent = {
  sessionId: string;
  providerId: string;
  url: string;
};

/** Providers that were found on PATH. */
export function detectedProviders(caps: AgentCliCapabilities | null): AgentCliProvider[] {
  if (!caps?.ptyAvailable) return [];
  return caps.providers.filter((p) => p.detected);
}

/** True when PTY works and at least one agent CLI is installed. */
export function agentDemoAvailable(caps: AgentCliCapabilities | null): boolean {
  return detectedProviders(caps).length > 0;
}

export async function fetchAgentCliCapabilities(): Promise<AgentCliCapabilities | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<AgentCliCapabilities>("agent_cli_capabilities");
  } catch {
    return null;
  }
}

export async function fetchAgentCliStatus(): Promise<AgentCliStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<AgentCliStatus>("agent_cli_status");
  } catch {
    return null;
  }
}

export async function startAgentDemo(opts: {
  providerId: string;
  url: string;
  productName?: string;
}): Promise<AgentCliStatus> {
  if (!isTauri()) throw new Error("Agent demo requires the Screen Beaver desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentCliStatus>("agent_cli_start", {
    providerId: opts.providerId,
    url: opts.url.trim(),
    productName: opts.productName?.trim() || null,
    cwd: null,
  });
}

export async function stopAgentDemo(): Promise<AgentCliStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<AgentCliStatus>("agent_cli_stop");
  } catch {
    return null;
  }
}

type Unlisten = () => void;

export async function listenAgentCliOutput(
  handler: (ev: AgentCliOutputEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<AgentCliOutputEvent>("agent-cli-output", (e) => handler(e.payload));
  return un;
}

export async function listenAgentCliExit(
  handler: (ev: AgentCliExitEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<AgentCliExitEvent>("agent-cli-exit", (e) => handler(e.payload));
  return un;
}

export async function listenAgentCliStarted(
  handler: (ev: AgentCliStartedEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<AgentCliStartedEvent>("agent-cli-started", (e) => handler(e.payload));
  return un;
}
