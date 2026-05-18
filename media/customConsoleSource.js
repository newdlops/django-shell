// Custom Django shell webview client that mounts xterm and notebook-like Python cells.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";

const STYLE_ID = "django-shell-custom-console-style";
const vscode = acquireVsCodeApi();
const terminalHost = document.getElementById("terminal");
const status = document.getElementById("status");
const currentOutput = document.getElementById("currentOutput");
const currentOutputLabel = document.getElementById("currentOutputLabel");
const outputList = document.getElementById("outputList");
const editorAnchor = document.getElementById("editorAnchor");
const inputPrompt = document.getElementById("inputPrompt");

let fitAddon;
let pendingExecution = 0;
let snapshotWritten = false;
let terminal;

/** Starts the webview client after the DOM has been created by the extension host. */
function main() {
  ensureStyle();
  mountTerminal();
  wirePythonCell();
  window.addEventListener("message", (event) => handleHostMessage(event.data || {}));
  document.getElementById("focusTerminal").addEventListener("click", () => terminal.focus());
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
  document.getElementById("showEditor").addEventListener("click", showOverlayEditor);
  document.getElementById("clear").addEventListener("click", clearOutput);
  if (editorAnchor) {
    new ResizeObserver(() => sendEditorGeometry()).observe(editorAnchor);
    window.addEventListener("resize", sendEditorGeometry);
    window.addEventListener("scroll", sendEditorGeometry, true);
    setTimeout(sendEditorGeometry, 0);
  }
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
    inputPrompt.textContent = `In [${pendingExecution}]:`;
  }
  if (message.type === "pythonResult") {
    showOutput(message.execution || pendingExecution, cleanPythonResult(message.text), Boolean(message.ok));
  }
  if (message.type === "measureEditor") {
    if (message.show) {
      showOverlayEditor();
    } else {
      sendEditorGeometry();
    }
  }
}

/** Updates the status label and writes the initial terminal snapshot once. */
function updateStatus(snapshot) {
  status.textContent = snapshot.ready ? "Python 3 / Django ready" : `${snapshot.state} / ${snapshot.mode}`;
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

/** Shows the workbench overlay editor used for Python input. */
function showOverlayEditor() {
  vscode.postMessage({ rect: editorGeometry(), type: "showOverlayEditor" });
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
