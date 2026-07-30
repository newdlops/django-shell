// Tests metadata-backed native Query Builder field-path picker state transitions.
import assert from "node:assert/strict";
import test from "node:test";
import { createQueryFieldPicker } from "../media/gridQueryFieldPicker.js";

/** Creates a lightweight DOM factory with event dispatch for native-picker tests. */
function element(tag, properties = {}, ...children) { const listeners = new Map(); const node = { ...properties, children: [], dataset: properties.dataset || {}, addEventListener(type, listener) { listeners.set(type, listener); }, append(...items) { items.forEach((item) => this.appendChild(item)); }, appendChild(item) { if (item && typeof item === "object") { item.parentNode = this; } this.children.push(item); }, dispatch(type) { listeners.get(type)?.(); }, focus() { this.focused = true; }, remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); } }, removeEventListener(type) { listeners.delete(type); }, replaceChildren(...items) { this.children = []; items.forEach((item) => this.appendChild(item)); }, replaceWith(item) { const parent = this.parentNode; if (!parent) { return; } const index = parent.children.indexOf(this); item.parentNode = parent; parent.children.splice(index, 1, item); }, tag }; node.append(...children); return node; }
/** Returns immediate metadata with one scalar and one relation target. */
function metadata(tree) { return { getState() { return { tree }; }, loadTree() { return Promise.resolve(tree); }, retry() { return Promise.resolve(tree); } }; }

test("root native picker groups fields, calculated values, and relations with a stable control key", async () => {
  const picker = createQueryFieldPicker({ computed: [{ alias: "total" }], controlKey: "predicate-lhs-x", el: element, metadata: metadata({ fields: [{ name: "name", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] }), source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const select = picker.node.children[0].children[0];
  assert.equal(select.tag, "select");
  assert.equal(select.dataset.queryControlKey, "predicate-lhs-x-0");
  assert.deepEqual(select.children.map((item) => item.label), [undefined, "Fields", "Calculated values", "Relations"]);
});

test("cached root metadata renders an enabled native select synchronously", () => {
  let loads = 0;
  const tree = { fields: [{ name: "name", type: "CharField" }], relations: [] };
  const picker = createQueryFieldPicker({ el: element, metadata: { getState() { return { tree }; }, loadTree() { loads += 1; return Promise.resolve(tree); } }, source: { app: "app", model: "Book" } });
  const select = picker.node.children[0].children[0];
  assert.equal(select.tag, "select");
  assert.equal(select.disabled, false);
  assert.equal(loads, 0);
});

test("relation choices wait for a scalar leaf unless relation terminals are allowed", async () => {
  const trees = new Map([["app.Book", { fields: [], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [{ name: "email", type: "EmailField" }], relations: [] }]]);
  const service = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, loadTree(target) { return Promise.resolve(trees.get(`${target.app}.${target.model}`)); } };
  const changes = [];
  const picker = createQueryFieldPicker({ controlKey: "field", el: element, metadata: service, onChange: (value) => changes.push(value), source: { app: "app", model: "Book" } });
  await new Promise((resolve) => setImmediate(resolve)); picker.node.children[0].children[0].value = "relation:owner"; picker.node.children[0].children[0].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(changes, []);
  const child = picker.node.children[0].children[1];
  assert.equal(child.tag, "select");
  assert.equal(child.dataset.queryControlKey, "field-1");
  child.value = "field:email"; child.dispatch("change");
  assert.deepEqual(changes, ["owner__email"]);
});

test("relationship traversal and terminal checks remain distinct allowlisted actions", async () => {
  const trees = new Map([["app.Book", { fields: [{ name: "owner", type: "CharField" }], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [{ name: "email", type: "EmailField" }], relations: [{ name: "group", target: "app.Group" }] }], ["app.Group", { fields: [], relations: [] }]]);
  let loads = 0; const changes = []; const service = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, loadTree(target) { loads += 1; return Promise.resolve(trees.get(`${target.app}.${target.model}`)); } };
  const picker = createQueryFieldPicker({ allowRelationTerminal: true, computed: [{ alias: "owner" }], el: element, metadata: service, onChange: (...args) => changes.push(args), source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask); const root = picker.node.children[0].children[0];
  assert.deepEqual(root.children.map((group) => group.label), [undefined, "Fields", "Calculated values", "Relations", "Relationship checks"]);
  root.value = "relation:owner"; root.dispatch("change"); await new Promise((done) => setImmediate(done));
  assert.equal(picker.node.children[0].children[0].value, "relation:owner"); assert.equal(changes.length, 0);
  picker.node.children[0].children[1].value = "field:email"; picker.node.children[0].children[1].dispatch("change");
  assert.deepEqual(changes[0].slice(0, 2), ["owner__email", "field"]);
  picker.setCurrent(""); await new Promise(queueMicrotask); const refreshed = picker.node.children[0].children[0]; refreshed.value = "relationTerminal:owner"; refreshed.dispatch("change");
  assert.deepEqual(changes[1].slice(0, 2), ["owner", "relationTerminal"]); assert.equal(loads, 0);
  refreshed.value = "relationTerminal:injected"; refreshed.dispatch("change"); assert.equal(changes.length, 2);
});

test("unavailable and trailing paths remain visibly disabled without emission", async () => {
  const changes = [];
  const picker = createQueryFieldPicker({ current: "name__missing", el: element, metadata: metadata({ fields: [{ name: "name", type: "CharField" }], relations: [] }), onChange: (value) => changes.push(value), source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const selects = picker.node.children[0].children;
  assert.equal(selects[0].value, "field:name");
  assert.equal(selects[1].value, "");
  assert.deepEqual(changes, []);
});

test("failed metadata renders retry and dispose prevents stale render", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const service = { getState() { return {}; }, loadTree() { return pending; }, retry() { return Promise.resolve({ fields: [], relations: [] }); } };
  const picker = createQueryFieldPicker({ el: element, metadata: service, source: { app: "app", model: "Book" } });
  picker.dispose(); resolve({ fields: [{ name: "name" }], relations: [] }); await new Promise(queueMicrotask);
  assert.equal(picker.node.children[0].children.length, 1);
});

test("cached errors do not auto-retry and detached Retry controls are inert", async () => {
  let loads = 0;
  let retries = 0;
  const service = { getState() { return { error: new Error("cached") }; }, loadTree() { loads += 1; return Promise.resolve(); }, retry() { retries += 1; return Promise.resolve({ fields: [], relations: [] }); } };
  const picker = createQueryFieldPicker({ el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const retry = picker.node.children[1].children.at(-1);
  assert.equal(loads, 0);
  picker.setCurrent("name");
  retry.dispatch("click");
  assert.equal(retries, 0);
});

test("loading replacement and terminal child failures retain the resolved prefix", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const service = { getState(target) { return target.model === "Book" ? {} : { error: new Error("child") }; }, loadTree(target) { return target.model === "Book" ? pending : Promise.reject(new Error("child")); } };
  const picker = createQueryFieldPicker({ current: "owner__email", el: element, metadata: service, source: { app: "app", model: "Book" } });
  assert.equal(picker.node.children[0].children.length, 1);
  resolve({ fields: [], relations: [{ name: "owner", target: "app.User" }] });
  await new Promise((done) => setImmediate(done));
  const controls = picker.node.children[0].children;
  assert.equal(controls.length, 2);
  assert.equal(controls[0].tag, "select");
  assert.equal(controls[0].value, "relation:owner");
  assert.equal(controls[1].disabled, true);
});

test("empty child metadata preserves the resolved parent select and renders disabled exact empty state", async () => {
  const trees = new Map([["app.Book", { fields: [], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [], relations: [] }]]);
  const service = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, loadTree(target) { return Promise.resolve(trees.get(`${target.app}.${target.model}`)); } };
  const picker = createQueryFieldPicker({ current: "owner__email", el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise((done) => setImmediate(done));
  const controls = picker.node.children[0].children;
  assert.equal(controls[0].value, "relation:owner");
  assert.equal(controls[1].disabled, true);
  assert.equal(controls[1].children[0].children[0], "No selectable fields.");
});

test("Retry invokes metadata retry once and rejected retry returns to an error state", async () => {
  let retries = 0;
  const service = { getState() { return { error: new Error("cached") }; }, retry() { retries += 1; return Promise.reject(new Error("still bad")); } };
  const picker = createQueryFieldPicker({ el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const retry = picker.node.children[1].children.at(-1);
  retry.dispatch("click"); retry.dispatch("click");
  await new Promise((done) => setImmediate(done));
  assert.equal(retries, 1);
  assert.equal(picker.node.children[0].children.at(-1).disabled, true);
});

test("successful Retry is one-shot and replaces the error with exactly one live native select", async () => {
  let retries = 0;
  const tree = { fields: [{ name: "name", type: "CharField" }], relations: [] };
  let recovered = false;
  const service = { getState() { return recovered ? { tree } : { error: new Error("cached") }; }, retry() { retries += 1; recovered = true; return Promise.resolve(tree); } };
  const picker = createQueryFieldPicker({ el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const retry = picker.node.children[1].children.at(-1);
  retry.dispatch("click"); retry.dispatch("click");
  await new Promise((done) => setImmediate(done));
  const controls = picker.node.children[0].children;
  assert.equal(retries, 1);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].tag, "select");
  assert.equal(controls[0].disabled, false);
});

test("an older pending load cannot overwrite a newer setCurrent render", async () => {
  let resolveOld;
  const old = new Promise((done) => { resolveOld = done; });
  let cached = false;
  let loads = 0;
  const tree = { fields: [{ name: "name", type: "CharField" }], relations: [] };
  const service = { getState() { return cached ? { tree } : {}; }, loadTree() { loads += 1; return old; } };
  const picker = createQueryFieldPicker({ el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  cached = true;
  picker.setCurrent("name");
  await new Promise(queueMicrotask);
  resolveOld({ fields: [{ name: "old", type: "CharField" }], relations: [] });
  await new Promise((done) => setImmediate(done));
  assert.equal(loads, 1);
  assert.equal(picker.node.children[0].children.length, 1);
  assert.equal(picker.node.children[0].children[0].value, "field:name");
});

test("persisted relation terminals and computed trailing segments do not load children", async () => {
  let loads = 0;
  const tree = { fields: [], relations: [{ name: "owner", target: "app.User" }] };
  const service = { getState() { return { tree }; }, loadTree() { loads += 1; return Promise.resolve(tree); } };
  const terminal = createQueryFieldPicker({ allowRelationTerminal: true, current: "owner", el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  assert.equal(terminal.node.children[0].children.length, 1);
  const computed = createQueryFieldPicker({ computed: [{ alias: "total" }], current: "total__bad", el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  assert.equal(computed.node.children[0].children.length, 2);
  assert.equal(loads, 0);
});

test("persisted allowed relation terminal with uncached child performs zero child loads", async () => {
  let loads = 0;
  const tree = { fields: [], relations: [{ name: "owner", target: "app.User" }] };
  const service = { getState(target) { return target.model === "Book" ? { tree } : {}; }, loadTree() { loads += 1; return Promise.resolve({ fields: [], relations: [] }); } };
  const picker = createQueryFieldPicker({ allowRelationTerminal: true, current: "owner", el: element, metadata: service, source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  assert.equal(picker.node.children[0].children.length, 1);
  assert.equal(loads, 0);
});

test("computed trailing segments render a disabled unavailable control and emit nothing", async () => {
  const changes = [];
  const picker = createQueryFieldPicker({ computed: [{ alias: "total" }], current: "total__bad", el: element, metadata: metadata({ fields: [], relations: [] }), onChange: (value) => changes.push(value), source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const controls = picker.node.children[0].children;
  assert.equal(controls.length, 2);
  assert.equal(controls[1].disabled, true);
  assert.equal(controls[1].children[0].children[0], "Unavailable field: bad");
  assert.deepEqual(changes, []);
});

test("injected non-allowlisted selection emits nothing and offers no manual-input fallback", async () => {
  const changes = [];
  const picker = createQueryFieldPicker({ el: element, metadata: metadata({ fields: [{ name: "name", type: "CharField" }], relations: [] }), onChange: (value) => changes.push(value), source: { app: "app", model: "Book" } });
  await new Promise(queueMicrotask);
  const select = picker.node.children[0].children[0];
  select.value = "field:injected"; select.dispatch("change");
  assert.deepEqual(changes, []);
  assert.equal(picker.node.children[0].children.every((control) => control.tag === "select"), true);
});

test("interactive relation terminal emits without loading an uncached child target", async () => {
  let childLoads = 0; const changes = [];
  const service = { getState(target) { return target.model === "Book" ? { tree: { fields: [], relations: [{ name: "owner", target: "app.User" }] } } : {}; }, loadTree(target) { if (target.model === "User") { childLoads += 1; } return Promise.resolve({ fields: [], relations: [] }); } };
  const picker = createQueryFieldPicker({ allowRelationTerminal: true, el: element, metadata: service, onChange: (...args) => changes.push(args), source: { app: "app", model: "Book" } }); await new Promise(queueMicrotask);
  const root = picker.node.children[0].children[0]; root.value = "relationTerminal:owner"; root.dispatch("change"); assert.deepEqual(changes[0].slice(0, 2), ["owner", "relationTerminal"]); assert.equal(childLoads, 0); picker.dispose();
});

test("persisted relation terminals and traversed paths select distinct internal tokens", async () => {
  const trees = new Map([["app.Book", { fields: [], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [{ name: "email", type: "EmailField" }], relations: [] }]]); const service = { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, loadTree(target) { return Promise.resolve(trees.get(`${target.app}.${target.model}`)); } };
  const terminal = createQueryFieldPicker({ allowRelationTerminal: true, current: "owner", el: element, metadata: service, source: { app: "app", model: "Book" } }); await new Promise(queueMicrotask); assert.equal(terminal.node.children[0].children[0].value, "relationTerminal:owner");
  const traversed = createQueryFieldPicker({ allowRelationTerminal: true, current: "owner__email", el: element, metadata: service, source: { app: "app", model: "Book" } }); await new Promise((done) => setImmediate(done)); assert.equal(traversed.node.children[0].children[0].value, "relation:owner"); assert.equal(traversed.node.children[0].children[1].value, "field:email"); terminal.dispose(); traversed.dispose();
});

test("nested relation terminal emits the complete traversed prefix", async () => {
  const trees = new Map([["app.Book", { fields: [], relations: [{ name: "owner", target: "app.User" }] }], ["app.User", { fields: [], relations: [{ name: "group", target: "app.Group" }] }]]); const changes = [];
  const picker = createQueryFieldPicker({ allowRelationTerminal: true, el: element, metadata: { getState(target) { return { tree: trees.get(`${target.app}.${target.model}`) }; }, loadTree(target) { return Promise.resolve(trees.get(`${target.app}.${target.model}`)); } }, onChange: (...args) => changes.push(args), source: { app: "app", model: "Book" } }); await new Promise(queueMicrotask); const root = picker.node.children[0].children[0]; root.value = "relation:owner"; root.dispatch("change"); await new Promise((done) => setImmediate(done)); const child = picker.node.children[0].children[1]; child.value = "relationTerminal:group"; child.dispatch("change"); assert.deepEqual(changes[0].slice(0, 2), ["owner__group", "relationTerminal"]); picker.dispose();
});

test("relation terminal options are absent when relation terminals are disabled", async () => {
  const picker = createQueryFieldPicker({ el: element, metadata: metadata({ fields: [], relations: [{ name: "owner", target: "app.User" }] }), source: { app: "app", model: "Book" } }); await new Promise(queueMicrotask); const select = picker.node.children[0].children[0]; const groups = select.children; assert.equal(groups.some((group) => group.label === "Relationship checks"), false); assert.equal(groups.flatMap((group) => group.children || []).some((option) => String(option.value).startsWith("relationTerminal:")), false); picker.dispose();
});
