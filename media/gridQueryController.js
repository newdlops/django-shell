// Query Builder shell controller for recipe draft/apply lifecycle and host message routing.
import { createEmptyQueryRecipe, createQueryRecipeStore } from "./gridQueryRecipeStore.js";
import { createComputedBuilder } from "./gridComputedBuilder.js";
import { createComputedDraft } from "./gridComputedShared.js";
import { createQueryMetadataService } from "./gridQueryMetadata.js";
import { createApplyLifecycle, createValidationLifecycle, transitionApply, transitionValidation, validationAllowsApply } from "./gridQueryLifecycle.js";
import { createPredicateBuilder } from "./gridPredicateBuilder.js";
import { captureQueryFocus, createQueryFocusIntent, restoreQueryFocus } from "./gridQueryFocus.js";
import { createQueryDrawerResize } from "./gridQueryDrawerResize.js";
import { createQueryRenderCoordinator } from "./gridQueryRenderCoordinator.js";
import { createQueryUiState } from "./gridQueryUiState.js";
import { createQueryWorkspace } from "./gridQueryWorkspace.js";
import { stageForQueryIssue } from "./gridQueryIssueTarget.js";
import { queryStageCounts, stageLabel } from "./gridQueryStageSelectors.js";
import { applyAvailability } from "./gridQueryExplanation.js";
import { copyQueryOrmPreview, renderQueryInspector } from "./gridQueryInspector.js";
import { QUERY_SECTION_GUIDANCE } from "./gridQueryGuidanceCopy.js";
import { renderApplyHelp, renderSectionGuidance } from "./gridQueryGuidanceView.js";
import { mergeRecipeIssues, outerOrderIssues } from "./gridQueryResultBuilder.js";
import { createQueryResultControls } from "./gridQueryResultControls.js";
import { buildQueryExamples, createQueryExamplesView, isCanonicalEmptyQueryRecipe } from "./gridQueryExamples.js";
import { createQueryAssistant } from "./gridQueryAssistant.js";
import { renderRecipePreview, renderQuerySummary } from "./gridQuerySummary.js";
import { applyQueryValidationAnnotations, focusQueryIssue, renderQueryValidation } from "./gridQueryValidationView.js";

const QUERY_IDS = ["querySummaryBand", "queryFilterButton", "queryColumnsButton", "queryModeButton", "queryHumanSummary", "queryDirtyState", "queryValidationState", "queryAppliedFiltersLabel", "queryAppliedFiltersEmpty", "queryAppliedFilters", "queryAppliedWhere", "queryAppliedPostFilter", "queryDrawerToggle", "queryDrawer", "queryDrawerResizeHandle", "gridwrap", "queryDrawerHeader", "queryBuilderTitle", "queryExamples", "queryWhereSection", "queryWhereGuide", "queryWhereRoot", "queryComputedSection", "queryComputedGuide", "queryComputedList", "queryPostFilterSection", "queryPostFilterGuide", "queryPostFilterRoot", "queryResultSection", "queryResultGuide", "queryGroupBy", "queryOrderBy", "queryPreviewSection", "queryPreviewGuide", "queryPlainMeaning", "queryImplicitBehavior", "queryOrmPreview", "queryCopyOrm", "queryIssueSummary", "queryResetDraft", "queryClearDraft", "queryDrawerApply", "queryDrawerApplyHelp", "queryDrawerStatus", "queryDraftStatus", "queryUndo", "queryRedo", "queryFocusMode", "queryMoreActions", "queryMoreMenu", "queryClose", "queryStageNav", "queryStageSelect", "queryStageFilterRows", "queryStageCalculatedValues", "queryStageFilterResults", "queryStageResult", "queryFilterRowsPanel", "queryCalculatedValuesPanel", "queryFilterResultsPanel", "queryResultPanel", "queryInspectorTabs", "queryInspectorMeaning", "queryInspectorProblems", "queryInspectorOrm", "queryInspectorAssistant", "queryMeaningPanel", "queryProblemsPanel", "queryEditorPane", "queryReviewPane", "queryOrmPanel", "queryAssistantPanel", "queryPopoverLayer", "queryWorkspace", "queryMobilePaneSwitch", "queryDrawerFooter"];
const QUERY_STAGE_ORDINALS = { calculatedValues: 2, filterResults: 3, filterRows: 1, result: 4 };

/** Creates the model-only Query Builder shell and its immutable Recipe state controller. */
export function createQueryController(options) {
  const root = options.root || document;
  const elements = Object.fromEntries(QUERY_IDS.map((id) => [id, root.getElementById(id)]));
  elements.queryDraftAiAssembly = root.getElementById("queryDraftAiAssembly");
  if (!elements.querySummaryBand) { return noQueryController(); }
  if (elements.queryInspectorAssistant && elements.queryInspectorTabs && elements.queryInspectorAssistant.parentElement !== elements.queryInspectorTabs) { elements.queryInspectorTabs.appendChild(elements.queryInspectorAssistant); }
  if (elements.queryAssistantPanel && elements.queryPreviewSection && elements.queryAssistantPanel.parentElement !== elements.queryPreviewSection) { elements.queryPreviewSection.appendChild(elements.queryAssistantPanel); }
  elements.queryBuilderTitle?.setAttribute("role", "heading");
  elements.queryBuilderTitle?.setAttribute("aria-level", "2");
  const post = options.post;
  const announcer = options.announcer;
  const status = options.status;
  let source = { app: "", model: "" };
  let requestSequence = 0;
  let previewTimer = 0;
  let observedDraftRevision = 0;
  let aiAssemblyRevision = -1;
  let metadataCatalogRequest = 0;
  let sectionsMounted = false;
  let resultSignature = "";
  let computedRenderVersion = 0;
  let predicateRenderVersion = 0;
  const scope = { columns: [], relations: [], source, target: source };
  const store = createQueryRecipeStore(createEmptyQueryRecipe(source));
  const resultControls = createQueryResultControls({ dispatch: (action) => store.dispatch(action), el: element, groupByMount: elements.queryGroupBy, orderByMount: elements.queryOrderBy, replaceGroupBy });
  const metadata = createQueryMetadataService({ onChange: () => requestBuilderRender("metadata"), post });
  let applyLifecycle = createApplyLifecycle();
  let validationLifecycle = createValidationLifecycle();
  const uiState = createQueryUiState({ getPersisted: options.getPersisted, persist: options.persist });
  const focusIntent = createQueryFocusIntent();
  const examplesView = createQueryExamplesView({ el: element, mount: elements.queryExamples, onChoose: chooseQueryExample });
  const assistant = createQueryAssistant({ element, getDraft: () => store.getSnapshot().draft, getRevision: () => store.getSnapshot().draftRevision, mount: elements.queryAssistantPanel, onAccepted: acceptAssistantRecipe, post });
  let predicateBuilders = [];
  let computedBuilder;
  const menuAbort = new AbortController();
  const drawerResize = createQueryDrawerResize({ container: elements.queryDrawer.parentElement, drawer: elements.queryDrawer, grid: elements.gridwrap, handle: elements.queryDrawerResizeHandle, onHeight: (height, dragging, bounds) => { uiState.setBounds(bounds); uiState.dispatch({ dragging, height, type: "SET_DRAWER_HEIGHT" }); }, root });
  const workspace = createQueryWorkspace({ drawerResize, element, elements, root, uiState });
  const openDrawer = workspace.open;
  const closeDrawer = workspace.close;
  const coordinator = createQueryRenderCoordinator({
    captureFocus: () => captureQueryFocus(root),
    getModel: () => ({ applyLifecycle, computedRenderVersion, metadataState: metadata.getState(source), predicateRenderVersion, recipe: store.getSnapshot(), scopeColumns: scope.columns, source, ui: uiState.getSnapshot(), validationLifecycle }),
    regions: [
      { id: "main", signature: (model) => JSON.stringify({ applyLifecycle: model.applyLifecycle, metadataState: model.metadataState, pendingResultMode: model.ui.pendingResultMode, recipe: model.recipe, scopeColumns: model.scopeColumns, source: model.source, validationLifecycle: model.validationLifecycle }), update: (model) => renderMain(model.recipe) },
      { id: "predicate", signature: (model) => model.predicateRenderVersion, update: () => predicateBuilders.forEach((builder) => builder.render()) },
      { id: "computed", signature: (model) => model.computedRenderVersion, update: () => computedBuilder?.render() },
      { id: "validation", signature: (model) => JSON.stringify({ revision: model.recipe.validationRevision, validation: model.recipe.validation }), update: (model) => { predicateBuilders.forEach((builder) => builder.updateValidation?.()); computedBuilder?.updateValidation?.(); applyQueryValidationAnnotations(root, model.recipe.validation); } },
      { id: "workspace", signature: (model) => JSON.stringify(model.ui), update: (model) => workspace.render(model.ui) }
    ],
    restoreFocus: (captured) => restoreCoordinatorFocus(captured)
  });

  /** Requests one coalesced Query Builder render without directly touching editor DOM. */
  function requestRender(reason = "recipe") { coordinator.request(reason); }

  /** Finds the currently rendered control for an explicit focus intent by exact key. */
  function findExplicitFocusTarget(intent) {
    return [...(root?.querySelectorAll?.("[data-query-control-key]") || [])].find((control) => control.dataset?.queryControlKey === intent?.controlKey);
  }

  /** Returns whether an explicit focus target can safely receive keyboard focus. */
  function isAvailableFocusTarget(control) {
    return Boolean(control?.focus) && control.disabled !== true && control.getAttribute?.("aria-disabled") !== "true";
  }

  /** Restores an explicit intent first and uses its stage heading if the control is unavailable. */
  function restoreCoordinatorFocus(captured) {
    const intent = focusIntent.consume();
    if (!intent) { return restoreQueryFocus(root, captured); }
    const control = findExplicitFocusTarget(intent);
    if (isAvailableFocusTarget(control) && restoreQueryFocus(root, intent, { reveal: true })) { return true; }
    const fallback = root?.getElementById?.(intent.fallbackId);
    if (fallback?.focus) { fallback.focus({ preventScroll: true }); return true; }
    return false;
  }

  /** Returns whether two source objects have the same complete app/model identity. */
  function sameQuerySource(left, right) {
    return typeof left?.app === "string" && typeof left?.model === "string" && left.app.trim() !== "" && left.model.trim() !== "" && left.app === right?.app && left.model === right?.model;
  }

  /** Revalidates and applies one schema-derived example only to the live draft. */
  function chooseQueryExample(candidate) {
    const snapshot = store.getSnapshot();
    if (!sameQuerySource(source, candidate?.source) || !sameQuerySource(snapshot.draft.source, source) || !isCanonicalEmptyQueryRecipe(snapshot.draft)) {
      status.textContent = "The draft changed; clear it before choosing an example.";
      announcer?.announceStatus("The draft changed; clear it before choosing an example.");
      requestRender("query-example-stale");
      return;
    }
    uiState.dispatch({ stage: candidate.stage, type: "SET_ACTIVE_STAGE" });
    focusIntent.set({ controlKey: candidate.controlKey, fallbackId: candidate.fallbackId });
    store.dispatch({ recipe: candidate.recipe, type: "REPLACE_DRAFT" });
    requestBuilderRender("query-example");
    const message = `${candidate.label} added to the draft. Review and Apply when ready.`;
    status.textContent = message;
    announcer?.announceStatus(message);
  }

  /** Replaces only the live draft after the host has freshly validated an AI suggestion. */
  function acceptAssistantRecipe(recipe) {
    const snapshot = store.getSnapshot();
    if (!recipe || !sameQuerySource(recipe.source, source)) { return; }
    uiState.dispatch({ stage: "calculatedValues", type: "SET_ACTIVE_STAGE" });
    uiState.dispatch({ tab: "meaning", type: "SET_INSPECTOR_TAB" });
    store.dispatch({ recipe, type: "REPLACE_DRAFT" });
    aiAssemblyRevision = store.getSnapshot().draftRevision;
    requestBuilderRender("query-assistant-accepted");
  }

  /** Requests persistent builder refreshes only for structural or metadata-driven changes. */
  function requestBuilderRender(reason, { computed = true, predicate = true } = {}) {
    if (computed) { computedRenderVersion += 1; }
    if (predicate) { predicateRenderVersion += 1; }
    requestRender(reason);
  }

  /** Restores an applied or empty draft and refreshes persistent builder sections. */
  function restoreDraft(reason, restore) {
    const beforeRevision = store.getSnapshot().draftRevision;
    restore();
    if (store.getSnapshot().draftRevision !== beforeRevision) { requestBuilderRender(reason); }
  }

  /** Replays the prior Recipe snapshot and refreshes the affected editor controls. */
  function undoDraft() { restoreDraft("undo", () => store.undo()); }

  /** Reapplies the next Recipe snapshot and refreshes the affected editor controls. */
  function redoDraft() { restoreDraft("redo", () => store.redo()); }

  /** Renders static Query Builder regions from one coordinator-owned immutable snapshot. */
  function renderMain(snapshot) {
    const examples = buildQueryExamples({ columns: scope.columns, relations: scope.relations, source });
    examplesView.render({ draft: snapshot.draft, examples, source });
    const checking = validationLifecycle.phase === "pending" || validationLifecycle.phase === "previewing";
    renderQuerySummary(elements, snapshot);
    const localOrderIssues = outerOrderIssues(snapshot.draft.orderBy);
    const validation = mergeValidation(snapshot.validation, localOrderIssues);
    renderQueryValidation({ issueSummary: elements.queryIssueSummary, validationState: elements.queryValidationState }, validation, { checking, onFocusIssue: focusIssue });
    const validationOk = validation.ok !== false && snapshot.validationRevision === snapshot.draftRevision;
    const canApply = Boolean(source.app && source.model && snapshot.dirty && validationOk && validationAllowsApply(validationLifecycle, snapshot.draftRevision) && applyLifecycle.phase !== "applying" && applyLifecycle.phase !== "loadingResults" && !snapshot.applyingRevision);
    if (elements.queryApply) { elements.queryApply.disabled = !canApply; }
    elements.queryDrawerApply.disabled = !canApply;
    if (elements.queryDrawerStatus) {
      elements.queryDrawerStatus.textContent = applyLifecycle.phase === "applying" ? "Applying query…" : applyLifecycle.phase === "loadingResults" ? "Loading query results…" : validationLifecycle.phase === "pending" || validationLifecycle.phase === "previewing" ? "Checking latest draft…" : validation.ok === false ? "Fix the reported query errors." : snapshot.dirty ? "Draft is ready to apply." : "Applied query is current.";
    }
    const availability = applyAvailability(snapshot, { applying: applyLifecycle.phase === "applying" || applyLifecycle.phase === "loadingResults" || Boolean(snapshot.applyingRevision), checking, metadataState: metadata.getState(source)?.pending ? "pending" : metadata.getState(source)?.error ? "error" : "ready", source, stale: snapshot.validationRevision !== snapshot.draftRevision, validation });
    renderApplyHelp(elements.queryDrawerApplyHelp, availability);
    if (elements.queryDraftStatus) { elements.queryDraftStatus.textContent = snapshot.dirty ? "Draft changes are not applied" : "Draft matches applied query"; }
    if (elements.queryDraftAiAssembly) { elements.queryDraftAiAssembly.hidden = aiAssemblyRevision !== snapshot.draftRevision; }
    if (elements.queryUndo) { elements.queryUndo.disabled = !snapshot.canUndo; }
    if (elements.queryRedo) { elements.queryRedo.disabled = !snapshot.canRedo; }
    const countButton = root.getElementById("count");
    if (countButton) {
      const globalSummary = snapshot.applied.mode === "summary" && !snapshot.applied.groupBy.length;
      countButton.disabled = globalSummary;
      countButton.title = globalSummary ? "Global summary always has one result row" : "Count the applied query results";
    }
    elements.queryOrmPreview.textContent = renderRecipePreview(snapshot.draft, snapshot.validation?.ormPreview);
    elements.queryCopyOrm.disabled = !snapshot.validation?.ormPreview;
    renderQueryInspector({ element, elements, recipe: snapshot.draft, root, scope, validation });
    const stageCounts = queryStageCounts(snapshot.draft);
    const stageButtons = { calculatedValues: elements.queryStageCalculatedValues, filterResults: elements.queryStageFilterResults, filterRows: elements.queryStageFilterRows, result: elements.queryStageResult };
    for (const [stage, button] of Object.entries(stageButtons)) { if (button) { button.textContent = `${QUERY_STAGE_ORDINALS[stage]}. ${stageLabel(stage, stageCounts[stage])}`; } }
    scope.computedFields = (snapshot.draft.computed || []).filter((item) => item?.enabled).map((item) => ({ alias: item.alias, enabled: item.enabled, outputType: item.outputType || "" }));
    if (!sectionsMounted) { mountSectionStates(snapshot.draft); }
    const nextResultSignature = JSON.stringify({ computed: snapshot.draft.computed, groupBy: snapshot.draft.groupBy, mode: snapshot.draft.mode, orderBy: snapshot.draft.orderBy });
    if (resultSignature !== nextResultSignature) { resultSignature = nextResultSignature; renderResultControls(snapshot.draft); }
  }

  /** Renders Recipe sections and mounts the shared predicate editor into its two top-level contexts. */
  function mountSectionStates(recipe) {
    renderSectionGuidance({ el: element, mount: elements.queryWhereGuide, guidance: QUERY_SECTION_GUIDANCE.where });
    renderSectionGuidance({ el: element, mount: elements.queryComputedGuide, guidance: QUERY_SECTION_GUIDANCE.computed });
    renderSectionGuidance({ el: element, mount: elements.queryPostFilterGuide, guidance: QUERY_SECTION_GUIDANCE.postFilter });
    renderSectionGuidance({ el: element, mount: elements.queryResultGuide, guidance: QUERY_SECTION_GUIDANCE.result });
    renderSectionGuidance({ el: element, mount: elements.queryPreviewGuide, guidance: QUERY_SECTION_GUIDANCE.preview });
    scope.computedFields = (recipe.computed || []).filter((item) => item?.enabled).map((item) => ({ alias: item.alias, enabled: item.enabled, outputType: item.outputType || "" }));
    disposePredicateBuilders();
    mountPredicateBuilder(elements.queryWhereRoot, "where", recipe.where.nodeId);
    mountComputedBuilder();
    mountPredicateBuilder(elements.queryPostFilterRoot, "postFilter", recipe.postFilter.nodeId);
    elements.queryGroupBy.replaceChildren();
    const mode = root.createElement("div");
    mode.className = "query-result-row";
    mode.append("Mode: ");
    const segmented = root.createElement("span");
    segmented.className = "query-mode-control";
    segmented.appendChild(modeButton("Rows", "rows", recipe.mode));
    segmented.appendChild(modeButton("Summary", "summary", recipe.mode));
    mode.appendChild(segmented);
    elements.queryGroupBy.appendChild(mode);
    sectionsMounted = true;
  }

  /** Renders limited Summary grouping and explicit outer ordering from the existing Recipe reducer. */
  function renderResultControls(recipe) {
    const fields = scope.columns.filter((field) => field?.attname || field?.name).map((field) => ({ label: field.label ? `${field.label} — ${field.attname || field.name}` : field.attname || field.name, path: field.attname || field.name }));
    resultControls.render(recipe, fields);
    renderResultModeConfirmation(recipe);
  }

  /** Renders the reversible confirmation required before Rows discards Summary groups. */
  function renderResultModeConfirmation(recipe) {
    const pending = uiState.getSnapshot().pendingResultMode;
    if (pending !== "rows" || recipe.mode !== "summary" || !recipe.groupBy.length) { return; }
    const confirmation = element("div", { className: "query-kind-confirmation", role: "alert" });
    const confirm = element("button", { className: "secondary", type: "button" }, "Switch to Rows");
    confirm.addEventListener("click", () => { uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" }); store.dispatch({ mode: "rows", type: "SET_MODE" }); });
    const cancel = element("button", { className: "secondary", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => { uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" }); renderResultControls(recipe); });
    confirmation.append("Switching to Rows removes the selected summary group fields. ", confirm, cancel);
    elements.queryGroupBy.appendChild(confirmation);
  }

  /** Replaces one group reference because the store intentionally exposes append/remove primitives only. */
  function replaceGroupBy(recipe, index, path) {
    const next = { ...recipe, groupBy: recipe.groupBy.map((item, itemIndex) => itemIndex === index ? { kind: "field", path } : item) };
    store.dispatch({ recipe: next, type: "REPLACE_DRAFT" });
  }

  /** Mounts one bounded, independently accessible predicate tree for the active Recipe draft. */
  function mountPredicateBuilder(container, context, rootNodeId) {
    container.replaceChildren();
    const builder = createPredicateBuilder({
      context,
      dispatch: (action) => store.dispatch(action),
      el: element,
      getRecipe: () => store.getSnapshot().draft,
      getScope: () => scope,
      metadata,
      popoverLayer: elements.queryPopoverLayer,
      requestRender: () => requestBuilderRender("predicate", { computed: false }),
      rootNodeId,
      validation: () => store.getSnapshot().validation
    });
    container.appendChild(builder.node);
    predicateBuilders.push(builder);
  }

  /** Releases replaced predicate instances before the immutable draft re-renders their containers. */
  function disposePredicateBuilders() {
    for (const builder of predicateBuilders) { builder.destroy(); }
    predicateBuilders = [];
  }

  /** Mounts the source-ordered computed-column editor with live draft and validation access. */
  function mountComputedBuilder() {
    computedBuilder?.destroy?.();
    computedBuilder = createComputedBuilder({
      dispatch: (action) => {
        store.dispatch(action);
        const changes = action.changes || {};
        const structuralComputedChange = action.type !== "UPDATE_COMPUTED" || changes.kind || changes.source || changes.select || changes.orderBy || changes.correlations;
        if (structuralComputedChange) { requestBuilderRender("computed", { predicate: false }); }
      },
      el: element,
      getRecipe: () => store.getSnapshot().draft,
      getScope: () => scope,
      metadata,
      cancelKindChange: (nodeId) => { uiState.dispatch({ nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" }); requestBuilderRender("computed", { predicate: false }); },
      confirmKindChange: (item, kind) => { uiState.dispatch({ nodeId: item.nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" }); store.dispatch({ changes: createComputedDraft(kind, item.nodeId, item.alias), nodeId: item.nodeId, type: "UPDATE_COMPUTED" }); requestBuilderRender("computed", { predicate: false }); },
      onOpenChange: (nodeId, open) => uiState.dispatch({ nodeId, open, type: "SET_COMPUTED_OPEN" }),
      openNodeIds: () => uiState.getSnapshot().openComputedNodeIds,
      pendingKinds: () => uiState.getSnapshot().pendingComputedKinds,
      popoverLayer: elements.queryPopoverLayer,
      requestKindChange: (item, kind) => { uiState.dispatch({ kind, nodeId: item.nodeId, type: "SET_PENDING_COMPUTED_KIND" }); requestBuilderRender("computed", { predicate: false }); },
      validation: () => store.getSnapshot().validation
    });
    elements.queryComputedList.replaceChildren(computedBuilder.node);
  }

  /** Creates one keyboard-accessible Result mode segment. */
  function modeButton(label, mode, current) {
    const button = root.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(current === mode));
    button.addEventListener("click", () => {
      const recipe = store.getSnapshot().draft;
      if (mode === "rows" && recipe.mode === "summary" && recipe.groupBy.length) {
        uiState.dispatch({ mode, type: "SET_PENDING_RESULT_MODE" });
        return;
      }
      store.dispatch({ type: "SET_MODE", mode });
    });
    return button;
  }

  /** Writes one safe section status using a text node only. */
  function setSectionText(container, text) {
    container.replaceChildren();
    const paragraph = root.createElement("p");
    paragraph.className = "query-builder-empty";
    paragraph.textContent = text;
    container.appendChild(paragraph);
  }

  /** Schedules a host-only preview for the current exact draft revision. */
  function schedulePreview() {
    if (!source.app || !source.model) { return; }
    if (previewTimer) { window.clearTimeout(previewTimer); }
    const revision = store.getSnapshot().draftRevision;
    previewTimer = window.setTimeout(() => {
      const requestId = `recipe-preview-${requestSequence += 1}`;
      validationLifecycle = transitionValidation(validationLifecycle, { requestId, revision, type: "PREVIEW_TIMER_FIRED" });
      requestRender("preview-started");
      post({ recipe: store.getSnapshot().draft, requestId, revision, type: "previewQueryRecipe" });
    }, 400);
  }

  /** Sends the exact draft snapshot to the host and preserves newer edits during execution. */
  function apply() {
    const snapshot = store.getSnapshot();
    const localOrderIssues = outerOrderIssues(snapshot.draft.orderBy);
    if (!snapshot.dirty || !validationAllowsApply(validationLifecycle, snapshot.draftRevision) || snapshot.validationRevision !== snapshot.draftRevision || snapshot.validation?.ok === false || localOrderIssues.length || !source.app || !source.model) { return; }
    const revision = Math.max(snapshot.appliedRevision, snapshot.draftRevision) + 1;
    applyLifecycle = transitionApply(applyLifecycle, { revision, type: "APPLY_STARTED" });
    store.beginApply(revision, snapshot.draft);
    status.textContent = "Applying query…";
    announcer?.announceStatus("Applying query…");
    post({ recipe: snapshot.draft, revision, type: "applyQueryRecipe" });
    requestRender("apply-started");
  }

  /** Brings an issue into view and provides an audible fallback when no editor node exists yet. */
  function focusIssue(issue) {
    const sectionByStage = { calculatedValues: "queryComputedSection", filterResults: "queryPostFilterSection", filterRows: "queryWhereSection", result: "queryResultSection" };
    openDrawer(sectionByStage[stageForQueryIssue(issue)], { focus: false });
    uiState.dispatch({ tab: "problems", type: "SET_INSPECTOR_TAB" });
    queueMicrotask(() => { if (!focusQueryIssue(issue, root)) { announcer?.announceError(issue.message || issue.code || "Query issue"); } });
  }

  /** Updates the draft Recipe source when the host opens a different model. */
  function setSource(nextSource) {
    if (!nextSource?.app || !nextSource?.model) { return; }
    const changed = source.app !== nextSource.app || source.model !== nextSource.model;
    source = { app: nextSource.app, model: nextSource.model };
    assistant.invalidate();
    scope.columns = Array.isArray(nextSource.columns) ? nextSource.columns : scope.columns;
    scope.relations = Array.isArray(nextSource.relations) ? nextSource.relations : scope.relations;
    scope.source = source;
    scope.target = source;
    if (!changed) { requestBuilderRender("source-metadata"); return; }
    const empty = createEmptyQueryRecipe(source);
    store.hydrate(empty, 0);
    disposePredicateBuilders();
    computedBuilder?.destroy?.();
    computedBuilder = undefined;
    resultControls.destroy();
    sectionsMounted = false;
    resultSignature = "";
    if (uiState.getSnapshot().focusMode) { setQueryFocusMode(false); }
    uiState.dispatch({ type: "RESET_TRANSIENT_FOR_SOURCE" });
    metadataCatalogRequest += 1;
    post({ requestId: `query-meta-catalog-${metadataCatalogRequest}`, type: "modelList" });
    validationLifecycle = transitionValidation(validationLifecycle, { revision: store.getSnapshot().draftRevision, type: "SOURCE_CHANGED" });
    applyLifecycle = transitionApply(applyLifecycle, { type: "SOURCE_CHANGED" });
    requestBuilderRender("source-changed");
    schedulePreview();
  }

  /** Records a new grid-header sort as a draft order change rather than running it implicitly. */
  function toggleGridOrder(field, descending) {
    const recipe = store.getSnapshot().draft;
    recipe.orderBy = descending === undefined ? [] : [{ direction: descending ? "desc" : "asc", nodeId: `grid-order-${String(field).replace(/[^A-Za-z0-9_-]/g, "-")}`, ref: { kind: "field", path: field } }];
    store.dispatch({ recipe, type: "REPLACE_DRAFT" });
  }

  /** Routes host Recipe messages and ignores stale preview/apply revisions. */
  function onMessage(message) {
    if (assistant.onMessage(message)) { return true; }
    if (!message || typeof message.type !== "string") { return false; }
    if (message.type === "filterFields") { return metadata.onMessage(message); }
    if (message.type === "modelList" && typeof message.requestId === "string" && message.requestId.startsWith("query-meta-catalog-")) {
      metadata.setCatalog(message.result?.ok ? message.result.models : []);
      requestBuilderRender("metadata-catalog");
      return true;
    }
    const snapshot = store.getSnapshot();
    if (message.type === "queryRecipePreview") {
      if (message.revision !== snapshot.draftRevision) { return true; }
      validationLifecycle = transitionValidation(validationLifecycle, { requestId: message.requestId, revision: message.revision, type: "PREVIEW_ACCEPTED", validation: message.validation });
      store.setValidation(message.validation || { issues: [], ok: true, warnings: [] }, message.revision);
      requestRender("preview-accepted");
      return true;
    }
    if (message.type === "queryRecipeApplied") {
      if (typeof message.revision !== "number") { return true; }
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "APPLY_ACCEPTED" });
      if (snapshot.applyingRevision === message.revision) {
        store.finishApply(message.revision, message.recipe || snapshot.draft);
      } else {
        store.hydrate(message.recipe || snapshot.draft, message.revision);
      }
      status.textContent = "Query applied.";
      announcer?.announceStatus("Query applied.");
      requestRender("apply-accepted");
      return true;
    }
    if (message.type === "queryRecipeRejected") {
      if (snapshot.applyingRevision === message.revision) { applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "APPLY_REJECTED" }); }
      else { validationLifecycle = transitionValidation(validationLifecycle, { requestId: message.requestId, revision: message.revision, type: "PREVIEW_REJECTED", issues: message.issues }); }
      const issues = mergeRecipeIssues(snapshot.validation?.issues, message.issues);
      if (snapshot.applyingRevision === message.revision) {
        store.failApply(message.revision, issues);
      } else if (message.revision === snapshot.draftRevision) {
        store.setValidation(validationWithIssues(issues), message.revision);
      } else {
        store.mergeValidationIssues(issues);
      }
      options.onRejected?.(message);
      status.textContent = "Query was not applied. Fix the reported errors.";
      announcer?.announceError("Query was not applied. Fix the reported errors.");
      openDrawer("queryWhereSection");
      uiState.dispatch({ tab: "problems", type: "SET_INSPECTOR_TAB" });
      requestRender("apply-rejected");
      return true;
    }
    if (message.type === "rows" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onRows?.(message, snapshot);
      requestRender("rows-accepted");
      return true;
    }
    if (message.type === "count" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onCount?.(message, snapshot);
      requestRender("count-accepted");
      return true;
    }
    if (message.type === "aggregate" && snapshot.applied.mode === "summary" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onSummary?.(message, snapshot);
      requestRender("summary-accepted");
      return true;
    }
    return false;
  }

  elements.queryDrawerToggle.addEventListener("click", () => elements.queryDrawer.hidden ? openDrawer("queryWhereSection") : closeDrawer());
  elements.queryFilterButton.addEventListener("click", () => openDrawer("queryWhereSection"));
  elements.queryColumnsButton.addEventListener("click", () => openDrawer("queryComputedSection"));
  elements.queryModeButton.addEventListener("click", () => openDrawer("queryResultSection"));
  elements.queryDrawerApply.addEventListener("click", apply);
  elements.queryCopyOrm.addEventListener("click", async () => {
    const copied = await copyQueryOrmPreview(root);
    status.textContent = copied ? "Django ORM copied." : "Django ORM could not be copied; select the preview and copy it manually.";
    if (copied) { announcer?.announceStatus("Django ORM copied."); } else { announcer?.announceError("Django ORM could not be copied."); }
  });
  elements.queryResetDraft.addEventListener("click", () => { restoreDraft("reset-draft", () => store.resetDraft()); closeMoreActions(); });
  elements.queryClearDraft.addEventListener("click", () => { restoreDraft("clear-draft", () => store.clearDraft(source)); closeMoreActions(); status.textContent = "Draft cleared. Undo is available."; announcer?.announceStatus("Draft cleared. Undo is available."); });
  elements.queryUndo.addEventListener("click", undoDraft);
  elements.queryRedo.addEventListener("click", redoDraft);
  elements.queryMoreActions.addEventListener("click", () => toggleMoreActions());
  elements.queryClose.addEventListener("click", closeDrawer);
  elements.queryFocusMode.addEventListener("click", () => {
    setQueryFocusMode(!uiState.getSnapshot().focusMode);
  });
  const stageControls = { queryStageCalculatedValues: "calculatedValues", queryStageFilterResults: "filterResults", queryStageFilterRows: "filterRows", queryStageResult: "result" };
  for (const [id, stage] of Object.entries(stageControls)) { elements[id].addEventListener("click", () => uiState.dispatch({ stage, type: "SET_ACTIVE_STAGE" })); }
  elements.queryStageSelect.addEventListener("change", () => uiState.dispatch({ stage: elements.queryStageSelect.value, type: "SET_ACTIVE_STAGE" }));
  const inspectorControls = { queryInspectorMeaning: "meaning", queryInspectorOrm: "orm", queryInspectorProblems: "problems", queryInspectorAssistant: "assistant" };
  for (const [id, tab] of Object.entries(inspectorControls)) { elements[id].addEventListener("click", () => uiState.dispatch({ tab, type: "SET_INSPECTOR_TAB" })); }
  workspace.installRovingTabs(Object.entries(stageControls).map(([id, value]) => ({ button: elements[id], value })), (stage) => uiState.dispatch({ stage, type: "SET_ACTIVE_STAGE" }));
  workspace.installRovingTabs(Object.entries(inspectorControls).map(([id, value]) => ({ button: elements[id], value })), (tab) => uiState.dispatch({ tab, type: "SET_INSPECTOR_TAB" }));
  elements.queryEditorPane.addEventListener("scroll", () => { const ui = uiState.getSnapshot(); if (ui.stageScrollTops[ui.activeStage] !== elements.queryEditorPane.scrollTop) { uiState.dispatch({ stage: ui.activeStage, top: elements.queryEditorPane.scrollTop, type: "SET_STAGE_SCROLL" }); } });
  elements.queryPreviewSection.addEventListener("scroll", () => { const ui = uiState.getSnapshot(); if (ui.inspectorScrollTops[ui.inspectorTab] !== elements.queryPreviewSection.scrollTop) { uiState.dispatch({ tab: ui.inspectorTab, top: elements.queryPreviewSection.scrollTop, type: "SET_INSPECTOR_SCROLL" }); } });
  for (const link of root.querySelectorAll("[data-query-skip-target]")) {
    link.addEventListener("click", (event) => {
      const target = root.getElementById(link.dataset.querySkipTarget);
      if (!target?.focus) { return; }
      event.preventDefault();
      if (target.tabIndex < 0) { target.tabIndex = -1; }
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "nearest" });
    }, { signal: menuAbort.signal });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.queryMoreMenu.hidden) { event.preventDefault(); closeMoreActions(); elements.queryMoreActions.focus(); return; }
    const pendingKind = uiState.getSnapshot().pendingComputedKinds.at(-1);
    if (event.key === "Escape" && pendingKind) { event.preventDefault(); uiState.dispatch({ nodeId: pendingKind.nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" }); requestBuilderRender("computed", { predicate: false }); return; }
    if (event.key === "Escape" && uiState.getSnapshot().pendingResultMode) { event.preventDefault(); uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" }); requestRender("result-mode-cancelled"); return; }
    if (event.key === "Escape" && uiState.getSnapshot().focusMode) {
      event.preventDefault();
      setQueryFocusMode(false);
      elements.queryFocusMode.focus();
      return;
    }
    if (event.key === "Escape" && !elements.queryDrawer.hidden) { event.preventDefault(); closeDrawer(); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z" && !isTextEntry(event.target)) { event.preventDefault(); if (event.shiftKey) { redoDraft(); } else { undoDraft(); } return; }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.altKey && !event.shiftKey && !isTextEntry(event.target)) { event.preventDefault(); apply(); }
  });
  root.addEventListener("pointerdown", (event) => { if (!elements.queryMoreMenu.hidden && !elements.queryMoreMenu.contains(event.target) && !elements.queryMoreActions.contains(event.target)) { closeMoreActions(); } }, { signal: menuAbort.signal });
  elements.queryMoreMenu.addEventListener("keydown", (event) => handleMoreMenuKey(event), { signal: menuAbort.signal });
  store.subscribe((snapshot) => {
    if (snapshot.draftRevision !== observedDraftRevision) {
      observedDraftRevision = snapshot.draftRevision;
      if (aiAssemblyRevision !== snapshot.draftRevision) { aiAssemblyRevision = -1; }
      validationLifecycle = transitionValidation(validationLifecycle, { revision: snapshot.draftRevision, type: "DRAFT_CHANGED" });
      assistant.invalidate();
      schedulePreview();
    }
    requestRender("store");
  });
  uiState.subscribe(() => requestRender("ui"));
  coordinator.flush();
  if (uiState.getSnapshot().drawerOpen) { elements.queryDrawer.hidden = false; elements.queryDrawerToggle.setAttribute("aria-expanded", "true"); drawerResize.setHeight(uiState.getSnapshot().drawerHeight); }
  return { apply, destroy() { menuAbort.abort(); drawerResize.destroy(); assistant.destroy(); examplesView.destroy(); coordinator.destroy(); uiState.destroy(); disposePredicateBuilders(); computedBuilder?.destroy?.(); resultControls.destroy(); }, getSnapshot: () => store.getSnapshot(), onMessage, openDrawer, setSource, toggleGridOrder };

  /** Opens or closes the compact overflow menu for draft recovery actions. */
  function toggleMoreActions() {
    const open = elements.queryMoreMenu.hidden;
    elements.queryMoreMenu.hidden = !open;
    elements.queryMoreActions.setAttribute("aria-expanded", String(open));
    if (open) { elements.queryMoreMenu.querySelector('[role="menuitem"]')?.focus(); }
  }

  /** Closes the recovery-action menu after an action is chosen. */
  function closeMoreActions() {
    elements.queryMoreMenu.hidden = true;
    elements.queryMoreActions.setAttribute("aria-expanded", "false");
  }

  /** Changes Focus Builder layout before synchronously refreshing drawer geometry. */
  function setQueryFocusMode(enabled) {
    const next = Boolean(enabled);
    if (next) { options.gridAdapter?.enterQueryFocusMode?.(); } else { options.gridAdapter?.exitQueryFocusMode?.(); }
    uiState.dispatch({ enabled: next, type: "SET_FOCUS_MODE" });
    drawerResize.refresh();
  }

  /** Implements conventional menu navigation without trapping Tab or duplicating native buttons. */
  function handleMoreMenuKey(event) {
    const items = [...elements.queryMoreMenu.querySelectorAll('[role="menuitem"]')];
    const index = Math.max(0, items.indexOf(root.activeElement));
    if (event.key === "Escape") { event.preventDefault(); closeMoreActions(); elements.queryMoreActions.focus(); return; }
    if (event.key === "Tab") { closeMoreActions(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { return; }
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

}

/** Builds one native DOM element using the webview's existing property naming convention. */
function element(tagName, properties = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(properties)) {
    if (name === "className") { node.className = value; }
    else if (name === "dataset" && value && typeof value === "object") { Object.assign(node.dataset, value); }
    else if (name === "ariaLabel") { node.setAttribute("aria-label", value); }
    else if (name === "ariaLive") { node.setAttribute("aria-live", value); }
    else if (name === "ariaHidden") { node.setAttribute("aria-hidden", value); }
    else if (name === "checked") { node.checked = Boolean(value); }
    else if (name === "disabled") { node.disabled = Boolean(value); }
    else if (name === "value") { node.value = value; }
    else { node.setAttribute(name, value); }
  }
  for (const child of children.flat()) { node.append(child instanceof Node ? child : document.createTextNode(String(child))); }
  return node;
}

/** Adds local result-builder issues to a host validation result without mutating either source. */
function mergeValidation(validation, localIssues) {
  const issues = mergeRecipeIssues(validation?.issues, localIssues);
  return validationWithIssues(issues, validation?.warnings);
}

/** Rebuilds validation projections from one authoritative issue list. */
function validationWithIssues(issues, warnings) {
  const all = Array.isArray(issues) ? issues : [];
  const warningList = Array.isArray(warnings) ? warnings : all.filter((issue) => issue?.severity === "warning");
  return { issues: all, ok: !all.some((issue) => issue?.severity !== "warning"), warnings: warningList };
}

/** Avoids stealing Ctrl/Cmd+Enter from an active typed query or editor input. */
function isTextEntry(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}

/** Creates a no-op controller for the standalone custom ORM query surface. */
function noQueryController() {
  return { apply() {}, getSnapshot() { return undefined; }, onMessage() { return false; }, openDrawer() {}, setSource() {}, toggleGridOrder() {} };
}
