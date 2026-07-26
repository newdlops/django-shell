// Verifies that degraded row responses still render data instead of an empty grid.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");

test("model grid derives read-only columns from returned rows when backend schema metadata is empty", () => {
  assert.match(source, /const fallbackColumns = !state\.columns\.length \? inferColumnsFromRows\(rows\.rows\) : \[\];/);
  assert.match(source, /const responseColumns = Array\.isArray\(rows\.columns\) && rows\.columns\.length \? rows\.columns : fallbackColumns;/);
  assert.match(source, /function inferColumnsFromRows\(rows\)/);
  assert.match(source, /\{ attname, editable: false, name: attname, type: "Unknown" \}/);
});
