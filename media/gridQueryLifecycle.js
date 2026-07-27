// Pure validation and Apply lifecycle transitions for the Model Data Query Builder.

/** Creates the initial validation lifecycle for an empty or freshly hydrated draft. */
export function createValidationLifecycle() {
  return { issues: [], phase: "idle", requestId: "", revision: 0, warnings: [] };
}

/** Creates the initial Apply lifecycle before a query has been submitted. */
export function createApplyLifecycle() {
  return { phase: "idle", revision: 0 };
}

/** Returns whether a lifecycle event belongs to the latest known draft revision. */
function matchesRevision(state, event) {
  return Number.isSafeInteger(event.revision) && event.revision === state.revision;
}

/** Normalizes a host validation payload without retaining mutable message references. */
function validationPayload(validation) {
  const issues = Array.isArray(validation?.issues) ? validation.issues.map((issue) => ({ ...issue })) : [];
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings.map((issue) => ({ ...issue })) : issues.filter((issue) => issue?.severity === "warning");
  return { issues, warnings };
}

/** Transitions validation state while ignoring stale preview events. */
export function transitionValidation(state = createValidationLifecycle(), event = {}) {
  if (event.type === "SOURCE_CHANGED") { return { ...createValidationLifecycle(), revision: Number.isSafeInteger(event.revision) ? event.revision : 0 }; }
  if (event.type === "DRAFT_CHANGED") { return { issues: [], phase: "pending", requestId: "", revision: event.revision, warnings: [] }; }
  if (event.type === "PREVIEW_TIMER_FIRED" && matchesRevision(state, event)) { return { ...state, phase: "previewing", requestId: String(event.requestId || "") }; }
  if (event.type === "PREVIEW_ACCEPTED" && matchesRevision(state, event) && (!state.requestId || state.requestId === event.requestId)) {
    const payload = validationPayload(event.validation);
    return { ...state, ...payload, phase: payload.issues.some((issue) => issue?.severity !== "warning") ? "invalid" : "ready" };
  }
  if (event.type === "PREVIEW_REJECTED" && matchesRevision(state, event) && (!state.requestId || state.requestId === event.requestId)) {
    const payload = validationPayload({ issues: event.issues, warnings: [] });
    return { ...state, ...payload, phase: "invalid" };
  }
  return state;
}

/** Transitions Apply/result state while retaining only the latest matching submission. */
export function transitionApply(state = createApplyLifecycle(), event = {}) {
  if (event.type === "SOURCE_CHANGED") { return createApplyLifecycle(); }
  if (event.type === "APPLY_STARTED") { return { phase: "applying", revision: event.revision }; }
  if (!matchesRevision(state, event)) { return state; }
  if (event.type === "APPLY_ACCEPTED") { return { ...state, phase: "loadingResults" }; }
  if (event.type === "RESULTS_ACCEPTED") { return { phase: "idle", revision: state.revision }; }
  if (event.type === "APPLY_REJECTED" || event.type === "RESULTS_FAILED") { return { ...state, phase: "failed" }; }
  return state;
}

/** Returns whether the validation lifecycle permits an Apply attempt for its exact draft revision. */
export function validationAllowsApply(state, revision) {
  return state?.phase === "ready" && state.revision === revision;
}

/** Exposes transition internals for focused lifecycle tests. */
export const __test = { matchesRevision, validationPayload };
