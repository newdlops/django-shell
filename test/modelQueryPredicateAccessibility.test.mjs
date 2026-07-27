// Guards keyboard and ARIA contracts of the standalone recursive Query Builder surface.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const builderSource = fs.readFileSync(new URL("../media/gridPredicateBuilder.js", import.meta.url), "utf8");
const valueSource = fs.readFileSync(new URL("../media/gridPredicateValue.js", import.meta.url), "utf8");

test("predicate builder retains semantic grouping, quiet inline issue details, and structural focus targets", () => {
  assert.match(builderSource, /el\("fieldset"/);
  assert.match(builderSource, /ariaLive: "polite"/);
  assert.match(builderSource, /role: "note"/);
  assert.doesNotMatch(builderSource, /query-predicate-issues", dataset[^\n]*ariaLive/);
  assert.match(builderSource, /data-focus-role = "lhs"|dataset\.focusRole = "lhs"/);
  assert.match(builderSource, /Maximum depth/);
});

test("predicate builder supplies keyboard equivalents for move and duplicate controls", () => {
  assert.match(builderSource, /MOVE_NODE_UP/);
  assert.match(builderSource, /MOVE_NODE_DOWN/);
  assert.match(builderSource, /DUPLICATE_NODE/);
  assert.match(builderSource, /event\.altKey && event\.shiftKey/);
  assert.match(builderSource, /event\.key\.toLowerCase\(\) === "d"/);
});

test("predicate Exists sources use bounded pickers and release replaced picker listeners", () => {
  assert.match(builderSource, /createGridCombobox/);
  assert.match(builderSource, /label: "Exists relation"/);
  assert.match(builderSource, /label: "Exists target model"/);
  assert.match(builderSource, /releasePickers\(\);/);
});

test("validation refresh only replaces issue regions instead of active predicate controls", () => {
  assert.match(builderSource, /dataset: \{ queryIssueNodeId: nodeId \}/);
  assert.match(builderSource, /function updateValidation\(\)/);
  assert.match(builderSource, /region\.replaceChildren\(\)/);
  assert.match(builderSource, /node, render, updateValidation/);
});

test("typed value controls expose persistent labels for relative, list, range, and field RHS", () => {
  for (const label of ["Relative time amount", "Add list value", "Range lower bound", "Compare to field", "Outer field"]) {
    assert.ok(valueSource.includes(label), label);
  }
  assert.match(valueSource, /No value needed/);
});

test("comparison rows expose visible Field, Comparison, Compare with, and Value labels", () => {
  for (const label of ["Field", "Comparison", "Compare with", "Value"]) { assert.ok(builderSource.includes(`"${label}"`), label); }
});

test("group join control appears only when a group has more than one child", () => {
  assert.match(builderSource, /group\.children \|\| \[\]\)\.length > 1/);
});
