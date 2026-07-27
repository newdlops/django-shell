// Verifies field-aware scalar input selection and JSON-safe Query Builder parsing.
import assert from "node:assert/strict";
import test from "node:test";

import { inputTypeForQueryScalar, parseQueryScalar } from "../media/gridQueryScalarEditor.js";

test("scalar editor selects native controls from Django field and lookup shape", () => {
  assert.equal(inputTypeForQueryScalar({ type: "DateField" }, "exact"), "date");
  assert.equal(inputTypeForQueryScalar({ type: "DateTimeField" }, "exact"), "datetime-local");
  assert.equal(inputTypeForQueryScalar({ type: "IntegerField" }, "exact"), "number");
  assert.equal(inputTypeForQueryScalar({ type: "CharField" }, "year"), "number");
});

test("scalar editor preserves empty, invalid, boolean, and numeric user input safely", () => {
  assert.equal(parseQueryScalar({ type: "IntegerField" }, ""), null);
  assert.equal(parseQueryScalar({ type: "IntegerField" }, "42"), 42);
  assert.equal(parseQueryScalar({ type: "DecimalField" }, "not-a-number"), "not-a-number");
  assert.equal(parseQueryScalar({ type: "BooleanField" }, "true"), true);
  assert.equal(parseQueryScalar({ type: "BooleanField" }, "false"), false);
});
