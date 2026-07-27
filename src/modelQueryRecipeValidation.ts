// Pure normalization and strict semantic validation for ModelQueryRecipeV2.

import type { BackendModelColumn } from "./modelBackend";
import type { BackendTransport } from "./backendClient";
import { createEmptyModelQueryRecipe, isModelQueryRecipeV2, MODEL_QUERY_RECIPE_VERSION, type ModelQueryRecipeV2, type QueryComparisonNode, type QueryComputedColumn, type QueryFormulaNode, type QueryModelRef, type QueryOrderTerm, type QueryPredicateGroup, type QueryPredicateNode, type QuerySubquerySource, type QueryValueRef } from "./modelQueryRecipe";
import { MODEL_QUERY_AGGREGATE_FUNCTIONS, MODEL_QUERY_FORMULA_FUNCTIONS, MODEL_QUERY_LOOKUPS, MODEL_QUERY_OUTPUT_TYPES, MODEL_QUERY_RECIPE_LIMITS, MODEL_QUERY_WINDOW_FUNCTIONS } from "./modelQueryRecipeLimits";
import { ModelQueryMetadataIndex, type QueryResolvedPath } from "./modelQueryRecipeMetadata";

/** Every stable error or warning code emitted by recipe validation. */
export const MODEL_QUERY_ISSUE_CODES = ["RECIPE_VERSION_UNSUPPORTED", "RECIPE_SOURCE_MISMATCH", "RECIPE_TOO_LARGE", "RECIPE_SHAPE_INVALID", "NODE_ID_INVALID", "NODE_ID_DUPLICATE", "PREDICATE_NODE_LIMIT", "PREDICATE_GROUP_DEPTH_LIMIT", "PREDICATE_GROUP_CHILD_LIMIT", "EMPTY_NESTED_GROUP", "FIELD_METADATA_UNAVAILABLE", "FIELD_PATH_INVALID", "FIELD_PATH_TOO_LONG", "FIELD_PATH_RELATION_TERMINAL", "FIELD_PATH_TO_MANY_UNSAFE", "LOOKUP_UNSUPPORTED", "LOOKUP_TYPE_MISMATCH", "RHS_KIND_UNSUPPORTED", "RHS_TYPE_MISMATCH", "VALUE_REQUIRED", "VALUE_INVALID", "IN_LIST_LIMIT", "RELATIVE_TIME_INVALID", "COMPUTED_COLUMN_LIMIT", "ALIAS_INVALID", "ALIAS_RESERVED", "ALIAS_COLLISION", "ALIAS_DUPLICATE", "COMPUTED_REFERENCE_UNKNOWN", "COMPUTED_REFERENCE_FORWARD", "COMPUTED_REFERENCE_DISABLED", "COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY", "AGGREGATE_FIELD_REQUIRED", "AGGREGATE_FANOUT_UNSAFE", "AGGREGATE_DISTINCT_UNSUPPORTED", "WINDOW_ORDER_REQUIRED", "WINDOW_FILTER_UNSUPPORTED", "FORMULA_NODE_LIMIT", "FORMULA_DEPTH_LIMIT", "FORMULA_TYPE_MISMATCH", "FORMULA_DIVIDE_BY_ZERO", "OUTPUT_TYPE_REQUIRED", "RAW_EXPRESSION_INVALID", "RAW_EXPRESSION_TRANSPORT_UNSUPPORTED", "RAW_MODEL_NAME_AMBIGUOUS", "SUBQUERY_SOURCE_INVALID", "SUBQUERY_RELATION_INVALID", "SUBQUERY_CORRELATION_REQUIRED", "SUBQUERY_CORRELATION_LIMIT", "SUBQUERY_CORRELATION_INVALID", "SUBQUERY_SELECT_INVALID", "SUBQUERY_ORDER_LIMIT", "SUBQUERY_IMPLICIT_ORDER", "SUBQUERY_AGGREGATE_FANOUT_UNSAFE", "OUTER_REF_SCOPE_INVALID", "GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED", "PYTHON_PROPERTY_FULL_SCAN", "PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED", "PYTHON_PROPERTY_SUMMARY_UNSUPPORTED", "AUTO_DISTINCT_APPLIED", "OFFSET_PAGINATION_REQUIRED", "TRANSPORT_CAPABILITY_UNSUPPORTED", "GENERATED_QUERY_TOO_LARGE"] as const;
/** Stable validation issue code. */
export type ModelQueryIssueCode = (typeof MODEL_QUERY_ISSUE_CODES)[number];
/** One user-actionable recipe validation finding. */
export interface ModelQueryIssue { code: ModelQueryIssueCode; fix: string; message: string; nodeId?: string; path: string; severity: "error" | "warning"; }
/** Complete result of normalization and semantic validation. */
export interface ModelQueryValidation { humanSummary: string; issues: ModelQueryIssue[]; normalized?: ModelQueryRecipeV2; ok: boolean; ormPreview?: string; warnings: ModelQueryIssue[]; }
/** Information available to a transport-neutral recipe validation pass. */
export interface ModelQueryValidationContext { columns: BackendModelColumn[]; metadata: ModelQueryMetadataIndex; source: QueryModelRef; transport: BackendTransport | "orm"; }

/** Validates an unknown recipe without executing compiler code or mutating the input. */
export function validateModelQueryRecipe(input: unknown, context: ModelQueryValidationContext): ModelQueryValidation {
  const issues: ModelQueryIssue[] = [];
  if (!isRecord(input)) { return finish(issues, undefined); }
  if (input.version !== MODEL_QUERY_RECIPE_VERSION) { add(issues, "RECIPE_VERSION_UNSUPPORTED", "/version", "Use recipe version 2."); }
  const normalized = normalizeModelQueryRecipe(input, context.source);
  if (!normalized || !isModelQueryRecipeV2(normalized)) { add(issues, "RECIPE_SHAPE_INVALID", "", "Restore the required recipe objects and arrays."); return finish(issues, undefined); }
  if (!sameModel(normalized.source, context.source)) { add(issues, "RECIPE_SOURCE_MISMATCH", "/source", "Use the model currently open in this data view."); }
  if (utf8Bytes(normalized) > MODEL_QUERY_RECIPE_LIMITS.recipeBytes) { add(issues, "RECIPE_TOO_LARGE", "", "Remove conditions or shorten entered expressions."); }
  validateNodeIdsAndLimits(normalized, issues);
  if (!context.metadata.getTree(context.source)) { add(issues, "FIELD_METADATA_UNAVAILABLE", "/source", "Reload field metadata before applying the query."); }
  validateGroup(normalized.where, "/where", context.source, context, issues, { nested: false, outerScope: false, propertyAllowed: true, postFilter: false, aliases: new Map() });
  const symbols = validateComputed(normalized, context, issues);
  validateMode(normalized, context, symbols, issues);
  validateGroup(normalized.postFilter, "/postFilter", context.source, context, issues, { nested: false, outerScope: false, propertyAllowed: false, postFilter: true, aliases: symbols });
  validateOrder(normalized.orderBy, "/orderBy", context.source, context, symbols, issues, false);
  validateTransport(normalized, context, issues);
  return finish(issues, normalized);
}

/** Normalizes roots and harmless spelling details into an independent clone without auto-fixing invalid semantics. */
export function normalizeModelQueryRecipe(input: unknown, source?: QueryModelRef): ModelQueryRecipeV2 | undefined {
  if (!isRecord(input)) { return undefined; }
  const fallback = source ? createEmptyModelQueryRecipe(source) : undefined;
  if (!fallback || !isRecord(input.source) || typeof input.source.app !== "string" || typeof input.source.model !== "string") { return undefined; }
  const clone = deepClone(input) as Record<string, unknown>;
  const recipe = clone as unknown as ModelQueryRecipeV2;
  recipe.version = input.version as 2;
  recipe.source = { app: String(input.source.app).trim(), model: String(input.source.model).trim() };
  recipe.mode = input.mode as "rows" | "summary";
  recipe.where = normalizeGroup(input.where, "where-root") ?? fallback.where;
  recipe.postFilter = normalizeGroup(input.postFilter, "post-root") ?? fallback.postFilter;
  recipe.computed = Array.isArray(input.computed) ? input.computed as QueryComputedColumn[] : [];
  recipe.groupBy = Array.isArray(input.groupBy) ? input.groupBy as ModelQueryRecipeV2["groupBy"] : [];
  recipe.orderBy = Array.isArray(input.orderBy) ? input.orderBy as QueryOrderTerm[] : [];
  trimRecipeStrings(recipe);
  normalizeBlankRhs(recipe.where);
  normalizeBlankRhs(recipe.postFilter);
  for (const computed of recipe.computed) { normalizeComputed(computed); }
  return recipe;
}

/** Appends issues in the validator's fixed traversal order. */
function add(issues: ModelQueryIssue[], code: ModelQueryIssueCode, path: string, fix: string, nodeId?: string, severity: "error" | "warning" = "error"): void {
  issues.push({ code, path, fix, nodeId, severity, message: issueMessage(code) });
}

/** Produces a stable concise message for every issue code. */
function issueMessage(code: ModelQueryIssueCode): string { return code.split("_").map((word) => word.toLowerCase()).join(" "); }

/** Finalizes warning projection and deterministic user-facing summary. */
function finish(issues: ModelQueryIssue[], normalized: ModelQueryRecipeV2 | undefined): ModelQueryValidation {
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const errors = issues.filter((issue) => issue.severity === "error");
  return { ok: errors.length === 0, issues, warnings, normalized, humanSummary: errors.length ? `${errors.length} query error${errors.length === 1 ? "" : "s"}` : warnings.length ? `${warnings.length} query warning${warnings.length === 1 ? "" : "s"}` : "Query is valid" };
}

/** Validates globally unique node identifiers and predicate structural limits. */
function validateNodeIdsAndLimits(recipe: ModelQueryRecipeV2, issues: ModelQueryIssue[]): void {
  const ids = new Set<string>();
  let nodes = 0;
  const visitId = (nodeId: unknown, path: string): void => {
    if (typeof nodeId !== "string" || !/^(where-root|post-root|[A-Za-z][A-Za-z0-9_-]{0,63})$/.test(nodeId)) { add(issues, "NODE_ID_INVALID", `${path}/nodeId`, "Use a short generated node identifier."); return; }
    if (ids.has(nodeId)) { add(issues, "NODE_ID_DUPLICATE", `${path}/nodeId`, "Generate a new unique node identifier.", nodeId); }
    ids.add(nodeId);
  };
  const visitGroup = (group: unknown, path: string, depth: number, root: boolean): void => {
    if (!isGroup(group)) { return; }
    nodes += 1; visitId(group.nodeId, path);
    if (depth > MODEL_QUERY_RECIPE_LIMITS.predicateGroupDepth) { add(issues, "PREDICATE_GROUP_DEPTH_LIMIT", path, "Remove a nested group.", group.nodeId); }
    if (group.children.length > MODEL_QUERY_RECIPE_LIMITS.predicateGroupChildren) { add(issues, "PREDICATE_GROUP_CHILD_LIMIT", `${path}/children`, "Split this group into smaller groups.", group.nodeId); }
    if (!root && group.children.length === 0) { add(issues, "EMPTY_NESTED_GROUP", path, "Add a condition or remove this empty group.", group.nodeId); }
    group.children.forEach((child, index) => { if (!isRecord(child)) { nodes += 1; return; } if (child.kind === "group") { visitGroup(child, `${path}/children/${index}`, depth + 1, false); return; } nodes += 1; visitId(child.nodeId, `${path}/children/${index}`); if (child.kind === "existsPredicate") { validateSubqueryNodeIds(child, `${path}/children/${index}`, visitId); } });
  };
  visitGroup(recipe.where, "/where", 1, true); visitGroup(recipe.postFilter, "/postFilter", 1, true);
  recipe.computed.forEach((computed, index) => { visitId(computed.nodeId, `/computed/${index}`); if ("correlations" in computed) { computed.correlations.forEach((item, child) => visitId(item.nodeId, `/computed/${index}/correlations/${child}`)); } if ("orderBy" in computed) { computed.orderBy.forEach((item, child) => visitId(item.nodeId, `/computed/${index}/orderBy/${child}`)); } });
  recipe.orderBy.forEach((term, index) => visitId(term.nodeId, `/orderBy/${index}`));
  if (nodes > MODEL_QUERY_RECIPE_LIMITS.predicateNodes) { add(issues, "PREDICATE_NODE_LIMIT", "", "Remove predicate nodes."); }
  if (recipe.computed.length > MODEL_QUERY_RECIPE_LIMITS.computedColumns) { add(issues, "COMPUTED_COLUMN_LIMIT", "/computed", "Remove a computed column."); }
}

/** Validates identifiers inside an EXISTS predicate. */
function validateSubqueryNodeIds(node: Record<string, unknown>, path: string, visitId: (id: unknown, path: string) => void): void { if (Array.isArray(node.correlations)) { node.correlations.forEach((item, index) => visitId(isRecord(item) ? item.nodeId : undefined, `${path}/correlations/${index}`)); } }

/** Validates one predicate group recursively in its current model scope. */
function validateGroup(group: unknown, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], options: GroupOptions): void {
  if (!isGroup(group)) { add(issues, "RECIPE_SHAPE_INVALID", path, "Use a predicate group."); return; }
  if (group.join !== "and" && group.join !== "or") { add(issues, "RECIPE_SHAPE_INVALID", `${path}/join`, "Choose AND or OR.", group.nodeId); }
  group.children.forEach((child, index) => {
    const childPath = `${path}/children/${index}`;
    if (!isRecord(child)) { add(issues, "RECIPE_SHAPE_INVALID", childPath, "Restore this predicate."); return; }
    if (child.kind === "group") { validateGroup(child, childPath, model, context, issues, { ...options, nested: true, propertyAllowed: false }); }
    else if (child.kind === "comparison") { validateComparison(child as QueryComparisonNode, childPath, model, context, issues, options); }
    else if (child.kind === "existsPredicate") { validateExistsPredicate(child, childPath, model, context, issues, options.aliases); }
    else { add(issues, "RECIPE_SHAPE_INVALID", childPath, "Choose a supported predicate kind."); }
  });
}

/** Predicate validation state that is inherited by nested groups. */
interface GroupOptions { aliases: Map<string, SymbolInfo>; nested: boolean; outerScope: boolean; postFilter: boolean; propertyAllowed: boolean; }
/** A computed alias available to later validators. */
interface SymbolInfo { enabled: boolean; outputType: string; kind: QueryComputedColumn["kind"]; }

/** Validates a lookup comparison and its value references. */
function validateComparison(node: QueryComparisonNode, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], options: GroupOptions): void {
  const lhs = resolveValueRef(node.lhs, `${path}/lhs`, model, context, options.aliases, issues);
  if (!(MODEL_QUERY_LOOKUPS as readonly string[]).includes(node.lookup)) { add(issues, "LOOKUP_UNSUPPORTED", `${path}/lookup`, "Choose a supported lookup.", node.nodeId); }
  if (lhs && lhs.leafKind === "relation" && node.lookup !== "isnull") { add(issues, "FIELD_PATH_RELATION_TERMINAL", `${path}/lhs/path`, "Select a scalar field or use is null.", node.nodeId); }
  if (lhs && !lookupAllowed(lhs.type, node.lookup)) { add(issues, "LOOKUP_TYPE_MISMATCH", `${path}/lookup`, "Choose a lookup supported by this field type.", node.nodeId); }
  if (lhs?.leafKind === "property") { validateProperty(node, path, context, issues, options); }
  validateRhs(node, path, model, context, issues, options, lhs);
}

/** Resolves a field or enabled computed alias reference. */
function resolveValueRef(ref: unknown, path: string, model: QueryModelRef, context: ModelQueryValidationContext, aliases: Map<string, SymbolInfo>, issues: ModelQueryIssue[]): QueryResolvedPath | undefined {
  if (!isRecord(ref)) { add(issues, "RECIPE_SHAPE_INVALID", path, "Choose a field or computed value."); return undefined; }
  if (ref.kind === "computed") {
    if (typeof ref.alias !== "string" || !aliases.has(ref.alias)) { add(issues, "COMPUTED_REFERENCE_UNKNOWN", `${path}/alias`, "Choose an enabled computed column."); return undefined; }
    const symbol = aliases.get(ref.alias)!;
    return { leafKind: "field", nullable: true, path: ref.alias, relationTerminal: false, toMany: false, type: symbol.outputType };
  }
  if (ref.kind !== "field" || typeof ref.path !== "string") { add(issues, "RECIPE_SHAPE_INVALID", path, "Choose a field path."); return undefined; }
  return resolvePath(ref.path, path, model, context, issues);
}

/** Resolves one metadata-backed path and reports all deterministic path errors. */
function resolvePath(pathValue: string, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[]): QueryResolvedPath | undefined {
  if (pathValue.length > MODEL_QUERY_RECIPE_LIMITS.pathCharacters || pathValue.trim().split("__").length > MODEL_QUERY_RECIPE_LIMITS.pathSegments) { add(issues, "FIELD_PATH_TOO_LONG", path, "Use a shorter field path."); return undefined; }
  if (!context.metadata.getTree(model)) { add(issues, "FIELD_METADATA_UNAVAILABLE", path, "Reload field metadata."); return undefined; }
  const resolved = context.metadata.resolvePath(model, pathValue);
  if (!resolved) { add(issues, "FIELD_PATH_INVALID", path, "Choose a field from the model tree."); }
  return resolved;
}

/** Validates RHS form, scalar content, and RHS field scope. */
function validateRhs(node: QueryComparisonNode, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], options: GroupOptions, lhs: QueryResolvedPath | undefined): void {
  if (!isRecord(node.rhs) || typeof node.rhs.kind !== "string") { add(issues, "RECIPE_SHAPE_INVALID", `${path}/rhs`, "Provide a comparison value.", node.nodeId); return; }
  const rhs = node.rhs;
  const noValue = node.lookup === "blank" || node.lookup === "not_blank";
  if (node.lookup === "in") {
    if (rhs.kind !== "list" || !Array.isArray(rhs.values)) { add(issues, "RHS_KIND_UNSUPPORTED", `${path}/rhs`, "Use a list value for in.", node.nodeId); }
    else { if (!rhs.values.length) { add(issues, "VALUE_REQUIRED", `${path}/rhs/values`, "Enter at least one value.", node.nodeId); } if (rhs.values.length > MODEL_QUERY_RECIPE_LIMITS.inValues) { add(issues, "IN_LIST_LIMIT", `${path}/rhs/values`, "Use at most 200 values.", node.nodeId); } rhs.values.forEach((value, index) => validateScalar(value, `${path}/rhs/values/${index}`, issues, node.nodeId)); }
    return;
  }
  if (node.lookup === "range") { if (rhs.kind !== "range") { add(issues, "RHS_KIND_UNSUPPORTED", `${path}/rhs`, "Use a lower and upper range.", node.nodeId); } else { validateScalar(rhs.lower, `${path}/rhs/lower`, issues, node.nodeId); validateScalar(rhs.upper, `${path}/rhs/upper`, issues, node.nodeId); } return; }
  if (node.lookup === "isnull") { if (rhs.kind !== "literal" || typeof rhs.value !== "boolean") { add(issues, "RHS_TYPE_MISMATCH", `${path}/rhs`, "Use true or false for is null.", node.nodeId); } return; }
  if (noValue) { if (rhs.kind !== "literal") { add(issues, "RHS_KIND_UNSUPPORTED", `${path}/rhs`, "Use the automatic blank value.", node.nodeId); } return; }
  if (rhs.kind === "literal") { validateScalar(rhs.value, `${path}/rhs/value`, issues, node.nodeId); }
  else if (rhs.kind === "field") { const right = resolvePath(rhs.path, `${path}/rhs/path`, model, context, issues); if (lhs && right && !compatibleTypes(lhs.type, right.type)) { add(issues, "RHS_TYPE_MISMATCH", `${path}/rhs/path`, "Compare compatible field types.", node.nodeId); } }
  else if (rhs.kind === "outerField") { if (!options.outerScope) { add(issues, "OUTER_REF_SCOPE_INVALID", `${path}/rhs/path`, "Use outer fields only inside a subquery.", node.nodeId); } else { resolvePath(rhs.path, `${path}/rhs/path`, context.source, context, issues); } }
  else if (rhs.kind === "relativeTime") { validateRelativeTime(rhs, path, lhs, issues, node.nodeId); }
  else { add(issues, "RHS_KIND_UNSUPPORTED", `${path}/rhs`, "Use a supported value form.", node.nodeId); }
}

/** Checks that a scalar is JSON-safe and within per-string limits. */
function validateScalar(value: unknown, path: string, issues: ModelQueryIssue[], nodeId?: string): void { if (!(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) { add(issues, "VALUE_INVALID", path, "Enter a JSON scalar value.", nodeId); } else if (typeof value === "string" && value.length > MODEL_QUERY_RECIPE_LIMITS.literalStringCharacters) { add(issues, "VALUE_INVALID", path, "Shorten the value to 4096 characters.", nodeId); } }

/** Checks relative-time domain and field compatibility. */
function validateRelativeTime(rhs: Record<string, unknown>, path: string, lhs: QueryResolvedPath | undefined, issues: ModelQueryIssue[], nodeId?: string): void { if (!Number.isInteger(rhs.amount) || (rhs.amount as number) < 1 || (rhs.amount as number) > 10000 || !["now", "today"].includes(String(rhs.anchor)) || !["past", "future"].includes(String(rhs.direction)) || !["minutes", "hours", "days", "weeks"].includes(String(rhs.unit)) || (lhs && (isTime(lhs.type) || (isDate(lhs.type) && rhs.anchor === "now")))) { add(issues, "RELATIVE_TIME_INVALID", `${path}/rhs`, "Use 1–10000 units and a time-compatible anchor.", nodeId); } }

/** Enforces the limited safe context for Python @property filtering. */
function validateProperty(node: QueryComparisonNode, path: string, context: ModelQueryValidationContext, issues: ModelQueryIssue[], options: GroupOptions): void { if (context.source !== context.source || !options.propertyAllowed || options.nested || options.postFilter || options.outerScope || !["literal", "list", "range"].includes(node.rhs.kind)) { add(issues, options.postFilter ? "PYTHON_PROPERTY_SUMMARY_UNSUPPORTED" : "PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED", path, "Use this property as a direct root AND condition only.", node.nodeId); } else { add(issues, "PYTHON_PROPERTY_FULL_SCAN", path, "This property filter scans loaded rows.", node.nodeId, "warning"); } }

/** Validates EXISTS source, correlation, and inner predicate scope. */
function validateExistsPredicate(node: Record<string, unknown>, path: string, outerModel: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], aliases: Map<string, SymbolInfo>): void {
  const nodeId = typeof node.nodeId === "string" ? node.nodeId : undefined;
  const inner = validateSubquerySource(node.source, `${path}/source`, outerModel, context, issues, nodeId);
  validateCorrelations(node.source, node.correlations, `${path}/correlations`, outerModel, inner, context, issues, nodeId);
  if (inner && isGroup(node.where)) { validateGroup(node.where, `${path}/where`, inner, context, issues, { aliases, nested: false, outerScope: true, propertyAllowed: false, postFilter: false }); } else { add(issues, "RECIPE_SHAPE_INVALID", `${path}/where`, "Provide an EXISTS condition group.", nodeId); }
}

/** Validates computed columns in declaration order while constructing the alias symbol table. */
function validateComputed(recipe: ModelQueryRecipeV2, context: ModelQueryValidationContext, issues: ModelQueryIssue[]): Map<string, SymbolInfo> {
  const symbols = new Map<string, SymbolInfo>();
  const declarations = new Map(recipe.computed.filter(isRecord).map((computed, index) => [typeof computed.alias === "string" ? computed.alias : "", { enabled: computed.enabled === true, index }]));
  const concrete = new Set(context.columns.flatMap((column) => [column.attname, column.name]));
  for (const relation of context.metadata.getTree(context.source)?.relations ?? []) { concrete.add(relation.name); if (relation.filterField) { concrete.add(relation.filterField); } }
  recipe.computed.forEach((computed, index) => {
    const path = `/computed/${index}`;
    if (!isRecord(computed)) { add(issues, "RECIPE_SHAPE_INVALID", path, "Restore this computed column."); return; }
    validateAlias(computed, path, concrete, symbols, issues);
    if (computed.kind === "aggregate") { validateAggregate(computed, path, context.source, context, issues, symbols); }
    else if (computed.kind === "scalarSubquery") { validateScalarSubquery(computed, path, context.source, context, issues, symbols); }
    else if (computed.kind === "exists") { validateExistsPredicate(computed as unknown as Record<string, unknown>, path, context.source, context, issues, symbols); }
    else if (computed.kind === "formula") { validateFormula(computed.expression, `${path}/expression`, context.source, context, issues, symbols, 1, { count: 0 }, declarations, index); if (!(MODEL_QUERY_OUTPUT_TYPES as readonly string[]).includes(computed.outputType)) { add(issues, "OUTPUT_TYPE_REQUIRED", `${path}/outputType`, "Choose a formula output type.", computed.nodeId); } }
    else if (computed.kind === "window") { if (!(MODEL_QUERY_WINDOW_FUNCTIONS as readonly string[]).includes(computed.function)) { add(issues, "RECIPE_SHAPE_INVALID", `${path}/function`, "Choose a supported window function.", computed.nodeId); } if (!computed.orderBy.length) { add(issues, "WINDOW_ORDER_REQUIRED", `${path}/orderBy`, "Add a window order term.", computed.nodeId); } validateOrder(computed.orderBy, `${path}/orderBy`, context.source, context, symbols, issues, false); computed.partitionBy.forEach((field, child) => resolvePath(field.path, `${path}/partitionBy/${child}/path`, context.source, context, issues)); }
    else if (computed.kind === "codeExpression") { validateCode(computed, path, context, issues); validateGroup(computed.when, `${path}/when`, context.source, context, issues, { aliases: symbols, nested: false, outerScope: false, propertyAllowed: false, postFilter: false }); }
    if (computed.enabled && validAlias(computed.alias) && !concrete.has(computed.alias) && !symbols.has(computed.alias)) { symbols.set(computed.alias, { enabled: true, outputType: computedOutputType(computed), kind: computed.kind }); }
  });
  return symbols;
}

/** Enforces alias syntax, reserved prefixes, source collisions, and enabled duplication. */
function validateAlias(computed: QueryComputedColumn, path: string, concrete: Set<string>, symbols: Map<string, SymbolInfo>, issues: ModelQueryIssue[]): void { const alias = computed.alias; if (!validAlias(alias)) { add(issues, "ALIAS_INVALID", `${path}/alias`, "Use a Python identifier up to 64 characters.", computed.nodeId); } else if (alias.startsWith("djs_") || alias.startsWith("__") || PYTHON_KEYWORDS.has(alias)) { add(issues, "ALIAS_RESERVED", `${path}/alias`, "Choose a non-reserved alias.", computed.nodeId); } else if (concrete.has(alias)) { add(issues, "ALIAS_COLLISION", `${path}/alias`, "Choose an alias not used by a field or relation.", computed.nodeId); } else if (computed.enabled && symbols.has(alias)) { add(issues, "ALIAS_DUPLICATE", `${path}/alias`, "Choose a unique enabled alias.", computed.nodeId); } }

/** Validates an aggregate annotation and its filter tree. */
function validateAggregate(computed: Extract<QueryComputedColumn, { kind: "aggregate" }>, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], symbols: Map<string, SymbolInfo>): void { if (!(MODEL_QUERY_AGGREGATE_FUNCTIONS as readonly string[]).includes(computed.function)) { add(issues, "RECIPE_SHAPE_INVALID", `${path}/function`, "Choose a supported aggregate.", computed.nodeId); } if (computed.function !== "count" && computed.field.kind === "all") { add(issues, "AGGREGATE_FIELD_REQUIRED", `${path}/field`, "Choose a scalar field for this aggregate.", computed.nodeId); } if (computed.field.kind === "field") { const field = resolvePath(computed.field.path, `${path}/field/path`, model, context, issues); if (field?.toMany && computed.function !== "count") { add(issues, "AGGREGATE_FANOUT_UNSAFE", `${path}/field/path`, "Use Count or a non-to-many field.", computed.nodeId); } if (field?.toMany && computed.function === "count") { add(issues, "AUTO_DISTINCT_APPLIED", `${path}/field/path`, "Count will use distinct for this to-many path.", computed.nodeId, "warning"); } } validateGroup(computed.filter, `${path}/filter`, model, context, issues, { aliases: symbols, nested: false, outerScope: false, propertyAllowed: false, postFilter: false }); }

/** Validates a scalar subquery annotation including source, select, order, and correlation. */
function validateScalarSubquery(computed: Extract<QueryComputedColumn, { kind: "scalarSubquery" }>, path: string, outer: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], symbols: Map<string, SymbolInfo>): void { const inner = validateSubquerySource(computed.source, `${path}/source`, outer, context, issues, computed.nodeId); validateCorrelations(computed.source, computed.correlations, `${path}/correlations`, outer, inner, context, issues, computed.nodeId); if (inner) { validateGroup(computed.where, `${path}/where`, inner, context, issues, { aliases: symbols, nested: false, outerScope: true, propertyAllowed: false, postFilter: false }); if (computed.select.kind === "field") { resolvePath(computed.select.field.path, `${path}/select/field/path`, inner, context, issues); } else if (computed.select.kind === "aggregate") { if (computed.select.function !== "count" && computed.select.field.kind === "all") { add(issues, "AGGREGATE_FIELD_REQUIRED", `${path}/select/field`, "Choose a scalar aggregate field.", computed.nodeId); } } else { add(issues, "SUBQUERY_SELECT_INVALID", `${path}/select`, "Choose a field or aggregate select.", computed.nodeId); } validateOrder(computed.orderBy, `${path}/orderBy`, inner, context, symbols, issues, false); } if (computed.orderBy.length > MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms) { add(issues, "SUBQUERY_ORDER_LIMIT", `${path}/orderBy`, "Use at most three subquery order terms.", computed.nodeId); } if (computed.select.kind === "field" && computed.orderBy.length === 0) { add(issues, "SUBQUERY_IMPLICIT_ORDER", `${path}/orderBy`, "Target primary-key ascending order will be used.", computed.nodeId, "warning"); } if (!(MODEL_QUERY_OUTPUT_TYPES as readonly string[]).includes(computed.outputType)) { add(issues, "OUTPUT_TYPE_REQUIRED", `${path}/outputType`, "Choose an output type.", computed.nodeId); } }

/** Resolves a subquery source into its target model. */
function validateSubquerySource(source: unknown, path: string, outer: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], nodeId?: string): QueryModelRef | undefined { if (!isRecord(source)) { add(issues, "SUBQUERY_SOURCE_INVALID", path, "Choose a relation or model source.", nodeId); return undefined; } if (source.kind === "model" && isRecord(source.target) && typeof source.target.app === "string" && typeof source.target.model === "string") { const target = { app: source.target.app, model: source.target.model }; if (!context.metadata.toBundle().catalog.some((item) => sameModel(item, target))) { add(issues, "SUBQUERY_SOURCE_INVALID", `${path}/target`, "Choose an installed model.", nodeId); } return target; } if (source.kind === "relation" && typeof source.relation === "string") { const relation = context.metadata.resolveRelation(outer, source.relation); if (!relation) { add(issues, "SUBQUERY_RELATION_INVALID", `${path}/relation`, "Choose a relation from the source model.", nodeId); return undefined; } return modelFromTarget(relation.target); } add(issues, "SUBQUERY_SOURCE_INVALID", path, "Choose a relation or model source.", nodeId); return undefined; }

/** Validates either metadata-derived relation correlation or explicit custom-model correlation pairs. */
function validateCorrelations(source: unknown, value: unknown, path: string, outer: QueryModelRef, inner: QueryModelRef | undefined, context: ModelQueryValidationContext, issues: ModelQueryIssue[], nodeId?: string): void {
  if (isRecord(source) && source.kind === "relation") { validateAutomaticRelationCorrelation(source, value, path, outer, inner, context, issues, nodeId); return; }
  if (!Array.isArray(value) || !value.length) { add(issues, "SUBQUERY_CORRELATION_REQUIRED", path, "Add a correlation to the outer query.", nodeId); return; }
  if (value.length > MODEL_QUERY_RECIPE_LIMITS.subqueryCorrelations) { add(issues, "SUBQUERY_CORRELATION_LIMIT", path, "Use at most four correlations.", nodeId); }
  value.forEach((item, index) => { if (!isRecord(item) || typeof item.outerPath !== "string" || typeof item.targetPath !== "string" || !inner) { add(issues, "SUBQUERY_CORRELATION_INVALID", `${path}/${index}`, "Choose valid outer and target fields.", nodeId); return; } const left = resolvePath(item.outerPath, `${path}/${index}/outerPath`, outer, context, issues); const right = resolvePath(item.targetPath, `${path}/${index}/targetPath`, inner, context, issues); if (left && right && !compatibleTypes(left.type, right.type)) { add(issues, "SUBQUERY_CORRELATION_INVALID", `${path}/${index}`, "Correlate compatible field types.", nodeId); } });
}

/** Validates the single metadata-backed outer-to-inner correlation required by a relation source. */
function validateAutomaticRelationCorrelation(source: Record<string, unknown>, value: unknown, path: string, outer: QueryModelRef, inner: QueryModelRef | undefined, context: ModelQueryValidationContext, issues: ModelQueryIssue[], nodeId?: string): void {
  if (!Array.isArray(value) || value.length !== 0) { add(issues, "SUBQUERY_CORRELATION_INVALID", path, "Relation sources derive their connection automatically. Remove manual correlations.", nodeId); return; }
  const correlation = automaticRelationCorrelation(source, outer, context);
  if (!correlation || !inner) { add(issues, "SUBQUERY_CORRELATION_INVALID", path, "This relation does not provide a safe automatic connection.", nodeId); return; }
  const left = resolvePath(correlation.outerPath, `${path}/automatic/outerPath`, outer, context, issues);
  const right = resolvePath(correlation.targetPath, `${path}/automatic/targetPath`, inner, context, issues);
  if (left && right && !compatibleTypes(left.type, right.type)) { add(issues, "SUBQUERY_CORRELATION_INVALID", path, "This relation does not provide compatible automatic connection fields.", nodeId); }
}

/** Resolves the trusted automatic correlation contract exposed by one direct filter relation. */
function automaticRelationCorrelation(source: Record<string, unknown>, outer: QueryModelRef, context: ModelQueryValidationContext): { outerPath: string; targetPath: string } | undefined {
  if (typeof source.relation !== "string") { return undefined; }
  const relation = context.metadata.resolveRelation(outer, source.relation);
  if (!relation?.filterField || !relation.outerField) { return undefined; }
  return { outerPath: relation.outerField, targetPath: relation.filterField };
}

/** Validates formula nodes and their computed references in declaration order. */
function validateFormula(node: QueryFormulaNode, path: string, model: QueryModelRef, context: ModelQueryValidationContext, issues: ModelQueryIssue[], symbols: Map<string, SymbolInfo>, depth: number, count: { count: number }, declarations: Map<string, { enabled: boolean; index: number }>, currentIndex: number): void { count.count += 1; if (count.count > MODEL_QUERY_RECIPE_LIMITS.formulaNodes) { add(issues, "FORMULA_NODE_LIMIT", path, "Remove formula nodes."); } if (depth > MODEL_QUERY_RECIPE_LIMITS.formulaDepth) { add(issues, "FORMULA_DEPTH_LIMIT", path, "Flatten the formula."); } if (node.kind === "field") { resolvePath(node.path, `${path}/path`, model, context, issues); } else if (node.kind === "computed") { if (!symbols.has(node.alias)) { const declaration = declarations.get(node.alias); add(issues, !declaration ? "COMPUTED_REFERENCE_UNKNOWN" : !declaration.enabled ? "COMPUTED_REFERENCE_DISABLED" : declaration.index >= currentIndex ? "COMPUTED_REFERENCE_FORWARD" : "COMPUTED_REFERENCE_UNKNOWN", `${path}/alias`, "Reference an earlier enabled computed alias."); } } else if (node.kind === "literal") { validateScalar(node.value, `${path}/value`, issues); } else if (node.kind === "binary") { validateFormula(node.left, `${path}/left`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex); validateFormula(node.right, `${path}/right`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex); if (node.operator === "/" && node.right.kind === "literal" && node.right.value === 0) { add(issues, "FORMULA_DIVIDE_BY_ZERO", `${path}/right`, "Use a non-zero divisor."); } } else if (node.kind === "function") { if (!(MODEL_QUERY_FORMULA_FUNCTIONS as readonly string[]).includes(node.function)) { add(issues, "FORMULA_TYPE_MISMATCH", `${path}/function`, "Choose a supported formula function."); } node.args.forEach((arg, index) => validateFormula(arg, `${path}/args/${index}`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex)); } else if (node.kind === "case") { if (node.branches.length > MODEL_QUERY_RECIPE_LIMITS.caseBranches) { add(issues, "FORMULA_NODE_LIMIT", `${path}/branches`, "Use at most eight Case branches."); } node.branches.forEach((branch, index) => { validateGroup(branch.when, `${path}/branches/${index}/when`, model, context, issues, { aliases: symbols, nested: false, outerScope: false, propertyAllowed: false, postFilter: false }); validateFormula(branch.then, `${path}/branches/${index}/then`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex); }); validateFormula(node.else, `${path}/else`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex); } else if (node.kind === "cast") { validateFormula(node.expression, `${path}/expression`, model, context, issues, symbols, depth + 1, count, declarations, currentIndex); } }

/** Validates restricted raw code expressions before later backend validation. */
function validateCode(computed: Extract<QueryComputedColumn, { kind: "codeExpression" }>, path: string, context: ModelQueryValidationContext, issues: ModelQueryIssue[]): void { if (!computed.expression.trim() || computed.expression.length > MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters || /(__import__|\bimport\b|\beval\b|\bexec\b)/.test(computed.expression)) { add(issues, "RAW_EXPRESSION_INVALID", `${path}/expression`, "Use a short restricted Django expression.", computed.nodeId); } if (context.transport !== "orm") { add(issues, "RAW_EXPRESSION_TRANSPORT_UNSUPPORTED", path, "Use ORM transport for code expressions.", computed.nodeId); } }

/** Enforces mutually exclusive rows and summary result-mode constraints. */
function validateMode(recipe: ModelQueryRecipeV2, context: ModelQueryValidationContext, symbols: Map<string, SymbolInfo>, issues: ModelQueryIssue[]): void { if (recipe.mode === "rows") { if (recipe.groupBy.length) { add(issues, "COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY", "/groupBy", "Clear group by in rows mode."); } return; } const enabled = recipe.computed.filter((computed) => computed.enabled); if (!enabled.length || enabled.some((computed) => computed.kind !== "aggregate")) { add(issues, "COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY", "/computed", "Summary mode requires at least one enabled aggregate."); } if (!recipe.groupBy.length && recipe.postFilter.children.length) { add(issues, "GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED", "/postFilter", "Clear result filters for a global summary."); } recipe.groupBy.forEach((field, index) => { const resolved = resolvePath(field.path, `/groupBy/${index}/path`, context.source, context, issues); if (resolved?.toMany) { add(issues, "FIELD_PATH_TO_MANY_UNSAFE", `/groupBy/${index}/path`, "Choose a non-to-many group field."); } }); if (recipe.groupBy.length > MODEL_QUERY_RECIPE_LIMITS.groupByFields) { add(issues, "FIELD_PATH_TO_MANY_UNSAFE", "/groupBy", "Use at most eight group fields."); } if (recipe.groupBy.length) { validateGroupedPostFilter(recipe.postFilter, symbols, issues); } }

/** Limits grouped-summary postfilter LHS to aggregates and group fields. */
function validateGroupedPostFilter(group: QueryPredicateGroup, symbols: Map<string, SymbolInfo>, issues: ModelQueryIssue[]): void { const visit = (item: QueryPredicateNode, path: string): void => { if (item.kind === "group") { item.children.forEach((child, index) => visit(child, `${path}/children/${index}`)); } else if (item.kind === "comparison" && item.lhs.kind === "computed" && symbols.get(item.lhs.alias)?.kind !== "aggregate") { add(issues, "COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY", `${path}/lhs`, "Filter grouped summaries by an aggregate alias or group field.", item.nodeId); } }; visit(group, "/postFilter"); }

/** Validates a stable ordered list of field or computed references. */
function validateOrder(terms: QueryOrderTerm[], path: string, model: QueryModelRef, context: ModelQueryValidationContext, symbols: Map<string, SymbolInfo>, issues: ModelQueryIssue[], allowToMany: boolean): void { if (terms.length > MODEL_QUERY_RECIPE_LIMITS.outerOrderTerms && path === "/orderBy") { add(issues, "FIELD_PATH_TO_MANY_UNSAFE", path, "Use at most eight order terms."); } const seen = new Set<string>(); terms.forEach((term, index) => { if (term.direction !== "asc" && term.direction !== "desc") { add(issues, "RECIPE_SHAPE_INVALID", `${path}/${index}/direction`, "Choose ascending or descending.", term.nodeId); } const key = term.ref.kind === "computed" ? `computed:${term.ref.alias}` : `field:${term.ref.path}`; if (seen.has(key)) { add(issues, "RECIPE_SHAPE_INVALID", `${path}/${index}/ref`, "Use each order reference only once.", term.nodeId); } seen.add(key); const resolved = resolveValueRef(term.ref, `${path}/${index}/ref`, model, context, symbols, issues); if (resolved?.toMany && !allowToMany) { add(issues, "FIELD_PATH_TO_MANY_UNSAFE", `${path}/${index}/ref`, "Choose a non-to-many order field.", term.nodeId); } }); }

/** Performs transport capability checks that do not compile or execute a query. */
function validateTransport(recipe: ModelQueryRecipeV2, context: ModelQueryValidationContext, issues: ModelQueryIssue[]): void { if (context.transport === "none") { add(issues, "TRANSPORT_CAPABILITY_UNSUPPORTED", "", "Connect a Django shell transport."); } if (recipe.computed.some((computed) => computed.kind === "codeExpression") && context.transport !== "orm") { return; } }

/** Normalizes an optionally omitted root group. */
function normalizeGroup(value: unknown, rootId: "where-root" | "post-root"): QueryPredicateGroup | undefined { if (!isRecord(value)) { return undefined; } const clone = deepClone(value) as QueryPredicateGroup; clone.nodeId = rootId; return clone; }

/** Trims path and alias boundaries without changing casing or identifiers. */
function trimRecipeStrings(recipe: ModelQueryRecipeV2): void { const trimRef = (ref: QueryValueRef): void => { if (ref.kind === "field") { ref.path = ref.path.trim(); } else { ref.alias = ref.alias.trim(); } }; const trimGroup = (group: QueryPredicateGroup): void => { for (const node of group.children) { if (node.kind === "group") { trimGroup(node); } else if (node.kind === "comparison") { trimRef(node.lhs); if (node.rhs.kind === "field" || node.rhs.kind === "outerField") { node.rhs.path = node.rhs.path.trim(); } } } }; trimGroup(recipe.where); trimGroup(recipe.postFilter); recipe.groupBy.forEach(trimRef); recipe.orderBy.forEach((term) => trimRef(term.ref)); recipe.computed.forEach((computed) => { computed.alias = computed.alias.trim(); }); }

/** Changes blank lookup RHS values to their canonical ignored literal representation. */
function normalizeBlankRhs(group: QueryPredicateGroup): void { for (const node of group.children) { if (node.kind === "group") { normalizeBlankRhs(node); } else if (node.kind === "comparison" && (node.lookup === "blank" || node.lookup === "not_blank")) { node.rhs = { kind: "literal", value: null }; } } }

/** Normalizes nested predicate trees owned by one computed column. */
function normalizeComputed(computed: QueryComputedColumn): void { if ("where" in computed) { normalizeBlankRhs(computed.where); } if (computed.kind === "aggregate") { normalizeBlankRhs(computed.filter); } if (computed.kind === "codeExpression") { normalizeBlankRhs(computed.when); } }

/** Uses JSON serialization for recipes, whose contract excludes non-JSON values. */
function deepClone(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }

/** Checks unknown values as object records. */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Checks unknown values as predicate groups. */
function isGroup(value: unknown): value is QueryPredicateGroup { return isRecord(value) && value.kind === "group" && Array.isArray(value.children) && typeof value.nodeId === "string"; }
/** Compares two exact Django model identities. */
function sameModel(left: QueryModelRef, right: QueryModelRef): boolean { return left.app === right.app && left.model === right.model; }
/** Converts a backend relation target into a model reference. */
function modelFromTarget(value: string): QueryModelRef | undefined { const dot = value.indexOf("."); return dot > 0 && dot < value.length - 1 ? { app: value.slice(0, dot), model: value.slice(dot + 1) } : undefined; }
/** Returns encoded UTF-8 byte count. */
function utf8Bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
/** Validates the immutable alias character contract. */
function validAlias(value: string): boolean { return value.length <= MODEL_QUERY_RECIPE_LIMITS.aliasCharacters && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value); }
/** Gives a conservative output type for downstream lookup validation. */
function computedOutputType(value: QueryComputedColumn): string { if (value.kind === "exists") { return "boolean"; } return "outputType" in value ? value.outputType : "auto"; }
/** Checks lookup support for a backend Django field category. */
function lookupAllowed(type: string, lookup: string): boolean { if (!(MODEL_QUERY_LOOKUPS as readonly string[]).includes(lookup)) { return false; } if (lookup === "blank" || lookup === "not_blank" || lookup.startsWith("length") || lookup === "trim") { return isText(type); } if (["date", "year", "quarter", "month", "week_day", "day"].includes(lookup)) { return isDate(type) || isDateTime(type); } if (["hour", "minute", "second"].includes(lookup)) { return isDateTime(type) || isTime(type); } if (isBoolean(type)) { return lookup === "exact" || lookup === "isnull"; } if (isNumeric(type)) { return !["iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith"].includes(lookup); } return true; }
/** Determines whether two recipe-facing field types may be compared directly. */
function compatibleTypes(left: string, right: string): boolean { return (isNumeric(left) && isNumeric(right)) || (isText(left) && isText(right)) || (isBoolean(left) && isBoolean(right)) || (isDate(left) && isDate(right)) || (isDateTime(left) && isDateTime(right)) || (isTime(left) && isTime(right)) || left === right; }
/** Checks text-like Django type names. */
function isText(type: string): boolean { return /(CharField|TextField|SlugField|EmailField|URLField|FileField|UUIDField|GenericIPAddressField|DurationField|text)/i.test(type); }
/** Checks numeric Django type names. */
function isNumeric(type: string): boolean { return /(Integer|AutoField|Decimal|Float|Positive|SmallInteger|BigInteger|numeric|integer|float|decimal)/i.test(type); }
/** Checks Boolean type names. */
function isBoolean(type: string): boolean { return /Boolean|boolean/i.test(type); }
/** Checks DateTime type names. */
function isDateTime(type: string): boolean { return /DateTime|datetime/i.test(type); }
/** Checks Date (but not DateTime) type names. */
function isDate(type: string): boolean { return /DateField|^date$/i.test(type); }
/** Checks Time type names. */
function isTime(type: string): boolean { return /TimeField|^time$/i.test(type) && !isDateTime(type); }

/** Python keywords disallowed as annotation aliases. */
const PYTHON_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
