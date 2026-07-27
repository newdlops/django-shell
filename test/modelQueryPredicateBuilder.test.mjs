// Covers Query Builder predicate metadata, structural helpers, and typed RHS restrictions without a browser runtime.
import assert from "node:assert/strict";
import test from "node:test";

import { createQueryMetadataService, rootMetadataOptions } from "../media/gridQueryMetadata.js";
import { __test as builder } from "../media/gridPredicateBuilder.js";
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
