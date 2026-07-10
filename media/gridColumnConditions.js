// Conditional Aggregate, Annotate, and Subquery row builder for the model browser's "+ Column" panel.

import { createCombobox } from "./gridCombobox.js";
import { createPathPicker } from "./gridFieldPath.js";

const MAX_CONDITIONS = 8;
const TEXT_TYPES = /Char|Text|Email|Slug|URL|UUID|IP|File|FilePath|Duration|Generic/;
const LENGTH_TYPES = /Char|Text|Email|Slug|URL|FilePath/;
const NUM_TYPES = /Integer|Float|Decimal|AutoField/;
const INT_LOOKUPS = new Set(["year", "month", "day", "week_day", "quarter", "hour", "minute", "second"]);
const VALUE_ONLY_LOOKUPS = new Set(["in", "isnull", "range"]);
const JOIN_OPTIONS = [{ label: "all (AND)", value: "all" }, { label: "any (OR)", value: "any" }];
const LOOKUP_LABEL = {
  exact: "=", iexact: "= (i)", contains: "contains", icontains: "contains (i)", gt: ">", gte: "≥", lt: "<", lte: "≤",
  startswith: "starts with", istartswith: "starts with (i)", endswith: "ends with", iendswith: "ends with (i)",
  in: "in (list)", isnull: "is null", range: "between", date: "date =", year: "year", month: "month", day: "day",
  week_day: "weekday", quarter: "quarter", hour: "hour", minute: "minute", second: "second",
  length: "length =", length__gt: "length >", length__gte: "length ≥", length__lt: "length <", length__lte: "length ≤", trim: "trimmed ="
};

/** Returns the allowed lookups for a selected condition terminal. */
function lookupsForTerminal(terminal, allLookups) {
  const allowed = new Set(allLookups || []);
  if (!terminal || terminal.role === "relation") {
    return allowed.has("isnull") ? ["isnull"] : [];
  }
  const type = String(terminal.type || "");
  let preferred;
  if (type === "BooleanField") {
    preferred = ["exact", "isnull"];
  } else if (type === "DateTimeField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "isnull"];
  } else if (type === "DateField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "year", "quarter", "month", "week_day", "day", "isnull"];
  } else if (type === "TimeField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "hour", "minute", "second", "isnull"];
  } else if (NUM_TYPES.test(type)) {
    preferred = ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  } else if (TEXT_TYPES.test(type)) {
    preferred = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"];
    if (LENGTH_TYPES.test(type)) {
      preferred.push("trim", "length", "length__gt", "length__gte", "length__lt", "length__lte");
    }
  } else {
    preferred = [...allowed];
  }
  return preferred.filter((lookup) => allowed.has(lookup));
}

/** Returns a useful default lookup for a newly selected condition field. */
function defaultLookup(terminal, names) {
  if (!terminal || terminal.role === "relation") {
    return names[0] || "";
  }
  if (TEXT_TYPES.test(String(terminal.type || "")) && names.includes("icontains")) {
    return "icontains";
  }
  return names.includes("exact") ? "exact" : (names[0] || "");
}

/** Returns the HTML input type suited to a Django field type. */
function inputTypeFor(type) {
  if (type === "DateField") { return "date"; }
  if (type === "DateTimeField") { return "datetime-local"; }
  if (type === "TimeField") { return "time"; }
  if (NUM_TYPES.test(String(type || ""))) { return "number"; }
  return "text";
}

/** Returns whether a persisted boolean-like value selects the truthy option. */
function isTruthy(value) {
  return /^(true|1|t|yes|on)$/i.test(String(value === undefined || value === null ? "" : value).trim());
}

/** Returns whether a literal control has enough input to form a condition safely. */
function literalValueComplete(lookup, value) {
  if (lookup === "isnull") {
    return true;
  }
  const parts = String(value === undefined || value === null ? "" : value).split(",").map((part) => part.trim());
  if (lookup === "range") {
    return parts.length === 2 && parts.every(Boolean);
  }
  if (lookup === "in") {
    return parts.some(Boolean);
  }
  return String(value === undefined || value === null ? "" : value).trim().length > 0;
}

/** Returns whether a lookup can compare against an F/OuterRef expression rather than a literal. */
function permitsExpressionRhs(lookup) {
  return Boolean(lookup) && !VALUE_ONLY_LOOKUPS.has(lookup);
}

/** Creates an optional all/any condition group and exposes a strict collector. */
export function createColumnConditionBuilder(deps) {
  const { el, fetchTree, getModel, rootOptions, allLookups = [], outer } = deps;
  const node = el("span", { className: "colconditions" });
  const toolbar = el("span", { className: "colcondition-toolbar" });
  const list = el("span", { className: "colcondition-list", dataset: { role: "condition-list" } });
  const joinCombo = createCombobox({ dataset: { role: "condition-join" }, el, options: JOIN_OPTIONS, value: "all" });
  const addButton = el("button", { className: "linkbtn", dataset: { role: "condition-add" }, title: `Add a condition (maximum ${MAX_CONDITIONS})`, type: "button" }, "+ condition");
  toolbar.append(el("span", { className: "tag" }, "where"), joinCombo.node, addButton);
  node.append(toolbar, list);

  /** Returns the RHS-kind options currently valid for one lookup. */
  function rhsKindOptions(lookup) {
    const options = [{ label: "value", value: "value" }];
    if (permitsExpressionRhs(lookup)) {
      options.push({ label: "target field (F)", value: "field" });
      if (outer) {
        options.push({ label: "current row (OuterRef)", value: "outer" });
      }
    }
    return options;
  }

  /** Updates the add button and group connector visibility after rows change. */
  function refreshGroupUi() {
    const count = list.querySelectorAll("[data-role=column-condition]").length;
    addButton.disabled = count >= MAX_CONDITIONS;
    joinCombo.node.style.display = count > 1 ? "" : "none";
  }

  /** Builds a two-input literal editor for a range lookup. */
  function rangeControl(terminal, presetValue) {
    const type = inputTypeFor(terminal ? terminal.type : "");
    const from = el("input", { className: "rangefrom", placeholder: "from", type });
    const to = el("input", { className: "rangeto", placeholder: "to", type });
    const parts = String(presetValue || "").split(",");
    from.value = (parts[0] || "").trim();
    to.value = (parts[1] || "").trim();
    return { getValue: () => `${from.value},${to.value}`, node: el("span", { className: "rangewrap", dataset: { role: "condition-value" } }, from, document.createTextNode(" – "), to) };
  }

  /** Builds a comma-list literal editor for an `in` lookup. */
  function listControl(presetValue) {
    const input = el("input", { className: "condition-list-value", dataset: { role: "condition-value" }, placeholder: "a, b, c", type: "text" });
    input.value = presetValue == null ? "" : String(presetValue);
    return { getValue: () => input.value, node: input };
  }

  /** Builds a typed literal editor for the selected terminal and lookup. */
  function literalControl(terminal, lookup, presetValue) {
    if (lookup === "isnull") {
      const select = el("select", { dataset: { role: "condition-value" } });
      select.append(el("option", { value: "false" }, "has value"), el("option", { value: "true" }, "is null"));
      select.value = isTruthy(presetValue) ? "true" : "false";
      return { getValue: () => select.value, node: select };
    }
    if (lookup === "range") {
      return rangeControl(terminal, presetValue);
    }
    if (lookup === "in") {
      return listControl(presetValue);
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && terminal.type === "BooleanField") {
      const select = el("select", { dataset: { role: "condition-value" } });
      select.append(el("option", { value: "True" }, "true"), el("option", { value: "False" }, "false"));
      select.value = isTruthy(presetValue) ? "True" : "False";
      return { getValue: () => select.value, node: select };
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && Array.isArray(terminal.choices) && terminal.choices.length) {
      const options = terminal.choices.map((choice) => ({ label: String(choice[1]), value: String(choice[0]) }));
      const selected = options.some((option) => option.value === String(presetValue)) ? String(presetValue) : options[0].value;
      const combo = createCombobox({ dataset: { role: "condition-value" }, el, options, value: selected });
      return { getValue: () => combo.getValue(), node: combo.node };
    }
    const extractedType = lookup === "date" ? "DateField" : (INT_LOOKUPS.has(lookup) || lookup.startsWith("length") ? "IntegerField" : (terminal ? terminal.type : ""));
    const input = el("input", { dataset: { role: "condition-value" }, type: inputTypeFor(extractedType) });
    if (presetValue !== undefined && presetValue !== null) {
      input.value = String(presetValue);
    }
    return { getValue: () => input.value, node: input };
  }

  /** Creates a path-picker RHS control for F or OuterRef comparisons. */
  function expressionControl(kind) {
    const source = kind === "outer" ? outer : { getModel, rootOptions };
    const picker = createPathPicker({ el, fetchTree, getModel: source.getModel, placeholder: kind === "outer" ? "current field" : "target field", rootOptions: source.rootOptions });
    return { getValue: () => picker.getPath(), node: picker.node, picker };
  }

  /** Rebuilds one row's RHS editor for its selected RHS kind and lookup. */
  function rebuildRhs(row, presetValue) {
    const slot = row.querySelector("[data-role=condition-rhs]");
    const lookup = row._lookup.node.value;
    const priorKind = row._rhsKind.node.value;
    const options = rhsKindOptions(lookup);
    row._rhsKind.setOptions(options);
    row._rhsKind.setValue(options.some((option) => option.value === priorKind) ? priorKind : "value");
    const kind = row._rhsKind.node.value;
    const control = kind === "value" ? literalControl(row._field.terminal(), lookup, presetValue) : expressionControl(kind);
    slot.innerHTML = "";
    slot.appendChild(control.node);
    row._rhs = control;
  }

  /** Refreshes one row's lookup choices after its LHS path changes. */
  function refreshLookups(row) {
    const terminal = row._field.terminal();
    const names = lookupsForTerminal(terminal, allLookups);
    const previous = row._lookup.node.value;
    row._lookup.setOptions(names.map((name) => ({ label: LOOKUP_LABEL[name] || name, value: name })));
    row._lookup.setValue(names.includes(previous) ? previous : defaultLookup(terminal, names));
    rebuildRhs(row);
  }

  /** Adds one removable condition row. */
  function addTerm(initial) {
    if (list.querySelectorAll("[data-role=column-condition]").length >= MAX_CONDITIONS) {
      return null;
    }
    const row = el("span", { className: "colcondition", dataset: { role: "column-condition" } });
    const fieldSlot = el("span", { className: "pathpick", dataset: { role: "condition-field" } });
    const field = createPathPicker({ el, fetchTree, getModel, onChange: () => refreshLookups(row), placeholder: "field / relation →", rootOptions });
    const lookup = createCombobox({ dataset: { role: "condition-lookup" }, el, onChange: () => rebuildRhs(row), options: [], placeholder: "lookup" });
    const rhsKind = createCombobox({ dataset: { role: "condition-rhs-kind" }, el, onChange: () => rebuildRhs(row), options: [{ label: "value", value: "value" }], value: "value" });
    const rhsSlot = el("span", { className: "condition-rhs", dataset: { role: "condition-rhs" } });
    const negate = el("input", { checked: Boolean(initial && initial.negate), dataset: { role: "condition-negate" }, type: "checkbox" });
    const remove = el("button", { className: "chipx", dataset: { role: "condition-remove" }, title: "Remove condition", type: "button" }, "✕");
    remove.addEventListener("click", () => { row.remove(); refreshGroupUi(); });
    row._field = field;
    row._lookup = lookup;
    row._rhsKind = rhsKind;
    row._rhs = null;
    fieldSlot.appendChild(field.node);
    row.append(fieldSlot, lookup.node, rhsKind.node, rhsSlot, el("label", { className: "condition-neg" }, negate, "not"), remove);
    list.appendChild(row);
    refreshGroupUi();
    return row;
  }

  /** Reads one complete row, returning null when any required selection/value is missing. */
  function readTerm(row) {
    const field = row._field.getPath();
    const terminal = row._field.terminal();
    const lookup = row._lookup.node.value;
    const kind = row._rhsKind.node.value;
    if (!field || !terminal || !lookup || !row._rhs || !lookupsForTerminal(terminal, allLookups).includes(lookup)) {
      return null;
    }
    const value = row._rhs.getValue();
    if ((kind === "value" && !literalValueComplete(lookup, value)) || (kind !== "value" && (!permitsExpressionRhs(lookup) || !value))) {
      return null;
    }
    if (kind !== "value" && (!row._rhs.picker || !row._rhs.picker.terminal() || row._rhs.picker.terminal().role === "relation")) {
      return null;
    }
    if (kind === "outer" && !outer) {
      return null;
    }
    const term = { field, lookup, rhs: kind === "value" ? { kind, value } : { field: value, kind } };
    if (terminal.type) { term.fieldType = terminal.type; }
    if (row.querySelector("[data-role=condition-negate]").checked) { term.negate = true; }
    if (row._field.toMany() || (kind === "field" && row._rhs.picker && row._rhs.picker.toMany())) { term.toMany = true; }
    return term;
  }

  /** Collects the optional condition group, rejecting the whole group if any visible row is incomplete. */
  function collect() {
    const rows = [...list.querySelectorAll("[data-role=column-condition]")];
    if (!rows.length) {
      return { conditions: undefined, invalid: false };
    }
    if (rows.length > MAX_CONDITIONS) {
      return { conditions: undefined, invalid: true };
    }
    const terms = rows.map((row) => {
      const term = readTerm(row);
      row.classList.toggle("invalid", !term);
      return term;
    });
    if (terms.some((term) => !term)) {
      return { conditions: undefined, invalid: true };
    }
    return { conditions: { join: joinCombo.node.value === "any" ? "any" : "all", terms }, invalid: false };
  }

  addButton.addEventListener("click", () => addTerm(null));
  refreshGroupUi();
  return { addTerm: () => addTerm(null), collect, node };
}

export const __test = { MAX_CONDITIONS, defaultLookup, inputTypeFor, isTruthy, literalValueComplete, lookupsForTerminal, permitsExpressionRhs };
