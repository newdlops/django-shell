// Contract tests for every stable validation issue presentation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { QUERY_ISSUE_GUIDANCE, presentQueryIssue } from "../media/gridQueryIssueGuidance.js";

/** Reads the canonical TypeScript code list without requiring a runtime TypeScript loader. */
async function validatorCodes() {
  const source = await readFile(new URL("../src/modelQueryRecipeValidation.ts", import.meta.url), "utf8");
  const declaration = source.match(/MODEL_QUERY_ISSUE_CODES\s*=\s*\[([^\]]+)\]/s)?.[1] || "";
  return [...new Set([...declaration.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]))];
}

/** Ensures a new backend code cannot silently ship without understandable copy. */
test("issue guidance covers every validator issue code", async () => {
  const codes = await validatorCodes();
  assert.deepEqual(Object.keys(QUERY_ISSUE_GUIDANCE).sort(), codes.sort());
  for (const code of codes) {
    const presentation = presentQueryIssue({ code, fix: "Fix it.", path: "/where" });
    assert.ok(presentation.title.length > 0, code);
    assert.ok(presentation.explanation.length > 0, code);
    assert.equal(presentation.fix, "Fix it.");
  }
});

/** Keeps unknown backend failures actionable while retaining diagnostic details. */
test("unknown issue guidance is safe and actionable", () => {
  assert.deepEqual(presentQueryIssue({ code: "FUTURE_PROBLEM", message: "New problem", path: "/x" }), { title: "FUTURE PROBLEM", explanation: "New problem", fix: "Review the highlighted query setting.", severity: "error", technical: { code: "FUTURE_PROBLEM", path: "/x" } });
});
