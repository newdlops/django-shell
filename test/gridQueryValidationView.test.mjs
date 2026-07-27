// Verifies invalid-control annotations preserve Query Builder field help and clear safely.
import assert from "node:assert/strict";
import test from "node:test";

import { applyQueryValidationAnnotations } from "../media/gridQueryValidationView.js";

/** Creates one minimal editable control with ARIA attributes and stable Query Builder keys. */
function control() {
  const attributes = new Map([["aria-describedby", "existing-help"]]);
  return {
    dataset: {},
    getAttribute: (name) => attributes.get(name),
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, String(value))
  };
}

/** Creates the smallest root that resolves both exact control keys and node fallbacks. */
function root(input) {
  return {
    querySelector(selector) {
      if (selector.includes("comparison-1") && selector.includes("value")) { return input; }
      if (selector.includes("comparison-1")) { return { querySelector: () => input }; }
      return undefined;
    },
    querySelectorAll(selector) { return selector === "[data-query-validation-message]" && input.dataset.queryValidationMessage ? [input] : []; }
  };
}

test("validation annotations mark the exact control and retain existing help text", () => {
  const input = control();
  const documentRoot = root(input);
  const validation = { issues: [{ controlKey: "comparison-1:value", nodeId: "comparison-1", severity: "error" }] };

  applyQueryValidationAnnotations(documentRoot, validation);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), "existing-help query-node-issues-comparison-1");
  assert.equal(input.dataset.queryValidationMessage, "query-node-issues-comparison-1");

  applyQueryValidationAnnotations(documentRoot, { issues: [] });
  assert.equal(input.getAttribute("aria-invalid"), undefined);
  assert.equal(input.getAttribute("aria-describedby"), "existing-help");
  assert.equal(input.dataset.queryValidationMessage, undefined);
});
