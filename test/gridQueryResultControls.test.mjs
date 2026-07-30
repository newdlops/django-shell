// Verifies pure direct and calculated reference grouping for Result-stage pickers.
import assert from "node:assert/strict";
import test from "node:test";

import { createQueryResultControls, resultReferenceOptions } from "../media/gridQueryResultControls.js";

/** Creates a lightweight DOM node for Result renderer assertions. */
function el(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener(type, listener) { listeners.set(type, listener); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, get lastElementChild() { return this.children.at(-1); }, remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); } }, removeEventListener(type) { listeners.delete(type); }, replaceChildren(...items) { this.children = []; this.append(...items); }, tag }; node.append(...children); return node; }
/** Finds a rendered descendant by accessible label. */
function byLabel(node, label) { if (node?.ariaLabel === label) { return node; } for (const child of node?.children || []) { const found = byLabel(child, label); if (found) { return found; } } }

test("Result references preserve direct fields and enabled calculated values as separate groups", () => {
  const options = resultReferenceOptions([{ label: "Company ID — id", path: "id" }], [{ alias: "latest_valuation_id", enabled: true }, { alias: "disabled_total", enabled: false }]);
  assert.deepEqual(options, [{ group: "Fields", label: "Company ID — id", value: "id" }, { group: "Calculated values", label: "calculated value latest_valuation_id", value: "@latest_valuation_id" }]);
});

test("Result renderer uses keyed native summary and order reference controls", () => {
  const group = el("div", {}, el("span", {}, "anchor")); const order = el("div");
  const controls = createQueryResultControls({ dispatch() {}, el, groupByMount: group, orderByMount: order, replaceGroupBy() {} });
  controls.render({ computed: [], groupBy: [{ path: "amount" }], mode: "summary", orderBy: [{ direction: "asc", nodeId: "order-1", ref: { kind: "field", path: "amount" } }] }, [{ label: "Amount", path: "amount" }]);
  for (const [label, key] of [["Summary group field", "result-group-1"], ["Order field", "result-order-order-1"]]) { const control = byLabel(label === "Summary group field" ? group : order, label); assert.equal(control.tag, "select"); assert.match(control.className, /query-native-select/); assert.equal(control.value, "amount"); assert.equal(control.dataset.queryControlKey, key); }
  controls.destroy();
});
