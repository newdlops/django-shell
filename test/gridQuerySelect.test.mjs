// Tests native Query Builder select normalization and allowlist enforcement.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createQuerySelect, normalizeQuerySelectOptions } from "../media/gridQuerySelect.js";

/** Creates a tiny DOM-like factory for select, group, and option contract tests. */
function element(tag, properties = {}, ...children) {
  const listeners = new Map();
  return { ...properties, children, dataset: properties.dataset || {}, appendChild(child) { this.children.push(child); }, addEventListener(type, listener) { listeners.set(type, listener); }, dispatch(type) { listeners.get(type)?.(); }, focus() { this.focused = true; }, removeEventListener(type) { listeners.delete(type); }, tag };
}

/** Creates DOM-like nodes where a disabled factory property has HTML attribute semantics. */
function attributeSemanticElement(tag, properties = {}, ...children) {
  const { disabled: ignoredDisabled, ...safeProperties } = properties;
  const listeners = new Map();
  return { ...safeProperties, children, dataset: properties.dataset || {}, disabled: Object.hasOwn(properties, "disabled"), appendChild(child) { this.children.push(child); }, addEventListener(type, listener) { listeners.set(type, listener); }, dispatch(type) { listeners.get(type)?.(); }, focus() { this.focused = true; }, removeEventListener(type) { listeners.delete(type); }, tag };
}

test("normalization preserves first values, group order, and unavailable current values", () => {
  const records = normalizeQuerySelectOptions([{ group: "Fields", label: "Name", value: "name" }, { group: "Fields", label: "Duplicate", value: "name" }, { group: "Calculated values", value: "total" }], "missing");
  assert.deepEqual(records.map(({ group, label, value }) => ({ group, label, value })), [{ group: "Fields", label: "Name", value: "name" }, { group: "Calculated values", label: "total", value: "total" }, { group: "Unavailable", label: "Unavailable field: missing", value: "missing" }]);
});

test("native select groups fields, preserves descriptions, and emits valid changes once", () => {
  const changes = [];
  const select = createQuerySelect({ ariaLabel: "Field", dataset: { queryControlKey: "field-1" }, el: element, onChange: (value) => changes.push(value), options: [{ description: "Text", group: "Fields", label: "Name", value: "name" }, { description: "Computed", group: "Calculated values", label: "Total", value: "total" }], value: "total" });
  assert.equal(select.node.tag, "select");
  assert.equal(select.node.dataset.queryControlKey, "field-1");
  assert.equal(select.node.value, "total");
  assert.equal(select.node.title, "Computed");
  assert.deepEqual(select.node.children.map((group) => group.label), ["Fields", "Calculated values"]);
  assert.equal(select.node.children[0].children[0].title, "Text");
  select.node.value = "name"; select.node.dispatch("change");
  assert.deepEqual(changes, ["name"]);
});

test("native disabled properties override attribute-oriented factory semantics", () => {
  const changes = [];
  const select = createQuerySelect({ el: attributeSemanticElement, onChange: (value) => changes.push(value), options: [{ disabled: true, label: "Choose field", value: "" }, { label: "Name", value: "name" }], value: "" });
  const disabledSelect = createQuerySelect({ disabled: true, el: attributeSemanticElement, options: [{ label: "Name", value: "name" }], value: "name" });
  assert.equal(select.node.disabled, false);
  assert.equal(select.node.children[0].disabled, true);
  assert.equal(select.node.children[1].disabled, false);
  assert.equal(disabledSelect.node.disabled, true);
  select.node.value = "name"; select.node.dispatch("change");
  assert.deepEqual(changes, ["name"]);
  select.node.value = ""; select.node.dispatch("change");
  assert.equal(select.node.value, "name");
  assert.deepEqual(changes, ["name"]);
});

test("invalid mutations restore the last valid selection while explicit empty follows allowEmpty", () => {
  const changes = [];
  const select = createQuerySelect({ el: element, onChange: (value) => changes.push(value), options: [{ disabled: true, label: "Disabled", value: "disabled" }, { label: "Choose", value: "" }, { label: "Name", value: "name" }], value: "name" });
  select.node.value = "disabled"; select.node.dispatch("change");
  assert.equal(select.node.value, "name");
  select.node.value = ""; select.node.dispatch("change");
  assert.equal(select.node.value, "name");
  select.node.value = "injected"; select.node.dispatch("change");
  assert.equal(select.node.value, "name");
  assert.deepEqual(changes, []);
  const permissive = createQuerySelect({ allowEmpty: true, el: element, onChange: (value) => changes.push(value), options: [{ label: "Choose", value: "" }, { label: "Name", value: "name" }], value: "name" });
  permissive.node.value = ""; permissive.node.dispatch("change");
  assert.deepEqual(changes, [""]);
});

test("unavailable current values remain disabled and destroy removes only owned behavior", () => {
  const changes = [];
  const select = createQuerySelect({ className: "field-picker", disabled: true, el: element, onChange: (value) => changes.push(value), options: [{ label: "Name", value: "name" }], value: "missing" });
  assert.equal(select.node.className, "query-native-select field-picker");
  assert.equal(select.node.disabled, true);
  assert.equal(select.node.value, "missing");
  assert.equal(select.selectedOption().disabled, true);
  select.focus(); assert.equal(select.node.focused, true);
  select.destroy(); select.node.value = "name"; select.node.dispatch("change");
  assert.deepEqual(changes, []);
});

test("native-select source contract excludes text entry and combobox roles", () => {
  const source = fs.readFileSync(new URL("../media/gridQuerySelect.js", import.meta.url), "utf8");
  assert.match(source, /el\("select"/);
  assert.match(source, /el\("optgroup"/);
  assert.match(source, /el\("option"/);
  assert.doesNotMatch(source, /el\("input"|combobox role/);
});
