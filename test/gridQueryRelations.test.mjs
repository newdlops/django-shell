// Verifies validator-aligned relation recommendation and source-scope helpers.
import assert from "node:assert/strict";
import test from "node:test";
import { createQuerySourceScope, relationSourceState, resolveQuerySourceTarget } from "../media/gridQueryRelations.js";

/** Returns metadata state fixtures keyed by complete app/model identity. */
function metadata(states) { return { getState: (target) => states[`${target?.app}.${target?.model}`] || {} }; }

test("relation recommendations retain live query identities, eligibility, and stale values", () => {
  const owner = { app: "db", model: "Company" };
  const service = metadata({ "db.Company": { tree: { fields: [], relations: [
    { filterField: "company_id", kind: "forward_fk", label: "Valuations", name: "valuation_history", outerField: "id", target: "db.Valuation" },
    { filterField: "company_id", kind: "many_to_many", name: "tags", target: "db.Tag", toMany: true },
    { name: "broken", target: "invalid" }
  ] } } });
  const state = relationSourceState({ current: "old_accessor", metadata: service, owner });
  assert.equal(state.phase, "ready");
  assert.deepEqual(state.options.map((option) => option.value), ["valuation_history", "tags", "old_accessor"]);
  assert.match(state.options[0].keywords, /valuation_history.*Valuations.*db\.Valuation.*forward fk.*one related row/);
  assert.equal(state.options[1].disabled, true);
  assert.match(state.options[1].disabledReason, /safe automatic connection/i);
  assert.equal(state.options[2].label, "Unavailable relation: old_accessor");
});

test("relation source states distinguish loading, cached errors, and empty metadata", () => {
  const owner = { app: "db", model: "Company" };
  assert.equal(relationSourceState({ metadata: metadata({}), owner }).phase, "loading");
  const failed = relationSourceState({ metadata: metadata({ "db.Company": { error: "Request failed" } }), owner });
  assert.deepEqual(failed, { error: "Request failed", options: [], phase: "error" });
  assert.equal(relationSourceState({ metadata: metadata({ "db.Company": { tree: { fields: [], relations: [] } } }), owner }).phase, "empty");
});

test("relation phases preserve stale choices and distinguish valid unsafe metadata from empty trees", () => {
  const owner = { app: "app.with.dot", model: "Book" }; const stale = "old";
  assert.equal(relationSourceState({ current: stale, metadata: metadata({}), owner }).options.at(-1).value, stale);
  assert.equal(relationSourceState({ current: stale, metadata: metadata({ "app.with.dot.Book": { error: "cached" } }), owner }).options.at(-1).value, stale);
  const unsafe = relationSourceState({ metadata: metadata({ "app.with.dot.Book": { tree: { fields: [], relations: [{ filterField: " ", name: "reverse", outerField: "", target: "app.with.dot.Target" }] } } }), owner });
  assert.equal(unsafe.phase, "ready"); assert.equal(unsafe.options[0].disabled, true);
  const empty = relationSourceState({ current: stale, metadata: metadata({ "app.with.dot.Book": { tree: { fields: [], relations: [] } } }), owner }); assert.equal(empty.phase, "empty"); assert.equal(empty.options[0].value, stale);
});

test("relation options retain safe reverse links and stable first-seen duplicate ordering", () => {
  const owner = { app: "app", model: "Book" };
  const state = relationSourceState({ metadata: metadata({ "app.Book": { tree: { fields: [], relations: [
    { filterField: "book_id", kind: "reverse_fk", label: "Reverse books", name: "reverse_books", outerField: "id", target: "app.Book" },
    { filterField: "book_id", label: "First duplicate", name: "duplicate", outerField: "id", target: "app.First" },
    { filterField: "book_id", label: "Second duplicate", name: "duplicate", outerField: "id", target: "app.Second" },
    { filterField: "book_id", name: "zeta", outerField: "id", target: "app.Zeta" }
  ] } } }), owner });
  assert.equal(state.phase, "ready"); assert.deepEqual(state.options.map((option) => option.value), ["reverse_books", "duplicate", "zeta"]); assert.equal(state.options[0].disabled, false); assert.match(state.options[0].keywords, /reverse fk/); assert.equal(state.options[1].label, "First duplicate → app.First");
});

test("relation helpers reject whitespace and malformed targets while resolving dotted filter-field identities", () => {
  const owner = { app: "owner.app.with.dot", model: "Book" };
  const service = metadata({ "owner.app.with.dot.Book": { tree: { fields: [], relations: [
    { filterField: " ", name: " ", outerField: "id", target: "target.app.Model" },
    { filterField: "valid", name: "missingTarget", outerField: "id", target: "   " },
    { filterField: "invalid-one", name: "badOne", outerField: "id", target: "NoSeparator" },
    { filterField: "invalid-two", name: "badTwo", outerField: "id", target: ".Model" },
    { filterField: "book.ref", name: "children", outerField: "id", target: "target.app.with.dot.Child" }
  ] } } });
  const state = relationSourceState({ metadata: service, owner }); assert.deepEqual(state.options.map((option) => option.value), ["children"]); assert.deepEqual(resolveQuerySourceTarget({ kind: "relation", relation: "book.ref" }, owner, service), { app: "target.app.with.dot", model: "Child" }); assert.deepEqual(resolveQuerySourceTarget({ kind: "relation", relation: "children" }, owner, service), { app: "target.app.with.dot", model: "Child" });
});

test("target resolution and isolated source scopes never fall back to outer fields", () => {
  const owner = { app: "db", model: "Company" };
  const service = metadata({ "db.Company": { tree: { fields: [{ name: "id", type: "AutoField" }], relations: [{ filterField: "company_id", name: "valuations", outerField: "id", target: "db.Valuation" }] } } });
  const ownerScope = { columns: [{ name: "name" }, { name: "id" }], computed: [{ alias: "score" }], source: owner };
  assert.deepEqual(resolveQuerySourceTarget({ kind: "model", target: { app: "db", model: "Valuation" } }, owner, service), { app: "db", model: "Valuation" });
  assert.deepEqual(resolveQuerySourceTarget({ kind: "relation", relation: "company_id" }, owner, service), { app: "db", model: "Valuation" });
  assert.equal(resolveQuerySourceTarget({ kind: "relation", relation: "missing" }, owner, service), undefined);
  const resolved = createQuerySourceScope({ kind: "relation", relation: "valuations" }, ownerScope, service);
  assert.deepEqual(resolved.target, { app: "db", model: "Valuation" });
  assert.deepEqual(resolved.source, resolved.target);
  assert.deepEqual(resolved.outerFields.map((field) => field.path), ["id", "name"]);
  assert.deepEqual(resolved.columns, []);
  assert.deepEqual(resolved.computed, []);
  assert.deepEqual(resolved.computedFields, []);
  const unresolved = createQuerySourceScope({ kind: "relation", relation: "missing" }, ownerScope, service); assert.equal(unresolved.target, undefined); assert.equal(unresolved.source, undefined);
});
