// VS Code configuration, local metadata discovery, and safe generation for Query Builder assistance.
import * as vscode from "vscode";
import { buildQueryAssistantCommand, prepareQueryAssistantEnvironment, resolveQueryAssistantExecutable, runQueryAssistantCommand, runQueryAssistantMetadataCommand } from "./modelQueryAssistantCli";
import { parseClaudeModelHelp, parseCodexModelCatalog, parseCodexModelHelp, type QueryAssistantDiscovery, type QueryAssistantModelOption } from "./modelQueryAssistantDiscovery";
import { normalizeAssistantModel, normalizeAssistantReasoningEffort, normalizeAssistantTimeout, type QueryAssistantProvider, type QueryAssistantProviderSettings, type QueryAssistantReasoningEffort } from "./modelQueryAssistantProtocol";

/** One host-authoritative provider compatibility state. */
export type QueryAssistantCompatibility = "ready" | "unverified" | "missing-model" | "retired-model" | "unsupported-reasoning" | "invalid-settings";
/** A safe provider record returned to the webview. */
export interface QueryAssistantProviderStatus { available: boolean; compatibility: QueryAssistantCompatibility; detail?: string; generationAllowed: boolean; label: string; metadata: { source: "catalog" | "help" | "unavailable"; state: "ready" | "unavailable" }; models: QueryAssistantModelOption[]; provider: QueryAssistantProvider; providerReasoningEfforts: QueryAssistantReasoningEffort[]; settings: QueryAssistantProviderSettings; }
/** Full settings and availability snapshot returned after detection, refresh, and writes. */
export interface QueryAssistantProvidersSnapshot { preferredProvider: QueryAssistantProvider; providers: QueryAssistantProviderStatus[]; }
/** Exposes bounded provider configuration, discovery, and generation to the Model Browser host. */
export interface QueryAssistantService { detectProviders(refresh?: boolean): Promise<QueryAssistantProvidersSnapshot>; configure(provider: QueryAssistantProvider, settings?: QueryAssistantProviderSettings): Promise<void>; generate(provider: QueryAssistantProvider, prompt: string, signal: AbortSignal): Promise<string>; onDidChangeConfiguration(listener: () => void): vscode.Disposable; }
/** Reports only non-sensitive assistant lifecycle metadata to the extension diagnostic logger. */
export type QueryAssistantLog = (event: string, details: Record<string, unknown>) => void;
/** Invokes one already-resolved local CLI request. */
export type QueryAssistantRunner = typeof runQueryAssistantCommand;
const LOGGABLE_FAILURES = new Set(["provider-unavailable", "authentication", "timeout", "cancelled", "context-too-large", "output-too-large", "provider-failed", "unsupported-settings"]);
/** Maps unknown process failures to a non-sensitive bounded category. */
function loggableFailure(error: unknown): string { const value = error instanceof Error ? error.message : ""; return LOGGABLE_FAILURES.has(value) ? value : "provider-failed"; }
/** Returns the normalized local assistant timeout configuration. */
export function queryAssistantTimeout(): number { return normalizeAssistantTimeout(vscode.workspace.getConfiguration("djangoShell.queryAssistant").get("timeoutMs")); }
/** Returns a stable workspace resource so scoped reads and writes inspect the same authority. */
function resource(): vscode.Uri | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri; }
/** Gets the scoped assistant configuration rather than an arbitrary global-only view. */
function configuration(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration("djangoShell.queryAssistant", resource()); }
/** Returns the exact configuration key for a provider-local property. */
function settingKey(provider: QueryAssistantProvider, suffix: "AutoUpdateModel" | "Model" | "ReasoningEffort"): string { return `${provider}${suffix}`; }
/** Reads provider settings while retaining whether a persisted value was structurally invalid. */
function readSettings(config: vscode.WorkspaceConfiguration, provider: QueryAssistantProvider): { invalid: boolean; settings: QueryAssistantProviderSettings } {
  const automatic = config.get<unknown>(settingKey(provider, "AutoUpdateModel"), true); const rawModel = config.get<unknown>(settingKey(provider, "Model"), ""); const rawReasoning = config.get<unknown>(settingKey(provider, "ReasoningEffort"), "");
  const model = normalizeAssistantModel(rawModel); const reasoningEffort = normalizeAssistantReasoningEffort(rawReasoning); const invalid = typeof automatic !== "boolean" || model === undefined || reasoningEffort === undefined;
  return { invalid, settings: { autoUpdateModel: typeof automatic === "boolean" ? automatic : true, model: model ?? "", reasoningEffort: reasoningEffort ?? "" } };
}
/** Produces a bounded compatibility record without mutating persisted settings. */
function compatibility(settings: QueryAssistantProviderSettings, discovery: QueryAssistantDiscovery, invalid = false): Pick<QueryAssistantProviderStatus, "compatibility" | "detail" | "generationAllowed"> {
  if (invalid) { return { compatibility: "invalid-settings", detail: "Saved provider settings are invalid.", generationAllowed: false }; }
  if (settings.autoUpdateModel) {
    if (settings.reasoningEffort && discovery.providerReasoningEfforts.length && !discovery.providerReasoningEfforts.includes(settings.reasoningEffort)) { return { compatibility: "unsupported-reasoning", detail: "This provider does not support the selected reasoning level.", generationAllowed: false }; }
    return { compatibility: discovery.source === "unavailable" || Boolean(settings.reasoningEffort && !discovery.providerReasoningEfforts.length) ? "unverified" : "ready", generationAllowed: true };
  }
  if (!settings.model) { return { compatibility: "missing-model", detail: "Choose a model before generating.", generationAllowed: false }; }
  const model = discovery.models.find((entry) => entry.model === settings.model); const retired = discovery.retiredModels?.find((entry) => entry.model === settings.model);
  if (retired) { return { compatibility: "retired-model", detail: retired.replacement, generationAllowed: false }; }
  if (model?.retired) { return { compatibility: "retired-model", detail: model.replacement, generationAllowed: false }; }
  if (!model && discovery.source === "catalog") { return { compatibility: "missing-model", detail: "This model is not available.", generationAllowed: false }; }
  const efforts = model ? model.supportedReasoningEfforts || [] : discovery.providerReasoningEfforts;
  if (settings.reasoningEffort && efforts.length && !efforts.includes(settings.reasoningEffort)) { return { compatibility: "unsupported-reasoning", detail: "This model does not support the selected reasoning level.", generationAllowed: false }; }
  return { compatibility: model && (!settings.reasoningEffort || efforts.length) || discovery.source === "catalog" && !settings.reasoningEffort ? "ready" : "unverified", generationAllowed: true };
}
/** Returns the effective authority and its pre-write value for one resource-scoped setting. */
function configurationWriteTarget(inspection: { globalValue?: unknown; workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined): { target: vscode.ConfigurationTarget; value: unknown } {
  if (inspection?.workspaceFolderValue !== undefined) { return { target: vscode.ConfigurationTarget.WorkspaceFolder, value: inspection.workspaceFolderValue }; }
  if (inspection?.workspaceValue !== undefined) { return { target: vscode.ConfigurationTarget.Workspace, value: inspection.workspaceValue }; }
  return { target: vscode.ConfigurationTarget.Global, value: inspection?.globalValue };
}
/** Verifies writes against a newly acquired configuration because VS Code configuration objects are read snapshots. */
function configurationContains(writes: Array<[string, unknown]>): boolean { const current = configuration(); return writes.every(([key, value]) => current.get(key) === value); }
/** Creates the configured service while retaining sensitive content inside local CLI processes. */
export function createQueryAssistantService(log: QueryAssistantLog = () => {}, resolve = resolveQueryAssistantExecutable, environment = prepareQueryAssistantEnvironment, runner: QueryAssistantRunner = runQueryAssistantCommand): QueryAssistantService {
  const cache = new Map<string, QueryAssistantDiscovery>();
  /** Reads the configured executable name rather than allowing command fragments. */
  const configured = (provider: QueryAssistantProvider) => String(configuration().get(provider === "claude" ? "claudeCommand" : "codexCommand", provider)).trim();
  /** Discovers one provider's bounded local help/catalog metadata with Codex help fallback. */
  const discover = async (provider: QueryAssistantProvider, command: string, env: NodeJS.ProcessEnv, refresh: boolean, signal?: AbortSignal): Promise<QueryAssistantDiscovery> => {
    const key = `${provider}:${command}`; if (!refresh && cache.has(key)) { return cache.get(key)!; }
    const cwd = resource()?.fsPath || process.cwd(); const controller = signal ? undefined : new AbortController(); const activeSignal = signal || controller!.signal; const run = async (args: string) => runQueryAssistantMetadataCommand({ args: args.split(" "), command, cwd }, activeSignal, env);
    let result: QueryAssistantDiscovery | undefined;
    try { result = provider === "claude" ? parseClaudeModelHelp(await run("--help")) : parseCodexModelCatalog(await run("debug models --bundled")); } catch (error) { if (activeSignal.aborted || error instanceof Error && error.message === "cancelled") { throw new Error("cancelled"); } }
    if (provider === "codex" && !result) { try { result = parseCodexModelHelp(`${await run("--help")}\n${await run("exec --help")}`); } catch (error) { if (activeSignal.aborted || error instanceof Error && error.message === "cancelled") { throw new Error("cancelled"); } } }
    result ||= { models: [], provider, providerReasoningEfforts: [], source: "unavailable" }; cache.set(key, result); return result;
  };
  /** Converts one provider into a safe snapshot record. */
  const status = async (provider: QueryAssistantProvider, env: NodeJS.ProcessEnv, refresh: boolean): Promise<QueryAssistantProviderStatus> => {
    const command = await resolve(configured(provider), env); const read = readSettings(configuration(), provider); const label = provider === "claude" ? "Claude Code" : "Codex";
    if (!command) { return { available: false, ...compatibility(read.settings, { models: [], provider, providerReasoningEfforts: [], source: "unavailable" }, read.invalid), detail: "That provider is not available on this machine.", generationAllowed: false, label, metadata: { source: "unavailable", state: "unavailable" }, models: [], provider, providerReasoningEfforts: [], settings: read.settings }; }
    const metadata = await discover(provider, command, env, refresh); return { available: true, ...compatibility(read.settings, metadata, read.invalid), label, metadata: { source: metadata.source, state: metadata.source === "unavailable" ? "unavailable" : "ready" }, models: metadata.models, provider, providerReasoningEfforts: metadata.providerReasoningEfforts, settings: read.settings };
  };
  return {
    async detectProviders(refresh = false) { const env = await environment(); if (refresh) { cache.clear(); } const savedProvider = configuration().get<unknown>("provider", "claude"); const preferred: QueryAssistantProvider = savedProvider === "codex" ? "codex" : "claude"; return { preferredProvider: preferred, providers: await Promise.all((["claude", "codex"] as const).map((provider) => status(provider, env, refresh))) }; },
    async configure(provider, settings) {
      const config = configuration(); const writes: Array<[string, unknown]> = settings ? [[settingKey(provider, "AutoUpdateModel"), settings.autoUpdateModel], [settingKey(provider, "Model"), settings.model], [settingKey(provider, "ReasoningEffort"), settings.reasoningEffort]] : [["provider", provider]];
      const targets = new Map(writes.map(([key]) => [key, configurationWriteTarget(config.inspect(key))])); const complete: Array<[string, { target: vscode.ConfigurationTarget; value: unknown }]> = [];
      try { for (const [key, value] of writes) { const previous = targets.get(key)!; await config.update(key, value, previous.target); complete.push([key, previous]); } if (!configurationContains(writes)) { throw new Error("settings-write-failed"); } }
      catch { for (const [key, previous] of complete.reverse()) { try { await config.update(key, previous.value, previous.target); } catch { /* Return only the bounded original write category. */ } } throw new Error("settings-write-failed"); }
    },
    async generate(provider, prompt, signal) {
      if (signal.aborted) { throw new Error("cancelled"); } const env = await environment(); if (signal.aborted) { throw new Error("cancelled"); } const command = await resolve(configured(provider), env); if (!command) { throw new Error("provider-unavailable"); }
      const discovery = await discover(provider, command, env, false, signal); if (signal.aborted) { throw new Error("cancelled"); } const read = readSettings(configuration(), provider); const gate = compatibility(read.settings, discovery, read.invalid); if (!gate.generationAllowed) { throw new Error("unsupported-settings"); }
      const started = Date.now(); try { const output = await runner(buildQueryAssistantCommand(provider, command, resource()?.fsPath || process.cwd(), read.settings), prompt, queryAssistantTimeout(), signal, env); log("queryAssistant.complete", { automatic: read.settings.autoUpdateModel, elapsedMs: Date.now() - started, outputCharacters: output.length, provider, result: "complete" }); return output; } catch (error) { const category = loggableFailure(error); log("queryAssistant.failed", { automatic: read.settings.autoUpdateModel, elapsedMs: Date.now() - started, provider, result: category }); throw new Error(category); }
    },
    /** Subscribes to resource-scoped changes that affect effective assistant settings. */
    onDidChangeConfiguration(listener) { const changes = vscode.workspace?.onDidChangeConfiguration; if (!changes) { return { dispose() {} }; } return changes((event) => { if (event.affectsConfiguration("djangoShell.queryAssistant", resource())) { listener(); } }); }
  };
}
