// Gives untyped Django model properties explicit text, number, and boolean filter values.

const TYPES = { text: "CharField", number: "FloatField", boolean: "BooleanField" };

/** Infers a retained property's value editor from its JSON scalar rather than guessing from text spelling. */
export function propertyValueType(rhs, lookup, retained) {
  const sample = rhs?.kind === "list" ? rhs.values?.[0] : rhs?.kind === "range" ? rhs.lower : rhs?.value;
  if (typeof sample === "string") { return "text"; }
  if (typeof sample === "boolean") { return "boolean"; }
  if (typeof sample === "number") { return "number"; }
  return retained in TYPES ? retained : ["gt", "gte", "lt", "lte", "range"].includes(lookup) ? "number" : "text";
}

/** Creates a type selector and reuses the existing literal, list, and range controls for that chosen scalar type. */
export function createPropertyPredicateValueEditor({ context, createEditor, el, field, lookup, onChange, popoverLayer, rhs, valueState }) {
  const node = el("span", { className: "query-predicate-value query-property-value", dataset: { role: "predicate-value" } });
  const type = el("select", { ariaLabel: "Property value type", autocomplete: "off", className: "query-predicate-select", name: "property-value-type" });
  for (const [value, label] of [["text", "Text"], ["number", "Number"], ["boolean", "Boolean"]]) { type.appendChild(el("option", { value }, label)); }
  if (valueState.propertyPath !== field.path) { valueState.propertyValueType = undefined; }
  valueState.propertyPath = field.path;
  type.value = propertyValueType(rhs, lookup, valueState.propertyValueType);
  const value = el("span", { className: "query-property-input" });
  let editor;
  node.append(type, value);

  /** Rebuilds only the local typed input so changing type does not disrupt the surrounding condition. */
  function render() {
    editor?.destroy?.();
    valueState.propertyValueType = type.value;
    editor = createEditor({ context, el, field: { type: TYPES[type.value] }, lookup, onChange: (next) => { rhs = next; onChange(next); }, popoverLayer, rhs });
    value.replaceChildren(editor.node);
  }

  /** Starts a fresh value of the explicitly selected type, without coercing text booleans or numeric strings. */
  function changeType() {
    const initial = type.value === "boolean" ? false : type.value === "number" ? 0 : "";
    rhs = lookup === "in" ? { kind: "list", values: [] } : lookup === "range" ? { kind: "range", lower: initial, upper: initial } : { kind: "literal", value: initial };
    onChange(rhs); render();
    value.querySelector("input,select")?.focus();
  }

  type.addEventListener("change", changeType);
  render();
  return { node, /** Releases any retained native field controls. */ destroy() { editor?.destroy?.(); } };
}
