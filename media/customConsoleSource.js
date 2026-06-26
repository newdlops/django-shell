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
const debugButtons = Array.from(document.querySelectorAll("[data-action=debug-shell]"));
const debugControlButtons = Array.from(document.querySelectorAll("[data-debug-control]"));
const debugInfo = document.getElementById("debugInfo");
const debugLocation = document.getElementById("debugLocation");
const debugMode = document.getElementById("debugMode");
const debugSourceLine = document.getElementById("debugSourceLine");
const debugStatus = document.getElementById("debugStatus");
const debugVariables = document.getElementById("debugVariables");
const newOverlayTabButtons = Array.from(document.querySelectorAll("[data-action=new-overlay-tab]"));
const outputList = document.getElementById("outputList");
const editorAnchor = document.getElementById("editorAnchor");
const inputPrompt = document.getElementById("inputPrompt");
const inputPromptText = inputPrompt && inputPrompt.querySelector(".promptMark");
const pythonCell = document.getElementById("pythonCell");
const pythonTabs = document.getElementById("pythonTabs");
const statusText = document.getElementById("statusText");
const transport = document.getElementById("transport");
const transportInfo = document.getElementById("transportInfo");

let fitAddon;
let geometryFrame = 0;
let lastGeometryKey = "";
let pendingExecution = 0;
const runningOutputs = new Map();
const LIVE_OUTPUT_LIMIT = 20000;
let snapshotWritten = false;
let e2eSawShellPrompt = false;
let debugAttached = false;
let debugBusy = false;
let debugDetail = "";
let debugDisplayMode = "file";
let debugState = "idle";
let breakpointCount = 0;
let overlayTabActive = "overlay-1";
let overlayTabs = [{ id: "overlay-1", label: "1" }];
let runtimeReady = false;
let terminal;

/** Starts the webview client after the DOM has been created by the extension host. */
function main() {
  ensureStyle();
  mountTerminal();
  wirePythonCell();
  wireCellResizers();
  window.addEventListener("message", (event) => handleHostMessage(event.data || {}));
  for (const button of debugButtons) {
    button.addEventListener("click", requestDebugShell);
  }
  for (const button of debugControlButtons) {
    button.addEventListener("click", () => requestDebugControl(button.dataset.debugControl));
  }
  for (const button of newOverlayTabButtons) {
    button.addEventListener("click", newOverlayTab);
  }
  focusTerminalButton.addEventListener("click", () => terminal.focus());
  document.getElementById("restart").addEventListener("click", () => vscode.postMessage({ type: "restart" }));
  debugMode?.addEventListener("change", () => setDebugMode(debugMode.value, true));
  transport?.addEventListener("change", () => vscode.postMessage({ mode: transport.value, type: "setTransport" }));
  setDebugStatus("idle", "");
  renderOverlayTabs();
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
  if (message.type === "overlayRunPython" && typeof message.code === "string") {
    const lineOffset = overlayLineOffset(message.range);
    const payload = { code: message.code, type: "runPython" };
    if (typeof message.text === "string") {
      payload.text = message.text;
    }
    if (lineOffset !== undefined) {
      payload.lineOffset = lineOffset;
    }
    vscode.postMessage(payload);
  }
  if (message.type === "overlayToggleBreakpoint") {
    vscode.postMessage({ column: Number(message.column) || 0, inline: Boolean(message.inline), inputStartLine: Number(message.inputStartLine) || 0, line: Number(message.line) || 0, rawColumn: Number(message.rawColumn) || 0, rawLine: Number(message.rawLine) || 0, source: String(message.source || "webview-fallback"), type: "overlayToggleBreakpoint" });
  }
  if (message.type === "terminalData" && typeof message.data === "string") {
    snapshotWritten = true;
    terminal.write(message.data);
  }
  if (message.type === "terminalStatus" && message.snapshot) {
    updateStatus(message.snapshot);
  }
  if (message.type === "transport" && transport) {
    transport.value = message.mode || "pty";
    transportInfo.innerHTML = message.mode === "orm" ? '<span class="pty">● ORM cell</span>' : message.active === "tcp" ? '<span class="on">● socket</span>' : message.active === "pty" ? '<span class="pty">● terminal</span>' : '<span class="off">○ not connected</span>';
  }
  if (message.type === "debugMode") {
    setDebugMode(message.mode, false);
  }
  if (message.type === "debugStatus") {
    setDebugStatus(String(message.state || "idle"), String(message.detail || ""));
  }
  if (message.type === "debugInfo") {
    setDebugInfo(message.info || {});
  }
  if (message.type === "breakpoints") {
    setBreakpointStatus(Number(message.count) || 0);
  }
  if (message.type === "overlayTabs") {
    setOverlayTabs(message.tabs, message.active);
  }
  if (message.type === "pythonStarted" && Number.isFinite(message.execution)) {
    pendingExecution = message.execution;
    setInputPrompt(`In [${pendingExecution}]:`);
    showRunningOutput(pendingExecution, String(message.code || ""));
  }
  if (message.type === "pythonResult") {
    showOutput(message.execution || pendingExecution, cleanPythonResult(message.text), Boolean(message.ok), String(message.code || ""));
  }
  if (message.type === "pythonProgress" && Number.isFinite(message.execution)) {
    showProgress(message.execution, message.progress || {});
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

/** Converts the Monaco 1-based execution range into a Python compile line offset. */
function overlayLineOffset(range) {
  const start = range && Number(range.start);
  return Number.isFinite(start) ? Math.max(0, Math.floor(start) - 1) : undefined;
}

/** Updates the status label and writes the initial terminal snapshot once. */
function updateStatus(snapshot) {
  runtimeReady = Boolean(snapshot.ready);
  status.dataset.ready = snapshot.ready ? "true" : "false";
  setSetupReady(Boolean(snapshot.ready));
  setPythonReady(Boolean(snapshot.ready));
  statusText.textContent = snapshot.ready ? "Python 3 / Django ready" : `${snapshot.state} / ${snapshot.mode}`;
  if (!runtimeReady) {
    setDebugStatus("idle", "");
  } else {
    updateDebugControls();
  }
  updateOverlayTabControls();
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
  e2eCellState("prompt");
}

/** Enables Python input only after the setup terminal has attached the backend. */
function setPythonReady(ready) {
  pythonCell?.classList.toggle("disabled", !ready);
}

/** Sends a debug attach request to the extension host when the shell is ready. */
function requestDebugShell() {
  if (debugAttached) {
    vscode.postMessage({ debugAttached, debugBusy, debugState, runtimeReady, type: "stopDebugShell" });
    return;
  }
  setDebugStatus("starting", "attaching");
  vscode.postMessage({ debugAttached, debugBusy, debugMode: debugDisplayMode, debugState, runtimeReady, type: "debugShell" });
}

/** Updates the selected debugger display mode and optionally notifies the extension host. */
function setDebugMode(mode, notify) {
  debugDisplayMode = mode === "overlay" ? "overlay" : "file";
  if (debugMode) {
    debugMode.value = debugDisplayMode;
  }
  if (notify) {
    vscode.postMessage({ debugMode: debugDisplayMode, type: "setDebugMode" });
  }
}

/** Requests one basic VS Code debugger action for the attached shell session. */
function requestDebugControl(action) {
  if (!runtimeReady || !debugAttached || debugBusy || !action) {
    return;
  }
  const nextState = action === "pause" ? "paused" : action === "stop" ? "idle" : "running";
  setDebugStatus(nextState, debugControlLabel(action));
  vscode.postMessage({ action, type: "debugControl" });
}

/** Updates debugger status text and button affordances from host state. */
function setDebugStatus(state, detail) {
  debugState = state;
  debugDetail = detail;
  debugBusy = state === "starting";
  debugAttached = state === "attached" || state === "paused" || state === "running";
  if (debugStatus) {
    debugStatus.dataset.state = state;
    debugStatus.textContent = debugStatusText(debugState, debugDetail);
  }
  if (state !== "paused") {
    setDebugInfo({ state });
  }
  updateDebugControls();
}

/** Updates the debugger status label with the visible breakpoint count. */
function setBreakpointStatus(count) {
  breakpointCount = Math.max(0, Math.floor(count));
  if (debugStatus) {
    debugStatus.textContent = debugStatusText(debugState, debugDetail);
  }
}

/** Enables or disables debugger actions based on shell and attach state. */
function updateDebugControls() {
  for (const button of debugButtons) {
    button.disabled = false;
    button.dataset.state = debugBusy ? "starting" : debugAttached ? "attached" : "idle";
    button.title = !runtimeReady ? "Start Django shell before debugging" : debugAttached ? "Stop Django Shell debugger" : "Debug current shell";
    button.setAttribute("aria-label", button.title);
    const label = button.querySelector(".buttonLabel");
    if (label) {
      label.textContent = debugAttached ? "Stop" : debugBusy ? "Debugging" : "Debug";
    }
  }
  for (const button of debugControlButtons) {
    const action = button.dataset.debugControl || "";
    button.disabled = !runtimeReady || !debugAttached || debugBusy;
    button.dataset.active = (debugState === "paused" && action === "pause") || (debugState === "running" && action === "continue") ? "true" : "false";
  }
}

/** Requests a new overlay tab backed by the current shell runtime. */
function newOverlayTab() {
  if (!runtimeReady) {
    return;
  }
  vscode.postMessage({ type: "newOverlayTab" });
}

/** Enables or disables overlay tab controls. */
function updateOverlayTabControls() {
  for (const button of newOverlayTabButtons) {
    button.disabled = !runtimeReady;
  }
  if (pythonTabs) {
    pythonTabs.setAttribute("aria-disabled", runtimeReady ? "false" : "true");
  }
  renderOverlayTabs();
}

/** Updates the local tab strip model from the extension host. */
function setOverlayTabs(tabs, active) {
  const normalized = Array.isArray(tabs) ? tabs.map(normalizeOverlayTab).filter(Boolean) : [];
  overlayTabs = normalized.length ? normalized : [{ id: "overlay-1", label: "1" }];
  overlayTabActive = overlayTabs.some((tab) => tab.id === active) ? active : overlayTabs[0].id;
  renderOverlayTabs();
}

/** Returns a safe tab strip item for webview rendering. */
function normalizeOverlayTab(tab) {
  if (!tab || typeof tab.id !== "string") {
    return undefined;
  }
  return { id: tab.id, label: String(tab.label || tab.id).slice(0, 12) };
}

/** Renders the overlay tab strip inside the Python cell toolbar. */
function renderOverlayTabs() {
  if (!pythonTabs) {
    return;
  }
  pythonTabs.textContent = "";
  for (const tab of overlayTabs) {
    const button = document.createElement("button");
    button.className = `pythonTab${tab.id === overlayTabActive ? " active" : ""}`;
    button.type = "button";
    button.role = "tab";
    button.dataset.tabId = tab.id;
    button.disabled = !runtimeReady;
    button.setAttribute("aria-selected", tab.id === overlayTabActive ? "true" : "false");
    button.textContent = tab.label;
    button.addEventListener("click", () => switchOverlayTab(tab.id));
    pythonTabs.appendChild(button);
  }
}

/** Requests activation of an existing overlay tab. */
function switchOverlayTab(tabId) {
  if (!runtimeReady || tabId === overlayTabActive) {
    if (runtimeReady) {
      showOverlayEditor();
    }
    return;
  }
  vscode.postMessage({ tabId, type: "switchOverlayTab" });
}

/** Returns compact debugger state copy for the top bar. */
function debugStatusText(state, detail) {
  const suffix = breakpointCount ? ` · ${breakpointCount} breakpoint${breakpointCount === 1 ? "" : "s"}` : "";
  if (state === "starting") {
    return `debugger attaching${suffix}`;
  }
  if (state === "attached") {
    return detail ? `debugger ${detail}${suffix}` : `debugger attached${suffix}`;
  }
  if (state === "running") {
    return detail ? `debugger ${detail}${suffix}` : `debugger running${suffix}`;
  }
  if (state === "paused") {
    return detail ? `debugger ${detail}${suffix}` : `debugger paused${suffix}`;
  }
  if (state === "error") {
    return detail ? `debugger ${detail}${suffix}` : `debugger failed${suffix}`;
  }
  return `debugger idle${suffix}`;
}

/** Renders the paused stack frame and variable preview panel. */
function setDebugInfo(info) {
  if (!debugInfo || !debugLocation || !debugSourceLine || !debugVariables) {
    return;
  }
  const state = String(info.state || "idle");
  debugInfo.dataset.state = state;
  debugVariables.textContent = "";
  if (state === "idle") {
    debugInfo.hidden = true;
    return;
  }
  debugInfo.hidden = false;
  if (state !== "paused" && state !== "error") {
    debugLocation.textContent = `Debugger ${state}`;
    debugSourceLine.textContent = "No paused Python frame";
    appendDebugMessage("No frame reported");
    return;
  }
  const frame = info.frame || {};
  debugLocation.textContent = state === "error" ? "Debug inspection failed" : debugLocationText(frame);
  debugSourceLine.textContent = String(info.error || frame.sourceLine || "");
  appendDebugScope("Line variables", info.focusVariables || []);
  for (const scope of info.scopes || []) {
    appendDebugScope(scope.total ? `${scope.name} (${scope.total})` : scope.name, scope.variables || []);
  }
  if (!debugVariables.children.length) {
    appendDebugMessage("No variables reported for this frame");
  }
}

/** Appends one titled group of debug variables. */
function appendDebugScope(title, variables) {
  if (!variables.length || !debugVariables) {
    return;
  }
  const label = document.createElement("div");
  label.className = "debugScopeTitle";
  label.textContent = title;
  debugVariables.appendChild(label);
  for (const variable of variables) {
    debugVariables.appendChild(debugVariableElement(variable));
  }
}

/** Creates one compact variable preview row. */
function debugVariableElement(variable) {
  const row = document.createElement("div");
  const name = document.createElement("span");
  const value = document.createElement("span");
  row.className = "debugVar";
  name.className = "debugVarName";
  value.className = "debugVarValue";
  name.textContent = String(variable.name || "");
  value.textContent = String(variable.value || "");
  row.title = variable.type ? `${name.textContent}: ${value.textContent} (${variable.type})` : `${name.textContent}: ${value.textContent}`;
  row.append(name, value);
  return row;
}

/** Appends a muted debug panel message. */
function appendDebugMessage(text) {
  const message = document.createElement("div");
  message.className = "debugScopeTitle";
  message.textContent = text;
  debugVariables.appendChild(message);
}

/** Formats one paused frame location for the debug panel. */
function debugLocationText(frame) {
  const path = String(frame.path || frame.name || "Paused");
  const file = path.split(/[\\/]/).pop() || path;
  const suffix = frame.line ? `:${frame.line}${frame.column ? `:${frame.column}` : ""}` : "";
  return `${file}${suffix}${frame.name ? ` · ${frame.name}` : ""}`;
}

/** Formats a debugger action name for compact status text. */
function debugControlLabel(action) {
  return String(action).replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
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

/** Sends the editor anchor rectangle to the extension host, skipping unchanged rectangles to avoid overlay layout thrash. */
function sendEditorGeometry() {
  const rect = editorGeometry();
  if (!rect) {
    return;
  }
  const key = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
  if (key === lastGeometryKey) {
    return;
  }
  lastGeometryKey = key;
  vscode.postMessage({ rect, type: "editorGeometry" });
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

/** Appends or refreshes one pending execution item below the active Python cell. */
function showRunningOutput(count, code) {
  currentOutput.classList.remove("outputHidden");
  currentOutputLabel.textContent = "Outputs";
  const item = outputItemFor(count) || createOutputItem(count, code);
  item.classList.add("running");
  const status = item.querySelector("[data-role=status]");
  const body = item.querySelector("[data-role=result]");
  const startedAt = Date.now();
  item.dataset.startedAt = String(startedAt);
  if (status) {
    status.textContent = elapsedText(startedAt);
  }
  if (body) {
    body.className = "result pending";
    delete body.dataset.streamed;
    body.textContent = "Running...";
  }
  stopOutputTimer(count);
  runningOutputs.set(count, window.setInterval(() => updateRunningOutput(count), 1000));
  currentOutput.scrollTop = currentOutput.scrollHeight;
}

/** Appends or completes one execution output directly below the active Python cell. */
function showOutput(count, result, ok, code) {
  currentOutput.classList.remove("outputHidden");
  currentOutputLabel.textContent = "Outputs";
  stopOutputTimer(count);
  const item = outputItemFor(count) || createOutputItem(count, code);
  item.classList.remove("running");
  const header = item.querySelector("[data-role=header-label]");
  if (header) {
    header.textContent = `In [${count || ""}] -> Out[${count || ""}]`;
  }
  const status = item.querySelector("[data-role=status]");
  if (status) {
    status.textContent = item.dataset.startedAt ? `${durationText(Number(item.dataset.startedAt))} total` : "complete";
  }
  const label = item.querySelector("[data-role=out-label]");
  if (label) {
    label.textContent = `Out[${count || ""}]:`;
  }
  const body = item.querySelector("[data-role=result]");
  if (!body) {
    return;
  }
  delete body.dataset.streamed;
  body.className = ok ? "result" : "result error";
  body.textContent = result;
  currentOutput.scrollTop = currentOutput.scrollHeight;
  vscode.postMessage({ ...e2eCellState("output"), execution: count || 0, ok: Boolean(ok), text: result, type: "e2eOutputRendered" });
}

/** Updates one running output item with backend-reported row/item progress. */
function showProgress(count, progress) {
  const item = outputItemFor(count);
  if (!item || !item.classList.contains("running")) {
    return;
  }
  const status = item.querySelector("[data-role=status]");
  const body = item.querySelector("[data-role=result]");
  if (status && item.dataset.startedAt) {
    status.textContent = elapsedText(Number(item.dataset.startedAt));
  }
  if (body) {
    body.className = "result pending";
    if (typeof progress.output === "string") {
      appendLiveOutput(body, cleanPythonResult(progress.output));
      return;
    }
    if (body.dataset.streamed === "true") {
      return;
    }
    body.textContent = progressText(progress);
  }
}

/** Appends live stdout/stderr while honoring carriage-return progress updates. */
function appendLiveOutput(body, text) {
  if (!text) {
    return;
  }
  if (body.dataset.streamed !== "true") {
    body.textContent = "";
    body.dataset.streamed = "true";
  }
  let next = body.textContent || "";
  for (const char of text) {
    if (char === "\r") {
      const index = next.lastIndexOf("\n");
      next = index >= 0 ? next.slice(0, index + 1) : "";
    } else if (char === "\b") {
      next = next.slice(0, -1);
    } else if (char !== "\u0007") {
      next += char;
    }
  }
  body.textContent = next.slice(-LIVE_OUTPUT_LIMIT) || "Running...";
  currentOutput.scrollTop = currentOutput.scrollHeight;
}

/** Creates one output item with the executed input source preserved exactly. */
function createOutputItem(count, code) {
  const item = document.createElement("section");
  item.className = "outputItem";
  item.dataset.execution = String(count || "");
  const header = document.createElement("div");
  header.className = "outputHeader";
  const headerLabel = document.createElement("span");
  headerLabel.dataset.role = "header-label";
  headerLabel.textContent = `In [${count || ""}] -> running`;
  const status = document.createElement("span");
  status.className = "outputStatus";
  status.dataset.role = "status";
  const spacer = document.createElement("span");
  spacer.className = "grow";
  header.appendChild(headerLabel);
  header.appendChild(spacer);
  header.appendChild(status);
  const source = document.createElement("pre");
  source.className = "inputSource";
  source.dataset.role = "source";
  source.textContent = code;
  const label = document.createElement("div");
  label.className = "outputItemLabel";
  label.dataset.role = "out-label";
  label.textContent = `Out[${count || ""}]:`;
  const body = document.createElement("pre");
  body.className = "result pending";
  body.dataset.role = "result";
  item.appendChild(header);
  item.appendChild(source);
  item.appendChild(label);
  item.appendChild(body);
  outputList.appendChild(item);
  return item;
}

/** Returns the output item already associated with an execution count. */
function outputItemFor(count) {
  return outputList.querySelector(`.outputItem[data-execution="${String(count || "")}"]`);
}

/** Refreshes one running output item's elapsed label. */
function updateRunningOutput(count) {
  const item = outputItemFor(count);
  const status = item && item.querySelector("[data-role=status]");
  if (!item || !status || !item.dataset.startedAt) {
    stopOutputTimer(count);
    return;
  }
  status.textContent = elapsedText(Number(item.dataset.startedAt));
}

/** Stops the elapsed timer for one execution item. */
function stopOutputTimer(count) {
  const timer = runningOutputs.get(count);
  if (!timer) {
    return;
  }
  window.clearInterval(timer);
  runningOutputs.delete(count);
}

/** Formats elapsed execution time for long-running cells. */
function elapsedText(startedAt) {
  return `running ${durationText(startedAt)}`;
}

/** Formats a compact duration from one start timestamp. */
function durationText(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Formats backend progress counts in the same output cell as the running code. */
function progressText(progress) {
  const label = progress.label || "Running";
  const detail = progress.detail ? `\n${progress.detail}` : "";
  const current = Number.isFinite(progress.current) ? Math.max(0, Math.floor(progress.current)) : undefined;
  const total = Number.isFinite(progress.total) ? Math.max(0, Math.floor(progress.total)) : undefined;
  const line = Number.isFinite(progress.line) && progress.line > 0 ? `line ${Math.floor(progress.line)} · ` : "";
  const rate = Number.isFinite(progress.rate) && progress.rate > 0 ? ` · ${formatRate(progress.rate)}/s` : "";
  if (current !== undefined && total !== undefined && total > 0) {
    const percent = Number.isFinite(progress.percent) ? progress.percent : current * 100 / total;
    return `${line}${label}: ${current} / ${total} items (${Math.min(100, percent).toFixed(1)}%)${rate}${detail}`;
  }
  if (current !== undefined) {
    return `${line}${label}: ${current} items${rate}${detail}`;
  }
  return `${line}${label}${detail}`;
}

/** Formats an item-per-second rate without noisy decimals. */
function formatRate(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** Returns E2E-visible Python cell state for prompt, output, and scroll regressions. */
function e2eCellState(reason) {
  const promptText = String(inputPromptText?.textContent || "");
  const cellText = String(pythonCell?.textContent || "");
  const hasShellPrompt = promptText.includes(">>>") || cellText.includes(">>>");
  e2eSawShellPrompt = e2eSawShellPrompt || hasShellPrompt;
  return { cellText, hasShellPrompt, outputClientHeight: currentOutput?.clientHeight || 0, outputCount: outputList?.children.length || 0, outputScrollHeight: currentOutput?.scrollHeight || 0, outputScrollTop: currentOutput?.scrollTop || 0, outputVisible: !currentOutput?.classList.contains("outputHidden"), promptText, reason, sawShellPrompt: e2eSawShellPrompt };
}

/** Clears the active Python cell output without touching the setup terminal session. */
function clearOutput() {
  for (const count of runningOutputs.keys()) {
    stopOutputTimer(count);
  }
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
