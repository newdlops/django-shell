// Bounded local model metadata projection for Query Builder assistant providers.
import { type QueryAssistantProvider, type QueryAssistantReasoningEffort } from "./modelQueryAssistantProtocol";

/** One text-safe discovered model record. */
export interface QueryAssistantModelOption { defaultReasoningEffort?: QueryAssistantReasoningEffort; description?: string; label: string; model: string; replacement?: string; retired?: boolean; supportedReasoningEfforts?: QueryAssistantReasoningEffort[]; }
/** A provider-local metadata projection that contains no raw help/catalog output. */
export interface QueryAssistantDiscovery { models: QueryAssistantModelOption[]; provider: QueryAssistantProvider; providerReasoningEfforts: QueryAssistantReasoningEffort[]; retiredModels?: QueryAssistantModelOption[]; source: "catalog" | "help" | "unavailable"; }
const EFFORTS = new Set<QueryAssistantReasoningEffort>(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MAX_TEXT = 240;

/** Returns a bounded safe model id from potentially untrusted CLI output. */
function modelId(value: unknown): string | undefined { const result = String(value || "").trim(); return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result) ? result : undefined; }
/** Returns clipped plain text suitable for later text-node rendering. */
function text(value: unknown): string | undefined { const result = typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : ""; return result || undefined; }
/** Returns a supported list of unique explicit efforts. */
function efforts(value: unknown): QueryAssistantReasoningEffort[] { return Array.isArray(value) ? [...new Set(value.filter((entry): entry is QueryAssistantReasoningEffort => typeof entry === "string" && EFFORTS.has(entry as QueryAssistantReasoningEffort)))] : []; }
/** Returns one CLI option line together with its indented wrapped description. */
function optionHelp(value: string, option: string): string {
  const lines = value.split(/\r?\n/); const start = lines.findIndex((line) => line.includes(option));
  if (start < 0) { return ""; }
  const selected = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s{0,8}-{1,2}[A-Za-z0-9]/.test(line)) { break; }
    selected.push(line);
  }
  return selected.join(" ");
}
/** Extracts safe Claude aliases and advertised efforts from local help text. */
export function parseClaudeModelHelp(help: string): QueryAssistantDiscovery {
  const bounded = help.slice(0, 1_048_576); const found = new Set<string>(); const modelHelp = optionHelp(bounded, "--model");
  const quoted = [...modelHelp.matchAll(/['"`]([A-Za-z0-9][A-Za-z0-9._:-]{0,159})['"`]/g)].map((match) => match[1]);
  const choices = [...(modelHelp.match(/(?:\b(?:sonnet|opus|haiku|fable)\b|\bclaude-[A-Za-z0-9._:-]+\b)/gi) || []), ...quoted];
  for (const choice of choices) { const id = modelId(choice); if (id && !["default", "latest", "model"].includes(id.toLowerCase())) { found.add(id.toLowerCase()); } }
  const advertised = efforts(optionHelp(bounded, "--effort").match(/\b(?:low|medium|high|xhigh|max|ultra)\b/gi)?.map((value) => value.toLowerCase()));
  const models = [...found].slice(0, 100).sort().map((model) => ({ label: model, model, supportedReasoningEfforts: advertised }));
  return models.length ? { models, provider: "claude", providerReasoningEfforts: advertised, source: "help" } : { models: [], provider: "claude", providerReasoningEfforts: [], source: "unavailable" };
}
/** Extracts safe Codex GPT model ids from bounded local help text. */
export function parseCodexModelHelp(help: string): QueryAssistantDiscovery {
  const bounded = help.slice(0, 1_048_576); const found = new Set<string>();
  for (const choice of bounded.match(/\bgpt-[A-Za-z0-9._:-]+\b/gi) || []) { const id = modelId(choice); if (id) { found.add(id.toLowerCase()); } }
  const advertised = efforts((bounded.match(/(?:model_reasoning_effort|reasoning(?:\s+effort|\s+level)?)[^\n]*/i)?.[0] || "").match(/\b(?:low|medium|high|xhigh|max|ultra)\b/gi)?.map((value) => value.toLowerCase()));
  const models = [...found].slice(0, 100).sort().map((model) => ({ label: model, model, supportedReasoningEfforts: advertised }));
  return models.length ? { models, provider: "codex", providerReasoningEfforts: advertised, source: "help" } : { models: [], provider: "codex", providerReasoningEfforts: [], source: "unavailable" };
}
/** Extracts the first balanced JSON object or array from warning-surrounded command output. */
function catalogJson(output: string): unknown {
  const value = output.slice(0, 1_048_576);
  let start = -1; const stack: string[] = []; let quoted = false; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]; if (start < 0) { if (character === "{" || character === "[") { start = index; stack.push(character === "{" ? "}" : "]"); } continue; }
    if (quoted) { if (escaped) { escaped = false; } else if (character === "\\") { escaped = true; } else if (character === "\"") { quoted = false; } continue; }
    if (character === "\"") { quoted = true; continue; }
    if (character === "{" || character === "[") { stack.push(character === "{" ? "}" : "]"); continue; }
    if (character !== stack[stack.length - 1]) { continue; }
    stack.pop(); if (stack.length) { continue; }
    try { return JSON.parse(value.slice(start, index + 1)); } catch { start = -1; quoted = false; escaped = false; }
  }
  return undefined;
}
/** Projects the current Codex bundled catalog without retaining unrelated data. */
export function parseCodexModelCatalog(output: string): QueryAssistantDiscovery | undefined {
  const parsed = catalogJson(output); const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const records = Array.isArray(parsed) ? parsed : Array.isArray(object?.models) ? object.models : Array.isArray(object?.data) ? object.data : undefined;
  if (!records) { return undefined; }
  const models: Array<QueryAssistantModelOption & { priority: number }> = [];
  const seen = new Map<string, boolean>(); for (const record of records.slice(0, 200)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) { continue; } const value = record as Record<string, unknown>; if (typeof (value.slug ?? value.id ?? value.model) !== "string") { continue; } const model = modelId(value.slug ?? value.id ?? value.model); if (!model) { continue; }
    const hidden = value.hidden === true || value.visibility === "hidden" || value.visibility === "hide"; if (seen.has(model) && seen.get(model) !== hidden) { return undefined; } if (seen.has(model)) { continue; } seen.set(model, hidden); const upgrade = value.upgrade && typeof value.upgrade === "object" && !Array.isArray(value.upgrade) ? (value.upgrade as Record<string, unknown>).model : value.upgrade; const replacement = typeof (upgrade ?? value.replacement ?? value.replaced_by) === "string" ? modelId(upgrade ?? value.replacement ?? value.replaced_by) : undefined;
    const levels = Array.isArray(value.supported_reasoning_levels) ? value.supported_reasoning_levels.map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).effort : entry) : undefined;
    models.push({ defaultReasoningEffort: efforts([value.default_reasoning_level ?? value.default_reasoning_effort ?? value.defaultReasoningEffort])[0], description: text(value.description), label: text(value.display_name ?? value.displayName) || model, model, priority: Number.isFinite(value.priority) ? Number(value.priority) : Number.MAX_SAFE_INTEGER, replacement, retired: hidden, supportedReasoningEfforts: efforts(levels ?? value.supported_reasoning_efforts ?? value.supportedReasoningEfforts ?? value.reasoning_efforts) });
  }
  const visible = models.filter((model) => !model.retired).sort((left, right) => left.priority - right.priority || left.model.localeCompare(right.model)); const hidden = models.filter((model) => model.retired).sort((left, right) => left.model.localeCompare(right.model));
  if (!visible.length) { return undefined; }
  return { models: visible, provider: "codex", providerReasoningEfforts: [], retiredModels: hidden, source: "catalog" };
}
