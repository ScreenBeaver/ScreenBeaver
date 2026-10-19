/**
 * Bridge to the Tauri desktop shell + Chrome/Edge extension.
 * When running inside the EXE, system-wide cursor / Shift|Ctrl+Click / Alt-hold zooms work.
 */

import type { CursorIconBitmap, CursorShape } from "./types";

export type NativeCursorEvent = {
  x: number;
  y: number;
  down: boolean;
  /** Right mouse button held (desktop hook). */
  right?: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  shape?: CursorShape;
  iconId?: string;
  icon?: CursorIconBitmap;
  source: "desktop" | "extension";
};

export type NativeMarkerEvent = {
  kind: "zoom" | "camera-move" | "scene-effect";
  x: number;
  y: number;
  duration?: number;
  /** Ctrl+1…7 preset id when kind is scene-effect. */
  preset?: string;
  source: "desktop" | "extension";
};

export type NativeSoundEvent = {
  kind: "typing";
  source: "desktop" | "extension";
};

export type NativeKeystrokeEvent = {
  label: string;
  keys: string[];
  source: "desktop" | "extension";
};

type Unlisten = () => void;

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Sync Pro/Team MCP entitlement into the native HTTP bridge (fail closed when false). */
export async function setMcpEntitled(entitled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_mcp_entitled", { entitled });
  } catch {
    /* bridge command unavailable in web-only */
  }
}

/** Bring Screen Beaver back in front after a recording ends. */
export async function focusStudioWindow(): Promise<void> {
  try {
    window.focus();
  } catch {
    /* ignore */
  }
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.unminimize();
    await win.setFocus();
    await win.show();
  } catch (err) {
    console.warn("focusStudioWindow", err);
  }
}

export async function startNativePointerHook(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("start_pointer_hook");
    return true;
  } catch (err) {
    console.error("start_pointer_hook failed", err);
    return false;
  }
}

export async function stopNativePointerHook(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stop_pointer_hook");
  } catch (err) {
    console.error("stop_pointer_hook failed", err);
  }
}

export async function listenNativeCursor(
  handler: (ev: NativeCursorEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeCursorEvent>("native-cursor", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export async function listenNativeMarker(
  handler: (ev: NativeMarkerEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeMarkerEvent>("native-marker", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export async function listenNativeSound(
  handler: (ev: NativeSoundEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeSoundEvent>("native-sound", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export type NativeCaretEvent = {
  /** Normalized like native-cursor (virtual screen). */
  x: number;
  y: number;
  source: "desktop" | "extension";
};

export async function listenNativeCaret(
  handler: (ev: NativeCaretEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeCaretEvent>("native-caret", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export async function listenNativeKeystroke(
  handler: (ev: NativeKeystrokeEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeKeystrokeEvent>("native-keystroke", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export type AgentCommandEvent = {
  id: string;
  action: string;
  payload: unknown;
};

export async function listenAgentCommand(
  handler: (ev: AgentCommandEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<AgentCommandEvent>("agent-command", (e) => handler(e.payload));
  return () => {
    void un();
  };
}

export async function reportAgentResult(
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("agent_report_result", { id, body: JSON.stringify(body) });
  } catch (err) {
    console.error("agent_report_result failed", err);
  }
}

export type NativeCaptureStartedEvent = {
  ok?: boolean;
  recording?: boolean;
  sourceLabel?: string;
  width?: number;
  height?: number;
  path?: string;
};

export type NativeCaptureStoppedEvent = {
  path: string;
  mediaUrl?: string;
  width: number;
  height: number;
  durationMs: number;
  sourceLabel: string;
};

export async function listenNativeCaptureStarted(
  handler: (ev: NativeCaptureStartedEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeCaptureStartedEvent>("native-capture-started", (e) =>
    handler(e.payload),
  );
  return () => {
    void un();
  };
}

export async function listenNativeCaptureStopped(
  handler: (ev: NativeCaptureStoppedEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<NativeCaptureStoppedEvent>("native-capture-stopped", (e) =>
    handler(e.payload),
  );
  return () => {
    void un();
  };
}
