// Bounded Query Builder assistant message contracts shared by webview and host.
import { isModelQueryRecipeV2, type ModelQueryRecipeV2 } from "./modelQueryRecipe";

/** Supported explicit local assistant providers. */
export type QueryAssistantProvider = "claude" | "codex";
/** Supported explicit provider reasoning levels; an empty value uses the CLI default. */
export type QueryAssistantReasoningEffort = "" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** Normalized persisted selection for one local provider. */
export interface QueryAssistantProviderSettings { autoUpdateModel: boolean; model: string; reasoningEffort: QueryAssistantReasoningEffort; }
/** Safe assistant failures that can cross the host boundary. */
export type QueryAssistantErrorCategory = "provider-unavailable" | "authentication" | "timeout" | "cancelled" | "context-too-large" | "output-too-large" | "provider-failed" | "invalid-response" | "invalid-recipe" | "stale" | "unsupported-settings" | "settings-write-failed" | "settings-overridden" | "settings-busy";
/** Bounded request message accepted from the Query Builder webview. */
export type QueryAssistantMessage =
  | { requestId: string; type: "queryAssistantProviders" }
  | { requestId: string; type: "refreshQueryAssistantProviders" }
  | { provider: QueryAssistantProvider; requestId: string; type: "selectQueryAssistantProvider" }
  | ({ provider: QueryAssistantProvider; requestId: string; type: "updateQueryAssistantProviderSettings" } & QueryAssistantProviderSettings)
  | { instruction: string; provider: QueryAssistantProvider; recipe: ModelQueryRecipeV2; requestId: string; revision: number; type: "generateQueryAssistantSuggestion" }
  | { requestId: string; type: "cancelQueryAssistantSuggestion" }
  | { requestId: string; revision: number; suggestionId: string; type: "acceptQueryAssistantSuggestion" }
  | { suggestionId: string; type: "dismissQueryAssistantSuggestion" }
  | { type: "openQueryAssistantSettings" };

export const QUERY_ASSISTANT_LIMITS = { contextBytes: 256 * 1024, id: 160, instruction: 12000, metadataOutput: 1_048_576, metadataTimeout: 20_000, model: 160, output: 200000, stderr: 16000, timeoutDefault: 120000, timeoutMaximum: 600000, timeoutMinimum: 1000 } as const;

/** Clips a string to a documented UTF-16 character boundary. */
export function clipAssistantText(value: unknown, limit: number): string { return typeof value === "string" ? value.slice(0, limit) : ""; }
/** Returns a nonblank bounded opaque request or suggestion identifier. */
export function assistantId(value: unknown): string | undefined { const id = clipAssistantText(value, QUERY_ASSISTANT_LIMITS.id).trim(); return id ? id : undefined; }
/** Narrows an unknown value to a non-array record. */
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
/** Normalizes a finite nonnegative revision. */
function revision(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }
/** Normalizes one safe provider model identifier without accepting argv fragments. */
export function normalizeAssistantModel(value: unknown): string | undefined { if (typeof value !== "string") { return undefined; } const model = value.slice(0, QUERY_ASSISTANT_LIMITS.model).trim(); return !model || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(model) ? model : undefined; }
/** Narrows an unknown value to a supported explicit reasoning level. */
export function normalizeAssistantReasoningEffort(value: unknown): QueryAssistantReasoningEffort | undefined { return typeof value === "string" && ["", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value) ? value as QueryAssistantReasoningEffort : undefined; }
/** Parses one bounded provider settings record. */
export function normalizeAssistantProviderSettings(value: unknown): QueryAssistantProviderSettings | undefined { if (!record(value) || typeof value.autoUpdateModel !== "boolean") { return undefined; } const model = normalizeAssistantModel(value.model); const reasoningEffort = normalizeAssistantReasoningEffort(value.reasoningEffort); return model !== undefined && reasoningEffort !== undefined ? { autoUpdateModel: value.autoUpdateModel, model, reasoningEffort } : undefined; }
/** Parses only one of the bounded assistant webview messages. */
export function parseQueryAssistantMessage(value: unknown): QueryAssistantMessage | undefined {
  if (!record(value) || typeof value.type !== "string") { return undefined; }
  const id = assistantId(value.requestId);
  if (value.type === "queryAssistantProviders") { return id ? { requestId: id, type: value.type } : undefined; }
  if (value.type === "refreshQueryAssistantProviders") { return id ? { requestId: id, type: value.type } : undefined; }
  if (value.type === "selectQueryAssistantProvider") { return id && (value.provider === "claude" || value.provider === "codex") ? { provider: value.provider, requestId: id, type: value.type } : undefined; }
  if (value.type === "updateQueryAssistantProviderSettings") { const settings = normalizeAssistantProviderSettings(value); return id && (value.provider === "claude" || value.provider === "codex") && settings ? { ...settings, provider: value.provider, requestId: id, type: value.type } : undefined; }
  if (value.type === "cancelQueryAssistantSuggestion") { return id ? { requestId: id, type: value.type } : undefined; }
  if (value.type === "dismissQueryAssistantSuggestion") { const suggestionId = assistantId(value.suggestionId); return suggestionId ? { suggestionId, type: value.type } : undefined; }
  if (value.type === "openQueryAssistantSettings") { return { type: value.type }; }
  if (value.type === "acceptQueryAssistantSuggestion") { const suggestionId = assistantId(value.suggestionId); const current = revision(value.revision); return id && suggestionId && current !== undefined ? { requestId: id, revision: current, suggestionId, type: value.type } : undefined; }
  if (value.type !== "generateQueryAssistantSuggestion" || (value.provider !== "claude" && value.provider !== "codex") || !isModelQueryRecipeV2(value.recipe)) { return undefined; }
  const instruction = clipAssistantText(value.instruction, QUERY_ASSISTANT_LIMITS.instruction).trim(); const current = revision(value.revision);
  return id && instruction && current !== undefined ? { instruction, provider: value.provider, recipe: value.recipe, requestId: id, revision: current, type: value.type } : undefined;
}
/** Normalizes settings timeout to the supported bounded range. */
export function normalizeAssistantTimeout(value: unknown): number { const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : QUERY_ASSISTANT_LIMITS.timeoutDefault; return Math.max(QUERY_ASSISTANT_LIMITS.timeoutMinimum, Math.min(QUERY_ASSISTANT_LIMITS.timeoutMaximum, numeric)); }
