// Verifies stable renderer keys for immutable nodeId-less Query Builder lists.
import assert from "node:assert/strict";
import test from "node:test";

import { createStableListKeyReconciler, stableListEntrySignature } from "../media/gridQueryStableListKeys.js";

test("stable list keys retain entries through immutable edits, duplicates, and reordering", () => {
  const keys = createStableListKeyReconciler("group");
  const first = keys.reconcile([{ kind: "field", path: "id" }, { kind: "field", path: "name" }, { kind: "field", path: "name" }]);
  const edited = keys.reconcile([{ kind: "field", path: "id" }, { kind: "field", path: "status" }, { kind: "field", path: "name" }]);
  const reordered = keys.reconcile([{ kind: "field", path: "name" }, { kind: "field", path: "id" }, { kind: "field", path: "status" }]);

  assert.equal(edited[0], first[0]);
  assert.equal(edited[1], first[1], "an edited list position keeps its renderer key");
  assert.equal(reordered[0], edited[2]);
  assert.equal(reordered[1], edited[0]);
  assert.equal(stableListEntrySignature({ alias: "total", kind: "computed" }), "computed:total");
});
