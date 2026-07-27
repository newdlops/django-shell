// Immutable draft/applied ModelQueryRecipeV2 state for the Model Data Query Builder.

import { cloneQueryRecipe, createEmptyQueryRecipe, reduceQueryRecipe } from "./gridQueryRecipeReducer.js";

export { createEmptyQueryRecipe } from "./gridQueryRecipeReducer.js";

/** Compares Recipe values by their JSON contract rather than object identity. */
function sameRecipe(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Creates the single source of truth for applied and editable query recipes. */
export function createQueryRecipeStore(initialRecipe) {
  let snapshot = {
    applied: cloneQueryRecipe(initialRecipe), appliedRevision: 0, applyingRevision: undefined, draft: cloneQueryRecipe(initialRecipe), draftRevision: 0,
    canRedo: false, canUndo: false, dirty: false, validation: { issues: [], ok: true, warnings: [] }, validationRevision: 0
  };
  const listeners = new Set();
  const history = { future: [], past: [], pendingGroup: undefined };
  const historyLimit = 50;
  const publish = () => { snapshot = { ...snapshot, dirty: !sameRecipe(snapshot.draft, snapshot.applied) }; listeners.forEach((listener) => listener(snapshot)); };
  const set = (changes) => { snapshot = { ...snapshot, ...changes }; publish(); };

  /** Synchronizes the public history availability flags without exposing Recipe snapshots. */
  function setHistoryFlags() { snapshot = { ...snapshot, canRedo: history.future.length > 0, canUndo: history.past.length > 0 }; }

  /** Adds the current draft to bounded undo history and clears the redo branch when needed. */
  function checkpoint(options = {}) {
    const group = options.group;
    const text = options.mode === "text";
    const now = Date.now();
    const coalesce = text && group && history.pendingGroup?.group === group && now - history.pendingGroup.at <= 600;
    if (!coalesce) {
      history.past.push(cloneQueryRecipe(snapshot.draft));
      if (history.past.length > historyLimit) { history.past.shift(); }
      history.future = [];
    }
    history.pendingGroup = text && group ? { at: now, group } : undefined;
    setHistoryFlags();
  }

  /** Clears all undo history after a source identity changes. */
  function clearHistory() { history.future = []; history.past = []; history.pendingGroup = undefined; setHistoryFlags(); }

  /** Commits any text-edit coalescing group before a structural boundary. */
  function endHistoryGroup() { history.pendingGroup = undefined; }

  /** Applies an immutable Recipe replacement and invalidates validation for its former revision. */
  function replaceDraft(draft) {
    set({ draft, draftRevision: snapshot.draftRevision + 1, validationRevision: -1, canRedo: history.future.length > 0, canUndo: history.past.length > 0 });
  }
  return {
    /** Returns an immutable-copy snapshot that callers cannot mutate in place. */
    getSnapshot() { return cloneQueryRecipe(snapshot); },
    /** Applies one action to draft state and records one bounded undo checkpoint. */
    dispatch(action = {}) {
      const next = reduceQueryRecipe(snapshot.draft, action);
      if (sameRecipe(next, snapshot.draft)) { return; }
      checkpoint(action.history || {});
      replaceDraft(next);
    },
    /** Adds one observer and returns an unsubscribe function. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Replaces the successful applied Recipe while retaining any newer draft edits. */
    setApplied(recipe, revision) { set({ applied: cloneQueryRecipe(recipe), appliedRevision: revision, applyingRevision: undefined }); },
    /** Restores draft from the last applied snapshot with undo support. */
    resetDraft() { const next = cloneQueryRecipe(snapshot.applied); if (!sameRecipe(next, snapshot.draft)) { checkpoint(); replaceDraft(next); } },
    /** Clears draft to the canonical source-specific empty Recipe with undo support. */
    clearDraft(source) { const next = createEmptyQueryRecipe(source || snapshot.applied.source); if (!sameRecipe(next, snapshot.draft)) { checkpoint(); replaceDraft(next); } },
    /** Records the exact revision and draft revision used for one in-flight Apply. */
    beginApply(revision, recipe) { set({ applyingDraftRevision: snapshot.draftRevision, applyingRecipe: cloneQueryRecipe(recipe), applyingRevision: revision }); },
    /** Accepts a normalized Recipe only for the matching Apply revision. */
    finishApply(revision, normalizedRecipe) { if (snapshot.applyingRevision !== revision) { return; } const changes = { applied: cloneQueryRecipe(normalizedRecipe), appliedRevision: revision, applyingRecipe: undefined, applyingRevision: undefined }; if (snapshot.applyingDraftRevision === snapshot.draftRevision) { changes.draft = cloneQueryRecipe(normalizedRecipe); } set(changes); },
    /** Hydrates an initial host Recipe after its source schema is known, without treating it as a user edit. */
    hydrate(recipe, revision) { if (!Number.isSafeInteger(revision) || revision < snapshot.appliedRevision) { return; } clearHistory(); set({ applied: cloneQueryRecipe(recipe), appliedRevision: revision, applyingRecipe: undefined, applyingRevision: undefined, canRedo: false, canUndo: false, draft: cloneQueryRecipe(recipe), draftRevision: revision, validationRevision: -1 }); },
    /** Retains draft/applied Recipes and records server rejection for the matching Apply. */
    failApply(revision, issues) { if (snapshot.applyingRevision === revision) { set({ applyingRecipe: undefined, applyingRevision: undefined, validation: { issues: cloneQueryRecipe(issues || []), ok: false, warnings: [] }, validationRevision: snapshot.draftRevision }); } },
    /** Merges authoritative runtime rejection issues while preserving an unrelated newer draft. */
    mergeValidationIssues(issues) { const merged = cloneQueryRecipe(issues || []); set({ validation: { issues: merged, ok: !merged.some((issue) => issue?.severity !== "warning"), warnings: merged.filter((issue) => issue?.severity === "warning") }, validationRevision: snapshot.draftRevision }); },
    /** Records validation that still belongs to the current draft revision. */
    setValidation(validation, validationRevision) { if (validationRevision === snapshot.draftRevision) { set({ validation: cloneQueryRecipe(validation), validationRevision }); } },
    /** Ends the active coalesced text-edit history group. */
    endHistoryGroup,
    /** Restores the prior Recipe draft without changing the applied query. */
    undo() {
      endHistoryGroup();
      const previous = history.past.pop();
      if (!previous) { return; }
      history.future.unshift(cloneQueryRecipe(snapshot.draft));
      if (history.future.length > historyLimit) { history.future.pop(); }
      setHistoryFlags();
      replaceDraft(previous);
    },
    /** Reapplies the next Recipe draft without changing the applied query. */
    redo() {
      endHistoryGroup();
      const next = history.future.shift();
      if (!next) { return; }
      history.past.push(cloneQueryRecipe(snapshot.draft));
      if (history.past.length > historyLimit) { history.past.shift(); }
      setHistoryFlags();
      replaceDraft(next);
    }
  };
}
