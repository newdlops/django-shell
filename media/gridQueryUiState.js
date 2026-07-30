// Persistent and transient presentation state for the Model Data Query Builder.
import { QUERY_DRAWER_MINIMUM_HEIGHT, QUERY_DRAWER_PREFERRED_HEIGHT } from "./gridQueryDrawerResize.js";

const STAGES = new Set(["filterRows", "calculatedValues", "filterResults", "result"]);
const INSPECTOR_TABS = new Set(["meaning", "problems", "orm", "assistant"]);
export const QUERY_DRAWER_SIZE_VERSION = 2;

/** Clamps one finite numeric value to supplied inclusive bounds. */
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum)); }
/** Returns one allowed stage value. */
function stage(value) { return STAGES.has(value) ? value : "filterRows"; }
/** Returns one allowed inspector tab value. */
function inspectorTab(value) { return INSPECTOR_TABS.has(value) ? value : "meaning"; }
/** Copies a JSON-compatible value without nested shared references. */
function copy(value) { return JSON.parse(JSON.stringify(value)); }
/** Normalizes incomplete or reversed drawer bounds. */
function normalizeBounds(bounds = {}) {
  const minimumHeight = Number.isFinite(bounds.minimumHeight) ? bounds.minimumHeight : QUERY_DRAWER_MINIMUM_HEIGHT;
  const requestedMaximum = Number.isFinite(bounds.maximumHeight) ? bounds.maximumHeight : 620;
  return { minimumHeight, maximumHeight: Math.max(minimumHeight, requestedMaximum) };
}
/** Returns the version-aware persisted drawer height. */
function migratedHeight(persisted, minimum, maximum) {
  const stored = persisted.queryDrawerHeight;
  const keep = persisted.queryDrawerSizeVersion === QUERY_DRAWER_SIZE_VERSION ? Number.isFinite(stored) : Number.isFinite(stored) && stored !== QUERY_DRAWER_MINIMUM_HEIGHT;
  return clamp(keep ? stored : QUERY_DRAWER_PREFERRED_HEIGHT, minimum, maximum);
}
/** Creates the complete in-memory UI state from safe persisted preferences. */
function initialState(persisted = {}, bounds = {}) {
  const heightBounds = normalizeBounds(bounds);
  return { activeStage: stage(persisted.queryActiveStage), drawerHeight: migratedHeight(persisted, heightBounds.minimumHeight, heightBounds.maximumHeight), drawerOpen: Boolean(persisted.queryDrawerOpen), focusMode: false, inspectorScrollTops: { assistant: 0, meaning: 0, orm: 0, problems: 0 }, inspectorTab: inspectorTab(persisted.queryInspectorTab), lastFocusedControlKey: "", mobilePane: "editor", openComputedNodeIds: new Set(), openGroupNodeIds: new Set(), openHelpIds: new Set(), pendingComputedKinds: new Map(), pendingResultMode: "", selectedNodeId: "", stageScrollTops: { calculatedValues: 0, filterResults: 0, filterRows: 0, result: 0 } };
}
/** Serializes only safe preference state for VS Code webview persistence. */
function preferences(state) { return { queryActiveStage: state.activeStage, queryDrawerHeight: state.drawerHeight, queryDrawerOpen: state.drawerOpen, queryDrawerSizeVersion: QUERY_DRAWER_SIZE_VERSION, queryInspectorTab: state.inspectorTab }; }
/** Converts mutable collection fields into immutable snapshot values. */
function snapshotOf(state) { return { ...state, inspectorScrollTops: { ...state.inspectorScrollTops }, openComputedNodeIds: [...state.openComputedNodeIds].sort(), openGroupNodeIds: [...state.openGroupNodeIds].sort(), openHelpIds: [...state.openHelpIds].sort(), pendingComputedKinds: [...state.pendingComputedKinds].map(([nodeId, kind]) => ({ kind, nodeId })), stageScrollTops: { ...state.stageScrollTops } }; }
/** Creates UI-only state without persisting Recipe values, validation, or ORM text. */
export function createQueryUiState({ bounds, getPersisted = () => ({}), persist = () => {} } = {}) {
  let heightBounds = normalizeBounds(bounds);
  let state = initialState(getPersisted() || {}, heightBounds);
  const listeners = new Set();
  let persistTimer = 0;
  /** Notifies observers with a detached immutable UI snapshot. */
  function publish() { const value = snapshotOf(state); for (const listener of listeners) { listener(value); } }
  /** Persists only the documented preference projection. */
  function writePreferences() { persistTimer = 0; persist(preferences(state)); }
  /** Requests delayed persistence for drag updates and immediate persistence otherwise. */
  function schedulePersistence(delay = 0) { if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; } if (delay) { persistTimer = setTimeout(writePreferences, delay); } else { writePreferences(); } }
  /** Toggles one stable identifier in a state-owned disclosure collection. */
  function toggle(collection, nodeId, open) { if (!nodeId) { return; } if (open) { collection.add(nodeId); } else { collection.delete(nodeId); } }
  /** Applies one documented UI-only action and publishes its snapshot. */
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
    else if (type === "RESET_TRANSIENT_FOR_SOURCE") { const next = initialState(getPersisted() || {}, heightBounds); next.drawerOpen = state.drawerOpen; next.drawerHeight = state.drawerHeight; state = next; }
    else { return; }
    publish();
  }
  return {
    /** Releases pending persistence work. */
    destroy() { if (persistTimer) { clearTimeout(persistTimer); } listeners.clear(); },
    /** Updates finite bounds, normalizes them, and reclamps the current height. */
    setBounds(next = {}) {
      const previousBounds = heightBounds;
      heightBounds = normalizeBounds({ minimumHeight: Number.isFinite(next.minimumHeight) ? next.minimumHeight : previousBounds.minimumHeight, maximumHeight: Number.isFinite(next.maximumHeight) ? next.maximumHeight : previousBounds.maximumHeight });
      const before = state.drawerHeight;
      state.drawerHeight = clamp(state.drawerHeight, heightBounds.minimumHeight, heightBounds.maximumHeight);
      if (before !== state.drawerHeight || heightBounds.minimumHeight !== previousBounds.minimumHeight || heightBounds.maximumHeight !== previousBounds.maximumHeight) { publish(); }
    },
    /** Returns a detached UI snapshot. */
    getSnapshot() { return copy(snapshotOf(state)); },
    /** Applies one documented UI-only action. */
    dispatch,
    /** Registers one UI observer. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
/** Exposes pure state helpers for focused tests. */
export const __test = { clamp, initialState, inspectorTab, migratedHeight, normalizeBounds, preferences, stage };
