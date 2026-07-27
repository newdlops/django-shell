// Verifies immutable webview Recipe draft/applied state and revision behavior.
import assert from "node:assert/strict";
import test from "node:test";

const { createEmptyQueryRecipe, createQueryRecipeStore } = await import("../media/gridQueryRecipeStore.js");

test("recipe store keeps applied state immutable while editing a draft", () => {
  const source = { app: "db", model: "Company" };
  const store = createQueryRecipeStore(createEmptyQueryRecipe(source));
  const before = store.getSnapshot();
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  const after = store.getSnapshot();

  assert.equal(before.draft.where.children.length, 0);
  assert.equal(after.applied.where.children.length, 0);
  assert.equal(after.draft.where.children.length, 1);
  assert.equal(after.dirty, true);
  assert.notEqual(after.draft.where.children[0].nodeId, "where-root");
});

test("condition field selection remains in the draft after a structural add", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  const nodeId = store.getSnapshot().draft.where.children[0].nodeId;
  store.dispatch({ changes: { lhs: { kind: "field", path: "id" } }, nodeId, type: "UPDATE_NODE" });
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.draft.where.children.length, 1);
  assert.deepEqual(snapshot.draft.where.children[0].lhs, { kind: "field", path: "id" });
  assert.equal(snapshot.applied.where.children.length, 0);
  assert.equal(snapshot.dirty, true);
});

test("recipe store regenerates every nested identifier when duplicating a predicate", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ group: { children: [{ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "exact", negated: false, nodeId: "name", rhs: { kind: "literal", value: "A" } }], join: "and", kind: "group", negated: false, nodeId: "names" }, parentId: "where-root", type: "ADD_GROUP" });
  store.dispatch({ nodeId: "names", type: "DUPLICATE_NODE" });
  const children = store.getSnapshot().draft.where.children;

  assert.equal(children.length, 2);
  assert.notEqual(children[0].nodeId, children[1].nodeId);
  assert.notEqual(children[0].children[0].nodeId, children[1].children[0].nodeId);
});

test("successful Apply preserves edits made after its snapshot began", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  const applying = store.getSnapshot().draft;
  store.beginApply(4, applying);
  store.dispatch({ type: "ADD_COMPUTED" });
  store.finishApply(4, applying);
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.applied.where.children.length, 1);
  assert.equal(snapshot.draft.computed.length, 1);
  assert.equal(snapshot.dirty, true);
});

test("stale validation cannot overwrite the current draft revision", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  const firstRevision = store.getSnapshot().draftRevision;
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  store.setValidation({ issues: [{ code: "VALUE_REQUIRED" }], ok: false, warnings: [] }, firstRevision);

  assert.equal(store.getSnapshot().validation.ok, true);
});

test("recipe history restores draft edits without changing the applied query", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  const nodeId = store.getSnapshot().draft.where.children[0].nodeId;
  store.dispatch({ changes: { lookup: "icontains" }, nodeId, type: "UPDATE_NODE" });
  store.undo();

  assert.equal(store.getSnapshot().draft.where.children[0].lookup, "exact");
  assert.equal(store.getSnapshot().applied.where.children.length, 0);
  assert.equal(store.getSnapshot().canRedo, true);
  store.redo();
  assert.equal(store.getSnapshot().draft.where.children[0].lookup, "icontains");
});

test("text history coalesces a focused control into one undo step", () => {
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ type: "ADD_COMPUTED" });
  const nodeId = store.getSnapshot().draft.computed[0].nodeId;
  store.dispatch({ changes: { alias: "a" }, history: { group: `computed:${nodeId}:alias`, mode: "text" }, nodeId, type: "UPDATE_COMPUTED" });
  store.dispatch({ changes: { alias: "ab" }, history: { group: `computed:${nodeId}:alias`, mode: "text" }, nodeId, type: "UPDATE_COMPUTED" });
  store.undo();

  assert.equal(store.getSnapshot().draft.computed[0].alias, "");
});
