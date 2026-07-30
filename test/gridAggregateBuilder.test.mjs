// Verifies safe Aggregate field picker options and legacy-value recovery.
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateFieldOptions, renderAggregateBuilder } from "../media/gridAggregateBuilder.js";

/** Creates a minimal DOM node for aggregate renderer assertions. */
function el(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener(type, listener) { listeners.set(type, listener); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, removeEventListener(type) { listeners.delete(type); }, replaceChildren(...items) { this.children = []; this.append(...items); }, tag }; node.append(...children); return node; }
/** Finds the first descendant matching an accessible label. */
function byLabel(node, label) { if (node?.ariaLabel === label) { return node; } for (const child of node?.children || []) { const found = byLabel(child, label); if (found) { return found; } } }

test("Aggregate field options keep all rows ungrouped and concrete fields grouped", () => {
  assert.deepEqual(aggregateFieldOptions([{ label: "Amount — amount", path: "amount", type: "DecimalField" }], "amount"), [{ label: "All rows", value: "*" }, { description: "DecimalField", group: "Fields", label: "Amount — amount", value: "amount" }]);
});

test("Aggregate renderer preserves empty, all, unavailable, and grouped native fields", () => {
  const scope = { fields: [{ label: "Amount", path: "amount", type: "DecimalField" }] };
  const render = (field, fn = "sum") => renderAggregateBuilder({ dispatch() { throw new Error("render must not dispatch"); }, el, getScope: () => scope, item: { distinct: "auto", field, filter: undefined, function: fn, nodeId: "a" } });
  const empty = byLabel(render({ kind: "field", path: "" }), "Aggregate field");
  assert.equal(empty.tag, "select"); assert.match(empty.className, /query-native-select/); assert.equal(empty.value, ""); assert.equal(empty.children[0].disabled, true);
  const all = byLabel(render({ kind: "all" }, "count"), "Aggregate field");
  assert.equal(all.value, "*"); assert.equal(all.children[0].value, "*");
  const missing = byLabel(render({ kind: "field", path: "missing" }), "Aggregate field");
  assert.equal(missing.value, "missing"); assert.equal(missing.children.at(-1).label, "Unavailable"); assert.equal(missing.children.at(-1).children[0].disabled, true);
  const known = byLabel(render({ kind: "field", path: "amount" }), "Aggregate field");
  assert.equal(known.children.at(-1).label, "Fields");
});

test("Aggregate field options leave unavailable legacy preservation to the shared select", () => {
  assert.deepEqual(aggregateFieldOptions([]), [{ label: "All rows", value: "*" }]);
});
