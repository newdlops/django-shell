// Verifies bounded metadata picker options for Window field references.
import assert from "node:assert/strict";
import test from "node:test";

import { renderWindowBuilder, windowFieldOptions } from "../media/gridWindowBuilder.js";

/** Creates a lightweight DOM node for Window renderer assertions. */
function el(tag, properties = {}, ...children) { const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener() {}, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { this.children.push(item); }, removeEventListener() {}, tag }; node.append(...children); return node; }
/** Finds a rendered descendant by its accessible label. */
function byLabel(node, label) { if (node?.ariaLabel === label) { return node; } for (const child of node?.children || []) { const found = byLabel(child, label); if (found) { return found; } } }

test("Window picker options include an explicit unset choice before fields", () => {
  assert.deepEqual(windowFieldOptions(["created_at", "id"], "Choose order"), [{ label: "Choose order", value: "" }, { label: "created_at", value: "created_at" }, { label: "id", value: "id" }]);
});

test("Window renderer keeps field, ordering, and partition references native and allowlisted", () => {
  const root = renderWindowBuilder({ dispatch() {}, el, getScope: () => ({ fields: [{ path: "amount" }, { path: "created_at" }] }), item: { field: { path: "amount" }, function: "RowNumber", nodeId: "win", orderBy: [{ ref: { path: "created_at" } }], partitionBy: [{ path: "amount" }] } });
  for (const [label, value] of [["Window field", "amount"], ["Window order field", "created_at"], ["Partition field", "amount"]]) { const control = byLabel(root, label); assert.equal(control.tag, "select"); assert.match(control.className, /query-native-select/); assert.equal(control.value, value); }
});
