// Deterministic migration of legacy model-browser query payloads into Recipe v2.

import type { BackendModelFilter, BackendModelOrder, ModelAnnotationSpec, ModelConditionGroup, ModelConditionTerm } from "./modelBackend";
import { createEmptyModelQueryRecipe, type ModelQueryRecipeV2, type QueryComparisonRhs, type QueryComputedColumn, type QueryFormulaNode, type QueryModelRef, type QueryOrderTerm, type QueryPredicateGroup, type QueryPredicateNode } from "./modelQueryRecipe";

/** A non-silent finding emitted when one legacy item cannot be represented by Recipe v2. */
export interface LegacyQueryAdapterIssue { code: "LEGACY_ANNOTATION_MALFORMED" | "LEGACY_ANNOTATION_UNSUPPORTED" | "LEGACY_FILTER_MALFORMED" | "LEGACY_GROUP_BY_MALFORMED" | "LEGACY_ORDER_MALFORMED"; index: number; message: string; path: string; }
/** Conversion result for one legacy filter array. */
export interface LegacyFilterConversion { issues: LegacyQueryAdapterIssue[]; where: QueryPredicateGroup; }
/** Conversion result for one legacy annotation array. */
export interface LegacyAnnotationConversion { computed: QueryComputedColumn[]; issues: LegacyQueryAdapterIssue[]; }
/** Complete legacy query input accepted during the one-release migration period. */
export interface LegacyModelQueryInput { annotations?: ModelAnnotationSpec[]; filters?: BackendModelFilter[]; groupBy?: string[]; order?: BackendModelOrder[]; source: QueryModelRef; }
/** Complete Recipe v2 migration result, including every conversion finding. */
export interface LegacyModelQueryConversion { issues: LegacyQueryAdapterIssue[]; recipe: ModelQueryRecipeV2; }

/** Converts legacy flat filters into the Recipe v2 root AND group. */
export function legacyFiltersToWhere(filters: BackendModelFilter[] | undefined): LegacyFilterConversion {
  const issues: LegacyQueryAdapterIssue[] = [];
  const children: QueryPredicateNode[] = [];
  for (const [index, filter] of (filters ?? []).entries()) {
    const path = `/filters/${index}`;
    if (!filter || !nonEmptyString(filter.field) || !nonEmptyString(filter.lookup)) {
      issues.push(issue("LEGACY_FILTER_MALFORMED", index, path, "A legacy filter needs a field and lookup."));
      continue;
    }
    const rhs = legacyRhs(filter.lookup, filter.value);
    if (!rhs) {
      issues.push(issue("LEGACY_FILTER_MALFORMED", index, path, "The legacy filter value is not a JSON scalar, list, or two-value range."));
      continue;
    }
    children.push({ kind: "comparison", lhs: { kind: "field", path: filter.field }, lookup: filter.lookup, negated: Boolean(filter.negate), nodeId: `legacy-filter-${index + 1}`, rhs });
  }
  return { issues, where: { children, join: "and", kind: "group", negated: false, nodeId: "where-root" } };
}

/** Converts legacy annotation specifications into Recipe v2 computed columns. */
export function legacyAnnotationsToComputed(annotations: ModelAnnotationSpec[] | undefined): LegacyAnnotationConversion {
  const issues: LegacyQueryAdapterIssue[] = [];
  const computed: QueryComputedColumn[] = [];
  for (const [index, annotation] of (annotations ?? []).entries()) {
    const path = `/annotations/${index}`;
    const converted = legacyAnnotation(annotation, index, issues);
    if (converted) { computed.push(converted); }
    else if (annotation && isSupportedLegacyAnnotationKind(annotation.kind)) { issues.push(issue("LEGACY_ANNOTATION_MALFORMED", index, path, `Legacy ${annotation.kind} annotation is missing a required field or has an invalid value.`)); }
    else if (annotation && nonEmptyString(annotation.kind)) { issues.push(issue("LEGACY_ANNOTATION_UNSUPPORTED", index, path, `Legacy annotation kind '${annotation.kind}' cannot be represented by Recipe v2.`)); }
    else { issues.push(issue("LEGACY_ANNOTATION_MALFORMED", index, path, "A legacy annotation needs a kind and valid fields.")); }
  }
  return { computed, issues };
}

/** Converts one full legacy browser query into the authoritative Recipe v2 shape. */
export function legacyQueryToRecipe(input: LegacyModelQueryInput): LegacyModelQueryConversion {
  const recipe = createEmptyModelQueryRecipe(input.source);
  const filters = legacyFiltersToWhere(input.filters);
  const annotations = legacyAnnotationsToComputed(input.annotations);
  const order = legacyOrderToRecipe(input.order);
  const groupBy = legacyGroupBy(input.groupBy);
  recipe.where = filters.where;
  recipe.computed = annotations.computed;
  recipe.groupBy = groupBy.groupBy;
  recipe.orderBy = order.orderBy;
  return { issues: [...filters.issues, ...annotations.issues, ...groupBy.issues, ...order.issues], recipe };
}

/** Converts one legacy annotation only when every required field is representable. */
function legacyAnnotation(annotation: ModelAnnotationSpec | undefined, index: number, issues: LegacyQueryAdapterIssue[]): QueryComputedColumn | undefined {
  if (!annotation || !nonEmptyString(annotation.kind) || !nonEmptyString(annotation.alias)) { return undefined; }
  const nodeId = `legacy-computed-${index + 1}`;
  if (annotation.kind === "aggregate") { return legacyAggregate(annotation, nodeId, index, issues); }
  if (annotation.kind === "annotate") { return legacyCodeExpression(annotation, nodeId, index, issues); }
  if (annotation.kind === "subquery") { return legacyScalarSubquery(annotation, nodeId, index, issues); }
  if (annotation.kind === "window") { return legacyWindow(annotation, nodeId, index, issues); }
  if (annotation.kind === "expr") { return legacyFormula(annotation, nodeId); }
  return undefined;
}

/** Converts a legacy aggregate annotation and its flat condition group. */
function legacyAggregate(annotation: ModelAnnotationSpec, nodeId: string, index: number, issues: LegacyQueryAdapterIssue[]): QueryComputedColumn | undefined {
  if (!nonEmptyString(annotation.func)) { return undefined; }
  const filter = legacyConditions(annotation.conditions, `/annotations/${index}/conditions`, issues, false);
  if (!filter) { return undefined; }
  const field = annotation.field === undefined || annotation.field === null || annotation.field === "" || annotation.field === "*" ? { kind: "all" as const } : { kind: "field" as const, path: annotation.field };
  return { alias: annotation.alias as string, distinct: annotation.distinct ? "always" : "auto", enabled: true, field, filter, function: annotation.func as "count" | "sum" | "avg" | "min" | "max", kind: "aggregate", nodeId };
}

/** Converts a legacy raw annotate expression into the Recipe v2 restricted code-expression form. */
function legacyCodeExpression(annotation: ModelAnnotationSpec, nodeId: string, index: number, issues: LegacyQueryAdapterIssue[]): QueryComputedColumn | undefined {
  if (!nonEmptyString(annotation.expression)) { return undefined; }
  const when = legacyConditions(annotation.conditions, `/annotations/${index}/conditions`, issues, false);
  if (!when) { return undefined; }
  return { alias: annotation.alias as string, enabled: true, expression: annotation.expression as string, kind: "codeExpression", nodeId, outputType: "auto", when };
}

/** Converts a legacy scalar subquery, preserving direct-relation auto-correlation and custom-model correlations. */
function legacyScalarSubquery(annotation: ModelAnnotationSpec, nodeId: string, index: number, issues: LegacyQueryAdapterIssue[]): QueryComputedColumn | undefined {
  if (!nonEmptyString(annotation.field)) { return undefined; }
  const source = legacySubquerySource(annotation);
  if (!source) { return undefined; }
  const where = legacyConditions(annotation.conditions, `/annotations/${index}/conditions`, issues, true);
  if (!where) { return undefined; }
  const correlations = source.kind === "relation" ? [] : legacyCorrelations(annotation, index, issues);
  if (!correlations) { return undefined; }
  const order = legacyOrderToRecipe(annotation.orderBy, `/annotations/${index}/orderBy`);
  issues.push(...order.issues);
  return {
    alias: annotation.alias as string,
    correlations,
    enabled: true,
    kind: "scalarSubquery",
    nodeId,
    onEmpty: { kind: "literal", value: null },
    orderBy: order.orderBy,
    outputType: "auto",
    select: { field: { kind: "field", path: annotation.field }, kind: "field" },
    source,
    where
  };
}

/** Converts a legacy window specification. */
function legacyWindow(annotation: ModelAnnotationSpec, nodeId: string, index: number, issues: LegacyQueryAdapterIssue[]): QueryComputedColumn | undefined {
  if (!nonEmptyString(annotation.func)) { return undefined; }
  const order = legacyOrderToRecipe(annotation.orderBy, `/annotations/${index}/orderBy`);
  issues.push(...order.issues);
  return {
    alias: annotation.alias as string,
    enabled: true,
    field: nonEmptyString(annotation.field) && annotation.field !== "*" ? { kind: "field", path: annotation.field } : undefined,
    function: annotation.func as "rank" | "dense_rank" | "row_number" | "sum" | "avg" | "min" | "max" | "count",
    kind: "window",
    nodeId,
    orderBy: order.orderBy,
    partitionBy: (annotation.partitionBy ?? []).filter(nonEmptyString).map((path) => ({ kind: "field", path }))
  };
}

/** Converts a legacy binary F-expression into a Recipe v2 Formula tree. */
function legacyFormula(annotation: ModelAnnotationSpec, nodeId: string): QueryComputedColumn | undefined {
  if (!nonEmptyString(annotation.op) || !["+", "-", "*", "/", "%"].includes(annotation.op)) { return undefined; }
  const left = legacyFormulaOperand(annotation.left);
  const right = legacyFormulaOperand(annotation.right);
  if (!left || !right) { return undefined; }
  return { alias: annotation.alias as string, enabled: true, expression: { kind: "binary", left, operator: annotation.op as "+" | "-" | "*" | "/" | "%", right }, kind: "formula", nodeId, outputType: "auto" };
}

/** Converts a legacy formula operand without guessing whether a non-numeric string is a field. */
function legacyFormulaOperand(value: string | number | undefined): QueryFormulaNode | undefined {
  if (typeof value === "number" && Number.isFinite(value)) { return { kind: "literal", value }; }
  if (typeof value !== "string") { return undefined; }
  const text = value.trim();
  if (!text) { return undefined; }
  const numeric = Number(text);
  return Number.isFinite(numeric) && text !== "" ? { kind: "literal", value: numeric } : { kind: "field", path: text };
}

/** Converts legacy all/any conditions, retaining outer references only within subquery predicates. */
function legacyConditions(group: ModelConditionGroup | undefined, path: string, issues: LegacyQueryAdapterIssue[], allowOuter: boolean): QueryPredicateGroup | undefined {
  const nodeId = `legacy-${path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  if (!group) { return { children: [], join: "and", kind: "group", negated: false, nodeId }; }
  if (!Array.isArray(group.terms)) { return undefined; }
  const children: QueryPredicateNode[] = [];
  for (const [index, term] of group.terms.entries()) {
    const child = legacyCondition(term, `${path}/terms/${index}`, allowOuter);
    if (!child) { issues.push(issue("LEGACY_ANNOTATION_MALFORMED", index, `${path}/terms/${index}`, "A legacy condition needs a field, lookup, and representable right-hand side.")); continue; }
    children.push(child);
  }
  return { children, join: group.join === "any" ? "or" : "and", kind: "group", negated: false, nodeId };
}

/** Converts one legacy condition term into a comparison predicate. */
function legacyCondition(term: ModelConditionTerm | undefined, path: string, allowOuter: boolean): QueryPredicateNode | undefined {
  if (!term || !nonEmptyString(term.field) || !nonEmptyString(term.lookup) || !term.rhs) { return undefined; }
  let rhs: QueryComparisonRhs | undefined;
  if (term.rhs.kind === "value") { rhs = legacyRhs(term.lookup, term.rhs.value); }
  else if (term.rhs.kind === "field" && nonEmptyString(term.rhs.field)) { rhs = { kind: "field", path: term.rhs.field }; }
  else if (allowOuter && term.rhs.kind === "outer" && nonEmptyString(term.rhs.field)) { rhs = { kind: "outerField", path: term.rhs.field }; }
  if (!rhs) { return undefined; }
  return { kind: "comparison", lhs: { kind: "field", path: term.field }, lookup: term.lookup, negated: Boolean(term.negate), nodeId: `legacy-condition-${path.replace(/[^A-Za-z0-9]+/g, "-")}`, rhs };
}

/** Converts a legacy subquery source into a direct relation or explicit app/model source. */
function legacySubquerySource(annotation: ModelAnnotationSpec): { kind: "relation"; relation: string } | { kind: "model"; target: QueryModelRef } | undefined {
  if (nonEmptyString(annotation.relation)) { return { kind: "relation", relation: annotation.relation }; }
  if (!nonEmptyString(annotation.target)) { return undefined; }
  const dot = annotation.target.indexOf(".");
  if (dot <= 0 || dot === annotation.target.length - 1) { return undefined; }
  return { kind: "model", target: { app: annotation.target.slice(0, dot), model: annotation.target.slice(dot + 1) } };
}

/** Converts the one legacy custom-model correlation into Recipe v2's explicit correlation array. */
function legacyCorrelations(annotation: ModelAnnotationSpec, index: number, issues: LegacyQueryAdapterIssue[]): Array<{ nodeId: string; outerPath: string; targetPath: string }> | undefined {
  if (!nonEmptyString(annotation.filterField) || !nonEmptyString(annotation.outerField)) {
    issues.push(issue("LEGACY_ANNOTATION_MALFORMED", index, `/annotations/${index}`, "A custom-model subquery needs target and current correlation fields."));
    return undefined;
  }
  return [{ nodeId: `legacy-correlation-${index + 1}`, outerPath: annotation.outerField, targetPath: annotation.filterField }];
}

/** Converts legacy order terms while recording malformed entries instead of dropping them silently. */
function legacyOrderToRecipe(order: BackendModelOrder[] | undefined, path = "/order"): { issues: LegacyQueryAdapterIssue[]; orderBy: QueryOrderTerm[] } {
  const issues: LegacyQueryAdapterIssue[] = [];
  const orderBy: QueryOrderTerm[] = [];
  for (const [index, term] of (order ?? []).entries()) {
    if (!term || !nonEmptyString(term.field)) { issues.push(issue("LEGACY_ORDER_MALFORMED", index, `${path}/${index}`, "A legacy sort needs a field.")); continue; }
    orderBy.push({ direction: term.desc ? "desc" : "asc", nodeId: `legacy-${path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${index + 1}`, ref: { kind: "field", path: term.field } });
  }
  return { issues, orderBy };
}

/** Converts valid legacy group-by path strings without making metadata-dependent assumptions. */
function legacyGroupBy(groupBy: string[] | undefined): { groupBy: ModelQueryRecipeV2["groupBy"]; issues: LegacyQueryAdapterIssue[] } {
  const issues: LegacyQueryAdapterIssue[] = [];
  const converted: ModelQueryRecipeV2["groupBy"] = [];
  for (const [index, path] of (groupBy ?? []).entries()) {
    if (!nonEmptyString(path)) { issues.push(issue("LEGACY_GROUP_BY_MALFORMED", index, `/groupBy/${index}`, "A legacy group-by entry needs a field path.")); continue; }
    converted.push({ kind: "field", path });
  }
  return { groupBy: converted, issues };
}

/** Converts one legacy filter value to the exact Recipe RHS container required by its lookup. */
function legacyRhs(lookup: string, value: unknown): QueryComparisonRhs | undefined {
  if (lookup === "in") {
    const values = legacyValueList(value);
    return values ? { kind: "list", values } : undefined;
  }
  if (lookup === "range") {
    const values = legacyValueList(value);
    return values && values.length === 2 ? { kind: "range", lower: values[0], upper: values[1] } : undefined;
  }
  return scalar(value) === undefined ? undefined : { kind: "literal", value: scalar(value) as string | number | boolean | null };
}

/** Converts a comma-separated or array legacy list into Recipe scalar values. */
function legacyValueList(value: unknown): Array<string | number | boolean | null> | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((item) => item.trim()) : [value];
  const converted = values.map(scalar);
  return converted.every((item) => item !== undefined) ? converted as Array<string | number | boolean | null> : undefined;
}

/** Narrows a legacy value to the JSON scalar union supported by Recipe v2. */
function scalar(value: unknown): string | number | boolean | null | undefined {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Returns whether a value is a non-empty string, preserving TypeScript narrowing. */
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** Returns whether a legacy annotation kind has a direct Recipe v2 migration form. */
function isSupportedLegacyAnnotationKind(kind: unknown): boolean { return kind === "aggregate" || kind === "annotate" || kind === "subquery" || kind === "window" || kind === "expr"; }

/** Constructs one concise, deterministic legacy adapter issue. */
function issue(code: LegacyQueryAdapterIssue["code"], index: number, path: string, message: string): LegacyQueryAdapterIssue { return { code, index, message, path }; }
