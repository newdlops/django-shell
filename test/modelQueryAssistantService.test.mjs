// Direct behavior tests for bounded Query Builder assistant service orchestration.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const originalLoad = NodeModule._load;
/** Loads the service with only the minimum deterministic VS Code configuration surface. */
function loadService(configuration = {}) {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === "vscode") { return { workspace: { getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback }), workspaceFolders: [{ uri: { fsPath: "/workspace" } }] } }; }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../out/modelQueryAssistantService.js")];
  return require("../out/modelQueryAssistantService.js");
}
/** Restores Node's module loader after a service test. */
function restoreServiceLoader() { NodeModule._load = originalLoad; }
/** Loads a mutable global configuration surface and records real configuration writes. */
function loadMutableService(values = {}, overrides = {}) {
  const writes = []; const changes = new EventEmitter(); const scoped = overrides.scoped || {}; const targets = { Global: "global", Workspace: "workspace", WorkspaceFolder: "workspaceFolder" };
  /** Returns the currently effective value from the mutable backing configuration. */
  const effective = (key, fallback) => scoped[key]?.workspaceFolderValue ?? scoped[key]?.workspaceValue ?? values[key] ?? fallback;
  /** Creates either a live mock or the read-snapshot behavior of VS Code's WorkspaceConfiguration. */
  const createConfiguration = () => {
    const snapshot = overrides.snapshotReads ? new Map([...new Set([...Object.keys(values), ...Object.keys(scoped)])].map((key) => [key, effective(key)])) : undefined;
    return {
      get: (key, fallback) => snapshot ? snapshot.has(key) ? snapshot.get(key) : fallback : effective(key, fallback),
      inspect: (key) => ({ globalValue: values[key], ...(scoped[key] || {}) }),
      update: async (key, value, target) => { writes.push({ key, target, value }); if (overrides.failAt === writes.length) { throw new Error("write failure"); } if (target === targets.WorkspaceFolder) { scoped[key] = { ...scoped[key], workspaceFolderValue: value }; } else if (target === targets.Workspace) { scoped[key] = { ...scoped[key], workspaceValue: value }; } else { values[key] = value; } }
    };
  };
  NodeModule._load = function loadWithMutableVscode(request, parent, isMain) { if (request === "vscode") { return { ConfigurationTarget: targets, workspace: { getConfiguration: createConfiguration, onDidChangeConfiguration: (listener) => { changes.on("change", listener); return { dispose: () => changes.off("change", listener) }; }, workspaceFolders: [{ uri: { fsPath: "/workspace" } }] } }; } return originalLoad.call(this, request, parent, isMain); };
  delete require.cache[require.resolve("../out/modelQueryAssistantService.js")]; return { change: (key) => changes.emit("change", { affectsConfiguration: (section, resource) => section === "djangoShell.queryAssistant" && resource?.fsPath === "/workspace" && key.startsWith("djangoShell.queryAssistant") }), service: require("../out/modelQueryAssistantService.js"), values, writes };
}
/** Replaces only the local metadata runner while loading a fresh service module. */
function replaceMetadataRunner(runner) { const cli = require("../out/modelQueryAssistantCli.js"); const original = cli.runQueryAssistantMetadataCommand; cli.runQueryAssistantMetadataCommand = runner; return () => { cli.runQueryAssistantMetadataCommand = original; }; }

test("detectProviders resolves with the prepared login-shell and common-path environment", async () => {
  const service = loadService().createQueryAssistantService(() => {}, async (_command, env) => env.PATH?.includes("/login") ? "/bin/found" : undefined, async () => ({ PATH: "/login:/common" }));
  try { const snapshot = await service.detectProviders(); assert.deepEqual(snapshot.providers.map((provider) => provider.available), [true, true]); assert.equal(snapshot.preferredProvider, "claude"); }
  finally { restoreServiceLoader(); }
});
test("pre-aborted generation performs no provider discovery or child run", async () => {
  const controller = new AbortController(); controller.abort(); let resolved = 0; let ran = 0; const service = loadService().createQueryAssistantService(() => {}, async () => { resolved += 1; return "/bin/codex"; }, async () => ({ PATH: "/prepared" }), async () => { ran += 1; return ""; });
  try { await assert.rejects(service.generate("codex", "prompt", controller.signal), { message: "cancelled" }); assert.equal(resolved, 0); assert.equal(ran, 0); }
  finally { restoreServiceLoader(); }
});
test("aborting during async executable discovery performs no child run", async () => {
  let release; const lookup = new Promise((resolve) => { release = resolve; }); const controller = new AbortController(); let ran = 0; const service = loadService().createQueryAssistantService(() => {}, async () => { await lookup; return "/bin/codex"; }, async () => ({ PATH: "/prepared" }), async () => { ran += 1; return ""; });
  try { const result = service.generate("codex", "prompt", controller.signal); controller.abort(); release(); await assert.rejects(result, { message: "cancelled" }); assert.equal(ran, 0); }
  finally { restoreServiceLoader(); }
});
test("configure writes provider settings to their controlling scope and rereads the effective values", async () => {
  const loaded = loadMutableService({ codexAutoUpdateModel: true, codexModel: "saved", codexReasoningEffort: "" });
  try { const instance = loaded.service.createQueryAssistantService(() => {}, async () => undefined, async () => ({ PATH: "/prepared" })); await instance.configure("codex", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }); assert.deepEqual(loaded.writes, [{ key: "codexAutoUpdateModel", target: "global", value: false }, { key: "codexModel", target: "global", value: "gpt-5" }, { key: "codexReasoningEffort", target: "global", value: "high" }]); const snapshot = await instance.detectProviders(); assert.deepEqual(snapshot.providers.find((provider) => provider.provider === "codex").settings, { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }); }
  finally { restoreServiceLoader(); }
});
test("configure verifies provider and model writes through fresh VS Code configuration snapshots", async () => {
  const loaded = loadMutableService({ provider: "claude", codexAutoUpdateModel: true, codexModel: "", codexReasoningEffort: "" }, { snapshotReads: true });
  try { const instance = loaded.service.createQueryAssistantService(() => {}, async () => undefined, async () => ({ PATH: "/prepared" })); await instance.configure("codex"); await instance.configure("codex", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }); assert.deepEqual(loaded.writes.map((write) => [write.key, write.value]), [["provider", "codex"], ["codexAutoUpdateModel", false], ["codexModel", "gpt-5"], ["codexReasoningEffort", "high"]]); assert.equal((await instance.detectProviders()).preferredProvider, "codex"); }
  finally { restoreServiceLoader(); }
});
test("configure updates workspace and workspace-folder authority, and rolls each target back atomically", async () => {
  const overridden = loadMutableService({}, { scoped: { codexAutoUpdateModel: { workspaceValue: true }, codexModel: { workspaceFolderValue: "workspace" }, codexReasoningEffort: { workspaceValue: "low" } } });
  try { const instance = overridden.service.createQueryAssistantService(); await instance.configure("codex", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }); assert.deepEqual(overridden.writes.map((write) => [write.key, write.target, write.value]), [["codexAutoUpdateModel", "workspace", false], ["codexModel", "workspaceFolder", "gpt-5"], ["codexReasoningEffort", "workspace", "high"]]); assert.deepEqual((await instance.detectProviders()).providers.find((provider) => provider.provider === "codex").settings, { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }); }
  finally { restoreServiceLoader(); }
  const rollback = loadMutableService({ codexAutoUpdateModel: true }, { failAt: 3, scoped: { codexModel: { workspaceFolderValue: "saved" }, codexReasoningEffort: { workspaceValue: "low" } } });
  try { const instance = rollback.service.createQueryAssistantService(); await assert.rejects(instance.configure("codex", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" }), { message: "settings-write-failed" }); assert.deepEqual(rollback.writes.map((write) => [write.key, write.target, write.value]), [["codexAutoUpdateModel", "global", false], ["codexModel", "workspaceFolder", "gpt-5"], ["codexReasoningEffort", "workspace", "high"], ["codexModel", "workspaceFolder", "saved"], ["codexAutoUpdateModel", "global", true]]); }
  finally { restoreServiceLoader(); }
});
test("each detection rereads external effective configuration without retaining stale snapshots", async () => {
  const loaded = loadMutableService({ provider: "claude" });
  try { const instance = loaded.service.createQueryAssistantService(() => {}, async () => undefined, async () => ({ PATH: "/prepared" })); assert.equal((await instance.detectProviders()).preferredProvider, "claude"); loaded.values.provider = "codex"; loaded.values.codexAutoUpdateModel = false; loaded.values.codexModel = ""; const codex = (await instance.detectProviders()).providers.find((provider) => provider.provider === "codex"); assert.equal((await instance.detectProviders()).preferredProvider, "codex"); assert.equal(codex.compatibility, "missing-model"); }
  finally { restoreServiceLoader(); }
});
test("configuration subscription reports only relevant resource-scoped assistant changes", () => {
  const loaded = loadMutableService(); let notifications = 0;
  try { const subscription = loaded.service.createQueryAssistantService().onDidChangeConfiguration(() => { notifications += 1; }); loaded.change("editor.fontSize"); loaded.change("djangoShell.queryAssistant.codexModel"); assert.equal(notifications, 1); subscription.dispose(); loaded.change("djangoShell.queryAssistant.provider"); assert.equal(notifications, 1); }
  finally { restoreServiceLoader(); }
});
test("discovery caches until refresh and cancellation prevents generation spawn", async () => {
  let metadataCalls = 0; const restoreRunner = replaceMetadataRunner(async () => { metadataCalls += 1; return '{"models":[{"slug":"gpt-5","supported_reasoning_levels":[{"effort":"high"}]}]}'; }); const loaded = loadMutableService({ codexAutoUpdateModel: false, codexModel: "gpt-5", codexReasoningEffort: "high" });
  try { const runs = []; const instance = loaded.service.createQueryAssistantService(() => {}, async () => "/bin/codex", async () => ({ PATH: "/prepared" }), async (...args) => { runs.push(args); return "recipe"; }); await instance.detectProviders(); await instance.detectProviders(); assert.equal(metadataCalls, 2); await instance.detectProviders(true); assert.equal(metadataCalls, 4); const controller = new AbortController(); controller.abort(); await assert.rejects(instance.generate("codex", "secret", controller.signal), { message: "cancelled" }); assert.equal(runs.length, 0); }
  finally { restoreRunner(); restoreServiceLoader(); }
});
test("compatibility preflight distinguishes unavailable, missing, retired, unverified, and unsupported settings without spawning", async () => {
  const restoreRunner = replaceMetadataRunner(async () => '{"models":[{"slug":"gpt-5","supported_reasoning_levels":[{"effort":"high"}]},{"slug":"old","visibility":"hide","upgrade":"gpt-5"}]}');
  try {
    const unavailable = loadMutableService({ codexAutoUpdateModel: false, codexModel: "gpt-5" }); const unavailableService = unavailable.service.createQueryAssistantService(() => {}, async () => undefined, async () => ({ PATH: "/prepared" })); assert.equal((await unavailableService.detectProviders()).providers.find((provider) => provider.provider === "codex").available, false); restoreServiceLoader();
    const cases = [[{ codexAutoUpdateModel: false, codexModel: "" }, "missing-model"], [{ codexAutoUpdateModel: false, codexModel: "old" }, "retired-model"], [{ codexAutoUpdateModel: false, codexModel: "gpt-5", codexReasoningEffort: "low" }, "unsupported-reasoning"]];
    for (const [values, expected] of cases) { const loaded = loadMutableService(values); let runs = 0; const instance = loaded.service.createQueryAssistantService(() => {}, async () => "/bin/codex", async () => ({ PATH: "/prepared" }), async () => { runs += 1; return ""; }); const status = (await instance.detectProviders()).providers.find((provider) => provider.provider === "codex"); assert.equal(status.compatibility, expected); await assert.rejects(instance.generate("codex", "secret", new AbortController().signal), { message: "unsupported-settings" }); assert.equal(runs, 0); restoreServiceLoader(); }
    restoreRunner(); const fallbackRunner = replaceMetadataRunner(async (spec) => spec.args[0] === "debug" ? "not a catalog" : "Usage: codex --model gpt-5\n"); const unverified = loadMutableService({ codexAutoUpdateModel: false, codexModel: "manual" }); const instance = unverified.service.createQueryAssistantService(() => {}, async () => "/bin/codex", async () => ({ PATH: "/prepared" })); const status = (await instance.detectProviders()).providers.find((provider) => provider.provider === "codex"); assert.equal(status.compatibility, "unverified"); fallbackRunner();
  } finally { restoreRunner(); restoreServiceLoader(); }
});
test("failure logs only a category and never prompt or raw secret errors", async () => {
  const loaded = loadMutableService({ codexAutoUpdateModel: true }); const events = [];
  try { const instance = loaded.service.createQueryAssistantService((event, details) => events.push({ event, details }), async () => "/bin/codex", async () => ({ PATH: "/prepared" }), async () => { throw new Error("secret provider output"); }); await assert.rejects(instance.generate("codex", "super-secret prompt", new AbortController().signal), { message: "provider-failed" }); assert.equal(events[0].details.result, "provider-failed"); assert.equal(JSON.stringify(events).includes("secret"), false); }
  finally { restoreServiceLoader(); }
});
