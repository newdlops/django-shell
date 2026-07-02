// Unit tests for choosing DAP step-in targets.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { chooseStepInTarget, pythonDirectCallIdentifierSpans, pythonIdentifierSpans, pythonImportedOrDefinedNames } = require("../out/debugStepTargetSelection.js");

test("chooses the user function target over Django descriptor targets", () => {
  const selected = chooseStepInTarget([
    { id: 10, label: "RelatedDescriptor.__get__" },
    { id: 11, label: "target_service" }
  ], ["target_service"]);

  assert.equal(selected.id, 11);
});

test("prefers the last non-zero duplicate debugpy target for a direct imported call", () => {
  const selected = chooseStepInTarget([
    { id: 0, label: "create_hrm_emp_from_employee(ps._deprecated_employee)" },
    { id: 1, label: "create_hrm_emp_from_employee(ps._deprecated_employee) (call 2)" },
    { id: 2, label: "create_hrm_emp_from_employee(ps._deprecated_employee) (call 3)" },
    { id: 3, label: "create_hrm_emp_from_employee(ps._deprecated_employee) (call 4)" },
    { id: 4, label: "ps.save(update_fields=[\"tmp_hrm_emp\"])" }
  ], ["create_hrm_emp_from_employee"]);

  assert.equal(selected.id, 3);
});

test("matches step-in targets by source range when labels are ambiguous", () => {
  const selected = chooseStepInTarget([
    { column: 10, id: 20, label: "call", line: 7 },
    { column: 25, id: 21, label: "call", line: 7 }
  ], ["target_service"], 7, "result = target_service(customer)");

  assert.equal(selected.id, 20);
});

test("extracts Python identifiers without keywords", () => {
  assert.deepEqual(pythonIdentifierSpans("return target_service(customer)").map((span) => span.name), ["target_service", "customer"]);
});

test("finds direct imported function calls without treating attributes as direct targets", () => {
  const line = "    create_hrm_emp_from_employee(ps._deprecated_employee); ps.save(update_fields=['tmp_hrm_emp'])";

  assert.deepEqual(pythonDirectCallIdentifierSpans(line).map((span) => span.name), ["create_hrm_emp_from_employee"]);
});

test("parses parenthesized imports as known step-in candidate names", () => {
  const source = [
    "from zuzu.packages.hrm.emp.services.hrm_emp_to_employee_sync_service import (",
    "    create_hrm_emp_from_employee,",
    ")",
    "def local_helper():",
    "    pass"
  ].join("\n");

  assert.deepEqual([...pythonImportedOrDefinedNames(source)].sort(), ["create_hrm_emp_from_employee", "local_helper"]);
});
