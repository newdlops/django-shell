// Focused contract tests for bounded Formula AST helpers and draft shapes.
import assert from "node:assert/strict";
import test from "node:test";
import { createComputedDraft } from "../media/gridComputedShared.js";
import { formulaArity, formulaMetrics } from "../media/gridFormulaBuilder.js";

test("Formula function arity follows the allowlisted function contracts", () => {
  for (const name of ["coalesce", "concat", "greatest", "least"]) { assert.equal(formulaArity(name), 2); }
  for (const name of ["lower", "upper", "trim", "length"]) { assert.equal(formulaArity(name), 1); }
});

test("Formula metrics include Binary, Case, Cast, and Function descendants", () => {
  const expression = { kind: "case", branches: [{ then: { args: [{ kind: "literal", value: 1 }], function: "lower", kind: "function" }, when: { children: [], join: "and", kind: "group", negated: false, nodeId: "when-1" } }], else: { expression: { kind: "literal", value: 2 }, kind: "cast", outputType: "text" } };
  assert.deepEqual(formulaMetrics(expression), { depth: 3, nodes: 5 });
});

test("Formula drafts preserve a typed output contract and literal expression starter", () => {
  const item = createComputedDraft("formula", "formula-1", "display_name");
  assert.equal(item.expression.kind, "literal");
  assert.equal(item.outputType, "auto");
});
