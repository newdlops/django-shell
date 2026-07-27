// Verifies bounded and selected-pinned option lists for Query Builder comboboxes.
import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../media/gridCombobox.js";

/** Builds simple allowlisted combobox options for bounded-list coverage. */
function options(count) { return Array.from({ length: count }, (_, index) => ({ label: `Field ${index}`, value: `field_${index}` })); }

test("combobox option rendering stays bounded for empty, short, and large metadata lists", () => {
  assert.deepEqual(__test.boundedOptions([], "", 60), []);
  assert.equal(__test.boundedOptions(options(1), "", 60).length, 1);
  assert.equal(__test.boundedOptions(options(60), "", 60).length, 60);
  assert.equal(__test.boundedOptions(options(61), "", 60).length, 60);
});

test("combobox pins a selected option that falls outside the initial render window", () => {
  const visible = __test.boundedOptions(options(61), "field_60", 60);
  assert.equal(visible.length, 60);
  assert.equal(visible[0].value, "field_60");
  assert.equal(visible.some((option) => option.value === "field_59"), false);
});
