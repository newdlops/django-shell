// Unit tests for generation-safe asynchronous runtime metadata caching.

import assert from "node:assert/strict";
import test from "node:test";

import { VersionedAsyncCache } from "../out/versionedAsyncCache.js";

test("a stale request cannot overwrite or clear a newer runtime cache entry", async () => {
  const cache = new VersionedAsyncCache();
  const old = deferred();
  const fresh = deferred();
  const first = cache.get(() => old.promise);

  cache.invalidate();
  const second = cache.get(() => fresh.promise);
  fresh.resolve("fresh");
  assert.equal(await second, "fresh");
  old.resolve("stale");
  assert.equal(await first, "stale", "the original caller may still receive its own completed request");
  assert.equal(await cache.get(() => Promise.resolve("unexpected")), "fresh");
});

test("joins one loader within a generation and starts a new loader after invalidation", async () => {
  const cache = new VersionedAsyncCache();
  const gate = deferred();
  let loads = 0;
  const load = () => { loads += 1; return gate.promise; };

  const first = cache.get(load);
  const joined = cache.get(load);
  assert.equal(loads, 1);
  gate.resolve(7);
  assert.equal(await first, 7);
  assert.equal(await joined, 7);
  assert.equal(await cache.get(load), 7);
  cache.invalidate();
  assert.equal(await cache.get(() => Promise.resolve(8)), 8);
});

test("normalizes a synchronous loader failure into a rejected promise", async () => {
  const cache = new VersionedAsyncCache();
  const pending = cache.get(() => { throw new Error("sync failure"); });
  await assert.rejects(pending, /sync failure/);
  assert.equal(await cache.get(() => Promise.resolve("recovered")), "recovered");
});

/** Creates a manually settled promise for deterministic overlap tests. */
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
