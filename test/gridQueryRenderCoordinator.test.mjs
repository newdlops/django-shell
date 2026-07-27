// Verifies coalesced, signature-gated Query Builder rendering.
import assert from "node:assert/strict";
import test from "node:test";

const { createQueryRenderCoordinator } = await import("../media/gridQueryRenderCoordinator.js");

test("render coordinator coalesces requests and skips unchanged regions", () => {
  const queued = [];
  const updates = [];
  let revision = 0;
  const coordinator = createQueryRenderCoordinator({ getModel: () => ({ revision }), regions: [{ id: "summary", signature: (model) => model.revision, update: (model) => updates.push(model.revision) }], schedule: (work) => queued.push(work) });

  coordinator.request("draft"); coordinator.request("validation");
  assert.equal(queued.length, 1);
  queued.shift()();
  coordinator.request("same"); queued.shift()();
  revision = 1; coordinator.request("changed"); queued.shift()();

  assert.deepEqual(updates, [0, 1]);
});

test("render coordinator uses only the latest model and restores focus after a region failure", () => {
  const queued = [];
  const models = [];
  const restores = [];
  let revision = 0;
  const coordinator = createQueryRenderCoordinator({
    captureFocus: () => "captured",
    getModel: () => ({ revision }),
    regions: [
      { id: "first", signature: (model) => model.revision, update: (model) => models.push(model.revision) },
      { id: "broken", signature: () => "once", update: () => { throw new Error("region failed"); } }
    ],
    restoreFocus: (...args) => restores.push(args),
    schedule: (work) => queued.push(work)
  });

  coordinator.request("first");
  revision = 2;
  coordinator.request("latest");
  assert.throws(() => queued.shift()(), /region failed/);
  assert.deepEqual(models, [2]);
  assert.deepEqual(restores, [["captured", { revision: 2 }, ["first", "latest"]]]);
});

test("render coordinator safely ignores queued work after destruction", () => {
  const queued = [];
  const destroyed = [];
  const updates = [];
  const coordinator = createQueryRenderCoordinator({
    getModel: () => ({ revision: 1 }),
    regions: [{ destroy: () => destroyed.push("region"), id: "main", signature: () => 1, update: () => updates.push("render") }],
    schedule: (work) => queued.push(work)
  });

  coordinator.request("pending");
  coordinator.destroy();
  queued.shift()();
  coordinator.request("after-destroy");
  assert.deepEqual(destroyed, ["region"]);
  assert.deepEqual(updates, []);
});
