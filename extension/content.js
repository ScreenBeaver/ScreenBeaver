/**
 * Screen Beaver companion — runs in every tab.
 * Shift+Click or Ctrl+Click → zoom marker (tab-normalized coords).
 * Shift+Space → camera sweep.
 * Pointer moves stream to the desktop app while recording.
 */

function post(payload) {
  try {
    chrome.runtime.sendMessage({ type: "sw-bridge", payload });
  } catch {
    /* extension context invalidated */
  }
}

function norm(e) {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  return {
    x: Math.min(1, Math.max(0, e.clientX / w)),
    y: Math.min(1, Math.max(0, e.clientY / h)),
  };
}

function cssShape(e) {
  try {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const c = (el ? getComputedStyle(el).cursor : "default").toLowerCase().split(",")[0].trim();
    if (c === "text" || c === "vertical-text") return "ibeam";
    if (c === "crosshair" || c === "cell") return "cross";
    if (c === "pointer" || c === "grab" || c === "grabbing") return "hand";
    if (c === "wait" || c === "progress") return "wait";
    if (c === "move" || c === "all-scroll") return "move";
    if (c.includes("resize")) {
      if (c.includes("ns") || c === "row-resize") return "resize-ns";
      if (c.includes("ew") || c === "col-resize") return "resize-ew";
      if (c.includes("nesw")) return "resize-nesw";
      if (c.includes("nwse")) return "resize-nwse";
    }
    if (c === "not-allowed" || c === "no-drop") return "not-allowed";
  } catch {
    /* ignore */
  }
  return "arrow";
}

let lastSent = 0;
window.addEventListener(
  "pointermove",
  (e) => {
    const now = performance.now();
    if (now - lastSent < 16) return;
    lastSent = now;
    const p = norm(e);
    post({
      kind: "cursor",
      x: p.x,
      y: p.y,
      down: (e.buttons & 1) !== 0,
      right: (e.buttons & 2) !== 0,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shape: cssShape(e),
    });
  },
  { passive: true, capture: true },
);

window.addEventListener(
  "pointerdown",
  (e) => {
    const p = norm(e);
    const isRight = e.button === 2;
    post({
      kind: "cursor",
      x: p.x,
      y: p.y,
      down: !isRight,
      right: isRight,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shape: cssShape(e),
    });
    if (!isRight && (e.shiftKey || e.ctrlKey)) {
      post({ kind: "zoom", x: p.x, y: p.y });
    }
  },
  true,
);

window.addEventListener(
  "keydown",
  (e) => {
    if (e.shiftKey && e.code === "Space") {
      e.preventDefault();
      post({ kind: "camera-move", x: 0.5, y: 0.5 });
    }
  },
  true,
);
