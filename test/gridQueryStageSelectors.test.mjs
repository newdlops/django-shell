// Verifies Query Builder stage counts and issue routing.
import assert from "node:assert/strict";
import test from "node:test";

const { queryStageCounts, stageForIssue, stageLabel } = await import("../media/gridQueryStageSelectors.js");

test("stage counts include nested and Exists predicate work", () => {
  const recipe = { computed: [{ enabled: false }, { enabled: true }], groupBy: [{ path: "state" }], orderBy: [{ ref: { path: "name" } }], postFilter: { children: [{ kind: "comparison" }] }, where: { children: [{ children: [{ kind: "comparison" }], kind: "group" }, { kind: "existsPredicate", where: { children: [{ kind: "comparison" }] } }] } };
  assert.deepEqual(queryStageCounts(recipe), { calculatedValues: 2, filterResults: 1, filterRows: 4, result: 2 });
});

test("issue paths route to a visible workspace stage", () => {
  assert.equal(stageForIssue({ path: "computed.0.alias" }), "calculatedValues");
  assert.equal(stageForIssue({ path: "postFilter.children.0" }), "filterResults");
  assert.equal(stageForIssue({ path: "orderBy.0" }), "result");
  assert.equal(stageForIssue({ path: "where.children.0" }), "filterRows");
  assert.equal(stageLabel("result", 2), "Result (2)");
});
