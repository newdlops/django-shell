// Verifies the Python Recipe v2 hard limits remain explicit and transport-independent.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";
import { backendPythonDirectory } from "./backendComposedSourceHelper.mjs";

const backend = path.join(backendPythonDirectory(), "django_shell_backend.py");

/** Runs a short isolated backend expression and returns its JSON output. */
function backendJson(expression) {
  const script = `import importlib.util,json; s=importlib.util.spec_from_file_location('b',${JSON.stringify(backend)}); b=importlib.util.module_from_spec(s); s.loader.exec_module(b); print(json.dumps(${expression}))`;
  const result = childProcess.spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Recipe v2 backend exposes the fixed hard-limit contract", () => {
  assert.deepEqual(backendJson("b._browse_recipe_limits()"), {
    aliasCharacters: 64, caseBranches: 8, computedColumns: 12, formulaDepth: 6, formulaNodes: 32,
    groupByFields: 8, groupChildren: 16, groupDepth: 5, inValues: 200, orderTerms: 8,
    pathCharacters: 240, pathSegments: 12, predicateNodes: 64, rawExpressionCharacters: 800,
    recipeBytes: 65536, stringCharacters: 4096, subqueryCorrelations: 4, subqueryOrderTerms: 3
  });
});

