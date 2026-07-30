// Verifies persistent and transient Query Builder UI state boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { createQueryUiState } from "../media/gridQueryUiState.js";

test("drawer migration preserves intentional versioned choices and upgrades legacy defaults", () => {
  assert.equal(createQueryUiState().getSnapshot().drawerHeight, 360);
  assert.equal(createQueryUiState({ getPersisted: () => ({ queryDrawerHeight: 220 }) }).getSnapshot().drawerHeight, 360);
  assert.equal(createQueryUiState({ getPersisted: () => ({ queryDrawerHeight: 333 }) }).getSnapshot().drawerHeight, 333);
  assert.equal(createQueryUiState({ getPersisted: () => ({ queryDrawerHeight: 220, queryDrawerSizeVersion: 2 }) }).getSnapshot().drawerHeight, 220);
});

test("bounds normalize safely and publish only meaningful changes", () => {
  const state = createQueryUiState({ bounds: { maximumHeight: 100, minimumHeight: 240 } });
  let published = 0;
  state.subscribe(() => { published += 1; });
  assert.equal(state.getSnapshot().drawerHeight, 240);
  state.setBounds({ maximumHeight: NaN });
  assert.equal(published, 0);
  state.setBounds({ maximumHeight: 230 });
  assert.equal(published, 0);
  state.setBounds({ maximumHeight: 300 });
  assert.equal(published, 1);
});

test("final non-dragging writes supersede delayed drag persistence", async () => {
  const writes = [];
  const state = createQueryUiState({ persist: (value) => writes.push(value) });
  state.dispatch({ dragging: true, height: 300, type: "SET_DRAWER_HEIGHT" });
  state.dispatch({ dragging: false, height: 320, type: "SET_DRAWER_HEIGHT" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].queryDrawerHeight, 320);
  assert.equal(writes[0].queryDrawerSizeVersion, 2);
});

test("UI preferences persist without transient disclosure state", () => {
  const writes = [];
  const state = createQueryUiState({ bounds: { maximumHeight: 500, minimumHeight: 240 }, getPersisted: () => ({ queryDrawerOpen: true }), persist: (value) => writes.push(value) });
  state.dispatch({ nodeId: "computed-1", open: true, type: "SET_COMPUTED_OPEN" });
  state.dispatch({ stage: "filterRows", type: "SET_ACTIVE_STAGE" });
  assert.equal(state.getSnapshot().drawerHeight, 360);
  assert.equal(state.getSnapshot().activeStage, "filterRows");
  assert.deepEqual(state.getSnapshot().openComputedNodeIds, ["computed-1"]);
  assert.equal("openComputedNodeIds" in writes.at(-1), false);
});

test("source resets clear transient disclosure without changing persisted drawer choices", () => {
  const state = createQueryUiState({ getPersisted: () => ({ queryDrawerHeight: 333, queryDrawerOpen: true, queryDrawerSizeVersion: 2 }) });
  state.dispatch({ nodeId: "group-1", open: true, type: "SET_GROUP_OPEN" });
  state.dispatch({ type: "RESET_TRANSIENT_FOR_SOURCE" });
  const snapshot = state.getSnapshot();
  assert.equal(snapshot.drawerOpen, true);
  assert.equal(snapshot.drawerHeight, 333);
  assert.deepEqual(snapshot.openGroupNodeIds, []);
});
