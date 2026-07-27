// Compiles validated Recipe v2 computed columns into Django annotation expressions.

import type { QueryComputedColumn, QueryFormulaNode, QueryModelRef, QueryPredicateGroup, QueryScalarSubqueryColumn, QueryWindowColumn } from "./modelQueryRecipe";
import type { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";
import { compileModelQueryInnerQuery, compileModelQueryPredicate, modelQueryOrmLiteral, modelQueryOrmString, type ModelQueryPredicateOrmContext } from "./modelQueryPredicateOrm";

/** Context used to compile computed annotation expressions in recipe order. */
export interface ModelQueryComputedOrmContext extends ModelQueryPredicateOrmContext {
  source: QueryModelRef;
}

/** A compiled enabled annotation and its window classification. */
export interface ModelQueryComputedOrmSpec {
  alias: string;
  expression: string;
  window: boolean;
}

/** Compiles every enabled computed column sequentially so Formula aliases can use earlier annotations. */
export function compileModelQueryComputed(columns: QueryComputedColumn[], context: ModelQueryComputedOrmContext): ModelQueryComputedOrmSpec[] {
  const specs: ModelQueryComputedOrmSpec[] = [];
  for (const column of columns) {
    if (!column.enabled) { continue; }
    specs.push({ alias: column.alias, expression: compileColumn(column, context), window: column.kind === "window" });
  }
  return specs;
}

/** Compiles the Django expression for one computed column. */
function compileColumn(column: QueryComputedColumn, context: ModelQueryComputedOrmContext): string {
  if (column.kind === "aggregate") {
    const predicate = compileModelQueryPredicate(column.filter, context.source, context);
    const field = column.field.kind === "all" ? "pk" : column.field.path;
    const distinct = column.distinct === "always" || (column.distinct === "auto" && Boolean(context.metadata.resolvePath(context.source, field)?.toMany));
    return aggregateExpression(column.function, field, distinct, predicate.expression);
  }
  if (column.kind === "scalarSubquery") { return scalarSubqueryExpression(column, context); }
  if (column.kind === "exists") {
    const inner = compileModelQueryInnerQuery(column.source, column.correlations, column.where, context.source, context);
    return `models.Exists(${inner.expression})`;
  }
  if (column.kind === "formula") { return formulaExpression(column.expression, context); }
  if (column.kind === "window") { return windowExpression(column); }
  const condition = compileModelQueryPredicate(column.when, context.source, context);
  return column.when.children.length ? `models.Case(models.When(${condition.expression}, then=${column.expression}), default=models.Value(None))` : column.expression;
}

/** Compiles a scalar field or aggregate Subquery with explicit ordering and empty-value fallback. */
function scalarSubqueryExpression(column: QueryScalarSubqueryColumn, context: ModelQueryComputedOrmContext): string {
  const inner = compileModelQueryInnerQuery(column.source, column.correlations, column.where, context.source, context);
  const order = column.orderBy.length ? column.orderBy.map((term) => modelQueryOrmString(`${term.direction === "desc" ? "-" : ""}${term.ref.kind === "field" ? term.ref.path : term.ref.alias}`)).join(", ") : '"pk"';
  let selected: string;
  if (column.select.kind === "field") {
    selected = `${inner.expression}.order_by(${order}).values(${modelQueryOrmString(column.select.field.path)})[:1]`;
  } else {
    const field = column.select.field.kind === "all" ? "pk" : column.select.field.path;
    const groupKey = column.correlations[0]?.targetPath ?? "pk";
    selected = `${inner.expression}.order_by().values(${modelQueryOrmString(groupKey)}).annotate(__djs_value=${aggregateExpression(column.select.function, field, column.select.distinct === "always", undefined)}).values("__djs_value")[:1]`;
  }
  const subquery = `models.Subquery(${selected})`;
  return column.onEmpty.value === null ? subquery : `models.functions.Coalesce(${subquery}, ${modelQueryOrmLiteral(column.onEmpty.value)})`;
}

/** Maps a recipe aggregate function to its Django expression constructor. */
function aggregateExpression(functionName: string, field: string, distinct: boolean, filter?: string): string {
  const constructors: Record<string, string> = { avg: "Avg", count: "Count", max: "Max", min: "Min", sum: "Sum" };
  const filterPart = filter ? `, filter=${filter}` : "";
  return `models.${constructors[functionName]}(${modelQueryOrmString(field)}${distinct ? ", distinct=True" : ""}${filterPart})`;
}

/** Recursively compiles a structured Formula tree without evaluating user-supplied code. */
function formulaExpression(node: QueryFormulaNode, context: ModelQueryComputedOrmContext): string {
  if (node.kind === "field") { return `models.F(${modelQueryOrmString(node.path)})`; }
  if (node.kind === "computed") { return `models.F(${modelQueryOrmString(node.alias)})`; }
  if (node.kind === "literal") { return `models.Value(${modelQueryOrmLiteral(node.value)})`; }
  if (node.kind === "binary") { return `(${formulaExpression(node.left, context)} ${node.operator} ${formulaExpression(node.right, context)})`; }
  if (node.kind === "function") {
    const constructors: Record<string, string> = { coalesce: "Coalesce", concat: "Concat", greatest: "Greatest", least: "Least", length: "Length", lower: "Lower", trim: "Trim", upper: "Upper" };
    return `models.functions.${constructors[node.function]}(${node.args.map((argument) => formulaExpression(argument, context)).join(", ")})`;
  }
  if (node.kind === "case") {
    const branches = node.branches.map((branch) => `models.When(${compileModelQueryPredicate(branch.when, context.source, context).expression}, then=${formulaExpression(branch.then, context)})`);
    return `models.Case(${branches.join(", ")}, default=${formulaExpression(node.else, context)})`;
  }
  return `models.functions.Cast(${formulaExpression(node.expression, context)}, output_field=${outputField(node.outputType)})`;
}

/** Compiles the supported Django Window function set. */
function windowExpression(column: QueryWindowColumn): string {
  const ranks: Record<string, string> = { dense_rank: "DenseRank", rank: "Rank", row_number: "RowNumber" };
  const inner = ranks[column.function] ? `models.functions.${ranks[column.function]}()` : aggregateExpression(column.function, column.field?.path ?? "pk", false);
  const partition = column.partitionBy.length ? `, partition_by=[${column.partitionBy.map((field) => `models.F(${modelQueryOrmString(field.path)})`).join(", ")}]` : "";
  const order = column.orderBy.length ? `, order_by=[${column.orderBy.map((term) => `models.F(${modelQueryOrmString(term.ref.kind === "field" ? term.ref.path : term.ref.alias)}).${term.direction}()`).join(", ")}]` : "";
  return `models.Window(${inner}${partition}${order})`;
}

/** Maps Recipe output types to Django output-field constructors. */
function outputField(type: Exclude<"auto" | "boolean" | "integer" | "float" | "decimal" | "text" | "date" | "datetime" | "time" | "duration" | "uuid", "auto">): string {
  const fields: Record<string, string> = { boolean: "BooleanField", date: "DateField", datetime: "DateTimeField", decimal: "DecimalField(max_digits=38, decimal_places=18)", duration: "DurationField", float: "FloatField", integer: "IntegerField", text: "TextField", time: "TimeField", uuid: "UUIDField" };
  const value = fields[type];
  return value.includes("(") ? `models.${value}` : `models.${value}()`;
}
