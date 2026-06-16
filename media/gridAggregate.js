// Unified "+ Column" builder for the model data browser.
// Each term defines one computed column — a raw annotate expression, an aggregate (Count/Sum/Avg/Min/Max over a field or
// relation), a window function (Rank/DenseRank/RowNumber/running Sum/Avg/Min/Max/Count with partition + order), or an
// F-expression. A group-by section is the toggle: no group-by → the terms are per-row annotation columns added to the
// grid; with group-by → the rows collapse into per-group summaries. Field/relation identifiers are picked from comboboxes.

import { createCombobox } from "./gridCombobox.js";
import { createPathPicker, createTreeService } from "./gridFieldPath.js";

const KINDS = [{ label: "Aggregate", value: "aggregate" }, { label: "Subquery", value: "subquery" }, { label: "Annotate", value: "annotate" }, { label: "Window", value: "window" }, { label: "Expr (F)", value: "expr" }];
const AGG_FUNCS = [{ label: "Count", value: "count" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }];
const WINDOW_FUNCS = [{ label: "Rank", value: "rank" }, { label: "DenseRank", value: "dense_rank" }, { label: "RowNumber", value: "row_number" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }, { label: "Count", value: "count" }];
const WINDOW_AGG = new Set(["sum", "avg", "min", "max", "count"]);
const OPS = [{ label: "+", value: "+" }, { label: "−", value: "-" }, { label: "×", value: "*" }, { label: "÷", value: "/" }];
const ORDER_DIR = [{ label: "asc", value: "asc" }, { label: "desc", value: "desc" }];
const SUBQUERY_MODES = [{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }];

/** Returns the bare model name from an "app.Model" label. */
function bareModel(target) {
  return String(target || "").split(".").pop();
}

/** Creates the column-builder controller bound to the term and group-by containers. */
export function createColumnBuilder(deps) {
  const { el, groupEl, termsEl, getState, postRaw } = deps;
  const treeService = createTreeService(postRaw);
  const modelRequests = new Map();
  let modelRequestSeq = 0;
  let modelOptionsCache = null;

  /** Returns concrete (non-computed) field options for window/partition/order pickers. */
  function concreteFields() {
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ label: column.attname, title: column.type, value: column.attname }));
  }

  /** Returns the root level's relations: the filter tree's relations, or the flat reverse/M2M relations as a fallback (ORM mode). */
  function relationsOf(tree) {
    if (tree) {
      return tree.relations || [];
    }
    return (getState().relations || []).map((relation) => ({ ...relation, name: relation.queryName || relation.name })).filter((relation) => relation.name && relation.target);
  }

  /** Returns the concrete-field options at a level (the tree's leaves, or the model's own columns as a fallback). */
  function levelFields(tree) {
    if (tree) {
      return (tree.fields || []).map((field) => ({ attname: field.attname, type: field.type }));
    }
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ attname: column.attname, type: column.type }));
  }

  /** Root options for an aggregate-field path picker: concrete fields, computed @property, and relations (drill into FKs). */
  function aggRootOptions(tree) {
    const options = [];
    for (const field of levelFields(tree)) {
      options.push({ label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const column of getState().columns || []) {
      if (column.computed) {
        options.push({ group: "computed @property", label: column.attname, role: "field", title: "@property (Socket/Auto, when summarizing)", value: `f:${column.attname}` });
      }
    }
    for (const relation of relationsOf(tree)) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → drill in`, value: `r:${relation.name}` });
    }
    return options;
  }

  /** Root options for a group-by path picker: concrete fields + relations (drill into FKs to a related field). */
  function groupRootOptions(tree) {
    const options = [];
    for (const field of levelFields(tree)) {
      options.push({ label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const relation of relationsOf(tree)) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → drill in`, value: `r:${relation.name}` });
    }
    return options;
  }

  /** Root relation options for the Subquery builder, including forward FK columns from the flat schema fallback. */
  function subqueryRelationOptions(tree) {
    const options = [];
    for (const relation of relationsOf(tree)) {
      options.push({ ...relation, group: "relations", label: `${relation.name} →`, role: "relation", title: `${relation.kind} → ${bareModel(relation.target)}`, value: relation.name });
    }
    if (!tree) {
      for (const column of getState().columns || []) {
        if (column.relation) {
          options.push({ ...column.relation, group: "foreign keys", kind: "fk", label: `${column.relation.field} →`, name: column.relation.field, role: "relation", title: `FK → ${bareModel(column.relation.target)}`, value: column.relation.field });
        }
      }
    }
    return options;
  }

  /** Root field options for a target-model Subquery value/order picker. */
  function subqueryTargetOptions(tree) {
    const options = [];
    for (const field of (tree && tree.fields) || []) {
      options.push({ label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const relation of (tree && tree.relations) || []) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → ${bareModel(relation.target)} (drill in)`, value: `r:${relation.name}` });
    }
    return options;
  }

  /** Resolves a pending model-list request for the Subquery target-model picker. */
  function onModelListResponse(message) {
    const entry = modelRequests.get(message.requestId);
    if (!entry) { return; }
    modelRequests.delete(message.requestId);
    const result = message.result && message.result.ok ? message.result : null;
    const options = result ? (result.models || []).map((model) => ({ label: `${model.app}.${model.model}`, title: model.table || model.label || "", value: `${model.app}.${model.model}` })) : [];
    modelOptionsCache = options;
    entry.resolve(options);
  }

  /** Returns model options for the custom Subquery mode, fetched once per panel. */
  function fetchModelOptions() {
    if (modelOptionsCache) { return Promise.resolve(modelOptionsCache); }
    return new Promise((resolve) => {
      const requestId = `models-${(modelRequestSeq += 1)}`;
      modelRequests.set(requestId, { resolve });
      postRaw({ requestId, type: "modelList" });
    });
  }

  /** Creates a cascading FK-drill path picker for one field selector. */
  function pathPicker(rootOptions, placeholder) {
    return createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => getState().model, placeholder, rootOptions });
  }

  /** Appends one group-by field picker row (drills through FKs to a related field). */
  function addGroupBy() {
    const row = el("span", { className: "aggchip" });
    const picker = pathPicker(groupRootOptions, "field / fk →");
    const remove = el("button", { className: "chipx", title: "Remove group-by field", type: "button" }, "✕");
    remove.addEventListener("click", () => row.remove());
    row._picker = picker;
    row.append(picker.node, remove);
    groupEl.appendChild(row);
  }

  /** Appends one removable field combobox to a window partition/order list, returning a value getter. */
  function addFieldChip(wrap, value, withDirection, desc) {
    const chip = el("span", { className: "winchip" });
    const combo = createCombobox({ el, options: concreteFields(), placeholder: "field", value: value || "" });
    const dir = withDirection ? createCombobox({ el, options: ORDER_DIR, value: desc ? "desc" : "asc" }) : null;
    const remove = el("button", { className: "chipx", title: "Remove", type: "button" }, "✕");
    remove.addEventListener("click", () => chip.remove());
    chip.append(combo.node, ...(dir ? [dir.node] : []), remove);
    chip._read = () => (withDirection ? { desc: dir.node.value === "desc", field: combo.node.value } : combo.node.value);
    wrap.appendChild(chip);
  }

  /** Builds the aggregate sub-controls (func · FK-drill field path · distinct) and returns a spec getter. */
  function aggregateBody(body, initial) {
    const funcCombo = createCombobox({ el, options: AGG_FUNCS, value: (initial && initial.func) || "count" });
    const picker = pathPicker(aggRootOptions, "all rows / field / fk →");
    const distinct = el("input", { checked: Boolean(initial && initial.distinct), title: "Count distinct values", type: "checkbox" });
    const distinctLabel = el("label", { className: "aggdistinct" }, distinct, "distinct");
    const sync = () => { distinctLabel.style.display = funcCombo.node.value === "count" ? "" : "none"; };
    funcCombo.node.addEventListener("change", sync);
    body.append(funcCombo.node, document.createTextNode(" of "), picker.node, distinctLabel);
    sync();
    return () => ({ distinct: distinct.checked, field: picker.getPath(), func: funcCombo.node.value, toMany: picker.toMany() });
  }

  /** Builds the window sub-controls (func · field · partition · order) and returns a spec getter. */
  function windowBody(body, initial) {
    const funcCombo = createCombobox({ el, options: WINDOW_FUNCS, value: (initial && initial.func) || "row_number" });
    const fieldCombo = createCombobox({ el, options: concreteFields(), value: (initial && initial.field) || "" });
    const partWrap = el("span", { className: "winwrap" });
    const orderWrap = el("span", { className: "winwrap" });
    const addPart = el("button", { className: "linkbtn", type: "button", title: "Add partition field" }, "+part");
    const addOrder = el("button", { className: "linkbtn", type: "button", title: "Add order field" }, "+order");
    addPart.addEventListener("click", () => addFieldChip(partWrap, "", false));
    addOrder.addEventListener("click", () => addFieldChip(orderWrap, "", true, false));
    const sync = () => { fieldCombo.node.style.display = WINDOW_AGG.has(funcCombo.node.value) ? "" : "none"; };
    funcCombo.node.addEventListener("change", sync);
    for (const field of (initial && initial.partitionBy) || []) { addFieldChip(partWrap, field, false); }
    for (const term of (initial && initial.orderBy) || []) { addFieldChip(orderWrap, term.field, true, term.desc); }
    body.append(funcCombo.node, document.createTextNode(" of "), fieldCombo.node, el("span", { className: "tag" }, "over part:"), partWrap, addPart, el("span", { className: "tag" }, "order:"), orderWrap, addOrder);
    sync();
    return () => ({
      field: fieldCombo.node.value,
      func: funcCombo.node.value,
      orderBy: [...orderWrap.querySelectorAll(".winchip")].map((chip) => chip._read()).filter((term) => term.field),
      partitionBy: [...partWrap.querySelectorAll(".winchip")].map((chip) => chip._read()).filter(Boolean)
    });
  }

  /** Builds the F-expression sub-controls (left op right) and returns a spec getter. */
  function exprBody(body, initial) {
    const left = el("input", { className: "aggalias", placeholder: "field / number", spellcheck: false, type: "text", value: (initial && initial.left != null ? String(initial.left) : "") });
    const opCombo = createCombobox({ el, options: OPS, value: (initial && initial.op) || "+" });
    const right = el("input", { className: "aggalias", placeholder: "field / number", spellcheck: false, type: "text", value: (initial && initial.right != null ? String(initial.right) : "") });
    body.append(left, opCombo.node, right);
    return () => ({ left: left.value.trim(), op: opCombo.node.value, right: right.value.trim() });
  }

  /** Builds the Subquery sub-controls (relation · value field · order field) and returns a spec getter. */
  function subqueryBody(body, initial) {
    const modeCombo = createCombobox({ el, onChange: () => rebuildMode(), options: SUBQUERY_MODES, value: initial && initial.target && !initial.relation ? "model" : "relation" });
    const content = el("span", { className: "termbody" });
    let readMode = () => ({});
    body.append(modeCombo.node, content);

    /** Rebuilds the Subquery controls when switching between relation-derived and arbitrary-model comparisons. */
    function rebuildMode() {
      content.innerHTML = "";
      readMode = modeCombo.node.value === "model" ? subqueryModelBody(content, initial) : subqueryRelationBody(content, initial);
    }

    rebuildMode();
    return () => readMode();
  }

  /** Builds Subquery controls for a selected relation on the current model. */
  function subqueryRelationBody(body, initial) {
    const relationMap = new Map();
    const relationCombo = createCombobox({ el, onChange: () => rebuildPickers(), options: [], placeholder: "relation →", value: (initial && initial.relation) || "" });
    const valueSlot = el("span", { className: "pathpick" });
    const orderSlot = el("span", { className: "pathpick" });
    const dirCombo = createCombobox({ el, options: ORDER_DIR, value: initial && initial.orderBy && initial.orderBy[0] && initial.orderBy[0].desc ? "desc" : "asc" });
    let targetModel = "";
    let valuePicker = null;
    let orderPicker = null;
    body.append(document.createTextNode("from "), relationCombo.node, document.createTextNode(" take "), valueSlot, document.createTextNode(" order "), orderSlot, dirCombo.node);
    treeService.fetchTree(getState().model).then((tree) => {
      const options = subqueryRelationOptions(tree);
      relationMap.clear();
      for (const option of options) { relationMap.set(option.value, option); }
      relationCombo.setOptions(options);
      if (initial && initial.relation) { relationCombo.setValue(initial.relation); }
      rebuildPickers();
    });

    /** Rebuilds target-model value/order pickers after the relation changes. */
    function rebuildPickers() {
      const relation = relationMap.get(relationCombo.node.value);
      targetModel = relation && relation.target ? relation.target : "";
      valueSlot.innerHTML = "";
      orderSlot.innerHTML = "";
      valuePicker = null;
      orderPicker = null;
      if (!targetModel) {
        valueSlot.appendChild(el("span", { className: "tag" }, "field"));
        orderSlot.appendChild(el("span", { className: "tag" }, "field"));
        return;
      }
      valuePicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "value field", rootOptions: subqueryTargetOptions });
      orderPicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "order field", rootOptions: subqueryTargetOptions });
      valueSlot.appendChild(valuePicker.node);
      orderSlot.appendChild(orderPicker.node);
    }

    return () => {
      const relation = relationMap.get(relationCombo.node.value) || {};
      const orderField = orderPicker ? orderPicker.getPath() : "";
      return {
        field: valuePicker ? valuePicker.getPath() : "",
        filterField: relation.filterField,
        orderBy: orderField ? [{ desc: dirCombo.node.value === "desc", field: orderField }] : [],
        outerField: relation.outerField,
        relation: relationCombo.node.value,
        relationKind: relation.kind,
        target: relation.target,
        throughOwner: relation.throughOwner,
        throughRelation: relation.throughRelation,
        throughSource: relation.throughSource,
        throughTarget: relation.throughTarget
      };
    };
  }

  /** Builds Subquery controls for an arbitrary target model compared to a current-row field. */
  function subqueryModelBody(body, initial) {
    const modelCombo = createCombobox({ el, onChange: () => rebuildTargetPickers(), options: [], placeholder: "app.Model", value: (initial && initial.target) || "" });
    const filterSlot = el("span", { className: "pathpick" });
    const outerSlot = el("span", { className: "pathpick" });
    const valueSlot = el("span", { className: "pathpick" });
    const orderSlot = el("span", { className: "pathpick" });
    const dirCombo = createCombobox({ el, options: ORDER_DIR, value: initial && initial.orderBy && initial.orderBy[0] && initial.orderBy[0].desc ? "desc" : "asc" });
    let filterPicker = null;
    let outerPicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => getState().model, placeholder: "current field", rootOptions: subqueryTargetOptions });
    let valuePicker = null;
    let orderPicker = null;
    body.append(document.createTextNode("from "), modelCombo.node, document.createTextNode(" where "), filterSlot, document.createTextNode(" = current "), outerSlot, document.createTextNode(" take "), valueSlot, document.createTextNode(" order "), orderSlot, dirCombo.node);
    outerSlot.appendChild(outerPicker.node);
    fetchModelOptions().then((options) => {
      modelCombo.setOptions(options);
      if (initial && initial.target) { modelCombo.setValue(initial.target); }
      rebuildTargetPickers();
    });

    /** Rebuilds target-model field pickers after the arbitrary target model changes. */
    function rebuildTargetPickers() {
      filterSlot.innerHTML = "";
      valueSlot.innerHTML = "";
      orderSlot.innerHTML = "";
      filterPicker = null;
      valuePicker = null;
      orderPicker = null;
      const targetModel = modelCombo.node.value;
      if (!targetModel) {
        filterSlot.appendChild(el("span", { className: "tag" }, "target field"));
        valueSlot.appendChild(el("span", { className: "tag" }, "value field"));
        orderSlot.appendChild(el("span", { className: "tag" }, "order field"));
        return;
      }
      filterPicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "target field", rootOptions: subqueryTargetOptions });
      valuePicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "value field", rootOptions: subqueryTargetOptions });
      orderPicker = createPathPicker({ el, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "order field", rootOptions: subqueryTargetOptions });
      filterSlot.appendChild(filterPicker.node);
      valueSlot.appendChild(valuePicker.node);
      orderSlot.appendChild(orderPicker.node);
    }

    return () => {
      const orderField = orderPicker ? orderPicker.getPath() : "";
      return {
        field: valuePicker ? valuePicker.getPath() : "",
        filterField: filterPicker ? filterPicker.getPath() : "",
        orderBy: orderField ? [{ desc: dirCombo.node.value === "desc", field: orderField }] : [],
        outerField: outerPicker ? outerPicker.getPath() : "",
        target: modelCombo.node.value
      };
    };
  }

  /** Builds the raw annotate-expression sub-control and returns a spec getter. */
  function annotateBody(body, initial) {
    const expression = el("input", {
      className: "aggexpr",
      placeholder: "models.F('field') / models.Subquery(...)",
      spellcheck: false,
      title: "Django expression passed to annotate(alias=...)",
      type: "text",
      value: (initial && initial.expression != null ? String(initial.expression) : "")
    });
    body.append(expression);
    return () => ({ expression: expression.value.trim() });
  }

  /** Appends one column term row whose body switches on the selected kind. */
  function addTerm(initial) {
    let seed = initial || {};
    const row = el("span", { className: "aggterm" });
    const kindCombo = createCombobox({ el, options: KINDS, value: seed.kind || "aggregate" });
    const body = el("span", { className: "termbody" });
    const alias = el("input", { className: "aggalias", placeholder: "as alias", spellcheck: false, type: "text", value: seed.alias || "" });
    const remove = el("button", { className: "chipx", title: "Remove column", type: "button" }, "✕");
    remove.addEventListener("click", () => row.remove());
    let readBody = () => ({});
    const rebuild = () => {
      body.innerHTML = "";
      const kind = kindCombo.node.value;
      readBody = kind === "annotate" ? annotateBody(body, seed) : kind === "subquery" ? subqueryBody(body, seed) : kind === "window" ? windowBody(body, seed) : kind === "expr" ? exprBody(body, seed) : aggregateBody(body, seed);
    };
    kindCombo.node.addEventListener("change", () => { seed = {}; rebuild(); });
    row._read = () => ({ alias: alias.value.trim(), kind: kindCombo.node.value, ...readBody() });
    row.append(kindCombo.node, body, document.createTextNode(" as "), alias, remove);
    termsEl.appendChild(row);
    rebuild();
  }

  /** Returns a default alias for a term when the user left it blank. */
  function defaultAlias(spec) {
    if (spec.kind === "annotate") { return "annotate"; }
    if (spec.kind === "expr") { return "expr"; }
    if (spec.kind === "subquery") { return `${spec.relation || "related"}_${spec.field || "value"}`.replace(/[^A-Za-z0-9_]+/g, "_"); }
    if (spec.kind === "window") { return spec.func + (WINDOW_AGG.has(spec.func) && spec.field ? `_${spec.field}` : ""); }
    return `${spec.field && spec.field !== "*" ? spec.field : "rows"}_${spec.func}`;
  }

  /** Ensures at least one term row exists (used when the panel first opens). */
  function ensureRows() {
    if (!termsEl.querySelector(".aggterm")) { addTerm(null); }
  }

  /** Collects the group-by fields and column terms (with defaulted aliases). A Count over a to-many relation is forced
   * distinct; a Sum/Avg/Min/Max over a to-many relation is dropped (JOIN fan-out can't be de-duplicated), reported via droppedToMany. */
  function collect() {
    const groupBy = [];
    for (const row of groupEl.querySelectorAll(".aggchip")) {
      const value = row._picker.getPath();
      if (value && !groupBy.includes(value)) { groupBy.push(value); }
    }
    const terms = [];
    let droppedToMany = 0;
    for (const row of termsEl.querySelectorAll(".aggterm")) {
      const spec = row._read();
      if (spec.kind === "aggregate" && spec.toMany) {
        if (spec.func === "count") {
          spec.distinct = true;
        } else {
          droppedToMany += 1;
          continue;
        }
      }
      delete spec.toMany;
      if (!spec.alias) { spec.alias = defaultAlias(spec); }
      terms.push(spec);
    }
    return { droppedToMany, groupBy, terms };
  }

  /** Clears every term and group-by row. */
  function clear() {
    groupEl.innerHTML = "";
    termsEl.innerHTML = "";
  }

  return { addGroupBy: () => addGroupBy(), addTerm: () => addTerm(null), clear, collect, ensureRows, onModelListResponse, onTreeResponse: treeService.onTreeResponse };
}

/** Builds the read-only result table for a grouped (collapse) aggregate response; group-by columns are emphasized. */
export function renderAggregateResult(result, helpers) {
  const { el, renderValue, groupBy } = helpers;
  const groups = new Set(groupBy || []);
  const columns = result.columns || [];
  const table = el("table", { className: "aggresult" });
  const head = el("thead", {});
  const headRow = el("tr", {});
  for (const column of columns) {
    headRow.appendChild(el("th", { className: groups.has(column.attname) ? "agggroupcol" : "" }, column.attname));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody", {});
  for (const row of result.rows || []) {
    const tr = el("tr", {});
    for (const column of columns) {
      const td = el("td", { className: groups.has(column.attname) ? "agggroupcol" : "" });
      td.appendChild(renderValue(row[column.attname]));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}
