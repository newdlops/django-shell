// Separates root property predicates from SQL and emits bounded Python property scans for ORM transport.

import type { ModelQueryRecipeV2, QueryComparisonNode, QueryPredicateGroup } from "./modelQueryRecipe";
import type { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";
import { modelQueryOrmLiteral } from "./modelQueryPredicateOrm";

/** Scalar comparisons implemented identically by the Python and ORM property evaluators. */
export const MODEL_QUERY_PROPERTY_LOOKUPS = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "gt", "gte", "lt", "lte", "in", "range", "isnull", "blank", "not_blank"] as const;

/** SQL predicates, declared property annotations, and deferred Python conditions for one validated recipe. */
export interface ModelQueryPropertyPlan { where: QueryPredicateGroup; annotations: Array<{ alias: string; field: string }>; terms: QueryComparisonNode[]; }

/** Splits only validated direct-root AND properties, retaining the original recipe unchanged. */
export function planModelQueryProperties(recipe: ModelQueryRecipeV2, metadata: ModelQueryMetadataIndex): ModelQueryPropertyPlan {
  const annotations: ModelQueryPropertyPlan["annotations"] = [], terms: QueryComparisonNode[] = [];
  const children = recipe.where.children.flatMap((node) => {
    if (node.kind !== "comparison" || node.lhs.kind !== "field") { return [node]; }
    const field = metadata.resolvePath(recipe.source, node.lhs.path);
    if (field?.leafKind !== "property") { return [node]; }
    if (!field.annotated) { terms.push(node); return []; }
    const alias = `__djs_property_${node.lhs.path}`;
    if (!annotations.some((item) => item.alias === alias)) { annotations.push({ alias, field: node.lhs.path }); }
    return [{ ...node, lhs: { kind: "field" as const, path: alias } }];
  });
  return { annotations, terms, where: { ...recipe.where, children } };
}

/** Emits an iterator over matching model instances without evaluating unrelated properties or caching candidates. */
export function modelQueryPropertyIterator(queryset: string, terms: QueryComparisonNode[]): string {
  return `_djs_property_rows(${queryset}, ${propertyLiteral(terms.map((term) => ({ field: term.lhs.kind === "field" ? term.lhs.path : "", lookup: term.lookup, negated: term.negated, rhs: term.rhs })))})`;
}

/** Serializes validated property descriptors as readable Python dictionaries with exact JSON scalar types. */
function propertyLiteral(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(propertyLiteral).join(", ")}]`; }
  if (value !== null && typeof value === "object") { return `{${Object.entries(value).map(([key, item]) => `${modelQueryOrmLiteral(key)}: ${propertyLiteral(item)}`).join(", ")}}`; }
  return modelQueryOrmLiteral(value);
}

/** Supplies self-contained Python helpers so audit-visible ORM cells do not depend on RPC globals. */
export function modelQueryPropertyPrelude(): string {
  return `import itertools as _djs_it
def _djs_property_expected(value, expected):
    """Preserves decimal numeric boundaries without coercing text or boolean literals."""
    from decimal import Decimal
    return Decimal(str(expected)) if isinstance(value, Decimal) and type(expected) in (int, float) else expected
def _djs_property_match(obj, term):
    """Evaluates a scalar property comparison, excluding a row when its getter or comparison raises."""
    try:
        value = getattr(obj, term["field"])
        lookup, rhs = term["lookup"], term["rhs"]
        expected = _djs_property_expected(value, rhs.get("value"))
        if lookup == "isnull":
            matched = (value is None) == expected
        elif lookup in ("blank", "not_blank"):
            matched = value is None or value == ""
            if lookup == "not_blank": matched = not matched
        elif lookup == "exact": matched = value == expected
        elif value is None:
            matched = False
        elif lookup == "iexact": matched = str(value).lower() == str(expected).lower()
        elif lookup == "contains": matched = str(expected) in str(value)
        elif lookup == "icontains": matched = str(expected).lower() in str(value).lower()
        elif lookup == "startswith": matched = str(value).startswith(str(expected))
        elif lookup == "istartswith": matched = str(value).lower().startswith(str(expected).lower())
        elif lookup == "endswith": matched = str(value).endswith(str(expected))
        elif lookup == "iendswith": matched = str(value).lower().endswith(str(expected).lower())
        elif lookup == "gt": matched = value > expected
        elif lookup == "gte": matched = value >= expected
        elif lookup == "lt": matched = value < expected
        elif lookup == "lte": matched = value <= expected
        elif lookup == "in": matched = any(value == _djs_property_expected(value, item) for item in rhs["values"])
        elif lookup == "range": matched = _djs_property_expected(value, rhs["lower"]) <= value <= _djs_property_expected(value, rhs["upper"])
        else: return False
        return not matched if term["negated"] else bool(matched)
    except Exception:
        return False
def _djs_property_rows(queryset, terms):
    """Streams database-filtered candidates and tests only the selected properties before pagination."""
    for obj in queryset.iterator(chunk_size=200):
        if all(_djs_property_match(obj, term) for term in terms):
            yield obj
`;
}
