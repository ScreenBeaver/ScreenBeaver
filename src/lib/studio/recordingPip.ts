/**
 * Floating Document Picture-in-Picture bar so Zoom / Camera / Stop stay reachable
 * while the user works in Excel or another shared app.
 */

export type PipActions = {
  onZoom: () => void;
  onCamera: () => void;
  onStop: () => void;
  getElapsed: () => number;
};

type PipHandle = {
  close: () => void;
};

export function supportsRecordingPip(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

export async function openRecordingPip(actions: PipActions): Promise<PipHandle | null> {
  const dpi = (
    window as Window & {
      documentPictureInPicture?: {
        requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
        window?: Window | null;
      };
    }
  ).documentPictureInPicture;

  if (!dpi) return null;
  if (dpi.window) {
    try {
      dpi.window.close();
    } catch {
      /* ignore */
    }
  }

  let pip: Window;
  try {
    pip = await dpi.requestWindow({ width: 360, height: 72 });
  } catch {
    return null;
  }

  const doc = pip.document;
  doc.head.innerHTML = `<style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; height: 100%;
      font: 600 12px/1.2 system-ui, sans-serif;
      background: #141416; color: #f4f4f5;
      user-select: none;
    }
    body {
      display: flex; align-items: center; gap: 8px;
      padding: 0 12px;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #ef4444;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse { 50% { opacity: 0.45; } }
    .time { min-width: 48px; font-variant-numeric: tabular-nums; }
    button {
      border: 0; border-radius: 8px; padding: 8px 10px;
      background: #232328; color: inherit; font: inherit; cursor: pointer;
    }
    button:hover { background: #2e2e34; }
    button.stop { background: #ef4444; color: #fff; }
    button.stop:hover { filter: brightness(1.08); }
  </style>`;

  doc.body.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <span class="time">0.0s</span>
    <button type="button" data-act="zoom">Zoom</button>
    <button type="button" data-act="camera">Camera</button>
    <button type="button" class="stop" data-act="stop">Stop</button>
  `;

  const timeEl = doc.querySelector(".time") as HTMLElement;
  const tick = window.setInterval(() => {
    if (!timeEl || pip.closed) {
      window.clearInterval(tick);
      return;
    }
    timeEl.textContent = `${actions.getElapsed().toFixed(1)}s`;
  }, 200);

  doc.body.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === "zoom") actions.onZoom();
    else if (act === "camera") actions.onCamera();
    else if (act === "stop") actions.onStop();
  });

  // Forward Shift+Space / shortcuts while the PiP is focused
  pip.addEventListener("keydown", (e) => {
    if (e.shiftKey && e.code === "Space") {
      e.preventDefault();
      actions.onCamera();
    }
  });

  const close = () => {
    window.clearInterval(tick);
    try {
      if (!pip.closed) pip.close();
    } catch {
      /* ignore */
    }
  };

  pip.addEventListener("pagehide", () => window.clearInterval(tick));

  return { close };
}
