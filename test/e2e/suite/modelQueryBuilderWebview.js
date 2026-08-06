// Extension Host E2E probe for the rendered Model Browser Query Builder webview.

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

/** Verifies the strict Query Builder progressive-example and AI-assist rendered flow. */
async function assertModelQueryBuilderWebview(extension) {
  await assertQueryAssistantConfigurationWrites(extension);
  const { ModelBrowser } = require(path.join(extension.extensionPath, "out", "modelBrowser.js"));
  const { createEmptyModelQueryRecipe } = require(path.join(extension.extensionPath, "out", "modelQueryRecipe.js"));
  const runtimeChange = new vscode.EventEmitter();
  const fixture = modelFixtureSource(runtimeChange.event);
  const source = fixture.source;
  const assistant = createAssistantFixture(createEmptyModelQueryRecipe);
  const browser = new ModelBrowser(extension.extensionPath, source, undefined, assistant.service);
  try {
    const snapshot = await browser.e2eProbeQueryBuilder({ app: "db", label: "Application user", model: "AppUser" });
    assert.equal(snapshot.error, undefined, JSON.stringify(snapshot));
    assert.equal(snapshot.drawerOpen, true);
    assert.equal(snapshot.conditionCount, 1);
    assert.equal(snapshot.disabled, false);
    assert.equal(snapshot.focused, true);
    assert.equal(snapshot.showPickerCalls, 1, "the final legacy picker invokes the native picker once");
    assert.equal(snapshot.placeholderDisabled, true);
    assert.equal(snapshot.selectedValue, "");
    assert.deepEqual(snapshot.sortCycle, ["ascending", "descending", "none"]);
    assert.ok(snapshot.enabledOptionCount >= 2);
    assert.deepEqual(snapshot.optionGroups, ["Fields", "Relations", "Relationship checks"]);
    assert.equal(snapshot.applyDisabled, true);
    assert.equal(snapshot.appliedFilters, "None");
    assert.equal(snapshot.exampleCount, 4);
    assert.equal(snapshot.applyDisabled, true, "the final legacy picker draft remains unapplied");
    assert.deepEqual(assistant.settings.claude, { autoUpdateModel: false, model: "sonnet", reasoningEffort: "high" });
    assert.deepEqual(assistant.settings.codex, { autoUpdateModel: false, model: "gpt-5-mini", reasoningEffort: "medium" });
    assert.equal(assistant.calls.refreshes, 1, "refresh must rerun local metadata discovery exactly once");
    assert.deepEqual(assistant.calls.generation, { provider: "claude", settings: { autoUpdateModel: false, model: "sonnet", reasoningEffort: "high" } });
    assert.deepEqual(assistant.calls.configure.filter((call) => !call.settings).map((call) => call.provider), ["codex", "claude"], "provider selections persist in user order");
    assert.ok(assistant.calls.configure.some((call) => call.provider === "claude" && call.settings?.model === "sonnet" && call.settings?.reasoningEffort === "high"));
    assert.ok(assistant.calls.configure.some((call) => call.provider === "codex" && call.settings?.model === "gpt-5-mini" && call.settings?.reasoningEffort === "medium"));
    for (const [name, metric] of Object.entries(snapshot.assistantOverflow)) {
      assert.ok(metric, `${name} overflow metric is present`);
      assert.ok(metric.scrollWidth <= metric.clientWidth, `${name} has no horizontal overflow`);
    }
    assert.equal(fixture.calls.modelAggregate, 0, "assistant and examples do not run aggregate queries");
    assert.equal(fixture.calls.modelCommit, 0, "assistant acceptance never commits edits");
    assert.equal(fixture.calls.modelRows, 4, "only the initial load and three header-sort states reload fixture rows");
    assert.deepEqual(fixture.calls.orders, ["default", "username:asc", "username:desc", "default"]);
  } finally {
    browser.dispose();
    runtimeChange.dispose();
  }
}

/** Verifies provider and model settings against VS Code's real snapshot-based configuration API. */
async function assertQueryAssistantConfigurationWrites(extension) {
  const { createQueryAssistantService } = require(path.join(extension.extensionPath, "out", "modelQueryAssistantService.js"));
  const service = createQueryAssistantService();
  const keys = ["provider", "codexAutoUpdateModel", "codexModel", "codexReasoningEffort"];
  try {
    await service.configure("codex");
    await service.configure("codex", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high" });
    const config = vscode.workspace.getConfiguration("djangoShell.queryAssistant", vscode.workspace.workspaceFolders?.[0]?.uri);
    assert.equal(config.get("provider"), "codex");
    assert.deepEqual([config.get("codexAutoUpdateModel"), config.get("codexModel"), config.get("codexReasoningEffort")], [false, "gpt-5", "high"]);
  } finally {
    const config = vscode.workspace.getConfiguration("djangoShell.queryAssistant", vscode.workspace.workspaceFolders?.[0]?.uri);
    for (const key of keys) { await config.update(key, undefined, vscode.ConfigurationTarget.Global); }
  }
}

/** Creates mutable authoritative settings and catalog records without starting a provider process. */
function createAssistantFixture(createEmptyModelQueryRecipe) {
  const settings = { claude: { autoUpdateModel: true, model: "", reasoningEffort: "" }, codex: { autoUpdateModel: true, model: "", reasoningEffort: "" } };
  const calls = { configure: [], generation: undefined, refreshes: 0 }; let preferredProvider = "claude";
  /** Projects current fake provider settings and compatibility into the production snapshot shape. */
  function snapshot() {
    return {
      preferredProvider,
      providers: ["claude", "codex"].map((provider) => {
        const selected = settings[provider];
        const models = provider === "claude"
          ? [{ label: "sonnet", model: "sonnet", supportedReasoningEfforts: ["low", "medium", "high", "max"] }, { label: "opus", model: "opus", supportedReasoningEfforts: ["low", "medium", "high", "max"] }]
          : [{ label: "GPT-5", model: "gpt-5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }, { label: "GPT-5 mini", model: "gpt-5-mini", supportedReasoningEfforts: ["low", "medium"] }, { label: "GPT-4 retired", model: "gpt-4-retired", replacement: "gpt-5", retired: true, supportedReasoningEfforts: [] }];
        const model = models.find((entry) => entry.model === selected.model);
        const incompatible = !selected.autoUpdateModel && Boolean(selected.reasoningEffort) && Boolean(model?.supportedReasoningEfforts?.length) && !model.supportedReasoningEfforts.includes(selected.reasoningEffort);
        return { available: true, compatibility: incompatible ? "unsupported-reasoning" : !selected.autoUpdateModel && !selected.model ? "missing-model" : "ready", generationAllowed: !incompatible && (selected.autoUpdateModel || Boolean(selected.model)), label: provider === "claude" ? "Claude Code" : "Codex", metadata: { source: "catalog", state: "ready" }, models, provider, providerReasoningEfforts: provider === "claude" ? ["low", "medium", "high", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"], settings: { ...selected } };
      })
    };
  }
  const service = {
    async configure(provider, next) { calls.configure.push({ provider, settings: next && { ...next } }); if (next) { settings[provider] = { ...next }; } else { preferredProvider = provider; } },
    async detectProviders(refresh = false) { if (refresh) { calls.refreshes += 1; } return snapshot(); },
    async generate(provider, _prompt, signal) {
      calls.generation = { provider, settings: { ...settings[provider] } };
    if (signal.aborted) { throw new Error("cancelled"); }
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 250); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true }); });
    const recipe = createEmptyModelQueryRecipe({ app: "db", model: "AppUser" });
    recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path: "status" }, lookup: "exact", negated: false, nodeId: "fixture-status-active", rhs: { kind: "literal", value: "active" } });
    return JSON.stringify({ recipe });
    }
  };
  return { calls, service, settings };
}

/** Creates deterministic read-only model metadata and call counters for the rendered probe. */
function modelFixtureSource(onDidChangeRuntime) {
  const columns = [
    { attname: "id", editable: false, label: "ID", name: "id", null: false, pk: true, type: "AutoField" },
    { attname: "status", choices: [["active", "Active"]], editable: true, label: "Status", name: "status", null: false, pk: false, type: "CharField" },
    { attname: "username", editable: true, label: "Username", name: "username", null: false, pk: false, type: "CharField" }
  ];
  const relations = [{ filterField: "company_id", kind: "reverse-fk", name: "memberships", outerField: "id", queryName: "memberships", single: false, target: "db.Membership" }];
  const fieldTree = {
    fields: columns.map((column) => ({ attname: column.attname, label: column.label, name: column.name, null: column.null, pk: column.pk, type: column.type })),
    ok: true,
    pk: "id",
    relations
  };
  const membershipTree = { fields: [{ attname: "company_id", label: "Company ID", name: "company_id", null: false, pk: false, type: "IntegerField" }, { attname: "id", label: "ID", name: "id", null: false, pk: true, type: "AutoField" }], ok: true, pk: "id", relations: [] };
  const calls = { modelAggregate: 0, modelCommit: 0, modelRows: 0, orders: [] };
  const source = {
    interruptModelQuery: async () => ({ interrupted: false, ok: true }),
    listModels: async () => ({ models: [{ app: "db", label: "Application user", model: "AppUser", table: "db_appuser" }, { app: "db", label: "Membership", model: "Membership", table: "db_membership" }], ok: true }),
    modelAggregate: async () => { calls.modelAggregate += 1; return { columns: [], ok: true, orm: "", rows: [], sql: [] }; },
    modelCommit: async () => { calls.modelCommit += 1; return { ok: false, error: "E2E fixture is read-only." }; },
    modelComputed: async () => ({ columns, ok: true, orm: "", rows: [], sql: [] }),
    modelCount: async () => ({ count: 0, ok: true, orm: "", sql: [] }),
    modelFilterFields: async (_app, model) => model === "Membership" ? membershipTree : fieldTree,
    modelLookup: async () => ({ columns: [], ok: true, rows: [], sql: [] }),
    modelQuery: async () => ({ columns, ok: true, orm: "", rows: [], sql: [] }),
    modelRelated: async () => ({ columns: [], hasMore: false, ok: true, orm: "", rows: [], single: false, sql: [] }),
    modelRows: async (query) => { calls.modelRows += 1; const term = query.recipe?.orderBy?.[0]; calls.orders.push(term ? `${term.ref.path || term.ref.alias}:${term.direction}` : "default"); return { columns, hasMore: false, nextOffset: null, ok: true, orm: "db.AppUser.objects.all()", pk: "id", relations, rows: [], sql: [] }; },
    modelSchema: async () => ({ app: "db", columns, label: "Application user", model: "AppUser", ok: true, pk: "id", relations, table: "db_appuser" }),
    modelTransportInfo: () => ({ active: "tcp", mode: "auto" }),
    onDidChangeRuntime,
    setModelTransport() {}
  };
  return { calls, source };
}

module.exports = { assertModelQueryBuilderWebview };
