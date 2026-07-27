// Verifies temporal validation and Apply lifecycle transitions.
import assert from "node:assert/strict";
import test from "node:test";

const { createApplyLifecycle, createValidationLifecycle, transitionApply, transitionValidation, validationAllowsApply } = await import("../media/gridQueryLifecycle.js");

test("validation ignores stale previews and accepts warning-only previews", () => {
  let lifecycle = transitionValidation(createValidationLifecycle(), { revision: 4, type: "DRAFT_CHANGED" });
  lifecycle = transitionValidation(lifecycle, { requestId: "preview-4", revision: 4, type: "PREVIEW_TIMER_FIRED" });
  lifecycle = transitionValidation(lifecycle, { requestId: "preview-3", revision: 3, type: "PREVIEW_ACCEPTED", validation: { issues: [{ severity: "error" }] } });
  assert.equal(lifecycle.phase, "previewing");
  lifecycle = transitionValidation(lifecycle, { requestId: "preview-4", revision: 4, type: "PREVIEW_ACCEPTED", validation: { issues: [{ severity: "warning" }] } });
  assert.equal(lifecycle.phase, "ready");
  assert.equal(validationAllowsApply(lifecycle, 4), true);
});

test("Apply lifecycle preserves a newer revision against stale results", () => {
  let lifecycle = transitionApply(createApplyLifecycle(), { revision: 8, type: "APPLY_STARTED" });
  lifecycle = transitionApply(lifecycle, { revision: 8, type: "APPLY_ACCEPTED" });
  assert.equal(lifecycle.phase, "loadingResults");
  lifecycle = transitionApply(lifecycle, { revision: 7, type: "RESULTS_ACCEPTED" });
  assert.equal(lifecycle.phase, "loadingResults");
  lifecycle = transitionApply(lifecycle, { revision: 8, type: "RESULTS_ACCEPTED" });
  assert.equal(lifecycle.phase, "idle");
});
