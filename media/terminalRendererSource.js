// Notebook renderer source that embeds an xterm.js terminal for Django shell setup.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";

const ELEMENT_STATE = new WeakMap();
const COMPACT_TERMINAL_HEIGHT = 32;
const HEIGHT_STATE_VERSION = 2;
const MAX_TERMINAL_HEIGHT = 1200;
const MIN_TERMINAL_HEIGHT = 32;
const PYTHON_HISTORY_MIME = "application/vnd.django-shell.python-history+json";
const SESSION_STATE = new Map();
const STYLE_ID = "django-shell-terminal-renderer-style";
const TERMINAL_DEFAULT_HEIGHT = 96;

/** Activates the notebook terminal renderer. */
export function activate(context) {
  ensureStyle();
  if (context.onDidReceiveMessage) {
    context.onDidReceiveMessage((message) => handleExtensionMessage(message));
  }
  return {
    renderOutputItem(data, element) {
      if (data.mime === PYTHON_HISTORY_MIME) {
        renderPythonHistory(data, element);
        return;
      }
      const value = data.json();
      const state = ensureTerminal(element, context, value);
      updateHeader(state.header, value, context);
      writeInitialText(state.terminal, state, value.text || "");
    }
  };
}

/** Renders accumulated Python execution history as a compact scrollable transcript. */
function renderPythonHistory(data, element) {
  const value = data.json();
  element.innerHTML = "";
  const history = document.createElement("pre");
  history.className = "djs-python-history";
  history.textContent = value.text || "";
  element.appendChild(history);
  requestAnimationFrame(() => {
    history.scrollTop = history.scrollHeight;
  });
}

/** Creates or returns the xterm instance mounted for one output element. */
function ensureTerminal(element, context, value) {
  const existing = ELEMENT_STATE.get(element);
  if (existing && existing.sessionId === value.sessionId) {
    return existing;
  }
  element.innerHTML = "";
  const root = document.createElement("div");
  root.className = "djs-terminal-root";
  const header = document.createElement("div");
  header.className = "djs-terminal-header";
  const host = document.createElement("div");
  host.className = "djs-terminal-host";
  host.style.height = `${terminalHeight(context, value.sessionId)}px`;
  const handle = document.createElement("div");
  handle.className = "djs-terminal-resize";
  handle.title = "Resize terminal";
  root.append(header, host, handle);
  element.appendChild(root);

  const terminal = new Terminal({
    allowProposedApi: false,
    cols: 100,
    convertEol: true,
    cursorBlink: true,
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-size"), 10) || 13,
    rows: 30,
    scrollback: 5000,
    theme: terminalTheme()
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  terminal.onData((input) => sendMessage(context, value.sessionId, input));
  terminal.onResize(({ cols, rows }) => sendResize(context, value.sessionId, cols, rows));
  host.addEventListener("click", () => terminal.focus());
  const observer = new ResizeObserver(() => fitTerminal(fitAddon, terminal));
  observer.observe(host);
  handle.addEventListener("pointerdown", (event) => startResize(event, host, context, value.sessionId, fitAddon, terminal));
  setTimeout(() => fitTerminal(fitAddon, terminal), 0);

  const state = { compacted: false, context, fitAddon, header, host, initialTextWritten: false, observer, sessionId: value.sessionId, terminal };
  ELEMENT_STATE.set(element, state);
  SESSION_STATE.set(value.sessionId, state);
  sendReady(context, value.sessionId);
  return state;
}

/** Updates the compact status line and settings selector above the terminal. */
function updateHeader(header, value, context) {
  const status = ensureHeaderElement(header, "span", "djs-terminal-status");
  const select = ensureHeaderElement(header, "select", "djs-settings-select");
  status.textContent = `Django Console Setup: ${value.state} (${value.mode})`;
  header.dataset.ready = value.ready ? "true" : "false";
  syncSettingsSelect(select, value, context);
}

/** Writes the initial PTY snapshot once; later updates stream through renderer messages. */
function writeInitialText(terminal, state, text) {
  if (state.initialTextWritten) {
    return;
  }
  state.initialTextWritten = true;
  if (text) {
    terminal.write(text);
  }
  terminal.scrollToBottom();
  terminal.focus();
}

/** Handles streamed PTY data and status updates from the extension host. */
function handleExtensionMessage(message) {
  const state = SESSION_STATE.get(message?.sessionId);
  if (!state) {
    return;
  }
  if (message.type === "terminalData" && typeof message.data === "string") {
    state.terminal.write(message.data);
  }
  if (message.type === "terminalStatus" && message.snapshot) {
    updateHeader(state.header, message.snapshot, state.context);
    if ((message.snapshot.ready || message.snapshot.mode === "django") && !state.compacted) {
      state.compacted = true;
      setTerminalHeight(state, COMPACT_TERMINAL_HEIGHT);
      storeTerminalHeight(state.context, state.sessionId, COMPACT_TERMINAL_HEIGHT);
    }
  }
}

/** Returns one header child, creating it when needed. */
function ensureHeaderElement(header, tagName, className) {
  let element = header.querySelector(`.${className}`);
  if (!element) {
    element = document.createElement(tagName);
    element.className = className;
    header.appendChild(element);
  }
  return element;
}

/** Synchronizes the in-notebook Django settings module selector. */
function syncSettingsSelect(select, value, context) {
  const candidates = Array.isArray(value.settingsCandidates) ? value.settingsCandidates : [];
  const selected = value.selectedSettingsModule || "";
  const options = selected && !candidates.includes(selected) ? [selected, ...candidates] : candidates;
  const key = JSON.stringify([selected, options]);
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(settingsOption("", "Auto"), ...options.map((candidate) => settingsOption(candidate, candidate)));
    select.value = selected;
  }
  select.title = "DJANGO_SETTINGS_MODULE";
  select.onchange = () => sendSettingsSelect(context, value.sessionId, select.value);
}

/** Creates one Django settings selector option. */
function settingsOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

/** Begins a pointer-driven terminal height resize gesture. */
function startResize(event, host, context, sessionId, fitAddon, terminal) {
  event.preventDefault();
  const handle = event.currentTarget;
  const startY = event.clientY;
  const startHeight = host.getBoundingClientRect().height;
  handle.setPointerCapture?.(event.pointerId);
  handle.classList.add("is-resizing");
  const onMove = (moveEvent) => {
    const nextHeight = setTerminalHeight({ fitAddon, host, terminal }, startHeight + moveEvent.clientY - startY);
    storeTerminalHeight(context, sessionId, nextHeight);
  };
  const onEnd = () => {
    handle.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    fitTerminal(fitAddon, terminal);
    terminal.focus();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd, { once: true });
  window.addEventListener("pointercancel", onEnd, { once: true });
}

/** Reads the persisted terminal height for one setup session. */
function terminalHeight(context, sessionId) {
  const state = context.getState?.();
  const height = state?.heightVersion === HEIGHT_STATE_VERSION ? state.heights?.[sessionId] : undefined;
  return clampHeight(Number.isFinite(height) ? height : TERMINAL_DEFAULT_HEIGHT);
}

/** Stores the terminal height in renderer webview state. */
function storeTerminalHeight(context, sessionId, height) {
  if (!context.setState) {
    return;
  }
  const state = context.getState?.() || {};
  context.setState({ ...state, heightVersion: HEIGHT_STATE_VERSION, heights: { ...(state.heights || {}), [sessionId]: height } });
}

/** Applies a terminal height and returns the bounded pixel value. */
function setTerminalHeight(state, height) {
  const nextHeight = clampHeight(height);
  state.host.style.height = `${nextHeight}px`;
  fitTerminal(state.fitAddon, state.terminal);
  return nextHeight;
}

/** Bounds terminal height to a practical notebook viewport range. */
function clampHeight(height) {
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, height));
}

/** Posts terminal keystrokes back to the extension host. */
function sendMessage(context, sessionId, data) {
  if (!context.postMessage) {
    return;
  }
  context.postMessage({ data, sessionId, type: "terminalInput" });
}

/** Posts terminal size changes back to the extension host. */
function sendResize(context, sessionId, cols, rows) {
  if (!context.postMessage) {
    return;
  }
  context.postMessage({ cols, rows, sessionId, type: "terminalResize" });
}

/** Posts a Django settings module selection back to the extension host. */
function sendSettingsSelect(context, sessionId, value) {
  if (!context.postMessage) {
    return;
  }
  context.postMessage({ sessionId, type: "settingsSelect", value });
}

/** Notifies the extension host that xterm is mounted and can receive PTY data. */
function sendReady(context, sessionId) {
  if (!context.postMessage) {
    return;
  }
  context.postMessage({ sessionId, type: "terminalReady" });
}

/** Fits xterm to its notebook cell container. */
function fitTerminal(fitAddon, terminal) {
  try {
    fitAddon.fit();
  } catch {
    // xterm can throw while the notebook output is detached or hidden.
  }
}

/** Builds a VS Code themed xterm palette. */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue("--vscode-terminal-background").trim() || css.getPropertyValue("--vscode-editor-background").trim(),
    cursor: css.getPropertyValue("--vscode-terminalCursor-foreground").trim() || css.getPropertyValue("--vscode-terminal-foreground").trim(),
    foreground: css.getPropertyValue("--vscode-terminal-foreground").trim() || css.getPropertyValue("--vscode-editor-foreground").trim()
  };
}

/** Installs xterm and notebook renderer CSS once. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    ${xtermCss}
    .djs-terminal-root { border: 1px solid var(--vscode-panel-border); background: var(--vscode-terminal-background, var(--vscode-editor-background)); }
    .djs-terminal-header { align-items: center; display: flex; gap: 8px; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 12px; }
    .djs-terminal-header[data-ready="true"] { color: var(--vscode-testing-iconPassed); }
    .djs-settings-select { background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); font: inherit; max-width: 45%; min-width: 180px; }
    .djs-terminal-host { box-sizing: border-box; height: ${TERMINAL_DEFAULT_HEIGHT}px; min-height: ${MIN_TERMINAL_HEIGHT}px; max-height: ${MAX_TERMINAL_HEIGHT}px; padding: 6px; overflow: hidden; }
    .djs-terminal-host .xterm { height: 100%; }
    .djs-terminal-resize { height: 9px; border-top: 1px solid var(--vscode-panel-border); cursor: ns-resize; position: relative; }
    .djs-terminal-resize::after { background: var(--vscode-descriptionForeground); border-radius: 999px; content: ""; height: 2px; left: 50%; opacity: 0.55; position: absolute; top: 3px; transform: translateX(-50%); width: 42px; }
    .djs-terminal-resize:hover::after,
    .djs-terminal-resize.is-resizing::after { opacity: 0.95; }
    .djs-python-history { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); box-sizing: border-box; color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; margin: 0; max-height: 280px; overflow: auto; padding: 8px 10px; white-space: pre-wrap; }
  `;
  document.head.appendChild(style);
}
