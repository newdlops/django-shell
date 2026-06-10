// Cascading relation-traversal filter bar for the model data browser.
// Each term is a chain of field/relation dropdowns (field → ▸relation → field → … → lookup → value).
// Relation segments are fetched lazily from the backend `filterfields` tree (cached per model) so the
// user can drill across foreign keys (author__profile__city) instead of only the model's own fields.
// The field/relation, operator, and enum-choice dropdowns are searchable comboboxes (type to filter).

import { createCombobox } from "./gridCombobox.js";

const REL = "r:";
const FIELD = "f:";
const TEXT_TYPES = /Char|Text|Email|Slug|URL|UUID|IP|File|FilePath|Duration|Generic/;
const NUM_TYPES = /Integer|Float|Decimal|AutoField/;
// Readable operator labels (the value stays the Django lookup name); "(i)" = case-insensitive.
const LOOKUP_LABEL = {
  exact: "=", iexact: "= (i)", contains: "contains", icontains: "contains (i)", gt: ">", gte: "≥", lt: "<", lte: "≤",
  startswith: "starts with", istartswith: "starts with (i)", endswith: "ends with", iendswith: "ends with (i)",
  in: "in (list)", isnull: "is null", range: "between", date: "date =", year: "year", month: "month", day: "day"
};

/** Returns a sensible default operator for a freshly-picked terminal (contains for text, = otherwise, is-null for a relation). */
function defaultLookup(terminal, names) {
  if (!terminal || terminal.role === "relation") {
    return names[0];
  }
  if (TEXT_TYPES.test(String(terminal.type || ""))) {
    return names.includes("icontains") ? "icontains" : names[0];
  }
  return names.includes("exact") ? "exact" : names[0];
}

/** Returns the {app, model} parts of an "app.Model" label (app labels never contain dots). */
function splitTarget(target) {
  const at = String(target || "").lastIndexOf(".");
  return at < 0 ? { app: "", model: String(target || "") } : { app: target.slice(0, at), model: target.slice(at + 1) };
}

/** Returns the lookups that make sense for one terminal segment, all within the backend allowlist. */
function lookupsForTerminal(terminal, all) {
  if (!terminal || terminal.role === "relation") {
    return ["isnull"];
  }
  if (terminal.role === "computed") {
    return all;
  }
  const type = String(terminal.type || "");
  if (type === "annotation") {
    // Annotation/aggregate columns filter post-aggregation (HAVING / WHERE-on-expression) — numeric-style lookups only.
    return ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  }
  if (type === "pk") {
    return ["exact", "in", "isnull"];
  }
  if (type === "BooleanField") {
    return ["exact", "isnull"];
  }
  if (type === "DateTimeField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "month", "day", "isnull"];
  }
  if (type === "DateField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "year", "month", "day", "isnull"];
  }
  if (type === "TimeField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "isnull"];
  }
  if (NUM_TYPES.test(type)) {
    return ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  }
  if (TEXT_TYPES.test(type)) {
    return ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"];
  }
  return all;
}

/** Returns the native input type for a value box given the field type (date/datetime/time/number/text). The synthetic `pk` entry stays text — a number box would silently drop a UUID/char primary key. */
function inputTypeFor(type) {
  if (type === "pk") { return "text"; }
  if (type === "annotation") { return "number"; }
  if (type === "DateField") { return "date"; }
  if (type === "DateTimeField") { return "datetime-local"; }
  if (type === "TimeField") { return "time"; }
  if (NUM_TYPES.test(String(type || ""))) { return "number"; }
  return "text";
}

/** Creates the cascading filter-bar controller bound to the term/active-filter containers. */
export function createFilterBar(deps) {
  const { el, termsEl, activeEl, getState, postRaw, lookups } = deps;
  const treeCache = new Map();
  const pending = new Map();
  let requestSeq = 0;
  let syncToken = 0;

  /** Resolves a previously requested filter tree (null on failure → caller falls back to flat fields). */
  function onTreeResponse(message) {
    const entry = pending.get(message.requestId);
    if (!entry) { return; }
    pending.delete(message.requestId);
    const tree = message.result && message.result.ok ? message.result : null;
    if (tree) { treeCache.set(entry.target, tree); }
    entry.resolve(tree);
  }

  /** Returns the filter tree for one "app.Model" target, fetching it once and caching the result. */
  function fetchTree(target) {
    if (treeCache.has(target)) { return Promise.resolve(treeCache.get(target)); }
    const parts = splitTarget(target);
    return new Promise((resolve) => {
      const requestId = ++requestSeq;
      pending.set(requestId, { resolve, target });
      postRaw({ app: parts.app, model: parts.model, requestId, type: "filterFields" });
    });
  }

  /** Builds the root option list: synthetic pk, concrete leaves, computed @property leaves, then traversable relations. */
  function rootOptions(tree) {
    const state = getState();
    const options = [];
    if (tree) {
      for (const field of tree.fields || []) {
        if (field.attname === state.pk) { continue; }
        options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
      }
    } else {
      for (const column of state.columns || []) {
        if (column.computed || column.attname === state.pk) { continue; }
        options.push({ choices: column.choices, label: column.attname, role: "field", type: column.type, value: `${FIELD}${column.attname}` });
      }
    }
    const pkColumn = (state.columns || []).find((column) => column.pk && !column.computed);
    options.push({ label: "pk", role: "field", title: "primary key", type: pkColumn ? pkColumn.type : "pk", value: `${FIELD}pk` });
    for (const column of state.columns || []) {
      if (column.computed) {
        options.push({ label: column.attname, role: "computed", title: "computed @property", type: "property", value: `${FIELD}${column.attname}` });
      }
    }
    // Per-row annotation columns (rows view) and aggregate-result columns (collapse view) filter post-aggregation (HAVING). Window columns can't be filtered in SQL.
    for (const column of state.columns || []) {
      if (column.annotation && column.type !== "window") {
        options.push({ label: column.attname, role: "field", title: "computed column · filter as HAVING", type: "annotation", value: `${FIELD}${column.attname}` });
      }
    }
    for (const name of state.aggregateColumns || []) {
      options.push({ label: name, role: "field", title: "aggregate column · filter as HAVING", type: "annotation", value: `${FIELD}${name}` });
    }
    for (const relation of relationsOf(tree, state)) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → ${bareModel(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }

  /** Builds option lists for a related model (concrete leaves + further relations, no synthetic pk/computed). */
  function nestedOptions(tree) {
    const options = [];
    for (const field of (tree && tree.fields) || []) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
    }
    for (const relation of (tree && tree.relations) || []) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → ${bareModel(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }

  /** Returns the tree's relations (filter query names) or, when the tree is unavailable, the flat schema relations mapped to their filter query name (reverse relations differ from the `_set` accessor). */
  function relationsOf(tree, state) {
    return tree ? tree.relations || [] : (state.relations || []).map((relation) => ({ kind: relation.kind, name: relation.queryName || relation.name, single: relation.single, target: relation.target }));
  }

  /** Returns the bare model name from an "app.Model" label. */
  function bareModel(target) {
    return splitTarget(target).model;
  }

  /** Appends one filter term row and wires its cascading selects, lookup, value, negate and remove controls. */
  async function addTerm(initial) {
    const term = el("span", { className: "term" });
    term._segs = [];
    const path = el("span", { className: "path", dataset: { role: "path" } });
    const lookupCombo = createCombobox({ dataset: { role: "lookup" }, el, onChange: () => rebuildValue(term), options: [], placeholder: "—" });
    term._lookupCombo = lookupCombo;
    const value = el("span", { className: "valwrap", dataset: { role: "value" } });
    const negate = el("input", { checked: Boolean(initial && initial.negate), dataset: { role: "negate" }, type: "checkbox" });
    const remove = el("button", { className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, "✕");
    remove.addEventListener("click", () => term.remove());
    term.append(path, lookupCombo.node, value, el("label", { className: "neg" }, negate, "not"), remove);
    termsEl.appendChild(term);
    const token = syncToken;
    const rootTree = await fetchTree(getState().model);
    if (token !== syncToken) {
      // A newer sync()/clear() superseded this term while its tree was loading — drop the stale continuation.
      term.remove();
      return term;
    }
    await buildSegment(term, 0, rootOptions(rootTree), initial ? segsFromPath(initial.field) : [], initial);
    return term;
  }

  /** Splits a saved filter path into the segment names to preselect (rel:/pk/field aware). */
  function segsFromPath(field) {
    const text = String(field || "");
    if (text.startsWith("rel:")) { return [text.slice(4)]; }
    return text ? text.split("__") : [];
  }

  /** Builds the searchable combobox for one path level, preselecting from a saved path and drilling into relations as needed. */
  async function buildSegment(term, level, options, preset, initial) {
    const comboOptions = options.map((option) => ({ group: option.role === "relation" ? "relations (drill in →)" : "", label: option.label, title: option.title || "", value: option.value }));
    const presetValue = preset[level];
    // An unmatched preset (e.g. saved path absent from a changed/flat-fallback option set) stays on the empty
    // placeholder rather than silently binding the first field, so collect() never emits the wrong field.
    const match = presetValue === undefined ? null : options.find((option) => option.value === `${REL}${presetValue}` || option.value === `${FIELD}${presetValue}`);
    const combo = createCombobox({ dataset: { level: String(level), role: "seg" }, el, onChange: () => void onSegmentChange(term, level), options: comboOptions, placeholder: level === 0 ? "— pick field / relation —" : "— exists / pick field —", value: match ? match.value : "" });
    const select = combo.node;
    // currentOption()/terminalOf() read the ORIGINAL option objects (role/target/type/choices), not the trimmed combo records.
    select._options = options;
    term._segs[level] = { combo, select };
    term.querySelector("[data-role=path]").appendChild(select);
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && preset.length > level + 1) {
      // Saved path drills deeper through this relation → fetch its target and rebuild the next level.
      const tree = await fetchTree(chosen.target);
      await buildSegment(term, level + 1, nestedOptions(tree), preset, initial);
      return;
    }
    // Field terminal, or a saved path that ends on the relation itself (existence/isnull terminal): stop here.
    refreshLookups(term, initial);
  }

  /** Returns the option object currently selected in a segment select. */
  function currentOption(select) {
    return (select._options || []).find((option) => option.value === select.value) || null;
  }

  /** Handles a segment change: truncate deeper levels, expand a chosen relation, then refresh lookup/value. */
  async function onSegmentChange(term, level) {
    for (let deeper = term._segs.length - 1; deeper > level; deeper -= 1) {
      const seg = term._segs[deeper];
      if (seg && seg.select) { seg.select.remove(); }
      term._segs.pop();
    }
    const select = term._segs[level].select;
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && select.value) {
      const expected = select.value;
      const tree = await fetchTree(chosen.target);
      if (select.value !== expected || !term._segs[level] || term._segs[level].select !== select) {
        // The user re-selected this segment while its tree was loading — let the newer change own the next level.
        return;
      }
      await buildSegment(term, level + 1, nestedOptions(tree), [], null);
      return;
    }
    refreshLookups(term);
  }

  /** Returns the deepest segment that carries a selection — the term's terminal field or relation. */
  function terminalOf(term) {
    for (let level = term._segs.length - 1; level >= 0; level -= 1) {
      const seg = term._segs[level];
      if (seg && seg.select && seg.select.value) {
        return currentOption(seg.select);
      }
    }
    return null;
  }

  /** Repopulates the lookup select for the current terminal and rebuilds the matching value control. A fresh field selection defaults to a useful operator (contains/=), NOT the prior isnull. */
  function refreshLookups(term, initial) {
    const combo = term._lookupCombo;
    const terminal = terminalOf(term);
    if (!terminal) {
      // Nothing picked yet: no operator/value until the user chooses a field (collect() skips this empty term).
      combo.setOptions([]);
      combo.setValue("");
      term.querySelector("[data-role=value]").innerHTML = "";
      term._value = null;
      return;
    }
    const names = lookupsForTerminal(terminal, lookups);
    const preferred = (initial && initial.lookup) || defaultLookup(terminal, names);
    combo.setOptions(names.map((name) => ({ label: LOOKUP_LABEL[name] || name, value: name })));
    combo.setValue(names.includes(preferred) ? preferred : names[0]);
    rebuildValue(term, initial && initial.value);
  }

  /** Rebuilds the value control to match the terminal field type and selected lookup, carrying the current value across lookup changes. */
  function rebuildValue(term, presetValue) {
    const wrap = term.querySelector("[data-role=value]");
    const lookup = term.querySelector("[data-role=lookup]").value;
    const terminal = terminalOf(term);
    const carried = presetValue !== undefined ? presetValue : (term._value ? term._value.getValue() : undefined);
    const control = buildValueControl(terminal, lookup, carried);
    wrap.innerHTML = "";
    wrap.appendChild(control.node);
    term._value = control;
  }

  /** Builds a value control (null toggle, choices/boolean select, range pair, in-chips, typed input) for a lookup. */
  function buildValueControl(terminal, lookup, presetValue) {
    if (lookup === "isnull") {
      const select = el("select", {});
      select.append(el("option", { value: "false" }, "has value"), el("option", { value: "true" }, "is null"));
      select.value = isTruthy(presetValue) ? "true" : "false";
      return { getValue: () => select.value, node: select };
    }
    if (lookup === "range") {
      return rangePair(terminal, presetValue);
    }
    if (lookup === "in") {
      return chips(presetValue);
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && terminal.type === "BooleanField") {
      // Emit capitalized "True"/"False": Django's BooleanField.to_python accepts those (but NOT lowercase "true")
      // even when a relation-traversal path reaches it uncoerced in ORM/Terminal mode; the socket backend still coerces them.
      const select = el("select", {});
      select.append(el("option", { value: "True" }, "true"), el("option", { value: "False" }, "false"));
      select.value = isTruthy(presetValue) ? "True" : "False";
      return { getValue: () => select.value, node: select };
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && Array.isArray(terminal.choices) && terminal.choices.length) {
      const choiceOptions = terminal.choices.map((choice) => ({ label: `${choice[1]}`, value: String(choice[0]) }));
      // A carried value from a prior text lookup may be "" (or not a real choice); fall back to the first choice so the
      // combobox never renders blank and collect() never emits an empty value — matching a native <select>'s default.
      const carried = presetValue === undefined || presetValue === null ? "" : String(presetValue);
      const selected = choiceOptions.some((option) => option.value === carried) ? carried : (choiceOptions[0] ? choiceOptions[0].value : "");
      const combo = createCombobox({ el, options: choiceOptions, placeholder: "— choose —", value: selected });
      return { getValue: () => combo.getValue(), node: combo.node };
    }
    // `date` compares only the date portion → force a plain date picker (a datetime-local value Django's __date rejects).
    const type = lookup === "date" ? "DateField" : (["year", "month", "day"].includes(lookup) ? "IntegerField" : (terminal ? terminal.type : ""));
    const input = el("input", { type: inputTypeFor(type) });
    if (presetValue !== undefined && presetValue !== null) { input.value = String(presetValue); }
    return { getValue: () => input.value, node: input };
  }

  /** Builds a two-input from/to control for a `range` lookup. */
  function rangePair(terminal, presetValue) {
    const type = inputTypeFor(terminal ? terminal.type : "");
    const from = el("input", { className: "rangefrom", placeholder: "from", type });
    const to = el("input", { className: "rangeto", placeholder: "to", type });
    const parts = String(presetValue || "").split(",");
    from.value = (parts[0] || "").trim();
    to.value = (parts[1] || "").trim();
    const node = el("span", { className: "rangewrap" }, from, document.createTextNode(" – "), to);
    return { getValue: () => `${from.value},${to.value}`, node };
  }

  /** Builds an add-on-Enter chip control for `in` (comma-separated) value lists. */
  function chips(presetValue) {
    const values = [];
    const node = el("span", { className: "chips" });
    const input = el("input", { className: "chipinput", placeholder: "value + Enter", type: "text" });
    const render = () => {
      node.innerHTML = "";
      values.forEach((text, index) => {
        const close = el("button", { className: "chipx", title: "Remove", type: "button" }, "✕");
        close.addEventListener("click", () => { values.splice(index, 1); render(); });
        node.appendChild(el("span", { className: "filterchip" }, text, close));
      });
      node.appendChild(input);
    };
    const add = (text) => { const value = String(text).trim(); if (value) { values.push(value); } };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(input.value); input.value = ""; render(); input.focus(); }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) { add(input.value); input.value = ""; render(); } });
    for (const part of String(presetValue || "").split(",")) { add(part); }
    render();
    return { getValue: () => values.join(","), node };
  }

  /** Returns whether a stored value should read as the truthy side of a boolean/isnull control. */
  function isTruthy(value) {
    return /^(true|1|t|yes|on)$/i.test(String(value === undefined || value === null ? "" : value).trim());
  }

  /** Returns the `__`-joined query-name path for a term up to its terminal segment. */
  function pathOf(term) {
    const names = [];
    for (const seg of term._segs) {
      if (seg && seg.select && seg.select.value) {
        names.push(seg.select.value.slice(2));
      }
    }
    return names.join("__");
  }

  /** Collects every term row into structured {field, lookup, value, negate} filters, skipping incomplete rows. */
  function collect() {
    const filters = [];
    for (const term of termsEl.querySelectorAll(".term")) {
      const field = pathOf(term);
      if (!field || !term._value) { continue; }
      const lookup = term.querySelector("[data-role=lookup]").value;
      const value = term._value.getValue();
      const negate = term.querySelector("[data-role=negate]").checked;
      filters.push({ field, lookup, negate, value });
    }
    return filters;
  }

  /** Rebuilds the term rows from a saved filter list (async tree fetches guarded by a sync token). */
  function sync(filters) {
    const token = ++syncToken;
    termsEl.innerHTML = "";
    for (const filter of filters || []) {
      if (token !== syncToken) { return; }
      void addTerm(filter);
    }
  }

  /** Clears every term row. */
  function clear() {
    syncToken += 1;
    termsEl.innerHTML = "";
  }

  /** Renders the read-only "applied filters" chip summary. */
  function renderSummary(filters) {
    if (!activeEl) { return; }
    activeEl.innerHTML = "";
    if (!filters.length) {
      activeEl.appendChild(el("span", { className: "tag" }, "No filters"));
      return;
    }
    activeEl.appendChild(el("span", { className: "tag" }, "Applied"));
    for (const filter of filters) {
      activeEl.appendChild(el("span", { className: "filterchip", title: "Currently applied filter" }, describe(filter)));
    }
  }

  /** Returns a compact human description of one applied filter. */
  function describe(filter) {
    const field = String(filter.field || "").replace(/^rel:/, "").replace(/__/g, " ▸ ");
    const value = filter.lookup === "isnull" ? String(filter.value).toLowerCase() : String(filter.value == null ? "" : filter.value);
    return `${filter.negate ? "not " : ""}${field} ${filter.lookup} ${value}`.trim();
  }

  return { addTerm: () => void addTerm(null), clear, collect, describe, onTreeResponse, renderSummary, sync };
}
