// Verifies progressive schema-safe Query Builder starter examples.
import assert from "node:assert/strict";
import test from "node:test";
import { buildQueryExamples, createQueryExamplesView, isCanonicalEmptyQueryRecipe } from "../media/gridQueryExamples.js";
import { createEmptyQueryRecipe, createQueryRecipeStore } from "../media/gridQueryRecipeStore.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ModelQueryMetadataIndex } = require("../out/modelQueryRecipeMetadata.js");
const { validateModelQueryRecipe } = require("../out/modelQueryRecipeValidation.js");
const { buildRecipeRowsOrm, buildRecipeSummaryOrm } = require("../out/modelQueryRecipeOrm.js");

/** Builds a compact root-column fixture. */
function column(name, type, extra = {}) { return { attname: name, name, type, ...extra }; }
/** Builds the stable source fixture. */
function source() { return { app: "db", model: "Company" }; }
/** Builds a relation fixture eligible for an automatic Exists correlation. */
function relation(extra = {}) { return { filterField: "company_id", kind: "reverse-fk", name: "membership_set", outerField: "id", queryName: "membership", single: false, target: "db.Membership", ...extra }; }

test("canonical empty remains the only starter-example gate", () => {
  const empty = createEmptyQueryRecipe(source());
  assert.equal(isCanonicalEmptyQueryRecipe(empty), true);
  assert.equal(isCanonicalEmptyQueryRecipe({ ...empty, orderBy: [{ direction: "asc" }] }), false);
});

test("builds all four progressive examples in exact aggregate, Exists, Formula, Window order", () => {
  const examples = buildQueryExamples({ columns: [column("id", "BigAutoField", { pk: true }), column("status", "CharField", { choices: [["active", "Active"]] })], relations: [relation()], source: source() });
  assert.equal(examples.length, 4);
  assert.equal(examples[0].label, "1 · Group status; Count ≥ 2");
  assert.equal(examples[0].recipe.mode, "summary");
  assert.equal(examples[0].recipe.groupBy[0].path, "status");
  assert.equal(examples[0].recipe.computed[0].kind, "aggregate");
  assert.equal(examples[0].recipe.computed[0].function, "count");
  assert.equal(examples[0].recipe.postFilter.children[0].lookup, "gte");
  assert.equal(examples[0].recipe.orderBy[0].direction, "desc");
  assert.equal(examples[1].label, "2 · Related membership via Exists");
  assert.equal(examples[1].recipe.computed[0].kind, "exists");
  assert.equal(examples[1].recipe.computed[0].source.relation, "membership");
  assert.equal(examples[1].recipe.postFilter.children[0].rhs.value, true);
  assert.equal(examples[2].label, "3 · Normalize status; Length ≥ 8");
  assert.equal(examples[2].recipe.computed[0].kind, "formula");
  assert.equal(examples[2].recipe.computed[1].expression.args[0].alias, examples[2].recipe.computed[0].alias);
  assert.equal(examples[3].label, "4 · Top 3 id per status");
  assert.equal(examples[3].recipe.computed[0].kind, "window");
  assert.equal(examples[3].recipe.computed[0].function, "row_number");
});

test("fails closed and emits only eligible progressive candidates", () => {
  assert.deepEqual(buildQueryExamples({ columns: [column("id", "BigAutoField", { pk: true })], relations: [relation()], source: source() }).map((item) => item.label), ["1 · Related membership via Exists"]);
  assert.deepEqual(buildQueryExamples({ columns: [column("status", "CharField")], relations: [relation({ outerField: "missing" })], source: source() }).map((item) => item.label), ["1 · Group status; Count ≥ 2", "2 · Normalize status; Length ≥ 8"]);
  assert.deepEqual(buildQueryExamples({ columns: [column("status", "CharField")], source: { app: "", model: "Company" } }), []);
  assert.deepEqual(buildQueryExamples({ columns: [column("status__unsafe", "CharField", { choices: [["a", "A"]] }), column("id", "AutoField", { pk: true })], relations: [relation()], source: source() }), []);
  assert.deepEqual(buildQueryExamples({ columns: [column("status", "CharField", { choices: [["a", "A"]] }), column("status", "CharField"), column("id", "AutoField", { pk: true })], relations: [relation()], source: source() }), []);
});

test("prefers categorical names and produces bounded collision-free aliases", () => {
  const long = "a".repeat(120);
  const examples = buildQueryExamples({ columns: [column("role", "CharField"), column("status", "CharField", { choices: [["a", "A"] ] }), column("row_count", "IntegerField"), column("id", "BigAutoField", { pk: true })], relations: [relation({ name: long, queryName: long })], source: source() });
  assert.equal(examples[0].recipe.groupBy[0].path, "status");
  assert.notEqual(examples[0].recipe.computed[0].alias, "row_count");
  assert.ok(examples[1].recipe.computed[0].alias.length <= 64);
});

test("avoids reserved aliases and accepts PositiveBigIntegerField Window ordering", () => {
  const examples = buildQueryExamples({ columns: [column("status", "CharField", { choices: [["a", "A"]] }), column("djs_name", "CharField"), column("rank", "PositiveBigIntegerField")], source: source() });
  const formula = examples.find((example) => example.recipe.computed[0].kind === "formula"); const window = examples.find((example) => example.recipe.computed[0].kind === "window"); assert.ok(formula.recipe.computed.every((item) => !item.alias.startsWith("djs_"))); assert.equal(window.recipe.computed[0].orderBy[0].ref.path, "rank");
});
test("named temporal paths require temporal types before winning Window order", () => {
  const examples = buildQueryExamples({ columns: [column("status", "CharField", { choices: [["a", "A"]] }), column("created_at", "CharField"), column("score", "IntegerField"), column("id", "AutoField", { pk: true })], source: source() }); const window = examples.find((example) => example.recipe.computed[0].kind === "window"); assert.equal(window.recipe.computed[0].orderBy[0].ref.path, "score");
});

test("prefers a non-primary numeric Window order before the primary-key fallback", () => {
  const examples = buildQueryExamples({ columns: [column("status", "CharField", { choices: [["a", "A"]] }), column("id", "BigAutoField", { pk: true }), column("score", "IntegerField")], source: source() });
  const window = examples.find((example) => example.recipe.computed[0].kind === "window"); assert.equal(window.recipe.computed[0].orderBy[0].ref.path, "score");
});
test("Formula and Window examples keep their exact progressive Recipe shapes and focus keys", () => {
  const examples = buildQueryExamples({ columns: [column("status", "CharField", { choices: [["a", "A"]] }), column("username", "CharField"), column("score", "IntegerField"), column("id", "BigAutoField", { pk: true })], source: source() });
  const formula = examples.find((example) => example.recipe.computed[0].kind === "formula"); const window = examples.find((example) => example.recipe.computed[0].kind === "window");
  assert.deepEqual(formula.recipe.computed.map((item) => [item.kind, item.expression.function, item.nodeId]), [["formula", "lower", formula.id + "-normalized"], ["formula", "length", formula.id + "-length"]]); assert.deepEqual(formula.recipe.postFilter.children[0].rhs, { kind: "literal", value: 8 }); assert.equal(formula.controlKey, `computed:${formula.id}-normalized:alias`);
  assert.deepEqual(window.recipe.computed[0].partitionBy, [{ kind: "field", path: "status" }]); assert.deepEqual(window.recipe.computed[0].orderBy[0].ref, { kind: "field", path: "score" }); assert.deepEqual(window.recipe.orderBy.map((item) => item.direction), ["asc", "asc"]); assert.equal(window.controlKey, `computed:${window.id}:alias`);
});
test("example view caps at four accessible actions and preserves the chosen focus target contract", () => {
  const node = (tag, properties = {}, value) => ({ tag, ...properties, children: [], appendChild(child) { this.children.push(child); return child; }, addEventListener(type, listener) { this.listener = type === "click" ? listener : this.listener; }, textContent: value });
  const mount = { children: [], hidden: true, appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; } }; const selected = []; const examples = buildQueryExamples({ columns: [column("id", "BigAutoField", { pk: true }), column("status", "CharField", { choices: [["a", "A"]] }), column("username", "CharField"), column("score", "IntegerField")], relations: [relation()], source: source() });
  createQueryExamplesView({ el: node, mount, onChoose: (example) => selected.push(example.controlKey) }).render({ draft: createEmptyQueryRecipe(source()), examples: [...examples, examples[0]], source: source() });
  const actions = mount.children.at(-1); assert.equal(mount.hidden, false); assert.equal(actions.className, "query-examples-actions"); assert.equal(actions.children.length, 4); assert.deepEqual(actions.children.map((action) => action.textContent), examples.map((example) => example.label)); assert.ok(actions.children.every((action) => action.type === "button" && action.ariaLabel.includes(action.textContent) && action.title)); actions.children[3].listener(); assert.equal(selected[0], examples[3].controlKey); assert.match(selected[0], /^computed:.*:alias$/);
});
test("examples are detached, deterministic, and draft-only one-step replacements", () => {
  const input = Object.freeze([Object.freeze(column("status", "CharField"))]);
  const first = buildQueryExamples({ columns: input, source: Object.freeze(source()) });
  const second = buildQueryExamples({ columns: input, source: source() });
  assert.deepEqual(first, second);
  assert.notEqual(first[0].recipe, second[0].recipe);
  const store = createQueryRecipeStore(createEmptyQueryRecipe(source()));
  store.dispatch({ recipe: first[0].recipe, type: "REPLACE_DRAFT" });
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().applied.mode, "rows");
  store.undo();
  assert.equal(isCanonicalEmptyQueryRecipe(store.getSnapshot().draft), true);
});
test("every emitted candidate validates against live metadata and compiles through the normal ORM boundary", () => {
  const columns = [column("id", "BigAutoField", { pk: true }), column("status", "CharField", { choices: [["a", "A"]] }), column("username", "CharField"), column("created_at", "DateTimeField")]; const index = new ModelQueryMetadataIndex(); const root = source(); const related = { app: "db", model: "Membership" }; const metadataColumns = columns.map((entry) => ({ ...entry, editable: true, null: false })); index.setCatalog([root, related]); index.addTree(root, { fields: metadataColumns, ok: true, pk: "id", relations: [{ filterField: "company_id", kind: "reverse", name: "membership_set", outerField: "id", queryName: "membership", single: false, target: "db.Membership" }] }); index.addTree(related, { fields: [{ attname: "id", name: "id", null: false, pk: true, type: "AutoField" }, { attname: "company_id", name: "company_id", null: false, pk: false, type: "BigAutoField" }], ok: true, pk: "id", relations: [] }); index.addColumns(root, metadataColumns);
  for (const example of buildQueryExamples({ columns, relations: [relation()], source: root })) { const context = { columns: metadataColumns, limit: 50, metadata: index, relations: [], source: root, transport: "orm" }; const validated = validateModelQueryRecipe(example.recipe, context); assert.equal(validated.ok, true, example.label); const compiled = example.recipe.mode === "summary" ? buildRecipeSummaryOrm(validated.normalized, context) : buildRecipeRowsOrm(validated.normalized, context); assert.equal(compiled.validation.ok, true, example.label); assert.notEqual(compiled.cell, "", example.label); }
});
