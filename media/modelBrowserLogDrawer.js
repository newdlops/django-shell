// Resizable persisted Query Log drawer behavior for the model-browser webview.

/** Installs persisted open state and pointer resizing for the Query Log drawer. */
export function installLogDrawer({ panel, resizeHandle, toggle, vscode }) {
  if (!resizeHandle || !panel) { return; }
  const savedState = vscode.getState() || {};
  toggleLogPanel({ open: Boolean(savedState.logOpen), panel, toggle });
  setPanelHeight(savedState.logHeight || panel.offsetHeight || 220, resizeHandle);
  resizeHandle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.offsetHeight;
    resizeHandle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    /** Updates the panel size as the pointer moves. */
    const move = (moveEvent) => {
      setPanelHeight(startHeight + (startY - moveEvent.clientY), resizeHandle);
    };
    /** Cleans up pointer listeners and persists the final height. */
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      resizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      vscode.setState({ ...(vscode.getState() || {}), logHeight: Math.round(panel.offsetHeight) });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  resizeHandle.addEventListener("keydown", (event) => {
    const maximum = maximumLogHeight();
    const current = panel.offsetHeight || 220;
    const step = event.shiftKey ? 64 : 16;
    let next;
    if (event.key === "ArrowUp") { next = current + step; }
    else if (event.key === "ArrowDown") { next = current - step; }
    else if (event.key === "Home") { next = 72; }
    else if (event.key === "End") { next = maximum; }
    if (next === undefined) { return; }
    event.preventDefault();
    setPanelHeight(next, resizeHandle);
    vscode.setState({ ...(vscode.getState() || {}), logHeight: Math.round(clampLogHeight(next)) });
  });
}

/** Applies a Query Log disclosure state to both its panel and trigger. */
export function toggleLogPanel({ open, panel, toggle }) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

/** Keeps the drawer usable while preserving enough room for the grid. */
function clampLogHeight(value) {
  return Math.max(72, Math.min(value, maximumLogHeight()));
}

/** Returns the drawer's bounded maximum height: no more than 60% of the viewport. */
function maximumLogHeight() {
  return Math.max(120, Math.min(Math.floor(window.innerHeight * 0.6), window.innerHeight - 160));
}

/** Applies a bounded drawer height and exposes its value to assistive technology. */
function setPanelHeight(value, resizeHandle) {
  const next = clampLogHeight(value);
  document.documentElement.style.setProperty("--log-h", `${next}px`);
  resizeHandle.setAttribute("aria-valuemin", "72");
  resizeHandle.setAttribute("aria-valuemax", String(maximumLogHeight()));
  resizeHandle.setAttribute("aria-valuenow", String(Math.round(next)));
}
