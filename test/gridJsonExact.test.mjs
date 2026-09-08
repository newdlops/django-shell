// Verifies exact JSON tokens through array editing, numeric inputs, and nested value round trips.
import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonExact, stringifyJsonExact } from "../media/gridJson.js";
import { __test as arrayEditor } from "../media/gridArrayEdit.js";

test("array edits preserve untouched big integers and distinguish numbers from numeric strings", () => {
  const parsed = arrayEditor.parseEditableArray({ type: "JSONField" }, '[9007199254740993,-9007199254740995,{"name":"old","id":9007199254740997},"9007199254740993"]');
  assert.equal(parsed.items[0], 9007199254740993n); assert.equal(parsed.items[1], -9007199254740995n);
  parsed.items[2].name = "edited";
  assert.equal(stringifyJsonExact(parsed.items), '[9007199254740993,-9007199254740995,{"name":"edited","id":9007199254740997},"9007199254740993"]');
  assert.equal(arrayEditor.coerceInput("9007199254740999", 1, "BigIntegerField"), 9007199254740999n);
  assert.equal(arrayEditor.coerceInput("-9007199254740999", 9007199254740993n), -9007199254740999n);
  assert.deepEqual(arrayEditor.coerceInput('{"id":9007199254740993}', {}), { id: 9007199254740993n });
});

test("exact JSON parsing retains ordinary JSON semantics, escaped text, and object keys", () => {
  for (const source of ['null', 'true', 'false', '1.5e2', '-0', '[1,"x\\\"y",null,true,{"a":[]}]', '{"a":1,"a":2,"__proto__":{"ok":true}}']) {
    const value = parseJsonExact(source);
    assert.deepEqual(value, JSON.parse(source));
    assert.deepEqual(JSON.parse(stringifyJsonExact(value)), JSON.parse(JSON.stringify(JSON.parse(source))));
  }
  for (const source of ['[1,]', '{"x":}', '01', '1e', 'true false', '[', '"bad\\q"', '{"a":1,}', '\u00a0null']) {
    assert.throws(() => parseJsonExact(source), SyntaxError, source);
  }
});
