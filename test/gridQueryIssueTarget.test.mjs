// Verifies pure validation-issue routing for the four-stage Query Builder workspace.
import assert from "node:assert/strict";
import test from "node:test";

import { stageForQueryIssue } from "../media/gridQueryIssueTarget.js";

test("issue target routing prioritizes explicit stage paths and safely defaults to Filter Rows", () => {
  assert.equal(stageForQueryIssue({ controlKey: "annotation.0.source" }), "calculatedValues");
  assert.equal(stageForQueryIssue({ path: "having.children.0" }), "filterResults");
  assert.equal(stageForQueryIssue({ path: "groupBy.0" }), "result");
  assert.equal(stageForQueryIssue({}), "filterRows");
});
