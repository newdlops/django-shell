// Compiles validated ModelQueryRecipeV2 predicate trees into injection-safe Django Q expressions.

import type { QueryComparisonNode, QueryComparisonRhs, QueryCorrelation, QueryExistsPredicateNode, QueryModelRef, QueryPredicateGroup, QueryPredicateNode, QuerySubquerySource, QueryValueRef } from "./modelQueryRecipe";
import type { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";

/** Context shared by all predicate compilation sites. */
export interface ModelQueryPredicateOrmContext {
  metadata: ModelQueryMetadataIndex;
  source: QueryModelRef;
}

/** Compiled Q expression plus whether joins can duplicate root rows. */
export interface ModelQueryPredicateOrmResult {
  expression: string;
  toMany: boolean;
}

/** Compiles one validated predicate group into a parenthesized Django Q expression. */
export function compileModelQueryPredicate(group: QueryPredicateGroup, model: QueryModelRef, context: ModelQueryPredicateOrmContext, outerScope = false): ModelQueryPredicateOrmResult {
  const pieces: string[] = [];
  let toMany = false;
  for (const child of group.children) {
    const compiled = compileNode(child, model, context, outerScope);
    pieces.push(compiled.expression);
    toMany ||= compiled.toMany;
  }
  const joined = pieces.length === 0 ? "models.Q()" : pieces.length === 1 ? pieces[0] : `(${pieces.join(group.join === "or" ? " | " : " & ")})`;
  return { expression: group.negated ? `~(${joined})` : joined, toMany };
}

/** Compiles a subquery source, correlations, and inner predicates for Exists and scalar subqueries. */
export function compileModelQueryInnerQuery(source: QuerySubquerySource, correlations: QueryCorrelation[], where: QueryPredicateGroup, outerModel: QueryModelRef, context: ModelQueryPredicateOrmContext): ModelQueryPredicateOrmResult {
  const target = sourceTarget(source, outerModel, context);
  const correlationFilters = source.kind === "relation" ? relationCorrelationFilter(source, outerModel, context) : correlations.map((correlation) => `**{${pythonString(correlation.targetPath)}: models.OuterRef(${pythonString(correlation.outerPath)})}`).join(", ");
  const innerPredicate = compileModelQueryPredicate(where, target, context, true);
  const filter = correlationFilters ? `.filter(${correlationFilters})` : "";
  return { expression: `${modelExpression(target)}._base_manager${filter}.filter(${innerPredicate.expression})`, toMany: innerPredicate.toMany };
}

/** Returns the required metadata-backed relation filter or a fail-closed filter for incomplete metadata. */
function relationCorrelationFilter(source: Extract<QuerySubquerySource, { kind: "relation" }>, outerModel: QueryModelRef, context: ModelQueryPredicateOrmContext): string {
  const relation = context.metadata.resolveRelation(outerModel, source.relation);
  if (!relation?.filterField || !relation.outerField) { return `**{${pythonString("pk__in")}: []}`; }
  return `**{${pythonString(relation.filterField)}: models.OuterRef(${pythonString(relation.outerField)})}`;
}

/** Emits an ORM-safe Django model expression keyed by app and model, avoiding bare-name collisions. */
export function modelQueryOrmModelExpression(model: QueryModelRef): string {
  return modelExpression(model);
}

/** Emits a JSON-compatible Python scalar literal without executable interpolation. */
export function modelQueryOrmLiteral(value: unknown): string {
  if (value === null) { return "None"; }
  if (typeof value === "boolean") { return value ? "True" : "False"; }
  if (typeof value === "number" && Number.isFinite(value)) { return String(value); }
  if (typeof value === "string") { return pythonString(value); }
  if (Array.isArray(value)) { return `[${value.map((item) => modelQueryOrmLiteral(item)).join(", ")}]`; }
  return "None";
}

/** Emits a JSON string literal, whose escaping rules are accepted by Python string literals. */
export function modelQueryOrmString(value: string): string {
  return pythonString(value);
}

/** Compiles one predicate node. */
function compileNode(node: QueryPredicateNode, model: QueryModelRef, context: ModelQueryPredicateOrmContext, outerScope: boolean): ModelQueryPredicateOrmResult {
  if (node.kind === "group") { return compileModelQueryPredicate(node, model, context, outerScope); }
  if (node.kind === "existsPredicate") { return compileExists(node, model, context); }
  return compileComparison(node, model, context, outerScope);
}

/** Compiles a comparison and preserves both leaf and group negation semantics. */
function compileComparison(node: QueryComparisonNode, model: QueryModelRef, context: ModelQueryPredicateOrmContext, outerScope: boolean): ModelQueryPredicateOrmResult {
  const lhs = valuePath(node.lhs);
  const toMany = node.lhs.kind === "field" && Boolean(context.metadata.resolvePath(model, node.lhs.path)?.toMany);
  let expression: string;
  if (node.lookup === "blank" || node.lookup === "not_blank") {
    const blank = `(models.Q(**{${pythonString(`${lhs}__isnull`)}: True}) | models.Q(**{${pythonString(`${lhs}__exact`)}: ""}))`;
    expression = node.lookup === "blank" ? blank : `~${blank}`;
  } else {
    expression = `models.Q(**{${pythonString(`${lhs}__${node.lookup}`)}: ${compileRhs(node.rhs, outerScope)}})`;
  }
  return { expression: node.negated ? `~(${expression})` : expression, toMany };
}

/** Compiles an Exists predicate as a Q-compatible conditional expression. */
function compileExists(node: QueryExistsPredicateNode, outerModel: QueryModelRef, context: ModelQueryPredicateOrmContext): ModelQueryPredicateOrmResult {
  const inner = compileModelQueryInnerQuery(node.source, node.correlations, node.where, outerModel, context);
  const expression = `models.Q(models.Exists(${inner.expression}))`;
  return { expression: node.negated ? `~(${expression})` : expression, toMany: inner.toMany };
}

/** Compiles an RHS value form after validation has established its type and scope. */
function compileRhs(rhs: QueryComparisonRhs, outerScope: boolean): string {
  if (rhs.kind === "literal") { return modelQueryOrmLiteral(rhs.value); }
  if (rhs.kind === "list") { return modelQueryOrmLiteral(rhs.values); }
  if (rhs.kind === "range") { return modelQueryOrmLiteral([rhs.lower, rhs.upper]); }
  if (rhs.kind === "field") { return `models.F(${pythonString(rhs.path)})`; }
  if (rhs.kind === "outerField") { return outerScope ? `models.OuterRef(${pythonString(rhs.path)})` : "None"; }
  const base = rhs.anchor === "now" ? '__import__("django.utils.timezone", fromlist=["timezone"]).now()' : '__import__("django.utils.timezone", fromlist=["timezone"]).localdate()';
  const delta = `__import__("datetime").timedelta(${rhs.unit}=${rhs.amount})`;
  return `(${base} ${rhs.direction === "past" ? "-" : "+"} ${delta})`;
}

/** Returns a field path or annotation alias from a value reference. */
function valuePath(ref: QueryValueRef): string {
  return ref.kind === "field" ? ref.path : ref.alias;
}

/** Resolves a subquery model source using the trusted metadata index. */
function sourceTarget(source: QuerySubquerySource, outerModel: QueryModelRef, context: ModelQueryPredicateOrmContext): QueryModelRef {
  if (source.kind === "model") { return source.target; }
  const relation = context.metadata.resolveRelation(outerModel, source.relation);
  if (!relation) { return outerModel; }
  const dot = relation.target.indexOf(".");
  return { app: relation.target.slice(0, dot), model: relation.target.slice(dot + 1) };
}

/** Returns a safe app-registry model reference. */
function modelExpression(model: QueryModelRef): string {
  return `__import__("django.apps", fromlist=["apps"]).apps.get_model(${pythonString(model.app)}, ${pythonString(model.model)})`;
}

/** Returns a JSON-escaped double-quoted Python string. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}
