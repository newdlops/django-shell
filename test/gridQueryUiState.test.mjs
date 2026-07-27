// Verifies persistent/transient Query Builder UI state boundaries.
import assert from "node:assert/strict";
import test from "node:test";

const { createQueryUiState } = await import("../media/gridQueryUiState.js");

test("Query Builder UI state persists preferences but keeps editor disclosure transient", () => {
  const writes = [];
  const state = createQueryUiState({ bounds: { maximumHeight: 500, minimumHeight: 240 }, getPersisted: () => ({ queryActiveStage: "result", queryDrawerHeight: 900, queryDrawerOpen: true, queryInspectorTab: "orm" }), persist: (value) => writes.push(value) });

  state.dispatch({ nodeId: "computed-1", open: true, type: "SET_COMPUTED_OPEN" });
  state.dispatch({ stage: "filterRows", type: "SET_ACTIVE_STAGE" });
  const snapshot = state.getSnapshot();

  assert.equal(snapshot.drawerHeight, 500);
  assert.equal(snapshot.activeStage, "filterRows");
  assert.deepEqual(snapshot.openComputedNodeIds, ["computed-1"]);
  assert.equal(writes.at(-1).queryActiveStage, "filterRows");
  assert.equal("openComputedNodeIds" in writes.at(-1), false);
});

test("source changes clear only transient Query Builder UI state", () => {
  const state = createQueryUiState({ getPersisted: () => ({ queryDrawerHeight: 333, queryDrawerOpen: true }) });
  state.dispatch({ nodeId: "group-1", open: true, type: "SET_GROUP_OPEN" });
  state.dispatch({ type: "RESET_TRANSIENT_FOR_SOURCE" });
  const snapshot = state.getSnapshot();

  assert.equal(snapshot.drawerOpen, true);
  assert.equal(snapshot.drawerHeight, 333);
  assert.deepEqual(snapshot.openGroupNodeIds, []);
});
