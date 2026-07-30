// Host-side lifecycle for bounded Query Builder AI draft suggestions.
import type { ModelQueryRecipeV2 } from "./modelQueryRecipe";
import { buildQueryAssistantPrompt, containsAiForbiddenCodeExpression, parseQueryAssistantResponse } from "./modelQueryAssistantPrompt";
import { parseQueryAssistantMessage, type QueryAssistantErrorCategory, type QueryAssistantMessage } from "./modelQueryAssistantProtocol";
import type { QueryAssistantService } from "./modelQueryAssistantService";

/** Captures the minimum current Query Builder context needed for a generation. */
export interface QueryAssistantHostContext { context: Record<string, unknown>; revision: number; source: { app: string; model: string }; }
/** Dependencies supplied by Model Browser without giving this module panel ownership. */
export interface QueryAssistantHostDependencies {
  /** Captures current source, revision, and privacy-projected schema context. */
  capture(): QueryAssistantHostContext;
  /** Opens the extension settings surface for assistant command recovery. */
  onSettings(): Thenable<unknown> | void;
  /** Sends a bounded lifecycle projection back to the webview. */
  post(message: Record<string, unknown>): void;
  /** Prepares privacy-safe current-draft metadata without evaluating a query. */
  prepare?(recipe: ModelQueryRecipeV2, revision: number): Promise<void>;
  service: QueryAssistantService;
  /** Validates and normalizes a candidate without evaluating a query. */
  validate(recipe: ModelQueryRecipeV2): Promise<{ normalized?: ModelQueryRecipeV2; orm?: string; issues?: unknown[]; ok: boolean; summary?: string; warnings?: string[] }>;
}

/** Owns one panel's opaque, cancellable assistant suggestion state. */
export function createModelQueryAssistantHost(dependencies: QueryAssistantHostDependencies) {
  let active: { controller: AbortController; requestId: string; token: object } | undefined;
  let pending: { fingerprint: string; id: string; recipe: ModelQueryRecipeV2; requestId: string; revision: number; source: { app: string; model: string }; token: object } | undefined;
  let accepting: { pending: object; token: object } | undefined;
  let disposed = false;
  let lastSettingsIdentity = "";
  let settingsRefreshActive = false;
  let settingsRefreshQueued = false;
  let settingsRefreshVersion = 0;
  let settingsSubscription: { dispose(): unknown } | undefined;
  /** Returns a deterministic source/schema identity without serializing provider output. */
  function fingerprint(context: QueryAssistantHostContext): string { return JSON.stringify({ context: context.context, source: context.source }); }
  /** Posts a bounded categorized error adjacent to the assistant form. */
  function error(requestId: string, category: QueryAssistantErrorCategory, terminal = false) { dependencies.post({ category, requestId, ...(terminal ? { terminal: true } : {}), type: "queryAssistantError" }); }
  /** Returns the persisted provider/model/reasoning identity without provider metadata. */
  function settingsIdentity(snapshot: Awaited<ReturnType<QueryAssistantService["detectProviders"]>>): string { return JSON.stringify({ preferredProvider: snapshot?.preferredProvider || "claude", providers: (snapshot?.providers || []).map((provider) => ({ provider: provider.provider, settings: provider.settings })) }); }
  /** Posts a snapshot and invalidates suggestions made with superseded effective settings. */
  function postSnapshot(snapshot: Awaited<ReturnType<QueryAssistantService["detectProviders"]>>, requestId?: string, settingsSync = false) {
    const identity = settingsIdentity(snapshot); if (lastSettingsIdentity && identity !== lastSettingsIdentity) { invalidate("settings"); }
    lastSettingsIdentity = identity; dependencies.post({ ...snapshot, ...(requestId ? { requestId } : {}), ...(settingsSync ? { settingsSync: true } : {}), type: "queryAssistantProviders" });
  }
  /** Coalesces external setting changes into one latest authoritative webview snapshot. */
  async function refreshSettings() {
    if (settingsRefreshActive) { return; } settingsRefreshActive = true;
    try { while (!disposed) { const version = settingsRefreshVersion; const snapshot = await dependencies.service.detectProviders(); if (disposed) { return; } if (version !== settingsRefreshVersion) { continue; } postSnapshot(snapshot, undefined, true); return; } }
    catch { if (!disposed) { /* A later configuration event or manual refresh remains recoverable. */ } }
    finally { settingsRefreshActive = false; if (!disposed && settingsRefreshVersion && !settingsRefreshQueued) { settingsRefreshVersion = 0; } }
  }
  /** Schedules an external setting refresh after VS Code has committed the effective value. */
  function scheduleSettingsRefresh() { settingsRefreshVersion += 1; if (settingsRefreshQueued || settingsRefreshActive || disposed) { return; } settingsRefreshQueued = true; queueMicrotask(() => { settingsRefreshQueued = false; void refreshSettings(); }); }
  settingsSubscription = dependencies.service.onDidChangeConfiguration?.(scheduleSettingsRefresh);
  /** Cancels the active process and makes its late completion harmless. */
  function cancel(requestId: string) { const operation = active; if (!operation || operation.requestId !== requestId) { return; } operation.controller.abort(); if (active === operation) { active = undefined; } dependencies.post({ requestId, type: "queryAssistantCancelled" }); }
  /** Handles a parsed assistant message and reports whether it consumed it. */
  async function handleMessage(value: unknown, parsed?: QueryAssistantMessage): Promise<boolean> {
    const message = parsed ?? parseQueryAssistantMessage(value);
    if (!message || disposed) { return false; }
    if (message.type === "queryAssistantProviders") {
      try { postSnapshot(await dependencies.service.detectProviders(), message.requestId); }
      catch { error(message.requestId, "provider-unavailable", true); }
      return true;
    }
    if (message.type === "refreshQueryAssistantProviders") {
      try { postSnapshot(await dependencies.service.detectProviders(true), message.requestId); }
      catch { error(message.requestId, "provider-unavailable", true); }
      return true;
    }
    if (message.type === "selectQueryAssistantProvider" || message.type === "updateQueryAssistantProviderSettings") {
      if (active) { error(message.requestId, "settings-busy", true); return true; }
      try { await dependencies.service.configure(message.provider, message.type === "updateQueryAssistantProviderSettings" ? { autoUpdateModel: message.autoUpdateModel, model: message.model, reasoningEffort: message.reasoningEffort } : undefined); postSnapshot(await dependencies.service.detectProviders(), message.requestId); }
      catch (caught) { const category = caught instanceof Error ? caught.message : "settings-write-failed"; const bounded = (["settings-overridden", "settings-write-failed"] as string[]).includes(category) ? category as QueryAssistantErrorCategory : "settings-write-failed"; try { const snapshot = await dependencies.service.detectProviders(); error(message.requestId, bounded); postSnapshot(snapshot, message.requestId); } catch { dependencies.post({ category: bounded, requestId: message.requestId, terminal: true, type: "queryAssistantError" }); } }
      return true;
    }
    if (message.type === "openQueryAssistantSettings") { try { await dependencies.onSettings(); } catch { error("", "provider-failed"); } return true; }
    if (message.type === "cancelQueryAssistantSuggestion") { cancel(message.requestId); return true; }
    if (message.type === "dismissQueryAssistantSuggestion") { if (pending?.id === message.suggestionId) { pending = undefined; accepting = undefined; dependencies.post({ suggestionId: message.suggestionId, type: "queryAssistantDismissed" }); } return true; }
    if (message.type === "acceptQueryAssistantSuggestion") {
      const candidate = pending; if (!candidate || candidate.id !== message.suggestionId || accepting?.pending === candidate.token) { error(message.requestId, "stale"); return true; }
      const acceptance = { pending: candidate.token, token: {} }; accepting = acceptance;
      try {
        const current = dependencies.capture();
        if (current.revision !== message.revision || current.revision !== candidate.revision || fingerprint(current) !== candidate.fingerprint || current.source.app !== candidate.source.app || current.source.model !== candidate.source.model) { error(message.requestId, "stale"); return true; }
        const validation = await dependencies.validate(candidate.recipe);
        const latest = dependencies.capture();
        if (disposed || accepting !== acceptance || pending !== candidate || latest.revision !== message.revision || latest.revision !== candidate.revision || fingerprint(latest) !== candidate.fingerprint || latest.source.app !== candidate.source.app || latest.source.model !== candidate.source.model) { error(message.requestId, "stale"); return true; }
        if (!validation.ok || !validation.normalized) { error(message.requestId, "invalid-recipe"); return true; }
        dependencies.post({ recipe: validation.normalized, requestId: message.requestId, revision: message.revision, suggestionId: candidate.id, type: "queryAssistantAccepted" }); if (pending === candidate) { pending = undefined; } return true;
      } catch { error(message.requestId, "invalid-recipe"); return true; } finally { if (accepting === acceptance) { accepting = undefined; } }
    }
    if (message.type !== "generateQueryAssistantSuggestion") { return false; }
    if (active) { cancel(active.requestId); }
    if (containsAiForbiddenCodeExpression(message.recipe)) { error(message.requestId, "invalid-recipe"); return true; }
    accepting = undefined; pending = undefined;
    const operation = { controller: new AbortController(), requestId: message.requestId, token: {} }; active = operation;
    dependencies.post({ provider: message.provider, requestId: message.requestId, type: "queryAssistantRunning" });
    try {
      await dependencies.prepare?.(message.recipe, message.revision);
      if (disposed || active !== operation) { return true; }
      const current = dependencies.capture();
      if (current.revision !== message.revision || current.source.app !== message.recipe.source.app || current.source.model !== message.recipe.source.model) { error(message.requestId, "stale"); return true; }
      const currentFingerprint = fingerprint(current);
      const prompt = buildQueryAssistantPrompt({ ...current.context, instruction: message.instruction, recipe: message.recipe });
      const output = await dependencies.service.generate(message.provider, prompt, operation.controller.signal);
      if (disposed || active !== operation) { return true; }
      const recipe = parseQueryAssistantResponse(output); if (!recipe) { error(message.requestId, "invalid-response"); return true; }
      const latest = dependencies.capture(); if (latest.revision !== current.revision || fingerprint(latest) !== currentFingerprint || latest.source.app !== current.source.app || latest.source.model !== current.source.model) { error(message.requestId, "stale"); return true; }
      const validation = await dependencies.validate(recipe); if (disposed || active !== operation) { return true; } const afterValidation = dependencies.capture(); if (afterValidation.revision !== current.revision || fingerprint(afterValidation) !== currentFingerprint || afterValidation.source.app !== current.source.app || afterValidation.source.model !== current.source.model) { error(message.requestId, "stale"); return true; } if (!validation.ok || !validation.normalized) { error(message.requestId, "invalid-recipe"); return true; }
      const id = `${message.requestId}:suggestion`; pending = { fingerprint: currentFingerprint, id, recipe: validation.normalized, requestId: message.requestId, revision: current.revision, source: current.source, token: {} };
      dependencies.post({ orm: validation.orm || "", provider: message.provider, requestId: message.requestId, suggestionId: id, summary: validation.summary || "AI-generated Recipe", type: "queryAssistantSuggestion", warnings: validation.warnings || [] });
    } catch (caught) {
      if (disposed || active !== operation) { return true; }
      const name = caught instanceof Error ? caught.message : "provider-failed";
      error(message.requestId, (["provider-unavailable", "authentication", "timeout", "cancelled", "context-too-large", "output-too-large", "provider-failed", "unsupported-settings"] as string[]).includes(name) ? name as QueryAssistantErrorCategory : "provider-failed");
    } finally { if (active === operation) { active = undefined; } }
    return true;
  }
  /** Invalidates active and pending work after the source/schema context changes. */
  function invalidate(_reason: string) { const operation = active; if (operation) { operation.controller.abort(); dependencies.post({ requestId: operation.requestId, type: "queryAssistantCancelled" }); } if (pending) { dependencies.post({ category: "stale", requestId: "", type: "queryAssistantError" }); } active = undefined; pending = undefined; accepting = undefined; }
  /** Releases process state when the owning panel closes. */
  function dispose() { disposed = true; settingsSubscription?.dispose(); invalidate("dispose"); }
  return { dispose, handleMessage, invalidate };
}
