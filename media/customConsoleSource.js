// Custom Django shell webview client that mounts xterm and notebook-like Python cells.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";

const STYLE_ID = "django-shell-custom-console-style";
const vscode = acquireVsCodeApi();
const terminalHost = document.getElementById("terminal");
const focusTerminalButton = document.getElementById("focusTerminal");
const setupCell = document.getElementById("setupCell");
const status = document.getElementById("status");
const currentOutput = document.getElementById("currentOutput");
const currentOutputLabel = document.getElementById("currentOutputLabel");
const outputList = document.getElementById("outputList");
const editorAnchor = document.getElementById("editorAnchor");
const inputPrompt = document.getElementById("inputPrompt");
const inputPromptText = inputPrompt && inputPrompt.querySelector(".promptMark");
const pythonCell = document.getElementById("pythonCell");
const statusText = document.getElementById("statusText");

let fitAddon;
let geometryFrame = 0;
let pendingExecution = 0;
let snapshotWritten = false;
let terminal;

/** Starts the webview client after the DOM has been created by the extension host. */
function main() {
  ensureStyle();
  mountTerminal();
  wirePythonCell();
  wireCellResizers();
  window.addEventListener("message", (event) => handleHostMessage(event.data || {}));
  focusTerminalButton.addEventListener("click", () => terminal.focus());
  document.getElementById("restart").addEventListener("click", () => vscode.postMessage({ type: "restart" }));
  vscode.postMessage({ type: "ready" });
}

/** Mounts xterm so setup input, cursor movement, and ANSI colors behave like a terminal. */
function mountTerminal() {
  terminal = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    fontFamily: terminalFontFamily(),
    fontSize: terminalFontSize(),
    scrollback: 5000,
    theme: terminalTheme()
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost);
  terminal.onData((data) => vscode.postMessage({ data, type: "terminalInput" }));
  terminal.onResize(({ cols, rows }) => vscode.postMessage({ cols, rows, type: "terminalResize" }));
  terminalHost.addEventListener("click", () => terminal.focus());
  new ResizeObserver(() => fitTerminal()).observe(terminalHost);
  setTimeout(() => {
    fitTerminal();
    terminal.focus();
  }, 0);
}

/** Registers editor-like Python input behavior and cell actions. */
function wirePythonCell() {
  document.getElementById("clear").addEventListener("click", clearOutput);
  if (editorAnchor) {
    editorAnchor.addEventListener("click", showOverlayEditor);
    new ResizeObserver(() => scheduleEditorGeometry()).observe(editorAnchor);
    window.addEventListener("resize", scheduleEditorGeometry);
    window.addEventListener("scroll", scheduleEditorGeometry, true);
    window.addEventListener("visibilitychange", scheduleEditorGeometry);
    window.visualViewport?.addEventListener("resize", scheduleEditorGeometry);
    window.visualViewport?.addEventListener("scroll", scheduleEditorGeometry);
    scheduleEditorGeometry();
  }
}

/** Registers notebook-style vertical resize handles for each visible cell. */
function wireCellResizers() {
  for (const handle of document.querySelectorAll("[data-resize-target]")) {
    const target = cellResizeTarget(handle);
    if (!target) {
      continue;
    }
    handle.addEventListener("pointerdown", (event) => startCellResize(event, handle, target));
    handle.addEventListener("dblclick", () => resetCellSize(target));
    handle.addEventListener("keydown", (event) => nudgeCellSize(event, target));
  }
}

/** Resolves the element resized by a cell handle. */
function cellResizeTarget(handle) {
  if (handle.dataset.resizeTarget === "terminal") {
    return terminalHost;
  }
  if (handle.dataset.resizeTarget === "editor") {
    return editorAnchor;
  }
  return undefined;
}

/** Starts a pointer-driven vertical resize operation for one cell body. */
function startCellResize(event, handle, target) {
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = target.getBoundingClientRect().height;
  document.body.classList.add("resizingCell");
  const move = (moveEvent) => resizeCell(target, startHeight + moveEvent.clientY - startY);
  const stop = () => {
    handle.removeEventListener("pointermove", move);
    document.body.classList.remove("resizingCell");
    refreshAfterCellResize(target);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop, { once: true });
  handle.addEventListener("pointercancel", stop, { once: true });
}

/** Applies a bounded pixel height to a resizable cell element. */
function resizeCell(target, height) {
  const min = target === terminalHost ? 92 : 160;
  const max = Math.max(window.innerHeight * 1.2, 720, min);
  target.style.height = `${Math.round(Math.min(max, Math.max(min, height)))}px`;
  refreshAfterCellResize(target);
}

/** Resets a cell to its stylesheet-defined default height. */
function resetCellSize(target) {
  target.style.height = "";
  refreshAfterCellResize(target);
}

/** Supports keyboard resizing from a focused cell resize handle. */
function nudgeCellSize(event, target) {
  const delta = event.key === "ArrowDown" ? 24 : event.key === "ArrowUp" ? -24 : 0;
  if (!delta && event.key !== "Home") {
    return;
  }
  event.preventDefault();
  if (event.key === "Home") {
    resetCellSize(target);
    return;
  }
  resizeCell(target, target.getBoundingClientRect().height + delta);
}

/** Refreshes terminal fit or overlay geometry after a cell height changes. */
function refreshAfterCellResize(target) {
  if (target === terminalHost) {
    fitTerminal();
  }
  scheduleEditorGeometry();
}

/** Handles one message from the extension host. */
function handleHostMessage(message) {
  if (message.type === "terminalData" && typeof message.data === "string") {
    snapshotWritten = true;
    terminal.write(message.data);
  }
  if (message.type === "terminalStatus" && message.snapshot) {
    updateStatus(message.snapshot);
  }
  if (message.type === "pythonStarted" && Number.isFinite(message.execution)) {
    pendingExecution = message.execution;
    setInputPrompt(`In [${pendingExecution}]:`);
  }
  if (message.type === "pythonResult") {
    showOutput(message.execution || pendingExecution, cleanPythonResult(message.text), Boolean(message.ok));
  }
  if (message.type === "resetPythonCell") {
    resetPythonCell();
  }
  if (message.type === "measureEditor") {
    if (message.show && !pythonCell?.classList.contains("disabled")) {
      showOverlayEditor();
    } else {
      sendEditorGeometry();
    }
  }
}

/** Updates the status label and writes the initial terminal snapshot once. */
function updateStatus(snapshot) {
  status.dataset.ready = snapshot.ready ? "true" : "false";
  setSetupReady(Boolean(snapshot.ready));
  setPythonReady(Boolean(snapshot.ready));
  statusText.textContent = snapshot.ready ? "Python 3 / Django ready" : `${snapshot.state} / ${snapshot.mode}`;
  if (snapshot.state === "starting" && !snapshot.text) {
    terminal.clear();
    snapshotWritten = false;
    return;
  }
  if (!snapshotWritten && snapshot.text) {
    snapshotWritten = true;
    terminal.write(snapshot.text);
  }
}

/** Minimizes the setup terminal while Django shell input is active. */
function setSetupReady(ready) {
  if (!setupCell || !terminalHost) {
    return;
  }
  const wasMinimized = setupCell.classList.contains("minimized");
  setupCell.classList.toggle("minimized", ready);
  focusTerminalButton.disabled = ready;
  if (ready && !wasMinimized) {
    terminalHost.dataset.expandedHeight = terminalHost.style.height;
    terminalHost.style.height = "34px";
    terminal.blur?.();
  }
  if (!ready && wasMinimized) {
    terminalHost.style.height = terminalHost.dataset.expandedHeight || "";
    delete terminalHost.dataset.expandedHeight;
    setTimeout(() => terminal.focus(), 0);
  }
  fitTerminal();
}

/** Updates the visible input prompt without dropping its notebook styling wrapper. */
function setInputPrompt(text) {
  if (inputPromptText) {
    inputPromptText.textContent = text;
  }
}

/** Enables Python input only after the setup terminal has attached the backend. */
function setPythonReady(ready) {
  pythonCell?.classList.toggle("disabled", !ready);
}

/** Shows the workbench overlay editor used for Python input. */
function showOverlayEditor() {
  if (pythonCell?.classList.contains("disabled")) {
    return;
  }
  vscode.postMessage({ rect: editorGeometry(), type: "showOverlayEditor" });
}

/** Schedules one editor geometry measurement on the next animation frame. */
function scheduleEditorGeometry() {
  if (geometryFrame) {
    return;
  }
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = 0;
    sendEditorGeometry();
  });
}

/** Sends the editor anchor rectangle to the extension host. */
function sendEditorGeometry() {
  const rect = editorGeometry();
  if (rect) {
    vscode.postMessage({ rect, type: "editorGeometry" });
  }
}

/** Returns the editor anchor rectangle in webview viewport coordinates. */
function editorGeometry() {
  if (!editorAnchor) {
    return undefined;
  }
  const rect = editorAnchor.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width
  };
}

/** Appends one execution output directly below the active Python cell. */
function showOutput(count, result, ok) {
  currentOutput.classList.remove("outputHidden");
  currentOutputLabel.textContent = "Outputs";
  const item = document.createElement("section");
  item.className = "outputItem";
  const label = document.createElement("div");
  label.className = "outputItemLabel";
  label.textContent = `Out[${count || ""}]:`;
  const body = document.createElement("pre");
  body.className = ok ? "result" : "result error";
  body.textContent = result;
  item.appendChild(label);
  item.appendChild(body);
  outputList.appendChild(item);
  currentOutput.scrollTop = currentOutput.scrollHeight;
}

/** Clears the active Python cell output without touching the setup terminal session. */
function clearOutput() {
  currentOutput.classList.add("outputHidden");
  outputList.textContent = "";
}

/** Clears Python prompt and output state after a backend restart. */
function resetPythonCell() {
  pendingExecution = 0;
  setInputPrompt("In\u00a0[\u00a0]:");
  clearOutput();
}

/** Strips ANSI control sequences from Python backend result text. */
function cleanPythonResult(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
}

/** Fits the xterm viewport to its visible webview host. */
function fitTerminal() {
  try {
    fitAddon.fit();
  } catch {
    // The webview can resize while xterm is detached from layout.
  }
}

/** Reads the terminal font family from VS Code theme variables. */
function terminalFontFamily() {
  return cssVar("--vscode-terminal-font-family") || cssVar("--vscode-editor-font-family") || "monospace";
}

/** Reads the terminal font size from VS Code theme variables. */
function terminalFontSize() {
  return Number.parseInt(cssVar("--vscode-terminal-font-size") || cssVar("--vscode-editor-font-size"), 10) || 13;
}

/** Builds an xterm theme from VS Code terminal theme variables. */
function terminalTheme() {
  return {
    background: cssVar("--vscode-terminal-background") || cssVar("--vscode-editor-background"),
    black: cssVar("--vscode-terminal-ansiBlack"),
    blue: cssVar("--vscode-terminal-ansiBlue"),
    brightBlack: cssVar("--vscode-terminal-ansiBrightBlack"),
    brightBlue: cssVar("--vscode-terminal-ansiBrightBlue"),
    brightCyan: cssVar("--vscode-terminal-ansiBrightCyan"),
    brightGreen: cssVar("--vscode-terminal-ansiBrightGreen"),
    brightMagenta: cssVar("--vscode-terminal-ansiBrightMagenta"),
    brightRed: cssVar("--vscode-terminal-ansiBrightRed"),
    brightWhite: cssVar("--vscode-terminal-ansiBrightWhite"),
    brightYellow: cssVar("--vscode-terminal-ansiBrightYellow"),
    cursor: cssVar("--vscode-terminalCursor-foreground") || cssVar("--vscode-terminal-foreground"),
    cyan: cssVar("--vscode-terminal-ansiCyan"),
    foreground: cssVar("--vscode-terminal-foreground") || cssVar("--vscode-editor-foreground"),
    green: cssVar("--vscode-terminal-ansiGreen"),
    magenta: cssVar("--vscode-terminal-ansiMagenta"),
    red: cssVar("--vscode-terminal-ansiRed"),
    white: cssVar("--vscode-terminal-ansiWhite"),
    yellow: cssVar("--vscode-terminal-ansiYellow")
  };
}

/** Reads one CSS custom property from the webview root. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Installs xterm CSS in the webview document. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${xtermCss}
    .terminalHost .xterm,
    .terminalHost .xterm-screen,
    .terminalHost .xterm-viewport {
      background: var(--vscode-terminal-background, var(--vscode-editor-background)) !important;
      height: 100%;
    }
    .terminalHost .xterm-viewport {
      overflow-y: auto;
    }
  `;
  document.head.appendChild(style);
}

main();
