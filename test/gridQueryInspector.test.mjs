// Verifies Query Builder ORM-preview copy behavior without a live VS Code webview.
import assert from "node:assert/strict";
import test from "node:test";

import { copyQueryOrmPreview } from "../media/gridQueryInspector.js";

/** Creates the smallest root needed by the ORM copy helper. */
function root(text) { return { getElementById: () => ({ textContent: text }) }; }

/** Runs one callback with a deterministic clipboard implementation and restores globals afterward. */
async function withClipboard(writeText, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText } } });
  try { return await callback(); }
  finally {
    if (descriptor) { Object.defineProperty(globalThis, "navigator", descriptor); }
    else { delete globalThis.navigator; }
  }
}

test("ORM copy sends only host-generated ORM source, not its presentation heading", async () => {
  const copied = [];
  const result = await withClipboard(async (value) => { copied.push(value); }, () => copyQueryOrmPreview(root("Django ORM\nCompany.objects.filter(id__gte=1)")));

  assert.equal(result, true);
  assert.deepEqual(copied, ["Company.objects.filter(id__gte=1)"]);
});

test("ORM copy fails safely when preview content or clipboard support is unavailable", async () => {
  assert.equal(await copyQueryOrmPreview(root("No generated preview")), false);
  const result = await withClipboard(async () => { throw new Error("denied"); }, () => copyQueryOrmPreview(root("Django ORM\nCompany.objects.all()")));
  assert.equal(result, false);
});
