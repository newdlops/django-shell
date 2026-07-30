// Guards keyboard and ARIA contracts of the standalone recursive Query Builder surface.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { __test as predicateTest, createPredicateBuilder } from "../media/gridPredicateBuilder.js";
import { createQueryFieldPicker } from "../media/gridQueryFieldPicker.js";
import { createPredicateValueEditor } from "../media/gridPredicateValue.js";

const builderSource = fs.readFileSync(new URL("../media/gridPredicateBuilder.js", import.meta.url), "utf8");
const valueSource = fs.readFileSync(new URL("../media/gridPredicateValue.js", import.meta.url), "utf8");
const fieldPickerSource = fs.readFileSync(new URL("../media/gridQueryFieldPicker.js", import.meta.url), "utf8");
const subquerySource = fs.readFileSync(new URL("../media/gridSubqueryBuilder.js", import.meta.url), "utf8");
/** Creates a minimal DOM node for native-reference renderer assertions. */
function el(tag, properties = {}, ...children) { const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener() {}, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { this.children.push(item); }, removeEventListener() {}, tag }; node.append(...children); return node; }

/** Creates a local event-capable picker node for rendered accessibility assertions. */
function pickerEl(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener(type, listener) { listeners.set(type, listener); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, dispatch(type) { listeners.get(type)?.(); }, remove() {}, removeEventListener(type) { listeners.delete(type); }, replaceChildren(...items) { this.children = []; this.append(...items); }, replaceWith(item) { const index = this.parentNode?.children.indexOf(this); if (index >= 0) { this.parentNode.children[index] = item; item.parentNode = this.parentNode; } }, tag }; node.append(...children); return node; }

/** Creates an event-capable local DOM node for rendered Exists accessibility checks. */
function existsEl(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], classList: { add() {}, remove() {} }, dataset: properties.dataset || {}, addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, dispatch(type, event = {}) { for (const listener of listeners.get(type) || []) { listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); } }, dispatchEvent(event) { this.dispatch(event.type, event); return true; }, focus() {}, remove() {}, removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener)); }, replaceChildren(...items) { this.children = []; this.append(...items); }, select() {}, setAttribute(name, value) { this[name] = String(value); }, querySelector(selector) { return this.querySelectorAll(selector)[0]; }, querySelectorAll(selector) { const found = []; const match = (item) => selector === "input" && item.tag === "input"; const walk = (item) => { for (const child of item.children || []) { if (match(child)) { found.push(child); } walk(child); } }; walk(this); return found; }, tag }; node.append(...children); return node; }

/** Finds the first rendered combobox container in a local node tree. */
function renderedCombobox(node) { if (node?._options) { return node; } for (const child of node?.children || []) { const found = renderedCombobox(child); if (found) { return found; } } return undefined; }

/** Finds a rendered node by its tag and a direct visible text child. */
function renderedText(node, tag, value) { if (node?.tag === tag && node.children?.includes(value)) { return node; } for (const child of node?.children || []) { const found = renderedText(child, tag, value); if (found) { return found; } } return undefined; }

/** Counts rendered nodes with one direct visible text child. */
function renderedTextCount(node, tag, value) { return (node?.tag === tag && node.children?.includes(value) ? 1 : 0) + (node?.children || []).reduce((count, child) => count + renderedTextCount(child, tag, value), 0); }

test("predicate builder retains semantic grouping, quiet inline issue details, and structural focus targets", () => {
  assert.match(builderSource, /el\("fieldset"/);
  assert.match(builderSource, /ariaLive: "polite"/);
  assert.match(builderSource, /role: "note"/);
  assert.doesNotMatch(builderSource, /query-predicate-issues", dataset[^\n]*ariaLive/);
  assert.match(builderSource, /data-focus-role = "lhs"|dataset\.focusRole = "lhs"/);
  assert.match(builderSource, /Maximum depth/);
});

test("predicate builder supplies keyboard equivalents for move and duplicate controls", () => {
  assert.match(builderSource, /MOVE_NODE_UP/);
  assert.match(builderSource, /MOVE_NODE_DOWN/);
  assert.match(builderSource, /DUPLICATE_NODE/);
  assert.match(builderSource, /event\.altKey && event\.shiftKey/);
  assert.match(builderSource, /event\.key\.toLowerCase\(\) === "d"/);
});

test("predicate Exists sources use bounded pickers and release replaced picker listeners", () => {
  assert.match(builderSource, /createGridCombobox/);
  assert.match(builderSource, /label: "Exists relation"/);
  assert.match(builderSource, /label: "Exists target model"/);
  assert.match(builderSource, /releasePickers\(\);/);
});

test("condition field paths use native selects while relation and model catalogs remain searchable", () => {
  assert.match(fieldPickerSource, /createQuerySelect/);
  assert.doesNotMatch(fieldPickerSource, /createCombobox/);
  assert.match(builderSource, /controlKey: "predicate-lhs-" \+ comparison\.nodeId/);
  assert.match(builderSource, /createGridCombobox/);
});

test("Add condition targets and opens the newly appended native field select", () => {
  const before = new Set(["comparison-old"]);
  const recipe = { postFilter: { children: [], kind: "group", nodeId: "post-root" }, where: { children: [{ kind: "comparison", nodeId: "comparison-old" }, { kind: "comparison", nodeId: "comparison-new" }], kind: "group", nodeId: "where-root" } };
  assert.deepEqual(predicateTest.addedComparisonFocus(recipe, "where-root", before), { nodeId: "comparison-new", role: "lhs-open" });
  const calls = [];
  assert.equal(predicateTest.focusAndOpenSelect({ disabled: false, focus() { calls.push("focus"); }, showPicker() { calls.push("open"); } }), true);
  assert.deepEqual(calls, ["focus", "open"]);
  assert.equal(predicateTest.focusAndOpenSelect({ disabled: true }), false);
});

test("F and OuterRef render allowlisted native reference selects while catalog call sites stay comboboxes", () => {
  const field = createPredicateValueEditor({ context: "where", el, field: { type: "CharField" }, lookup: "exact", rhs: { kind: "field", path: "name" }, scopeFields: [{ label: "Name", path: "name" }] }).node.children[0];
  const outer = createPredicateValueEditor({ context: "subquery", el, field: { type: "CharField" }, lookup: "exact", rhs: { kind: "outerField", path: "id" }, outerFields: [{ label: "ID", path: "id" }] }).node.children[0];
  assert.equal(field.tag, "select"); assert.match(field.className, /query-native-select/); assert.equal(field.value, "name");
  assert.equal(outer.tag, "select"); assert.match(outer.className, /query-native-select/); assert.equal(outer.value, "id");
  const exists = builderSource.slice(builderSource.indexOf("function renderExists"), builderSource.indexOf("function renderCorrelations"));
  const source = subquerySource.slice(subquerySource.indexOf("function sourceControls"), subquerySource.indexOf("function correlationControls"));
  assert.match(exists, /createGridCombobox\(\{[^}]*label: "Exists relation"/); assert.match(exists, /createGridCombobox\(\{ el, label: "Exists target model"/);
  assert.match(source, /createGridCombobox\(\{[^}]*label: "Relation"/);
  assert.match(source, /createGridCombobox\(\{ el, label: "Subquery model"/);
});

test("validation refresh only replaces issue regions instead of active predicate controls", () => {
  assert.match(builderSource, /dataset: \{ queryIssueNodeId: nodeId \}/);
  assert.match(builderSource, /function updateValidation\(\)/);
  assert.match(builderSource, /region\.replaceChildren\(\)/);
  assert.match(builderSource, /node, render, updateValidation/);
});

test("typed value controls expose persistent labels for relative, list, range, and field RHS", () => {
  for (const label of ["Relative time amount", "Add list value", "Range lower bound", "Compare to field", "Outer field"]) {
    assert.ok(valueSource.includes(label), label);
  }
  assert.match(valueSource, /No value needed/);
});

test("comparison rows expose visible Field, Comparison, Compare with, and Value labels", () => {
  for (const label of ["Field", "Comparison", "Compare with", "Value"]) { assert.ok(builderSource.includes(`"${label}"`), label); }
});

test("group join control appears only when a group has more than one child", () => {
  assert.match(builderSource, /group\.children \|\| \[\]\)\.length > 1/);
});

test("rendered relationship actions expose distinct accessible group text", async () => {
  const picker = createQueryFieldPicker({ allowRelationTerminal: true, el: pickerEl, metadata: { getState() { return { tree: { fields: [], relations: [{ name: "owner", target: "app.User" }] } }; } }, source: { app: "app", model: "Book" } }); await new Promise(queueMicrotask); const select = picker.node.children[0].children[0]; const groups = select.children; assert.equal(groups.find((group) => group.label === "Relations").children[0].children[0], "owner → app.User"); assert.equal(groups.find((group) => group.label === "Relationship checks").children[0].children[0], "Check relationship owner"); picker.dispose();
});

test("rendered Exists relation controls describe loading, cached errors, and unsafe choices", () => {
  const priorDocument = globalThis.document; globalThis.document = { createElement: (tag) => existsEl(tag) };
  const recipe = { where: { children: [{ kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "stale" }, where: { children: [], join: "and", kind: "group", nodeId: "nested" } }], join: "and", kind: "group", nodeId: "root" } };
  const make = (state) => createPredicateBuilder({ dispatch() {}, el: existsEl, getRecipe: () => recipe, getScope: () => ({ source: { app: "app", model: "Book" } }), metadata: { getState() { return state; } }, rootNodeId: "root" });
  try {
    const pending = make({ pending: true }); const pendingCombo = renderedCombobox(pending.node); const pendingInput = pendingCombo.children.find((node) => node.tag === "input");
    assert.equal(pendingInput["aria-describedby"], "query-exists-relation-loading-exists"); assert.ok(renderedText(pending.node, "p", "Loading related sources.")); pending.destroy();
    const failed = make({ error: "cached metadata failure" }); const failedCombo = renderedCombobox(failed.node); const failedInput = failedCombo.children.find((node) => node.tag === "input");
    assert.equal(failedInput["aria-describedby"], "query-exists-relation-error-exists"); assert.ok(renderedText(failed.node, "p", "cached metadata failure")); failed.destroy();
    const empty = make({ tree: { fields: [], relations: [] } }); const emptyCombo = renderedCombobox(empty.node); const emptyInput = emptyCombo.children.find((node) => node.tag === "input"); const emptyMessage = "No related sources are available for this model.";
    assert.equal(emptyInput["aria-describedby"], "query-exists-relation-empty-exists"); assert.equal(renderedTextCount(empty.node, "p", emptyMessage), 1); assert.equal(renderedText(empty.node, "p", emptyMessage).id, "query-exists-relation-empty-exists"); empty.destroy();
    const unsafe = make({ tree: { fields: [], relations: [{ filterField: "", name: "unsafe", outerField: "", target: "app.Unsafe", toMany: true }] } }); const unsafeCombo = renderedCombobox(unsafe.node); const unsafeInput = unsafeCombo.children.find((node) => node.tag === "input"); const unsafeOption = unsafeCombo._options.find((option) => option.value === "unsafe");
    assert.equal(unsafeOption.disabled, true); assert.match(unsafeOption.disabledReason, /safe automatic/i); unsafeInput.dispatch("focus"); const list = unsafeCombo.children.find((node) => node.tag === "div"); const choice = list.children.find((node) => node.children?.includes("unsafe → app.Unsafe")); assert.ok(renderedText(choice, "span", unsafeOption.disabledReason)); unsafe.destroy();
  } finally { globalThis.document = priorDocument; }
});
