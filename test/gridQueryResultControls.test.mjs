// Verifies pure direct and calculated reference grouping for Result-stage pickers.
import assert from "node:assert/strict";
import test from "node:test";

import { resultReferenceOptions } from "../media/gridQueryResultControls.js";

test("Result references preserve direct fields and enabled calculated values as separate groups", () => {
  const options = resultReferenceOptions([{ label: "Company ID — id", path: "id" }], [{ alias: "latest_valuation_id", enabled: true }, { alias: "disabled_total", enabled: false }]);
  assert.deepEqual(options, [{ group: "Fields", label: "Company ID — id", value: "id" }, { group: "Calculated values", label: "calculated value latest_valuation_id", value: "@latest_valuation_id" }]);
});
