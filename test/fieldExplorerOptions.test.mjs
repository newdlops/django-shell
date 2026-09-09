// Verifies searchable relation traversal and pasted lookups remain bounded by live Django metadata.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveFieldExplorer } from "../media/gridFieldExplorerOptions.js";

/** Creates a small schema with overlapping foreign-key names and storage attributes. */
function fixture() {
  const source = { app: "app", model: "Record" }, requests = [];
  const trees = {
    Record: { fields: [{ name: "company", attname: "company_id", type: "IntegerField" }, { name: "title", type: "CharField", label: "Display title" }], relations: [{ name: "company", target: "app.Company" }] },
    Company: { fields: [{ name: "user", attname: "user_id", type: "IntegerField" }, { name: "name", type: "CharField" }], relations: [{ name: "user", target: "app.User" }] },
    User: { fields: [{ name: "email", type: "EmailField" }, { name: "active", type: "BooleanField" }], relations: [] }
  };
  return { source, requests, trees, async loadTree(model) { requests.push(model.model); assert.ok(trees[model.model]); return trees[model.model]; } };
}

test("search distinguishes a traversable relation from its scalar foreign-key value", async () => {
  const data = fixture(), result = await resolveFieldExplorer({ ...data, query: "company" });
  assert.deepEqual(result.items.map((item) => [item.path, item.kind]), [["company", "relation"], ["company_id", "field"], ["company", "relationTerminal"]]);
  assert.deepEqual(data.requests, ["Record"]);
});

test("a pasted two-hop field and lookup resolve atomically against the terminal field type", async () => {
  const data = fixture(), result = await resolveFieldExplorer({ ...data, query: "company__user__email__icontains" });
  assert.equal(result.items.length, 1);
  assert.deepEqual([result.items[0].path, result.items[0].lookup, result.items[0].descriptor.type], ["company__user__email", "icontains", "EmailField"]);
  assert.deepEqual(data.requests, ["Record", "Company", "User"]);
  const transformed = await resolveFieldExplorer({ ...fixture(), query: "company__user__email__length__gte" });
  assert.equal(transformed.items[0].lookup, "length__gte");
  const presence = await resolveFieldExplorer({ ...fixture(), query: "company__user__isnull" });
  assert.equal(presence.items[0].kind, "relationTerminal");
  assert.equal(presence.items[0].path, "company__user");
});

test("browsing and search share the same complete nested field paths", async () => {
  const nested = await resolveFieldExplorer({ ...fixture(), prefix: ["company", "user"], query: "ema" });
  const pasted = await resolveFieldExplorer({ ...fixture(), query: "company__user__ema" });
  assert.deepEqual(nested.items, pasted.items);
  assert.equal(nested.items[0].path, "company__user__email");
  const labels = await resolveFieldExplorer({ ...fixture(), query: "display" });
  assert.equal(labels.items[0].path, "title");
});

test("unsupported lookups and storage-attribute traversal never yield executable choices", async () => {
  for (const query of ["company_id__name", "company__user__active__icontains", "company__user__email__delete", "unknown__email", "__import__('os')", "x".repeat(241)]) {
    const result = await resolveFieldExplorer({ ...fixture(), query });
    assert.deepEqual(result.items, [], query);
  }
});

test("large schemas render bounded options while search can find a field beyond the initial page", async () => {
  const data = fixture();
  data.trees.Record.fields = Array.from({ length: 200 }, (_, index) => ({ name: `field_${index}`, type: "CharField" }));
  assert.equal((await resolveFieldExplorer(data)).items.length, 60);
  const last = await resolveFieldExplorer({ ...data, query: "field_199" });
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].path, "field_199");
});
