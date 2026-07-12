// Regression guards for keeping background metadata outside interactive shell and debugger work.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const consoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const ptySource = fs.readFileSync(new URL("../src/notebookPtySession.ts", import.meta.url), "utf8");

test("interactive PTY execution passes queued metadata requests", () => {
  assert.ok(ptySource.includes('payload.kind === "execute" ? "high" : "normal"'));
});

test("debug runs cancel metadata work and defer warm-session refresh until idle", () => {
  const debugShell = methodSource("async debugShell()", "private async reuseWarmDebugRun");
  const executePython = methodSource("private async executePython", "private async executeBackendPython");
  const scheduleRefresh = methodSource("private scheduleRuntimeRefresh()", "private clearRuntimeRefreshTimer()");
  const blocked = methodSource("private runtimeRefreshBlocked()", "private clearRuntimeRefreshTimer()");
  assert.ok(debugShell.includes("this.clearRuntimeRefreshTimer(); this.clearPreludeRetryTimer()"));
  assert.ok(executePython.includes("this.clearRuntimeRefreshTimer(); this.clearPreludeRetryTimer(); this.clearInspectionCache()"));
  assert.equal(executePython.includes("void this.updateOverlayPrelude"), false, "execution completion must not duplicate an immediate prelude fetch");
  assert.ok(scheduleRefresh.includes("if (this.runtimeRefreshBlocked()) { return; }"));
  assert.ok(scheduleRefresh.includes("WARM_DEBUG_REFRESH_DELAY_MS"), "a warm debugger leaves a long cancellation window for the next run");
  assert.equal(blocked.includes("this.debugSession || this.overlayDebugSession"), false, "an idle warm debugger must not leave metadata stale forever");
});

test("hidden prelude requests coalesce within one execution generation", () => {
  const updatePrelude = methodSource("private async updateOverlayPrelude", "private schedulePreludeRetry");
  const clearInspection = methodSource("private clearInspectionCache()", "private async restartSession");
  assert.ok(updatePrelude.includes("this.runtimePrelude.get(() => backend.prelude())"));
  assert.ok(updatePrelude.includes("this.runtimePrelude.isCurrent(requestVersion)"));
  assert.ok(clearInspection.includes("this.runtimePrelude.invalidate()"));
});

test("ready startup measures immediately and notifies runtime views only after prelude idle grace", () => {
  const snapshot = methodSource("private handleSessionSnapshot", "private async handleMessage");
  const ready = snapshot.slice(snapshot.indexOf("if (!snapshot.ready || this.runtimeReady)"));
  const schedule = methodSource("private async scheduleReadyRuntimeRefresh", "private schedulePreludeRetry");
  const clearRefresh = methodSource("private clearRuntimeRefreshTimer()", "private clearInspectionCache()");
  assert.ok(ready.indexOf('type: "measureEditor"') < ready.indexOf("void this.scheduleReadyRuntimeRefresh"), "overlay measurement must not wait for metadata");
  assert.equal(ready.includes("this.runtimeEmitter.fire()"), false, "READY must not fan out background runtime reads immediately");
  assert.ok(schedule.indexOf("await this.updateOverlayPrelude(generation)") < schedule.indexOf("this.runtimeEmitter.fire()"));
  assert.ok(schedule.includes("READY_RUNTIME_REFRESH_DELAY_MS"));
  assert.ok(schedule.includes("refreshVersion !== this.runtimeRefreshVersion"), "restart and execution cancellation must invalidate startup work");
  assert.ok(clearRefresh.includes("this.runtimeRefreshVersion += 1"));
  assert.ok(clearRefresh.includes('phase: "cancel"'));
});

/** Returns one source method section bounded by the next stable declaration. */
function methodSource(startMarker, endMarker) {
  const start = consoleSource.indexOf(startMarker);
  const end = consoleSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startMarker}`);
  return consoleSource.slice(start, end);
}
