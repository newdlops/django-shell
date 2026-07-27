// Guards Recipe v2 structured compilation against dynamic evaluation and legacy silent-drop patterns.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { backendPythonDirectory } from "./backendComposedSourceHelper.mjs";

const parts = path.join(backendPythonDirectory(), "backend_parts");
const predicate = fs.readFileSync(path.join(parts, "90_model_query_recipe_predicate.pyfrag"), "utf8");
const computed = fs.readFileSync(path.join(parts, "91_model_query_recipe_computed.pyfrag"), "utf8");

test("structured Recipe predicates and Formula nodes do not use eval", () => {
  assert.equal(predicate.includes("eval("), false);
  assert.equal(computed.slice(0, computed.indexOf("def _browse_recipe_code_expression")).includes("eval("), false);
  assert.match(computed, /_browse_eval_annotation_expression/);
});

test("Recipe failure payload is atomic and retains issue details", () => {
  assert.match(predicate, /"issues": state\["issues"\]/);
  assert.match(predicate, /"rows": \[\]/);
  assert.match(predicate, /RECIPE_SOURCE_MISMATCH/);
  assert.match(predicate, /FIELD_PATH_INVALID/);
});

