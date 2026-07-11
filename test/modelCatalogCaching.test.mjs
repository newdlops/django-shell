// Regression tests for backend-lifetime model catalog caching and explicit refreshes.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BackendClient } = require("../out/backendClient.js");

test("model catalog coalesces automatic loads per backend and refreshes only when forced", async () => {
  let ptyEnumerations = 0;
  let releaseFirst;
  const firstRequest = new Promise((resolve) => { releaseFirst = resolve; });
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" }, undefined, async (payload) => {
    assert.equal(payload.code, "len(apps.get_models())");
    ptyEnumerations += 1;
    if (ptyEnumerations === 1) { await firstRequest; }
    return `${JSON.stringify({ models: { models: [{ app: "db", label: "company", model: "Company", table: "db_company" }], ok: true }, ok: true, result: "1" })}\n`;
  });
  client.setTransportMode("orm");
  const left = client.models();
  const right = client.models();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ptyEnumerations, 1, "concurrent visible-view loads share one PTY model enumeration");
  const forcedDuringLoad = client.models(true);
  assert.equal(ptyEnumerations, 1, "a forced refresh waits for the active automatic enumeration");
  releaseFirst();
  await Promise.all([left, right]);
  await forcedDuringLoad;
  assert.equal(ptyEnumerations, 2, "the queued forced refresh performs a fresh enumeration after the automatic load");

  const cached = await client.models();
  assert.equal(cached.models[0].model, "Company");
  assert.equal(ptyEnumerations, 2, "cell-driven runtime invalidation does not type another ORM probe");

  await client.models(true);
  assert.equal(ptyEnumerations, 3, "the explicit refresh action bypasses a completed cache");
});

test("catalog UI reserves forced reloads for the explicit refresh command", () => {
  const source = fs.readFileSync(new URL("../src/modelCatalog.ts", import.meta.url), "utf8");
  assert.ok(source.includes('registerCommand("djangoShell.refreshModelCatalog", () => this.refresh(true))'));
  assert.ok(source.includes("this.source.listModels(force)"));
  assert.ok(source.includes("if (this.stale) { this.refresh(); }"), "runtime and visibility refreshes remain cacheable");
});
