// Verifies accessible names, ARIA combobox state, modal focus containment, and keyboard resize limits.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createCombobox } from "../media/gridCombobox.js";
import { __test as resize } from "../media/gridResize.js";

/** Creates the small DOM surface needed to exercise the combobox without a browser dependency. */
function testElement(tag, props = {}, ...children) {
  let childNodes = [...children];
  const listeners = new Map();
  const attributes = new Map();
  const node = {
    attributes,
    children: childNodes,
    className: props.className || "",
    dataset: { ...(props.dataset || {}) },
    hidden: false,
    tag,
    value: "",
    addEventListener(name, listener) { listeners.set(name, listener); },
    appendChild(child) { childNodes.push(child); return child; },
    dispatchEvent() { return true; },
    focus() {},
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    select() {},
    setAttribute(name, value) { attributes.set(name, String(value)); }
  };
  Object.assign(node, props);
  Object.defineProperty(node, "innerHTML", { get: () => "", set: () => { childNodes = []; node.children = childNodes; } });
  Object.defineProperty(node, "listeners", { value: listeners });
  return node;
}

/** Invokes a registered keyboard listener with a minimal cancellable event. */
function key(node, value) {
  let prevented = false;
  node.listeners.get("keydown")({ key: value, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  return prevented;
}

test("searchable combobox exposes listbox semantics and tracks its active option", () => {
  const control = createCombobox({ ariaLabel: "Filter field", el: testElement, options: [{ label: "Name", value: "name" }, { label: "Status", value: "status" }] });
  const [input, list] = control.node.children;
  assert.equal(input.role, "combobox");
  assert.equal(input.ariaLabel, "Filter field");
  assert.equal(list.role, "listbox");
  input.listeners.get("focus")();
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(list.children.filter((child) => child.role === "option").length, 2);
  assert.equal(input.getAttribute("aria-activedescendant"), `${list.id}-option-0`);
  assert.equal(key(input, "End"), true);
  assert.equal(input.getAttribute("aria-activedescendant"), `${list.id}-option-1`);
  assert.equal(key(input, "Escape"), true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), undefined);
});

test("column widths clamp to the documented pointer and keyboard range", () => {
  assert.equal(resize.clampWidth(1), 72);
  assert.equal(resize.clampWidth(200.6), 201);
  assert.equal(resize.clampWidth(900), 480);
});

test("filter controls and array editor retain accessible labels and modal focus containment", () => {
  const filterSource = readFileSync(new URL("../media/gridFilter.js", import.meta.url), "utf8");
  const arraySource = readFileSync(new URL("../media/gridArrayEdit.js", import.meta.url), "utf8");
  const browserSource = readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");
  assert.match(filterSource, /ariaLabel: level === 0 \? "Filter field or relation"/);
  assert.match(filterSource, /ariaLabel: "Filter operator"/);
  assert.match(filterSource, /ariaLabel: "Range start"/);
  assert.match(filterSource, /ariaLabel: `Remove value \$\{text\}`/);
  assert.match(arraySource, /aria-modal/);
  assert.match(arraySource, /aria-labelledby/);
  assert.match(arraySource, /button:not\(\[disabled\]\),input:not\(\[disabled\]\)/);
  assert.match(arraySource, /previousFocus\?\.focus\?\.\(\)/);
  assert.match(browserSource, /aria-description", "modified, not committed/);
  assert.match(browserSource, /ariaReadOnly: "false"/);
  assert.match(browserSource, /state\.totalCount === undefined \? "-1" : String\(state\.totalCount \+ 1\)/);
});

test("virtual grid headers and rendered cells retain their logical aria column indices", () => {
  const rendererSource = readFileSync(new URL("../media/gridRenderer.js", import.meta.url), "utf8");
  const browserSource = readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");

  assert.match(rendererSource, /ariaColIndex: "1"/);
  assert.match(rendererSource, /logicalColumnIndices\?\.\[descriptor\.key\]/);
  assert.match(browserSource, /ariaColIndex: "1"/);
  assert.match(browserSource, /setAttribute\("aria-colindex", String\(columnIndex \?\? 1\)\)/);
});
