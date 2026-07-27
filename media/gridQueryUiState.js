// Persistent and transient presentation state for the Model Data Query Builder.

const STAGES = new Set(["filterRows", "calculatedValues", "filterResults", "result"]);
const INSPECTOR_TABS = new Set(["meaning", "problems", "orm"]);

/** Clamps one finite numeric value to the supplied inclusive bounds. */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

/** Returns one allowed stage value, falling back to the first recipe stage. */
function stage(value) {
  return STAGES.has(value) ? value : "filterRows";
}

/** Returns one allowed inspector tab, falling back to Meaning. */
function inspectorTab(value) {
  return INSPECTOR_TABS.has(value) ? value : "meaning";
}

/** Copies a JSON-compatible value without retaining callers' nested references. */
function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Creates the complete in-memory UI state from safe persisted preferences. */
function initialState(persisted = {}, bounds = {}) {
  const minimum = Number.isFinite(bounds.minimumHeight) ? bounds.minimumHeight : 220;
  const maximum = Number.isFinite(bounds.maximumHeight) ? bounds.maximumHeight : 620;
  const drawerHeight = clamp(persisted.queryDrawerHeight, minimum, maximum);
  return {
    activeStage: stage(persisted.queryActiveStage),
    drawerHeight,
    drawerOpen: Boolean(persisted.queryDrawerOpen),
    focusMode: false,
    inspectorScrollTops: { meaning: 0, orm: 0, problems: 0 },
    inspectorTab: inspectorTab(persisted.queryInspectorTab),
    lastFocusedControlKey: "",
    mobilePane: "editor",
    openComputedNodeIds: new Set(),
    openGroupNodeIds: new Set(),
    openHelpIds: new Set(),
    pendingComputedKinds: new Map(),
    pendingResultMode: "",
    selectedNodeId: "",
    stageScrollTops: { calculatedValues: 0, filterResults: 0, filterRows: 0, result: 0 }
  };
}

/** Serializes only safe preference state for VS Code webview persistence. */
function preferences(state) {
  return {
    queryActiveStage: state.activeStage,
    queryDrawerHeight: state.drawerHeight,
    queryDrawerOpen: state.drawerOpen,
    queryInspectorTab: state.inspectorTab
  };
}

/** Converts mutable collection fields into immutable snapshot values. */
function snapshotOf(state) {
  return {
    ...state,
    inspectorScrollTops: { ...state.inspectorScrollTops },
    openComputedNodeIds: [...state.openComputedNodeIds].sort(),
    openGroupNodeIds: [...state.openGroupNodeIds].sort(),
    openHelpIds: [...state.openHelpIds].sort(),
    pendingComputedKinds: [...state.pendingComputedKinds].map(([nodeId, kind]) => ({ kind, nodeId })),
    stageScrollTops: { ...state.stageScrollTops }
  };
}

/** Creates UI-only state without persisting Recipe values, validation, or ORM text. */
export function createQueryUiState({ bounds, getPersisted = () => ({}), persist = () => {} } = {}) {
  let heightBounds = { maximumHeight: 620, minimumHeight: 220, ...bounds };
  let state = initialState(getPersisted() || {}, heightBounds);
  const listeners = new Set();
  let persistTimer = 0;

  /** Notifies observers with a detached immutable UI snapshot. */
  function publish() {
    const value = snapshotOf(state);
    for (const listener of listeners) { listener(value); }
  }

  /** Persists only the documented preference projection. */
  function writePreferences() {
    persistTimer = 0;
    persist(preferences(state));
  }

  /** Requests delayed preference persistence for pointer-driven resize updates. */
  function schedulePersistence(delay = 0) {
    if (persistTimer) { clearTimeout(persistTimer); }
    if (!delay) { writePreferences(); return; }
    persistTimer = setTimeout(writePreferences, delay);
  }

  /** Toggles a stable node identifier inside one state-owned disclosure collection. */
  function toggle(collection, nodeId, open) {
    if (!nodeId) { return; }
    if (open) { collection.add(nodeId); } else { collection.delete(nodeId); }
  }

  /** Applies one UI-only state action and publishes only when its value changes. */
  function dispatch(action = {}) {
    const type = action.type;
    if (type === "SET_ACTIVE_STAGE") { state.activeStage = stage(action.stage); state.mobilePane = "editor"; schedulePersistence(); }
    else if (type === "SET_DRAWER_OPEN") { state.drawerOpen = Boolean(action.open); schedulePersistence(); }
    else if (type === "SET_DRAWER_HEIGHT") { state.drawerHeight = clamp(action.height, heightBounds.minimumHeight, heightBounds.maximumHeight); schedulePersistence(action.dragging ? 150 : 0); }
    else if (type === "SET_FOCUS_MODE") { state.focusMode = Boolean(action.enabled); }
    else if (type === "SET_INSPECTOR_TAB") { state.inspectorTab = inspectorTab(action.tab); state.mobilePane = "review"; schedulePersistence(); }
    else if (type === "SET_MOBILE_PANE") { state.mobilePane = action.pane === "review" ? "review" : "editor"; }
    else if (type === "SET_SELECTED_NODE") { state.selectedNodeId = String(action.nodeId || ""); }
    else if (type === "SET_LAST_FOCUSED_CONTROL") { state.lastFocusedControlKey = String(action.key || ""); }
    else if (type === "SET_STAGE_SCROLL") { state.stageScrollTops = { ...state.stageScrollTops, [stage(action.stage)]: Math.max(0, Number(action.top) || 0) }; }
    else if (type === "SET_INSPECTOR_SCROLL") { state.inspectorScrollTops = { ...state.inspectorScrollTops, [inspectorTab(action.tab)]: Math.max(0, Number(action.top) || 0) }; }
    else if (type === "SET_COMPUTED_OPEN") { toggle(state.openComputedNodeIds, action.nodeId, action.open); }
    else if (type === "SET_GROUP_OPEN") { toggle(state.openGroupNodeIds, action.nodeId, action.open); }
    else if (type === "SET_HELP_OPEN") { toggle(state.openHelpIds, action.helpId, action.open); }
    else if (type === "SET_PENDING_COMPUTED_KIND") { if (action.nodeId && action.kind) { state.pendingComputedKinds.set(action.nodeId, action.kind); } }
    else if (type === "CLEAR_PENDING_COMPUTED_KIND") { state.pendingComputedKinds.delete(action.nodeId); }
    else if (type === "SET_PENDING_RESULT_MODE") { state.pendingResultMode = action.mode === "summary" || action.mode === "rows" ? action.mode : ""; }
    else if (type === "CLEAR_PENDING_RESULT_MODE") { state.pendingResultMode = ""; }
    else if (type === "RESET_TRANSIENT_FOR_SOURCE") {
      const next = initialState(getPersisted() || {}, heightBounds);
      next.drawerOpen = state.drawerOpen;
      next.drawerHeight = state.drawerHeight;
      state = next;
    } else { return; }
    publish();
  }

  return {
    /** Releases pending persistence work. */
    destroy() { if (persistTimer) { clearTimeout(persistTimer); } listeners.clear(); },
    /** Updates the current height clamp without changing the selected UI mode. */
    setBounds(nextBounds = {}) { heightBounds = { ...heightBounds, ...nextBounds }; state.drawerHeight = clamp(state.drawerHeight, heightBounds.minimumHeight, heightBounds.maximumHeight); publish(); },
    /** Returns a detached UI snapshot. */
    getSnapshot() { return copy(snapshotOf(state)); },
    /** Applies one documented UI-only action. */
    dispatch,
    /** Registers one UI observer. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

/** Exposes pure state helpers for focused tests. */
export const __test = { clamp, initialState, inspectorTab, preferences, stage };
