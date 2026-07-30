// Validator-aligned relation-source and isolated target-scope helpers for Query Builder controls.
import { rootMetadataOptions } from "./gridQueryMetadata.js";

/** Returns a trimmed non-empty metadata string or an empty sentinel. */
function text(value) { return typeof value === "string" ? value.trim() : ""; }

/** Parses one complete app-qualified target using the last separator. */
export function parseQueryTarget(value) { const target = text(value); const index = target.lastIndexOf("."); const app = text(target.slice(0, index)); const model = text(target.slice(index + 1)); return index > 0 && app && model ? { app, model } : undefined; }

/** Returns a copied complete model source target. */
function modelTarget(source) { const app = text(source?.target?.app); const model = text(source?.target?.model); return source?.kind === "model" && app && model ? { app, model } : undefined; }

/** Normalizes live relation metadata without translating identities. */
function normalizeRelation(relation) { const name = text(relation?.name); const target = parseQueryTarget(relation?.target); return name && target ? { ...relation, filterField: text(relation?.filterField), name, outerField: text(relation?.outerField), target: `${target.app}.${target.model}` } : undefined; }

/** Describes whether a relation can use the existing automatic-correlation contract. */
export function relationHasAutomaticConnection(relation) { return Boolean(text(relation?.filterField) && text(relation?.outerField)); }

/** Builds one searchable relation option without translating accessor identities. */
export function relationSourceOption(relation) { const item = normalizeRelation(relation); if (!item) { return undefined; } const kind = text(item.kind).replace(/[_-]/g, " ") || "relation"; const cardinality = item.toMany ? "many related rows" : "one related row"; const automatic = relationHasAutomaticConnection(item); const label = text(item.label) || item.name; return { description: `${kind}; ${cardinality}; ${item.target}; ${automatic ? "automatic connection" : "automatic connection unavailable"}`, disabled: !automatic, disabledReason: automatic ? "" : "This relation does not provide a safe automatic connection.", keywords: `${item.name} ${label} ${item.target} ${kind} ${cardinality}`, label: `${label} → ${item.target}`, value: item.name }; }

/** Preserves a persisted stale selection as a disabled option. */
function unavailable(current) { const value = text(current); return value ? { description: "This persisted relation is unavailable from current metadata.", disabled: true, disabledReason: "Unavailable relation", keywords: value, label: `Unavailable relation: ${value}`, value } : undefined; }

/** Projects one owner metadata state into a finite relation-source state. */
export function relationSourceState({ current, metadata, owner } = {}) { const state = metadata?.getState?.(owner); const tree = state?.tree; const options = tree ? rootMetadataOptions(tree).relations.map(relationSourceOption).filter(Boolean).filter((option, index, list) => list.findIndex((item) => item.value === option.value) === index) : []; const phase = tree ? (options.length ? "ready" : "empty") : state?.error ? "error" : "loading"; const stale = unavailable(current); if (stale && !options.some((option) => option.value === stale.value)) { options.push(stale); } return { error: state?.error && !tree ? state.error : "", options, phase }; }

/** Resolves a source target only through normalized owner filter-tree metadata. */
export function resolveQuerySourceTarget(source, owner, metadata) { const direct = modelTarget(source); if (direct) { return direct; } if (source?.kind !== "relation" || !text(owner?.app) || !text(owner?.model)) { return undefined; } const relationValue = text(source.relation); const relation = rootMetadataOptions(metadata?.getState?.(owner)?.tree).relations.map(normalizeRelation).find((item) => item && (item.name === relationValue || item.filterField === relationValue)); return parseQueryTarget(relation?.target); }

/** Builds an isolated source-owned scope without retaining outer target fields. */
export function createQuerySourceScope(source, ownerScope, metadata) { const owner = ownerScope?.target || ownerScope?.source; const target = resolveQuerySourceTarget(source, owner, metadata); const fields = rootMetadataOptions(metadata?.getState?.(owner)?.tree).fields.map((field) => ({ ...field, path: field.name, role: "field" })); const fallback = (ownerScope?.columns || []).map((field) => ({ ...field, path: field.attname || field.name, role: "field" })); const seen = new Set(); const outerFields = [...fields, ...fallback].filter((field) => text(field.path) && !seen.has(field.path) && seen.add(field.path)); return { columns: [], computed: [], computedFields: [], outerFields, source: target, target }; }
