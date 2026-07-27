// Verifies Recipe v2 migration payloads and BackendClient wire-contract boundaries.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BackendClient } = require("../out/backendClient.js");
const { createInitialPkModelQueryRecipe } = require("../out/modelQueryRecipeInitialPk.js");
const { legacyAnnotationsToComputed, legacyFiltersToWhere, legacyQueryToRecipe } = require("../out/modelQueryLegacyAdapter.js");

test("legacy filters become one root AND group and malformed values become adapter issues", () => {
  const converted = legacyFiltersToWhere([
    { field: "name", lookup: "icontains", value: "acme" },
    { field: "id", lookup: "in", negate: true, value: "1, 2" },
    { field: "broken", lookup: "exact", value: { object: true } }
  ]);

  assert.equal(converted.where.join, "and");
  assert.equal(converted.where.children.length, 2);
  assert.deepEqual(converted.where.children[1], {
    kind: "comparison", lhs: { kind: "field", path: "id" }, lookup: "in", negated: true,
    nodeId: "legacy-filter-2", rhs: { kind: "list", values: ["1", "2"] }
  });
  assert.deepEqual(converted.issues.map((issue) => issue.code), ["LEGACY_FILTER_MALFORMED"]);
});

test("legacy annotations produce supported Recipe v2 forms and report malformed entries", () => {
  const converted = legacyAnnotationsToComputed([
    { alias: "member_count", conditions: { join: "all", terms: [] }, distinct: true, field: "members", func: "count", kind: "aggregate" },
    { alias: "city", field: "name", filterField: "company_id", kind: "subquery", outerField: "id", target: "db.Address" },
    { alias: "bad", field: "name", kind: "aggregate" }
  ]);

  assert.equal(converted.computed[0].kind, "aggregate");
  assert.equal(converted.computed[0].distinct, "always");
  assert.equal(converted.computed[1].kind, "scalarSubquery");
  assert.deepEqual(converted.computed[1].correlations, [{ nodeId: "legacy-correlation-2", outerPath: "id", targetPath: "company_id" }]);
  assert.deepEqual(converted.issues.map((issue) => issue.code), ["LEGACY_ANNOTATION_MALFORMED"]);
});

test("initial primary-key drill-in uses a normal Recipe comparison", () => {
  const recipe = createInitialPkModelQueryRecipe({ app: "db", model: "Company" }, 42);

  assert.deepEqual(recipe.where.children, [{
    kind: "comparison", lhs: { kind: "field", path: "pk" }, lookup: "exact", negated: false,
    nodeId: "initial-pk", rhs: { kind: "literal", value: 42 }
  }]);
});

test("recipe metadata remains in-process and is stripped from a socket rows request", async () => {
  let request;
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      request = JSON.parse(chunk.toString());
      socket.end(`${JSON.stringify({ columns: [], hasMore: false, nextOffset: null, ok: true, orm: "", rows: [], sql: [] })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const recipe = legacyQueryToRecipe({ filters: [{ field: "id", lookup: "exact", value: 1 }], source: { app: "db", model: "Company" } }).recipe;
  const client = new BackendClient({ host: "127.0.0.1", port, token: "secret" });
  client.setTransportMode("tcp");
  try {
    const result = await client.modelRows({ app: "db", columns: [], filters: [{ field: "id", lookup: "exact", value: "legacy" }], limit: 50, model: "Company", recipe, recipeMetadata: { catalog: [], models: {} } });
    assert.equal(result.ok, true);
    assert.equal(request.kind, "rows");
    assert.equal(request.recipe.version, 2);
    assert.equal("recipeMetadata" in request, false);
    assert.equal(request.token, "secret");
  } finally {
    server.close();
  }
});

test("ORM Recipe rows use the v2 compiler and never broaden an invalid metadata request", async () => {
  const recipe = createInitialPkModelQueryRecipe({ app: "db", model: "Company" }, 42);
  const metadata = {
    catalog: [{ app: "db", model: "Company" }],
    models: {
      "db.Company": {
        tree: { fields: [{ attname: "id", name: "id", null: false, pk: true, type: "AutoField" }], ok: true, pk: "id", relations: [] }
      }
    }
  };
  let ptyPayload;
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "secret" }, undefined, async (payload) => {
    ptyPayload = payload;
    return `${JSON.stringify({ grid: { columns: [], rows: [] }, ok: true, sql: [] })}\n`;
  });
  client.setTransportMode("orm");

  const result = await client.modelRows({ app: "db", columns: [{ attname: "id", editable: false, name: "id", null: false, pk: true, type: "AutoField" }], limit: 50, model: "Company", recipe, recipeMetadata: metadata, relations: [] });

  assert.equal(result.ok, true);
  assert.equal(result.recipeVersion, 2);
  assert.equal(ptyPayload.kind, "ormcell");
  assert.match(ptyPayload.code, /apps\.get_model\("db", "Company"\)/);
  assert.match(ptyPayload.code, /"pk__exact"/);

  let fallbackCalled = false;
  const invalidClient = new BackendClient({ host: "127.0.0.1", port: 9, token: "secret" }, undefined, async () => {
    fallbackCalled = true;
    return "";
  });
  invalidClient.setTransportMode("orm");
  const invalid = await invalidClient.modelRows({ app: "db", columns: [], limit: 50, model: "Company", recipe, relations: [] });
  assert.equal(invalid.ok, false);
  assert.equal(fallbackCalled, false);
  assert.ok(invalid.issues?.some((issue) => issue.code === "FIELD_METADATA_UNAVAILABLE"));
});
