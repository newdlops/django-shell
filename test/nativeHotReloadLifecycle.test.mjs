// Source-level lifecycle guards for the VS Code watcher, which imports the vscode runtime.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const nativeHotReloadSource = fs.readFileSync(new URL("../src/nativeHotReload.ts", import.meta.url), "utf8");

test("built-in experimental debugging owns a live-configured hot-reload watcher for the shell lifetime", () => {
  assert.ok(customConsoleSource.includes("new NativeHotReloadCoordinator(backend, this.logger, () => !this.pythonBusy || this.debugPaused)"));
  assert.ok((customConsoleSource.match(/nativeHotReload\?\.dispose\(\)/g) ?? []).length >= 3);
  assert.ok(nativeHotReloadSource.includes('createFileSystemWatcher("**/*.py")'));
  assert.ok(nativeHotReloadSource.includes("onDidChangeConfiguration"));
  assert.ok(nativeHotReloadSource.includes('affectsConfiguration("djangoShell.debug.hotReload")'));
  assert.ok(nativeHotReloadSource.includes("canFlush: this.canReload"));
  assert.ok(nativeHotReloadSource.includes("shouldIgnoreNativeHotReload"));
});
