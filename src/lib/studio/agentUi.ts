/** Lightweight events so AgentHost can drive studio chrome (picker, focus UI). */

export type AgentUiEventDetail =
  | { type: "open-picker"; surface?: "screen" | "application" | "tab" | "android" }
  | { type: "close-picker" }
  | { type: "native-recording"; active: boolean };

const EVENT = "sw-agent-ui";

export function emitAgentUi(detail: AgentUiEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

export function listenAgentUi(handler: (detail: AgentUiEventDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<AgentUiEventDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

export function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}
