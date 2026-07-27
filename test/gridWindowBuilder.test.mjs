// Verifies bounded metadata picker options for Window field references.
import assert from "node:assert/strict";
import test from "node:test";

import { windowFieldOptions } from "../media/gridWindowBuilder.js";

test("Window picker options include an explicit unset choice before fields", () => {
  assert.deepEqual(windowFieldOptions(["created_at", "id"], "Choose order"), [{ label: "Choose order", value: "" }, { label: "created_at", value: "created_at" }, { label: "id", value: "id" }]);
});
