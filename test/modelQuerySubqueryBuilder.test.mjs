// Focused contract tests for scalar-subquery and Exists computed draft limits.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createComputedDraft } from "../media/gridComputedShared.js";
import { __test as subquery, renderExistsComputedBuilder, renderSubqueryBuilder } from "../media/gridSubqueryBuilder.js";
import { resolveQuerySourceTarget } from "../media/gridQueryRelations.js";

test("scalar subquery drafts include the independent where root and scalar-only controls", () => {
  const item = createComputedDraft("scalarSubquery", "subquery-1", "latest_name");
  assert.equal(item.source.kind, "relation");
  assert.equal(item.select.kind, "field");
  assert.equal(item.where.kind, "group");
  assert.deepEqual(item.orderBy, []);
  assert.equal(item.onEmpty.kind, "literal");
});

test("Exists drafts reuse source/correlation/where but do not carry scalar select state", () => {
  const item = createComputedDraft("exists", "exists-1", "has_child");
  assert.equal(item.source.kind, "relation");
  assert.equal(item.where.kind, "group");
  assert.equal("select" in item, false);
  assert.equal("onEmpty" in item, false);
  assert.equal("orderBy" in item, false);
});

test("custom correlation and subquery order limits are bounded at four and three", () => {
  assert.equal(subquery.canAddCorrelation(Array.from({ length: 3 })), true);
  assert.equal(subquery.canAddCorrelation(Array.from({ length: 4 })), false);
  assert.equal(subquery.canAddOrder(Array.from({ length: 2 })), true);
  assert.equal(subquery.canAddOrder(Array.from({ length: 3 })), false);
});

test("subquery row choice moves only adjacent order entries and preserves boundaries", () => {
  const entries = [{ nodeId: "first" }, { nodeId: "second" }];
  assert.deepEqual(subquery.moveSubqueryOrder(entries, 1, -1), [{ nodeId: "second" }, { nodeId: "first" }]);
  assert.deepEqual(subquery.moveSubqueryOrder(entries, 0, -1), entries);
});

test("subquery field pickers use live filter-tree relation identities", () => {
  const scope = { source: { app: "db", model: "Company" } };
  const metadata = { getState: () => ({ tree: { fields: [], relations: [{ filterField: "company_id", name: "valuation_history", target: "db.ValuationHistory" }] } }) };
  assert.deepEqual(resolveQuerySourceTarget({ kind: "relation", relation: "valuation_history" }, scope.source, metadata), { app: "db", model: "ValuationHistory" });
  assert.deepEqual(resolveQuerySourceTarget({ kind: "relation", relation: "company_id" }, scope.source, metadata), { app: "db", model: "ValuationHistory" });
  assert.deepEqual(resolveQuerySourceTarget({ kind: "model", target: { app: "db", model: "Company" } }, scope.source, metadata), { app: "db", model: "Company" });
  assert.equal(resolveQuerySourceTarget({ kind: "relation", relation: "missing" }, scope.source, metadata), undefined);
});

test("scalar subquery editor exposes the six numbered assembly fieldsets in order", () => {
  const source = fs.readFileSync(new URL("../media/gridSubqueryBuilder.js", import.meta.url), "utf8");
  for (const label of ["1. Source", "2. Connection", "3. Target filter", "4. Returned value", "5. Row choice", "6. Output"]) { assert.ok(source.includes(label), `missing ${label}`); }
  const render = source.slice(source.indexOf("export function renderSubqueryBuilder"), source.indexOf("/** Renders an Exists"));
  const positions = ["sourceControls", "correlationControls", "targetFilter", "scalarControls"].map((name) => render.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

/** Creates the narrow local DOM surface used by rendered Subquery controls. */
function dom(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], dataset: properties.dataset || {}, classList: { add() {}, remove() {} }, addEventListener(type, listener) { listeners.set(type, listener); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, dispatch(type, event = {}) { listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); }, dispatchEvent(event) { this.dispatch(event.type, event); return true; }, focus() {}, select() {}, remove() {}, removeEventListener(type) { listeners.delete(type); }, replaceChildren(...items) { this.children = []; this.append(...items); }, setAttribute(name, value) { this[name] = String(value); }, querySelector(selector) { return this.querySelectorAll(selector)[0]; }, querySelectorAll(selector) { const found = []; const walk = (item) => { for (const child of item.children || []) { if ((selector === "input" && child.tag === "input") || (selector === "select" && child.tag === "select") || (selector === "option" && child.tag === "option")) { found.push(child); } walk(child); } }; walk(this); return found; }, tag }; Object.defineProperty(node, "textContent", { get: () => node.children.map((child) => typeof child === "string" ? child : child?.textContent || "").join(""), set: (value) => { node.children = [String(value)]; } }); if (tag === "option") { Object.defineProperty(node, "label", { get: () => properties.label || node.textContent }); } if (tag === "select") { Object.defineProperty(node, "options", { get: () => node.querySelectorAll("option") }); } node.append(...children); return node; }

/** Finds all native select controls below a rendered local test node. */
function selects(node, found = []) { if (node?.tag === "select") { found.push(node); } for (const child of node?.children || []) { selects(child, found); } return found; }

/** Finds the first local rendered node satisfying a predicate. */
function findNode(node, matches) { if (matches(node)) { return node; } for (const child of node?.children || []) { const found = findNode(child, matches); if (found) { return found; } } return undefined; }

/** Returns visible option labels below a native local select. */
function optionLabels(select) { return [...select.options].map((option) => option.label || option.textContent); }

test("rendered relation Subquery keeps target field controls separate from outer fields", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o1", ref: { kind: "field", path: "" } }], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "children" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } };
    const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [] }]]);
    const metadata = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return [{ app: "app", model: "Child" }]; } }; const actions = [];
    const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata, scope: { columns: [{ name: "outer" }], source: { app: "app", model: "Book" } } });
    await new Promise((done) => setImmediate(done)); const labels = selects(root).flatMap((select) => [...select.options].map((option) => option.label || option.textContent));
    assert.ok(labels.includes("target")); assert.equal(labels.includes("outer"), false); assert.deepEqual(actions, []); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("relation Subquery independently renders its target predicate comparison from target metadata", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "children" }, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "target" }, lookup: "exact", nodeId: "target-comparison", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" } };
    const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [] }]]);
    const root = renderSubqueryBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); await new Promise((done) => setImmediate(done));
    const predicateSelect = selects(root).find((select) => select.dataset.queryControlKey === "predicate-lhs-target-comparison-0"); assert.ok(predicateSelect); assert.ok(optionLabels(predicateSelect).includes("target")); assert.equal(optionLabels(predicateSelect).includes("outer"), false); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered relation source exposes safe, unsafe, reverse, and stale choices", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } };
    const tree = { fields: [], relations: [{ filterField: "book_id", kind: "forward_fk", label: "Children", name: "children", outerField: "id", target: "app.Child" }, { filterField: "book_id", kind: "reverse_fk", label: "Reverse", name: "reverse_query", outerField: "id", target: "app.Reverse" }, { filterField: "", kind: "many_to_many", name: "tags", outerField: "", target: "app.Tag", toMany: true }] };
    const actions = []; const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } });
    const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(root); })(); const options = combo._options;
    assert.deepEqual(options.map((option) => option.value), ["", "children", "reverse_query", "tags", "stale"]); assert.match(options[1].keywords, /children.*Children.*app\.Child.*forward fk.*one related row/); assert.equal(options[3].disabled, true); assert.match(options[3].disabledReason, /safe automatic/i); assert.equal(options[4].disabled, true);
    root.__queryDestroy(); assert.deepEqual(actions, []);
  } finally { globalThis.document = priorDocument; }
});

test("rendered relation combobox dispatches safe choices and rejects disabled choices", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } };
    const tree = { fields: [], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }, { filterField: "", name: "unsafe", outerField: "", target: "app.Unsafe" }] }; const actions = [];
    const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } });
    const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(root); })(); const input = combo.children.find((node) => node.tag === "input"); const list = combo.children.find((node) => node.tag === "div"); input.dispatch("focus");
    const children = list.children.filter((node) => node.className?.includes("cbx-opt")); children.find((node) => node.textContent.includes("children")).dispatch("click"); assert.deepEqual(actions[0], { changes: { source: { kind: "relation", relation: "children" } }, nodeId: "sub", type: "UPDATE_COMPUTED" });
    children.find((node) => node.textContent.includes("unsafe")).dispatch("click"); input.dispatch("keydown", { key: "ArrowDown" }); input.dispatch("keydown", { key: "Enter" }); assert.equal(actions.length, 1); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("incomplete and unresolved Subquery sources retain isolated target controls without clearing", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    for (const source of [{ kind: "model", target: { app: "", model: "" } }, { kind: "relation", relation: "missing" }]) {
      const item = { correlations: [{ nodeId: "c", outerPath: "outer", targetPath: "target" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "target" } }], outputType: "CharField", select: { field: { kind: "field", path: "target" }, kind: "field" }, source, where: { children: [], join: "and", kind: "group", nodeId: "where" } };
      const actions = []; const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree: { fields: [{ name: "outer", type: "CharField" }], relations: [] } }; }, getCatalog() { return []; } }, scope: { columns: [{ name: "outer" }], source: { app: "app", model: "Book" } } });
      await new Promise((done) => setImmediate(done)); assert.ok(root.textContent.includes("Choose a relation or model source before selecting a field.")); assert.deepEqual(actions, []); root.__queryDestroy();
    }
  } finally { globalThis.document = priorDocument; }
});

test("custom-model Subquery preserves separate target and outer correlation identities", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [{ nodeId: "c", outerPath: "", targetPath: "" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "" } }], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "model", target: { app: "app", model: "Child" } }, where: { children: [], join: "and", kind: "group", nodeId: "where" } };
    const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [] }]]); const actions = [];
    const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return [{ app: "app", model: "Child" }]; } }, scope: { source: { app: "app", model: "Book" } } });
    await new Promise((done) => setImmediate(done)); const controls = selects(root); const outer = controls.find((select) => select.ariaLabel === "Outer field"); const target = controls.find((select) => select.ariaLabel === "Target field"); assert.ok([...outer.options].some((option) => option.value === "field:outer")); assert.ok([...target.options].some((option) => option.value === "field:target")); outer.value = "field:outer"; outer.dispatch("change"); assert.equal(actions[0].changes.correlations[0].outerPath, "outer"); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("custom-model Subquery scopes predicate, returned, order, and target correlation fields to the target", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [{ nodeId: "c", outerPath: "", targetPath: "" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "" } }], outputType: "CharField", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "model", target: { app: "app", model: "Child" } }, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "target" }, lookup: "exact", nodeId: "where-target", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" } };
    const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [] }]]); const root = renderSubqueryBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return [{ app: "app", model: "Child" }]; } }, scope: { source: { app: "app", model: "Book" } } }); await new Promise((done) => setImmediate(done));
    const controls = selects(root); const targetOwned = [controls.find((select) => select.dataset.queryControlKey === "predicate-lhs-where-target-0"), controls.find((select) => select.ariaLabel === "Target field"), controls.find((select) => select.ariaLabel === "Subquery field"), controls.find((select) => select.ariaLabel === "Subquery order field")]; for (const control of targetOwned) { assert.ok(control); assert.ok(optionLabels(control).includes("target")); assert.equal(optionLabels(control).includes("outer"), false); } const outer = controls.find((select) => select.ariaLabel === "Outer field"); assert.ok(optionLabels(outer).includes("outer")); assert.equal(optionLabels(outer).includes("target"), false); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered source switches preserve incompatible Subquery-owned state until explicit reset", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [{ nodeId: "c", outerPath: "outer", targetPath: "old" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "old" } }], outputType: "CharField", select: { field: { kind: "field", path: "old" }, kind: "field" }, source: { kind: "relation", relation: "old_relation" }, where: { children: [{ kind: "comparison", nodeId: "w" }], join: "and", kind: "group", nodeId: "where" } };
    const tree = { fields: [], relations: [{ filterField: "book_id", name: "new_relation", outerField: "id", target: "app.New" }, { filterField: "book_id", name: "old_relation", outerField: "id", target: "app.Old" }] }; const actions = [];
    const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(root); })(); const input = combo.children.find((node) => node.tag === "input"); const list = combo.children.find((node) => node.tag === "div"); input.dispatch("focus"); list.children.filter((node) => node.className?.includes("cbx-opt")).find((node) => node.textContent.includes("new_relation")).dispatch("click");
    assert.deepEqual(actions[0], { changes: { source: { kind: "relation", relation: "new_relation" } }, nodeId: "sub", type: "UPDATE_COMPUTED" }); const next = { ...item, ...actions[0].changes }; assert.deepEqual(next.where, item.where); assert.deepEqual(next.select, item.select); assert.deepEqual(next.orderBy, item.orderBy); assert.deepEqual(next.correlations, item.correlations); assert.equal(actions.some((action) => action.changes?.orderBy?.length === 0 || action.changes?.correlations?.length === 0), false); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("source-switch rerender makes old target-owned fields unavailable without clearing them", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [{ nodeId: "c", outerPath: "outer", targetPath: "old" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "old" } }], outputType: "CharField", select: { field: { kind: "field", path: "old" }, kind: "field" }, source: { kind: "model", target: { app: "app", model: "Old" } }, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "old" }, lookup: "exact", nodeId: "old-where", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" } }; const actions = [];
    const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [] }], ["app.New", { fields: [{ name: "fresh", type: "CharField" }], relations: [] }], ["app.Old", { fields: [{ name: "old", type: "CharField" }], relations: [] }]]); const metadata = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return [{ app: "app", model: "Old" }, { app: "app", model: "New" }]; } }; const make = (current) => renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item: current, metadata, scope: { source: { app: "app", model: "Book" } } });
    const first = make(item); const combo = findNode(first, (node) => node?._options); const input = combo.children.find((node) => node.tag === "input"); input.dispatch("focus"); combo.children.find((node) => node.tag === "div").children.find((node) => node.textContent.includes("app.New")).dispatch("click"); first.__queryDestroy(); const next = { ...item, ...actions[0].changes }; const rerendered = make(next); await new Promise((done) => setImmediate(done));
    const controls = selects(rerendered); const staleControls = [controls.find((select) => select.dataset.queryControlKey === "predicate-lhs-old-where-0"), controls.find((select) => select.ariaLabel === "Target field"), controls.find((select) => select.ariaLabel === "Subquery field"), controls.find((select) => select.ariaLabel === "Subquery order field")]; for (const control of staleControls) { assert.ok(control); const old = [...control.options].find((option) => option.value === "unavailable:old"); assert.ok(old); assert.equal(old.disabled, true); assert.equal(old.label, "Unavailable field: old"); } const outer = controls.find((select) => select.ariaLabel === "Outer field"); assert.ok(outer); assert.ok([...outer.options].some((option) => option.value === "field:outer")); assert.equal([...outer.options].some((option) => option.value === "unavailable:old"), false); assert.equal(actions.length, 1); assert.equal(actions[0].changes.where, undefined); assert.equal(actions[0].changes.select, undefined); assert.equal(actions[0].changes.orderBy, undefined); assert.equal(actions[0].changes.correlations, undefined); rerendered.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("Reset incompatible fields is the explicit rendered clear path", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [{ nodeId: "c", outerPath: "outer", targetPath: "old" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "old" } }], outputType: "CharField", select: { field: { kind: "field", path: "old" }, kind: "field" }, source: { kind: "relation", relation: "old" }, where: { children: [{ kind: "comparison", nodeId: "w" }], join: "and", kind: "group", nodeId: "where" } }; const actions = []; const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree: { fields: [], relations: [{ filterField: "book_id", name: "old", outerField: "id", target: "app.Old" }] } }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); findNode(root, (node) => node?.tag === "button" && node.textContent === "Reset incompatible fields").dispatch("click"); assert.deepEqual(actions, [{ changes: { orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } }, nodeId: "sub", type: "UPDATE_COMPUTED" }]); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered Subquery relation lifecycle loads idle metadata and preserves non-ready state", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } }; let loads = 0; let retries = 0; let state = {};
    const metadata = { getState() { return state; }, loadTree() { loads += 1; return Promise.resolve(); }, retry() { retries += 1; return Promise.resolve(); }, getCatalog() { return []; } }; const root = renderSubqueryBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata, scope: { source: { app: "app", model: "Book" } } }); assert.equal(loads, 1); root.__queryDestroy();
    state = { error: "cached" }; const errorRoot = renderSubqueryBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata, scope: { source: { app: "app", model: "Book" } } }); const errorCombo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(errorRoot); })(); const errorInput = errorCombo.children.find((node) => node.tag === "input"); assert.equal(errorInput["aria-describedby"], "query-subquery-relation-error-sub"); assert.ok(errorRoot.textContent.includes("cached")); assert.equal(errorCombo._options.at(-1).value, "stale"); const retry = (() => { const walk = (node) => node?.tag === "button" && node.textContent === "Retry" ? node : (node?.children || []).map(walk).find(Boolean); return walk(errorRoot); })(); assert.equal(loads, 1); retry.dispatch("click"); retry.dispatch("click"); assert.equal(retries, 1); errorRoot.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("pending, empty, and stale Subquery source states remain visible without actions", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } }; const actions = [];
    for (const state of [{ pending: true }, { tree: { fields: [], relations: [] } }]) { const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return state; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(root); })(); assert.equal(combo._options.at(-1).value, "stale"); if (state.pending) { assert.equal(combo.children.find((node) => node.tag === "input").disabled, true); } else { assert.ok(root.textContent.includes("No related sources are available")); } root.__queryDestroy(); }
    assert.deepEqual(actions, []);
  } finally { globalThis.document = priorDocument; }
});

test("unresolved sources separately withhold each target-owned Subquery control", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    for (const source of [{ kind: "model", target: { app: "", model: "" } }, { kind: "relation", relation: "missing" }]) {
      const item = { correlations: [{ nodeId: "c", outerPath: "outer", targetPath: "old" }], kind: "scalarSubquery", nodeId: "sub", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "asc", nodeId: "o", ref: { kind: "field", path: "old" } }], outputType: "CharField", select: { field: { kind: "field", path: "old" }, kind: "field" }, source, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "old" }, lookup: "exact", nodeId: "w", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" } };
      const root = renderSubqueryBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree: { fields: [{ name: "outer", type: "CharField" }], relations: [] } }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); await new Promise((done) => setImmediate(done)); const help = "Choose a relation or model source before selecting a field."; assert.ok(root.textContent.split(help).length - 1 >= 2); const controls = selects(root); assert.equal(controls.some((select) => select.dataset.queryControlKey === "predicate-lhs-w-0"), false); const outer = controls.find((select) => select.ariaLabel === "Outer field"); if (outer) { assert.ok(optionLabels(outer).includes("outer")); } const targetOwned = controls.filter((select) => ["Target field", "Subquery field", "Subquery order field"].includes(select.ariaLabel)); assert.equal(targetOwned.some((select) => optionLabels(select).includes("outer")), false); root.__queryDestroy();
    }
  } finally { globalThis.document = priorDocument; }
});

test("stale disabled Subquery relation is rendered but cannot dispatch", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } }; const actions = []; const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState() { return { tree: { fields: [], relations: [] } }; }, getCatalog() { return []; } }, scope: { source: { app: "app", model: "Book" } } }); const combo = findNode(root, (node) => node?._options); assert.equal(combo._options.at(-1).disabled, true); const input = combo.children.find((node) => node.tag === "input"); input.dispatch("focus"); combo.children.find((node) => node.tag === "div").children.find((node) => node.textContent.includes("Unavailable relation: stale")).dispatch("click"); assert.deepEqual(actions, []); root.__queryDestroy();
  } finally { globalThis.document = priorDocument; }
});

test("Exists computed renderer scopes its target predicate and releases it before late metadata", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const item = { correlations: [], kind: "exists", nodeId: "exists", source: { kind: "relation", relation: "children" }, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "target" }, lookup: "exact", nodeId: "exists-target", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" } }; const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [] }]]); const metadata = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, getCatalog() { return []; } }; const root = renderExistsComputedBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata, scope: { source: { app: "app", model: "Book" } } }); await new Promise((done) => setImmediate(done)); const predicateSelect = selects(root).find((select) => select.dataset.queryControlKey === "predicate-lhs-exists-target-0"); assert.ok(optionLabels(predicateSelect).includes("target")); assert.equal(optionLabels(predicateSelect).includes("outer"), false); root.__queryDestroy();
    let resolve; const pending = new Promise((done) => { resolve = done; }); const late = renderExistsComputedBuilder({ dispatch() {}, el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState(target) { return target.model === "Book" ? { tree: trees.get("app.Book") } : {}; }, getCatalog() { return []; }, loadTree() { return pending; } }, scope: { source: { app: "app", model: "Book" } } }); const before = late.children.length; late.__queryDestroy(); resolve({ fields: [{ name: "target", type: "CharField" }], relations: [] }); await new Promise((done) => setImmediate(done)); assert.equal(late.children.length, before);
  } finally { globalThis.document = priorDocument; }
});

test("destroyed Subquery renderers ignore late picker lifecycle work", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    let resolve; const pending = new Promise((done) => { resolve = done; }); const item = { correlations: [], kind: "scalarSubquery", nodeId: "sub", orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "children" }, where: { children: [], join: "and", kind: "group", nodeId: "where" } }; const actions = [];
    const root = renderSubqueryBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => ({}), getScope: () => ({ source: { app: "app", model: "Book" } }), item, metadata: { getState(target) { return target.model === "Book" ? { tree: { fields: [], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }] } } : {}; }, getCatalog() { return []; }, loadTree() { return pending; } }, scope: { source: { app: "app", model: "Book" } } }); const before = root.children.length; root.__queryDestroy(); resolve({ fields: [{ name: "target", type: "CharField" }], relations: [] }); await new Promise((done) => setImmediate(done)); assert.equal(root.children.length, before); assert.deepEqual(actions, []);
  } finally { globalThis.document = priorDocument; }
});
