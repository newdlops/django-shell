// Covers Query Builder predicate metadata, structural helpers, and typed RHS restrictions without a browser runtime.
import assert from "node:assert/strict";
import test from "node:test";

import { createQueryMetadataService, rootMetadataOptions } from "../media/gridQueryMetadata.js";
import { __test as builder, createPredicateBuilder } from "../media/gridPredicateBuilder.js";
import { defaultLookup, lookupsForField, rhsKindsFor, scalarFromInput } from "../media/gridPredicateValue.js";

test("metadata cache uses query-meta IDs, ignores stale messages, and retries explicit failures", async () => {
  const posted = [];
  const service = createQueryMetadataService({ post: (message) => posted.push(message) });
  const target = { app: "db", model: "Company" };
  const pending = service.loadTree(target);
  assert.equal(posted[0].requestId, "query-meta-1");
  assert.equal(service.onMessage({ requestId: "query-meta-stale", result: { ok: true } }), true);
  assert.equal(service.getState(target).pending, true);
  service.onMessage({ requestId: posted[0].requestId, result: { fields: [{ name: "id", type: "AutoField" }], ok: true, relations: [] } });
  assert.equal((await pending).fields[0].name, "id");
  assert.equal(service.getState(target).pending, false);
  assert.equal(await service.loadTree(target), service.getState(target).tree, "successful targets are cached");
});

test("field metadata and typed RHS restrictions preserve backend-safe contexts", () => {
  const date = { role: "field", type: "DateTimeField" };
  assert.ok(lookupsForField({ role: "field", type: "CharField" }).includes("not_blank"));
  assert.equal(defaultLookup({ role: "field", type: "CharField" }), "icontains");
  assert.deepEqual(rhsKindsFor({ context: "aggregateFilter", field: date, lookup: "gt" }), ["literal", "field"]);
  assert.deepEqual(rhsKindsFor({ context: "subquery", field: date, lookup: "gt" }), ["literal", "field", "outerField", "relativeTime"]);
  assert.deepEqual(rhsKindsFor({ context: "where", field: date, lookup: "in" }), ["literal"]);
  assert.equal(scalarFromInput({ type: "IntegerField" }, "12"), 12);
  assert.equal(scalarFromInput({ type: "BooleanField" }, "false"), false);
});

test("metadata option and structural helpers retain nested group and Exists parent relationships", () => {
  const options = rootMetadataOptions({ fields: [{ name: "name", type: "CharField" }], relations: [{ name: "items", target: "db.Item" }] });
  assert.deepEqual(options.fields[0], { name: "name", path: "name", role: "field", type: "CharField" });
  assert.equal(options.relations[0].role, "relation");
  const recipe = { where: { children: [{ children: [{ kind: "comparison", nodeId: "condition" }], kind: "group", nodeId: "nested" }, { kind: "existsPredicate", nodeId: "exists", where: { children: [], kind: "group", nodeId: "exists-where" } }], kind: "group", nodeId: "where-root" } };
  assert.equal(builder.findGroup(recipe, "exists-where").nodeId, "exists-where");
  assert.equal(builder.findNode(recipe, "condition").parent.nodeId, "nested");
  assert.equal(builder.actionScope("postFilter"), "postFilter");
  assert.equal(builder.allowsExists("aggregateFilter"), false);
  assert.deepEqual(builder.starterRhs("relativeTime"), { amount: 1, anchor: "now", direction: "past", kind: "relativeTime", unit: "days" });
  assert.deepEqual(builder.lookupChanges({ lookup: "exact", rhs: { kind: "literal", value: null } }, "isnull"), { lookup: "isnull", rhs: { kind: "literal", value: true } });
  assert.deepEqual(builder.lookupChanges({ lookup: "isnull", rhs: { kind: "literal", value: false } }, "exact"), { lookup: "exact", rhs: { kind: "literal", value: null } });
});

test("field selection patches comparisons atomically for relations and scalar replacements", () => {
  const relation = builder.fieldSelectionChanges({ lhs: { kind: "field", path: "name" }, lookup: "icontains", rhs: { kind: "literal", value: "old" } }, { role: "relation", type: "forward_fk" }, "owner", "where");
  assert.deepEqual(relation, { lhs: { kind: "field", path: "owner" }, lookup: "isnull", rhs: { kind: "literal", value: true } });
  const numeric = builder.fieldSelectionChanges({ lookup: "icontains", rhs: { kind: "literal", value: "old" } }, { role: "field", type: "IntegerField" }, "quantity", "where");
  assert.deepEqual(numeric, { lhs: { kind: "field", path: "quantity" }, lookup: "exact", rhs: { kind: "literal", value: null } });
  const computed = builder.fieldSelectionChanges({ lookup: "exact", rhs: { kind: "literal", value: 3 } }, { role: "computed", type: "IntegerField" }, "total", "where");
  assert.deepEqual(computed.lhs, { alias: "total", kind: "computed" });
  assert.equal(computed.lookup, "exact");
  assert.deepEqual(computed.rhs, { kind: "literal", value: 3 });
});

test("persisted descriptors retain computed roles and resolve cached traversed target fields", () => {
  const metadata = { getState(target) { return target.model === "Book" ? { tree: { fields: [{ name: "owner", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] } } : { tree: { fields: [{ name: "email", type: "EmailField" }], relations: [] } }; } };
  const scope = { computed: [{ alias: "owner", outputType: "IntegerField" }], source: { app: "app", model: "Book" } };
  const fields = [{ path: "owner", role: "field", type: "CharField" }, { path: "owner", role: "computed", type: "IntegerField" }];
  assert.equal(builder.persistedFieldForPath({ alias: "owner", kind: "computed" }, scope, metadata, fields).role, "computed");
  assert.deepEqual(builder.persistedFieldForPath({ kind: "field", path: "owner__email" }, scope, metadata, fields), { name: "email", path: "owner__email", role: "field", type: "EmailField" });
});

/** Creates a local event-capable DOM node for driven predicate-builder tests. */
function dom(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], classList: { add() {}, remove() {} }, dataset: properties.dataset || {}, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, addEventListener(type, listener) { const existing = listeners.get(type) || []; existing.push(listener); listeners.set(type, existing); }, dispatch(type, event = {}) { for (const listener of listeners.get(type) || []) { listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); } }, dispatchEvent(event) { this.dispatch(event.type, event); return true; }, focus() { this.focused = true; }, select() {}, remove() {}, removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener)); }, replaceChildren(...items) { this.children = []; this.append(...items); }, setAttribute(name, value) { this[name] = String(value); if (name.startsWith("data-")) { this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); } }, querySelector(selector) { return this.querySelectorAll(selector)[0]; }, querySelectorAll(selector) { const found = []; const match = (item) => selector === "input" ? item.tag === "input" : selector === "select" ? item.tag === "select" : selector.includes(".query-field-picker") ? item.tag === "select" : selector.startsWith("[data-query-node-id=") ? item.dataset?.queryNodeId === selector.match(/="([^"]+)/)?.[1] : false; const walk = (item) => { for (const child of item.children || []) { if (match(child)) { found.push(child); } walk(child); } }; walk(this); return found; }, tag }; node.append(...children); return node; }

/** Finds native selects in source order below a local test node. */
function selects(node, found = []) { if (node?.tag === "select") { found.push(node); } for (const child of node?.children || []) { selects(child, found); } return found; }

test("driven predicate picker keeps traversal separate from terminal atomic updates", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const recipe = { where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", nodeId: "c1", rhs: { kind: "literal", value: "x" } }], join: "and", kind: "group", nodeId: "root" } };
    const trees = new Map([["app.Book", { fields: [{ name: "name", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [{ name: "email", type: "EmailField" }], relations: [] }]]);
    const actions = []; const metadata = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; } };
    const editor = createPredicateBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" });
    await new Promise(queueMicrotask); const rootPicker = selects(editor.node).find((select) => select.dataset?.queryControlKey === "predicate-lhs-c1-0");
    rootPicker.value = "relation:owner"; rootPicker.dispatch("change"); await new Promise((done) => setImmediate(done));
    assert.equal(actions.length, 0);
    const child = selects(editor.node).find((select) => select.dataset?.queryControlKey === "predicate-lhs-c1-1"); child.value = "field:email"; child.dispatch("change");
    assert.deepEqual(actions[0].changes, { lhs: { kind: "field", path: "owner__email" }, lookup: "icontains", rhs: { kind: "literal", value: "x" } });
    editor.destroy(); await new Promise((done) => setImmediate(done));
  } finally { globalThis.document = priorDocument; }
});

test("driven predicate relationship check dispatches one atomic null comparison", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const recipe = { where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "exact", nodeId: "c2", rhs: { kind: "literal", value: "x" } }], join: "and", kind: "group", nodeId: "root" } };
    const actions = []; const metadata = { getState() { return { tree: { fields: [{ name: "name", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] } }; } };
    const editor = createPredicateBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" });
    const picker = selects(editor.node).find((select) => select.dataset?.queryControlKey === "predicate-lhs-c2-0"); picker.value = "relationTerminal:owner"; picker.dispatch("change");
    assert.equal(actions.length, 1); assert.deepEqual(actions[0].changes, { lhs: { kind: "field", path: "owner" }, lookup: "isnull", rhs: { kind: "literal", value: true } });
    picker.value = "relationTerminal:injected"; picker.dispatch("change"); assert.equal(actions.length, 1);
    editor.destroy(); await new Promise((done) => setImmediate(done));
  } finally { globalThis.document = priorDocument; }
});

test("rendered Exists sources retain safe, unsafe, and stale relation states", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const where = { children: [], join: "and", kind: "group", nodeId: "exists-where" };
    const recipe = { where: { children: [{ correlations: [{ nodeId: "keep" }], kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "stale" }, where }], join: "and", kind: "group", nodeId: "root" } };
    const tree = { fields: [{ name: "id", type: "AutoField" }], relations: [{ filterField: "book_id", name: "forward", outerField: "id", target: "app.Forward" }, { filterField: "book_id", name: "reverse", outerField: "id", target: "app.Reverse" }, { filterField: "", name: "unsafe", outerField: "", target: "app.Unsafe", toMany: true }] };
    const metadata = { getState() { return { tree }; } }; const actions = [];
    const editor = createPredicateBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" });
    const combobox = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(editor.node); })();
    assert.deepEqual(combobox._options.map((option) => option.value), ["", "forward", "reverse", "unsafe", "stale"]); assert.equal(combobox._options.find((option) => option.value === "unsafe").disabled, true); assert.match(combobox._options.find((option) => option.value === "unsafe").disabledReason, /safe automatic/i); assert.equal(combobox._options.at(-1).disabled, true);
    const type = selects(editor.node).find((select) => select["aria-label"] === "Exists source type"); type.value = "model"; type.dispatch("change"); assert.equal(actions[0].changes.correlations, undefined); assert.equal(actions[0].changes.source.kind, "model"); editor.destroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered Exists cached metadata error exposes guarded Retry without implicit retry", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const recipe = { where: { children: [{ kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "nested" } }], join: "and", kind: "group", nodeId: "root" } }; let retries = 0; const metadata = { getState() { return { error: "cached" }; }, retry() { retries += 1; return Promise.resolve(); } };
    const editor = createPredicateBuilder({ dispatch() {}, el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); const retry = (() => { const walk = (node) => node?.tag === "button" && node.textContent === "Retry" ? node : (node?.children || []).map(walk).find(Boolean); return walk(editor.node); })(); retry.dispatch("click"); retry.dispatch("click"); assert.equal(retries, 1); editor.destroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered unsafe and stale Exists choices reject click and keyboard selection", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const recipe = { where: { children: [{ kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "nested" } }], join: "and", kind: "group", nodeId: "root" } }; const actions = []; const metadata = { getState() { return { tree: { fields: [], relations: [{ filterField: "", name: "unsafe", outerField: "", target: "app.Unsafe" }] } }; } };
    const editor = createPredicateBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(editor.node); })(); const input = combo.children.find((node) => node.tag === "input"); const list = combo.children.find((node) => node.tag === "div"); input.dispatch("focus"); const choices = list.children.filter((node) => node.className?.includes("cbx-opt")); choices.find((node) => node.children.includes("unsafe → app.Unsafe")).dispatch("click"); choices.find((node) => node.children.includes("Unavailable relation: stale")).dispatch("click"); input.value = "unsafe"; input.dispatch("input"); input.dispatch("keydown", { key: "Enter" }); assert.deepEqual(actions, []); editor.destroy(); await new Promise((done) => setImmediate(done));
  } finally { globalThis.document = priorDocument; }
});

test("rendered Exists loads idle metadata and associates pending and empty help", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const recipe = { where: { children: [{ kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "nested" } }], join: "and", kind: "group", nodeId: "root" } }; let loads = 0; let state = {};
    const metadata = { getState() { return state; }, loadTree() { loads += 1; state = { pending: true }; return Promise.resolve(); } }; const make = () => createPredicateBuilder({ dispatch() {}, el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); const idle = make(); assert.equal(loads, 1); idle.destroy(); state = { pending: true }; const pending = make(); const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(pending.node); })(); assert.equal(combo.children.find((node) => node.tag === "input").disabled, true); assert.equal(combo.children.find((node) => node.tag === "input")["aria-describedby"], "query-exists-relation-loading-exists"); pending.destroy(); state = { tree: { fields: [], relations: [] } }; const empty = make(); const emptyCombo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(empty.node); })(); assert.equal(emptyCombo.children.find((node) => node.tag === "input")["aria-describedby"], "query-exists-relation-empty-exists"); empty.destroy();
  } finally { globalThis.document = priorDocument; }
});

test("nested Exists scopes target fields and recursive owner metadata", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const nested = { children: [{ kind: "comparison", lhs: { kind: "field", path: "target" }, lookup: "exact", nodeId: "c", rhs: { kind: "literal", value: null } }, { kind: "existsPredicate", nodeId: "inner", source: { kind: "relation", relation: "grandchildren" }, where: { children: [], join: "and", kind: "group", nodeId: "inner-where" } }], join: "and", kind: "group", nodeId: "where" }; const recipe = { where: { children: [{ kind: "existsPredicate", nodeId: "outer", source: { kind: "relation", relation: "children" }, where: nested }], join: "and", kind: "group", nodeId: "root" } }; const calls = []; const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [{ filterField: "book_id", name: "children", outerField: "id", target: "app.Child" }] }], ["app.Child", { fields: [{ name: "target", type: "CharField" }], relations: [{ filterField: "child_id", name: "grandchildren", outerField: "id", target: "app.Grandchild" }] }]]);
    const metadata = { getState(target) { calls.push(`${target?.app}.${target?.model}`); return { tree: trees.get(`${target?.app}.${target?.model}`) }; } }; const editor = createPredicateBuilder({ dispatch() {}, el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); await new Promise((done) => setImmediate(done)); const targetPicker = selects(editor.node).find((select) => select.dataset?.queryControlKey === "predicate-lhs-c-0"); const values = targetPicker.children.flatMap((group) => group.children || []).map((option) => option.value); assert.ok(values.includes("field:target")); assert.equal(values.includes("field:outer"), false); assert.ok(calls.includes("app.Child")); editor.destroy();
  } finally { globalThis.document = priorDocument; }
});

test("rendered Exists source switch rerenders stale target fields without implicit reset", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const where = { children: [{ kind: "comparison", lhs: { kind: "field", path: "old" }, lookup: "exact", nodeId: "c", rhs: { kind: "literal", value: null } }], join: "and", kind: "group", nodeId: "where" }; const exists = { correlations: [{ nodeId: "x", outerPath: "outer", targetPath: "old" }], kind: "existsPredicate", nodeId: "exists", source: { kind: "model", target: { app: "app", model: "Old" } }, where }; const actions = []; const trees = new Map([["app.Book", { fields: [{ name: "outer", type: "CharField" }], relations: [] }], ["app.Old", { fields: [{ name: "old", type: "CharField" }], relations: [] }], ["app.New", { fields: [{ name: "fresh", type: "CharField" }], relations: [] }]]); const metadata = { getCatalog() { return [{ app: "app", model: "Old" }, { app: "app", model: "New" }]; }, getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; } }; const make = (node) => { const recipe = { where: { children: [node], join: "and", kind: "group", nodeId: "root" } }; return createPredicateBuilder({ dispatch: (action) => actions.push(action), el: dom, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); };
    const first = make(exists); const combo = (() => { const walk = (node) => node?._options ? node : (node?.children || []).map(walk).find(Boolean); return walk(first.node); })(); const input = combo.children.find((node) => node.tag === "input"); input.dispatch("focus"); combo.children.find((node) => node.tag === "div").children.find((node) => node.children?.includes("app.New")).dispatch("click"); assert.deepEqual(actions[0].changes, { source: { kind: "model", target: { app: "app", model: "New" } } }); first.destroy(); const next = { ...exists, ...actions[0].changes }; const rerendered = make(next); await new Promise((done) => setImmediate(done)); const controls = selects(rerendered.node); const staleControls = [controls.find((select) => select.dataset?.queryControlKey === "predicate-lhs-c-0"), controls.find((select) => select.ariaLabel === "Target field")]; for (const control of staleControls) { assert.ok(control); const old = control.children.flatMap((group) => group.children || []).find((option) => option.value === "unavailable:old"); assert.ok(old); assert.equal(old.disabled, true); assert.equal(old.children[0], "Unavailable field: old"); } const outer = controls.find((select) => select.ariaLabel === "Current outer-row field"); assert.ok(outer); const outerValues = outer.children.flatMap((group) => group.children || []).map((option) => option.value); assert.ok(outerValues.includes("field:outer")); assert.equal(outerValues.includes("unavailable:old"), false); assert.deepEqual(next.where, where); assert.deepEqual(next.correlations, exists.correlations); assert.equal(actions.some((action) => action.changes?.correlations?.length === 0), false); rerendered.destroy();
  } finally { globalThis.document = priorDocument; }
});

test("persisted traversed and computed comparisons render descriptor-consistent controls", async () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => dom(tag) };
  try {
    const trees = new Map([["app.Book", { fields: [{ name: "owner", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [{ name: "email", type: "EmailField" }], relations: [] }]]); const metadata = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; } };
    const make = (lhs, nodeId) => { const recipe = { where: { children: [{ kind: "comparison", lhs, lookup: "icontains", nodeId, rhs: { kind: "literal", value: "x" } }], join: "and", kind: "group", nodeId: "root" } }; return createPredicateBuilder({ dispatch() {}, el: dom, getRecipe: () => recipe, getScope: () => ({ computed: [{ alias: "owner", outputType: "CharField" }], source: { app: "app", model: "Book" } }), metadata, rootNodeId: "root" }); };
    const traversed = make({ kind: "field", path: "owner__email" }, "t"); await new Promise((done) => setImmediate(done)); const lookup = selects(traversed.node).find((select) => select["aria-label"] === "Comparison"); assert.equal(lookup.value, "icontains"); traversed.destroy(); const computed = make({ alias: "owner", kind: "computed" }, "c"); const computedLookup = selects(computed.node).find((select) => select["aria-label"] === "Comparison"); assert.equal(computedLookup.value, "icontains"); computed.destroy();
  } finally { globalThis.document = priorDocument; }
});
