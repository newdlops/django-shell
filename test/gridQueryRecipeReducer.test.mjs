// Verifies immutable Query Builder Recipe reducer actions and generated-node safety.
import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyQueryRecipe, reduceQueryRecipe } from "../media/gridQueryRecipeReducer.js";

/** Creates a minimal source descriptor for canonical Recipe factory coverage. */
function source() { return { app: "db", model: "Company" }; }

test("Recipe reducer leaves the source snapshot unchanged while applying structural actions", () => {
  const initial = createEmptyQueryRecipe(source());
  const next = reduceQueryRecipe(initial, { type: "ADD_COMPARISON" });

  assert.equal(initial.where.children.length, 0);
  assert.equal(next.where.children.length, 1);
  assert.equal(next.where.children[0].lhs.path, "");
  assert.notEqual(next.where, initial.where);
});

test("Recipe reducer regenerates every duplicated nested node identifier", () => {
  const initial = createEmptyQueryRecipe(source());
  const branch = {
    children: [{ kind: "comparison", lhs: { kind: "field", path: "id" }, lookup: "exact", nodeId: "comparison-original", rhs: { kind: "literal", value: 1 } }],
    join: "and", kind: "group", negated: false, nodeId: "group-original"
  };
  const withBranch = reduceQueryRecipe(initial, { group: branch, type: "ADD_GROUP" });
  const duplicated = reduceQueryRecipe(withBranch, { nodeId: withBranch.where.children[0].nodeId, type: "DUPLICATE_NODE" });
  const [first, second] = duplicated.where.children;

  assert.notEqual(first.nodeId, second.nodeId);
  assert.notEqual(first.children[0].nodeId, second.children[0].nodeId);
  assert.deepEqual(first.children[0].lhs, second.children[0].lhs);
});

test("Rows mode intentionally clears only Summary grouping while retaining ordering", () => {
  const initial = { ...createEmptyQueryRecipe(source()), groupBy: [{ kind: "field", path: "name" }], mode: "summary", orderBy: [{ direction: "desc", nodeId: "order-1", ref: { kind: "field", path: "id" } }] };
  const next = reduceQueryRecipe(initial, { mode: "rows", type: "SET_MODE" });

  assert.equal(next.mode, "rows");
  assert.deepEqual(next.groupBy, []);
  assert.deepEqual(next.orderBy, initial.orderBy);
});
