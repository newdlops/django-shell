// Guards constant-cost array cell metadata and bounded handling of wide JSON objects.
import assert from "node:assert/strict";
import test from "node:test";
import { editableArrayLength } from "../media/gridArrayValue.js";
import { __test as arrayEditor } from "../media/gridArrayEdit.js";

test("painting metadata-backed lists never reads or parses the full JSON text", () => {
  const cell = { t: "json", kind: "array", len: 10000, get edit() { throw new Error("Full array was read during painting"); } };
  for (let index = 0; index < 1000; index++) { assert.equal(editableArrayLength({ type: "JSONField" }, cell), 10000); }
  assert.equal(editableArrayLength({ type: "JSONField" }, { t: "json", kind: "scalar", edit: "false" }), undefined);
});

test("legacy cell payloads reuse their item count without retaining parsed values", () => {
  let reads = 0;
  const cell = { t: "json", get edit() { reads++; return '[9007199254740993,{"a":[1,2]},"a,b"]'; } };
  for (let index = 0; index < 30; index++) { assert.equal(editableArrayLength({ type: "JSONField" }, cell), 3); }
  assert.equal(reads, 1);
  assert.equal(editableArrayLength({ type: "ArrayField" }, ""), 0); assert.equal(editableArrayLength({ type: "JSONField" }, ""), undefined);
  assert.equal(editableArrayLength({ type: "JSONField" }, "[1,]"), undefined);
});

test("wide object arrays use bounded per-item JSON controls instead of a column explosion", () => {
  const item = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key${index}`, index]));
  assert.deepEqual(arrayEditor.arrayShape([item]), { keys: [], kind: "scalar", wide: true });
  assert.deepEqual(arrayEditor.coerceInput(arrayEditor.inputText(item), item), item);
});
