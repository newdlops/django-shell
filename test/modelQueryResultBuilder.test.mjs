// Tests Recipe result-mode labels, outer-order safeguards, and pagination selection.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { describeResultMode, outerOrderIssues, recipePaginationMode, resultCountLabel } from "../media/gridQueryResultBuilder.js";
import { describeQueryRecipe } from "../media/gridQuerySummary.js";

test("result helpers describe grouped and global summary output", () => {
  const grouped = { computed: [], groupBy: [{ kind: "field", path: "state" }], mode: "summary", orderBy: [] };
  assert.equal(describeResultMode(grouped), "Summary · 1 group field");
  assert.equal(resultCountLabel(grouped, 2), "2 groups");
  assert.equal(resultCountLabel({ ...grouped, groupBy: [] }, 0), "1 summary row");
});

test("outer order protects the eight-term limit and duplicate references", () => {
  const terms = Array.from({ length: 9 }, (_, index) => ({ direction: "asc", nodeId: `order-${index}`, ref: { kind: "field", path: index === 8 ? "field0" : `field${index}` } }));
  const codes = outerOrderIssues(terms).map((issue) => issue.code);
  assert.ok(codes.includes("ORDER_TERM_LIMIT"));
  assert.ok(codes.includes("ORDER_REFERENCE_DUPLICATE"));
});

test("only the default non-computed result shape uses primary-key keyset pagination", () => {
  assert.equal(recipePaginationMode({ computed: [], orderBy: [] }), "pk-keyset");
  assert.equal(recipePaginationMode({ computed: [{ enabled: true, kind: "formula" }], orderBy: [] }), "offset");
  assert.equal(recipePaginationMode({ computed: [], orderBy: [{ ref: { kind: "field", path: "name" } }] }), "offset");
});

test("worst-case Recipe summaries remain bounded and preview scheduling coalesces edits", () => {
  const recipe = {
    computed: Array.from({ length: 12 }, (_, index) => ({ alias: `metric_${index}`, enabled: true, kind: "formula" })), groupBy: [], mode: "rows", orderBy: [],
    where: { children: Array.from({ length: 64 }, (_, index) => ({ kind: "comparison", lhs: { kind: "field", path: `field_${index}` }, lookup: "exact", rhs: { kind: "literal", value: index } })), join: "and", kind: "group", negated: false }
  };
  const started = performance.now();
  const summary = describeQueryRecipe(recipe);
  assert.ok(performance.now() - started < 100, "summary rendering should not become a visible typing pause");
  assert.match(summary, /field_63/);
  const controller = fs.readFileSync(new URL("../media/gridQueryController.js", import.meta.url), "utf8");
  const browser = fs.readFileSync(new URL("../src/modelBrowser.ts", import.meta.url), "utf8");
  assert.match(controller, /window\.clearTimeout\(previewTimer\)/);
  assert.match(controller, /}, 400\)/);
  assert.match(browser, /recipeTreeRequests/);
  assert.match(browser, /recipeTreeCache/);
});

test("Rows conversion remains explicit because it discards Summary group fields", () => {
  const controller = fs.readFileSync(new URL("../media/gridQueryController.js", import.meta.url), "utf8");
  assert.match(controller, /SET_PENDING_RESULT_MODE/);
  assert.match(controller, /Switching to Rows removes the selected summary group fields/);
  assert.match(controller, /CLEAR_PENDING_RESULT_MODE/);
});
