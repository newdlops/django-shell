// Captures bounded native hover events and the isolated test window for E2E diagnosis.
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { captureTestWorkbench } = require("./focusTestWorkbench.js");
const { installHoverInputGuard } = require("./overlayHoverInputGuard.js");

const RESULTS = path.resolve(__dirname, "../../../.vscode-test/results");

/** Starts a scoped renderer trace and always restores native methods after one hover probe. */
async function withHoverDiagnostics(extension, run, label = "default") {
  await vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", `(${installHoverTrace.toString()})()`);
  try {
    await vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", `(${installHoverInputGuard.toString()})()`);
    return await run();
  }
  catch (error) {
    await captureHoverStage(extension, `${label}-failed`).catch((captureError) => console.warn(String(captureError)));
    throw error;
  } finally {
    try {
      const input = await vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", `(function(){const guard=window.__dsoE2eHoverInput;const state=guard&&guard.snapshot();guard&&guard.cleanup();delete window.__dsoE2eHoverInput;return JSON.stringify(state||{});})()`);
      fs.mkdirSync(RESULTS, { recursive: true });
      fs.writeFileSync(path.join(RESULTS, `overlay-hover-${label}-input.json`), input);
    } catch (error) { console.warn(`Hover input cleanup failed: ${String(error)}`); }
    try {
      const trace = await vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", `(function(){const trace=window.__dsoE2eHoverTrace;trace&&trace.cleanup();delete window.__dsoE2eHoverTrace;return JSON.stringify(trace&&trace.events||[]);})()`);
      fs.mkdirSync(RESULTS, { recursive: true });
      fs.writeFileSync(path.join(RESULTS, `overlay-hover-${label}-trace.json`), trace);
    } catch (error) { console.warn(`Hover diagnostic cleanup failed: ${String(error)}`); }
  }
}

/** Overwrites a small, named screenshot instead of accumulating full development extension copies. */
async function captureHoverStage(extension, stage) {
  await captureTestWorkbench(extension, path.join(RESULTS, `overlay-hover-${stage}.png`));
}

/** Installs a bounded event trace without modifying native hover decisions. */
function installHoverTrace() {
  window.__dsoE2eHoverTrace?.cleanup();
  const root = document.getElementById("django-shell-overlay");
  const editor = root?.__djangoShellEditor;
  const portal = root?.__dsoWidgetRoot;
  const node = editor?.getDomNode();
  const controller = editor?.getContribution("editor.contrib.contentHover");
  const events = [], cleanup = [], started = performance.now();
  /** Adds one relevant event and current native/portal ownership state to the bounded log. */
  function record(type, extra = {}) {
    const hover = portal?.querySelector(".monaco-resizable-hover,.monaco-hover");
    const rect = hover?.getBoundingClientRect();
    events.push({ ms: Math.round(performance.now() - started), type, focused: document.hasFocus(),
      held: !!root?.__dsoDetachedHoverHeld, inside: !!root?.__dsoDetachedHoverPointerInside,
      keepOpen: controller?.shouldKeepOpenOnEditorMouseMoveOrLeave,
      hover: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null, ...extra });
    if (events.length > 250) { events.shift(); }
  }
  /** Records only events on the overlay, its popup, or the renderer window. */
  function onEvent(event) {
    if (!node?.contains(event.target) && !portal?.contains(event.target) && event.target !== window) { return; }
    record(event.type, { target: String(event.target?.className || event.target?.nodeName || "window"), related: String(event.relatedTarget?.className || ""), x: event.clientX, y: event.clientY });
  }
  for (const type of ["mouseover", "mouseout", "mousemove", "mousedown", "mouseup", "blur", "focus"]) {
    window.addEventListener(type, onEvent, true);
    cleanup.push(() => window.removeEventListener(type, onEvent, true));
  }
  for (const name of ["hideContentHover", "_cancelScheduler"]) {
    const original = controller?.[name];
    if (typeof original !== "function") { continue; }
    /** Records the native hover call stack before forwarding the original receiver and arguments. */
    const traced = function (...args) { record(name, { stack: new Error().stack?.split("\n").slice(2, 7).join("\n") }); return original.apply(this, args); };
    controller[name] = traced;
    cleanup.push(() => { if (controller[name] === traced) { controller[name] = original; } });
  }
  for (const name of ["onDidChangeModelContent", "onDidChangeCursorPosition"]) {
    const subscription = editor?.[name]?.(() => record(name));
    if (subscription) { cleanup.push(() => subscription.dispose()); }
  }
  const observer = new MutationObserver(() => record("portal-mutated"));
  if (portal) { observer.observe(portal, { childList: true, subtree: true, attributes: true }); }
  cleanup.push(() => observer.disconnect());
  window.__dsoE2eHoverTrace = { events, cleanup: () => cleanup.splice(0).forEach((dispose) => dispose()) };
  record("installed", { controllerKeys: Object.keys(controller || {}), model: String(editor?.getModel()?.uri) });
  return "hover-trace-installed";
}

module.exports = { withHoverDiagnostics, captureHoverStage };
