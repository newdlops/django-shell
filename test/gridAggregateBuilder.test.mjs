// Verifies safe Aggregate field picker options and legacy-value recovery.
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateFieldOptions } from "../media/gridAggregateBuilder.js";

test("Aggregate field options keep the all-rows choice and known metadata fields", () => {
  assert.deepEqual(aggregateFieldOptions([{ label: "Amount — amount", path: "amount", type: "DecimalField" }], "amount"), [{ label: "All rows", value: "*" }, { description: "DecimalField", label: "Amount — amount", value: "amount" }]);
});

test("Aggregate field options preserve an unavailable legacy field until the user repairs it", () => {
  const options = aggregateFieldOptions([], "old_amount");
  assert.deepEqual(options[1], { description: "Choose a supported replacement.", disabled: true, disabledReason: "Unavailable field", label: "Unavailable field: old_amount", value: "old_amount" });
});
