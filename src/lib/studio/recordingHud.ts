/**
 * Always-on-top Document PiP bar so Zoom / Camera / Stop stay reachable
 * while the user works in Excel or another shared app.
 */

export type RecordingHudActions = {
  onZoom: () => void;
  onCamera: () => void;
  onStop: () => void;
  getElapsed: () => number;
};

type PipWindow = Window & { closed: boolean };

let pipWindow: PipWindow | null = null;
let elapsedTimer: number | null = null;

function supportsDocPip(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

export async function openRecordingPip(actions: RecordingHudActions): Promise<boolean> {
  if (!supportsDocPip()) return false;
  await closeRecordingPip();

  try {
    const api = window.documentPictureInPicture as {
      requestWindow: (opts?: { width?: number; height?: number; disallowReturnToOpener?: boolean }) => Promise<Window>;
    };
    const win = await api.requestWindow({
      width: 360,
      height: 64,
      disallowReturnToOpener: true,
    });
    pipWindow = win as PipWindow;

    const doc = win.document;
    doc.head.innerHTML = `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;
        background: #141416;
        color: #f4f4f5;
        height: 100%;
        display: flex;
        align-items: center;
        padding: 0 10px;
        gap: 8px;
        user-select: none;
      }
      .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #ef4444;
        box-shadow: 0 0 0 0 rgba(239,68,68,0.6);
        animation: pulse 1.2s ease-out infinite;
      }
      @keyframes pulse {
        70% { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
        100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
      }
      .time { min-width: 48px; font-variant-numeric: tabular-nums; }
      button {
        border: 0; border-radius: 8px; padding: 7px 10px;
        background: #232328; color: #f4f4f5; font: inherit; cursor: pointer;
      }
      button:hover { background: #2e2e34; }
      button.stop { background: #ef4444; color: white; font-weight: 700; }
      button.stop:hover { filter: brightness(1.05); }
    </style>`;

    doc.body.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span class="time" id="t">0.0s</span>
      <button type="button" id="zoom" title="Zoom at cursor">Zoom</button>
      <button type="button" id="cam" title="Camera sweep">Camera</button>
      <button type="button" class="stop" id="stop">Stop</button>
    `;

    doc.getElementById("zoom")?.addEventListener("click", () => actions.onZoom());
    doc.getElementById("cam")?.addEventListener("click", () => actions.onCamera());
    doc.getElementById("stop")?.addEventListener("click", () => actions.onStop());

    const timeEl = doc.getElementById("t");
    elapsedTimer = window.setInterval(() => {
      if (!timeEl || !pipWindow || pipWindow.closed) return;
      timeEl.textContent = `${actions.getElapsed().toFixed(1)}s`;
    }, 200);

    win.addEventListener("pagehide", () => {
      void closeRecordingPip();
    });
    return true;
  } catch {
    pipWindow = null;
    return false;
  }
}

export async function closeRecordingPip() {
  if (elapsedTimer != null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (pipWindow && !pipWindow.closed) {
    try {
      pipWindow.close();
    } catch {
      /* ignore */
    }
  }
  pipWindow = null;
}
