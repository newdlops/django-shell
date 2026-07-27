// Typed Recipe predicate lookup matrix and value editors for the VS Code-native Query Builder.
import { createGridCombobox } from "./gridCombobox.js";
import { inputTypeForQueryScalar, parseQueryScalar } from "./gridQueryScalarEditor.js";

const NUMERIC_TYPES = /Integer|Float|Decimal|AutoField/;
const TEXT_TYPES = /Char|Text|Email|Slug|URL|FilePath/;
const GENERIC_TEXT_TYPES = /UUID|IP|Duration|File|Generic/;
const DATE_TYPES = new Set(["DateField", "DateTimeField", "TimeField"]);
const VALUE_ONLY_LOOKUPS = new Set(["in", "isnull", "range", "blank", "not_blank"]);

export const LOOKUP_LABELS = Object.freeze({
  blank: "is blank", contains: "contains", date: "date =", endswith: "ends with", exact: "=", gt: ">", gte: "≥", icontains: "contains (i)", iexact: "= (i)", iendswith: "ends with (i)", in: "in list", isnull: "is null", istartswith: "starts with (i)", length: "length =", length__gt: "length >", length__gte: "length ≥", length__lt: "length <", length__lte: "length ≤", lt: "<", lte: "≤", not_blank: "is not blank", quarter: "quarter", range: "between", second: "second", startswith: "starts with", trim: "trimmed =", week_day: "weekday", year: "year", month: "month", day: "day", hour: "hour", minute: "minute"
});

/** Returns type-appropriate, backend-allowlisted lookups for one resolved scalar field. */
export function lookupsForField(field, allowed = Object.keys(LOOKUP_LABELS)) {
  const available = new Set(allowed);
  const type = String(field?.type || "");
  let names;
  if (field?.role === "relation") { names = ["isnull"]; }
  else if (type === "BooleanField") { names = ["exact", "isnull"]; }
  else if (type === "DateTimeField") { names = ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "isnull"]; }
  else if (type === "DateField") { names = ["exact", "gt", "gte", "lt", "lte", "range", "year", "quarter", "month", "week_day", "day", "isnull"]; }
  else if (type === "TimeField") { names = ["exact", "gt", "gte", "lt", "lte", "range", "hour", "minute", "second", "isnull"]; }
  else if (NUMERIC_TYPES.test(type)) { names = ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"]; }
  else if (TEXT_TYPES.test(type)) { names = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "blank", "not_blank", "trim", "length", "length__gt", "length__gte", "length__lt", "length__lte"]; }
  else if (GENERIC_TEXT_TYPES.test(type)) { names = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"]; }
  else { names = ["exact", "in", "isnull"]; }
  return names.filter((name) => available.has(name));
}

/** Returns the single non-surprising initial lookup for a newly chosen field. */
export function defaultLookup(field, allowed) {
  const lookups = lookupsForField(field, allowed);
  return TEXT_TYPES.test(String(field?.type || "")) && lookups.includes("icontains") ? "icontains" : (lookups.includes("exact") ? "exact" : (lookups[0] || ""));
}

/** Returns valid RHS kinds for an editor context and lookup without permitting unsafe OuterRef use. */
export function rhsKindsFor({ context = "where", field, lookup } = {}) {
  if (!lookup || VALUE_ONLY_LOOKUPS.has(lookup)) { return ["literal"]; }
  const kinds = ["literal", "field"];
  if (context === "subquery") { kinds.push("outerField"); }
  if ((context === "where" || context === "subquery") && DATE_TYPES.has(String(field?.type || ""))) { kinds.push("relativeTime"); }
  return kinds;
}

/** Returns whether an existing RHS remains valid after its LHS field or lookup changed. */
export function rhsIsCompatible(rhs, context, field, lookup) {
  if (!rhs || typeof rhs !== "object") { return false; }
  return rhsKindsFor({ context, field, lookup }).includes(rhs.kind);
}

/** Returns an input type that preserves the selected Django field's native value shape. */
export function inputTypeFor(field, lookup) {
  return inputTypeForQueryScalar(field, lookup);
}

/** Converts native form input to JSON scalar without treating string booleans as booleans. */
export function scalarFromInput(field, raw) {
  return parseQueryScalar(field, raw);
}

/** Creates a compact native select from safe {label,value} entries. */
function selectControl(el, ariaLabel, options, value, onChange) {
  const select = el("select", { ariaLabel, className: "query-predicate-select" });
  for (const option of options) { select.appendChild(el("option", { value: option.value }, option.label)); }
  select.value = options.some((option) => String(option.value) === String(value)) ? String(value) : String(options[0]?.value || "");
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** Builds the typed literal, list, range, field, OuterRef, or relative-time RHS control for one comparison row. */
export function createPredicateValueEditor({ context, el, field, lookup, onChange, popoverLayer, rhs = { kind: "literal", value: null }, scopeFields = [], outerFields = [] }) {
  const node = el("span", { className: "query-predicate-value", dataset: { role: "predicate-value" } });
  const kind = lookup === "in" ? "list" : (lookup === "range" ? "range" : (rhsIsCompatible(rhs, context, field, lookup) ? rhs.kind : (rhs?.kind || "literal")));

  /** Emits a JSON-safe RHS update and leaves parent rendering responsible for validation state. */
  function emit(next) { onChange?.(next); }

  /** Creates a field-reference select for F or OuterRef RHS variants. */
  function fieldReference(kindName, options) {
    const picker = createGridCombobox({ el, label: kindName === "outerField" ? "Outer field" : "Compare to field", onChange: (path) => emit({ kind: kindName, path }), options: [{ label: "Choose field", value: "" }, ...options.map((entry) => ({ description: entry.type || "", label: entry.label || entry.path, value: entry.path }))], popoverLayer, value: rhs.path || "" });
    node.appendChild(picker.node);
    return picker;
  }

  if (kind === "field") { const picker = fieldReference("field", scopeFields); return { destroy: picker.destroy, node }; }
  if (kind === "outerField") { const picker = fieldReference("outerField", outerFields); return { destroy: picker.destroy, node }; }
  if (kind === "relativeTime") {
    const amount = el("input", { ariaLabel: "Relative time amount", min: "1", max: "10000", type: "number", value: String(rhs.amount || 1) });
    const anchor = selectControl(el, "Relative time anchor", [{ label: "now", value: "now" }, { label: "today", value: "today" }], rhs.anchor || "now", updateRelative);
    const direction = selectControl(el, "Relative time direction", [{ label: "past", value: "past" }, { label: "future", value: "future" }], rhs.direction || "past", updateRelative);
    const unit = selectControl(el, "Relative time unit", ["minutes", "hours", "days", "weeks"].map((value) => ({ label: value, value })), rhs.unit || "days", updateRelative);
    amount.addEventListener("input", updateRelative);
    node.append(amount, anchor, direction, unit);
    function updateRelative() { emit({ amount: Number(amount.value), anchor: anchor.value, direction: direction.value, kind: "relativeTime", unit: unit.value }); }
    return { node };
  }
  if (lookup === "isnull") {
    node.appendChild(selectControl(el, "Null state", [{ label: "has value", value: "false" }, { label: "is null", value: "true" }], String(Boolean(rhs.value)), (value) => emit({ kind: "literal", value: value === "true" })));
    return { node };
  }
  if (lookup === "blank" || lookup === "not_blank") {
    node.appendChild(el("span", { className: "query-predicate-static", role: "note" }, "No value needed"));
    return { node };
  }
  if (field?.type === "BooleanField" && kind === "literal") {
    node.appendChild(selectControl(el, "Boolean value", [{ label: "true", value: "true" }, { label: "false", value: "false" }], String(rhs.value === true), (value) => emit({ kind: "literal", value: value === "true" })));
    return { node };
  }
  if (Array.isArray(field?.choices) && field.choices.length && kind === "literal") {
    node.appendChild(selectControl(el, "Field value", field.choices.map((choice) => ({ label: String(choice[1]), value: String(choice[0]) })), rhs.value, (value) => emit({ kind: "literal", value })));
    return { node };
  }
  if (kind === "list") {
    const values = Array.isArray(rhs.values) ? [...rhs.values] : [];
    const chips = el("span", { ariaLabel: "List values", className: "query-value-chips" });
    const input = el("input", { ariaLabel: "Add list value", placeholder: "Add value", type: inputTypeFor(field, "exact") });
    const add = el("button", { ariaLabel: "Add list value", type: "button" }, "Add");
    const redraw = () => { chips.replaceChildren(...values.map((value, index) => { const remove = el("button", { ariaLabel: `Remove ${String(value)}`, type: "button" }, "Remove"); remove.addEventListener("click", () => { values.splice(index, 1); emit({ kind: "list", values: [...values] }); redraw(); }); return el("span", { className: "query-value-chip" }, String(value), remove); })); };
    add.addEventListener("click", () => { if (input.value !== "") { values.push(scalarFromInput(field, input.value)); input.value = ""; emit({ kind: "list", values: [...values] }); redraw(); input.focus(); } });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); add.click(); } });
    redraw(); node.append(chips, input, add); return { node };
  }
  if (kind === "range") {
    const lower = el("input", { ariaLabel: "Range lower bound", placeholder: "From", type: inputTypeFor(field, "exact"), value: rhs.lower == null ? "" : String(rhs.lower) });
    const upper = el("input", { ariaLabel: "Range upper bound", placeholder: "To", type: inputTypeFor(field, "exact"), value: rhs.upper == null ? "" : String(rhs.upper) });
    const update = () => emit({ kind: "range", lower: scalarFromInput(field, lower.value), upper: scalarFromInput(field, upper.value) });
    lower.addEventListener("input", update); upper.addEventListener("input", update); node.append(lower, upper); return { node };
  }
  if (kind === "literal" && (field?.type === "BooleanField" || lookupIsValueFree(field, rhs))) { return { node }; }
  const input = el("input", { ariaLabel: "Comparison value", type: inputTypeFor(field, "exact"), value: rhs.value == null ? "" : String(rhs.value) });
  input.addEventListener("input", () => emit({ kind: "literal", value: scalarFromInput(field, input.value) }));
  node.appendChild(input);
  return { node };
}

/** Returns whether this editor is intentionally value-free; blank/null are rendered by the parent row. */
function lookupIsValueFree(_field, rhs) {
  return rhs?.kind === "literal" && rhs.value === undefined;
}

/** Exposes pure predicate-value rules to focused unit tests. */
export const __test = { defaultLookup, inputTypeFor, rhsIsCompatible, scalarFromInput, VALUE_ONLY_LOOKUPS };
