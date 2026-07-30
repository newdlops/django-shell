// Tests geometry, accessible input, and cleanup for Query Builder drawer resizing.
import assert from "node:assert/strict";
import test from "node:test";
import { __test, createQueryDrawerResize } from "../media/gridQueryDrawerResize.js";

/** Creates a minimal event target suitable for pointer and keyboard tests. */
function target(height = 0) {
  const listeners = new Map();
  return { children: [], dataset: {}, hidden: false, style: {}, addEventListener(type, listener) { listeners.set(type, listener); }, dispatch(type, event = {}) { listeners.get(type)?.({ preventDefault() {}, ...event }); }, getBoundingClientRect() { return { height }; }, hasPointerCapture(id) { return this.capture === id; }, removeAttribute(name) { delete this.attributes?.[name]; if (name.startsWith("data-")) { delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; } }, removeEventListener(type) { listeners.delete(type); }, setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = String(value); }, setPointerCapture(id) { this.capture = id; }, releasePointerCapture(id) { if (this.capture === id) { this.released = id; this.capture = undefined; } } };
}

/** Creates one fully connected drawer-resizer fixture. */
function fixture({ containerHeight = 900, drawerHidden = false, gridHidden = false } = {}) {
  const root = target();
  const window = target();
  class Observer { constructor(callback) { this.callback = callback; fixtureObserver = this; } disconnect() { this.disconnected = true; } observe(node) { (this.nodes ||= []).push(node); } }
  let fixtureObserver;
  root.defaultView = { ResizeObserver: Observer, addEventListener: window.addEventListener.bind(window), innerHeight: 800, removeEventListener: window.removeEventListener.bind(window) };
  const container = target(containerHeight);
  const drawer = target(360); drawer.hidden = drawerHidden;
  const grid = target(200); grid.hidden = gridHidden;
  const fixed = target(120);
  container.children = [fixed, drawer, grid];
  const handle = target();
  const calls = [];
  const controller = createQueryDrawerResize({ container, drawer, grid, handle, onHeight: (...args) => calls.push(args), root });
  return { calls, container, controller, drawer, grid, handle, observer: () => fixtureObserver, root, window };
}

test("drawer geometry preserves the grid reserve and handles constrained space", () => {
  assert.deepEqual(__test.calculateDrawerBounds({ containerHeight: 900, fixedHeight: 120, gridHidden: false }), { minimumHeight: 220, maximumHeight: 636 });
  assert.deepEqual(__test.calculateDrawerBounds({ containerHeight: 900, fixedHeight: 120, gridHidden: true }), { minimumHeight: 220, maximumHeight: 780 });
  assert.deepEqual(__test.calculateDrawerBounds({ containerHeight: 300, fixedHeight: 120, gridHidden: false }), { minimumHeight: 220, maximumHeight: 220 });
  assert.equal(__test.clampHeight(100, 220, 620), 220);
  assert.equal(__test.clampHeight(900, 220, 620), 620);
  assert.equal(__test.clampHeight(411.6, 220, 620), 412);
});

test("resizer updates ARIA, pointer state, and terminal persistence", () => {
  const view = fixture();
  view.controller.setHeight(360);
  assert.deepEqual(view.handle.attributes, { "aria-valuemax": "636", "aria-valuemin": "220", "aria-valuenow": "360", "aria-valuetext": "360 pixels high" });
  view.handle.dispatch("pointerdown", { button: 0, clientY: 500, pointerId: 7 });
  assert.equal(view.handle.capture, 7);
  view.root.dispatch("pointermove", { clientY: 600, pointerId: 7 });
  assert.equal(view.drawer.style.height, "460px");
  view.root.dispatch("pointermove", { clientY: 700, pointerId: 8 });
  assert.equal(view.drawer.style.height, "460px");
  view.root.dispatch("pointerup", { pointerId: 7 });
  assert.equal(view.handle.released, 7);
  assert.equal(view.calls.at(-1)[1], false);
  assert.equal(view.calls.at(-1)[0], 460);
});

test("matching lost pointer capture ends one active resize without duplicate cleanup", () => {
  const view = fixture();
  view.controller.setHeight(360);
  view.handle.dispatch("pointerdown", { button: 0, clientY: 500, pointerId: 7 });
  view.root.dispatch("pointermove", { clientY: 540, pointerId: 7 });
  const beforeLoss = view.calls.length;
  view.handle.dispatch("lostpointercapture", { pointerId: 8 });
  assert.equal(view.handle.dataset.dragging, "true");
  view.handle.dispatch("lostpointercapture", { pointerId: 7 });
  assert.equal(view.handle.dataset.dragging, undefined);
  assert.equal(view.calls.length, beforeLoss + 1);
  view.handle.dispatch("pointerdown", { button: 0, clientY: 500, pointerId: 9 });
  view.handle.dispatch("lostpointercapture");
  assert.equal(view.handle.dataset.dragging, undefined);
  assert.equal(view.calls.at(-1)[1], false);
  view.handle.dispatch("lostpointercapture", { pointerId: 7 });
  assert.equal(view.calls.length, beforeLoss + 2);
  view.controller.destroy();
  assert.equal(view.calls.length, beforeLoss + 2);
});

test("secondary input, keyboard bounds, observers, and destroy remain fail-safe", () => {
  const view = fixture();
  view.handle.dispatch("pointerdown", { button: 2, clientY: 500, pointerId: 1 });
  assert.equal(view.handle.capture, undefined);
  view.controller.setHeight(360);
  view.handle.dispatch("keydown", { key: "ArrowUp", shiftKey: false });
  assert.equal(view.drawer.style.height, "344px");
  view.handle.dispatch("keydown", { key: "ArrowDown", shiftKey: true });
  assert.equal(view.drawer.style.height, "408px");
  view.handle.dispatch("keydown", { key: "End" });
  assert.equal(view.drawer.style.height, "636px");
  view.container.getBoundingClientRect = () => ({ height: 500 });
  view.observer().callback();
  assert.equal(view.drawer.style.height, "236px");
  view.handle.dispatch("pointerdown", { button: 0, clientY: 500, pointerId: 2 });
  view.controller.destroy();
  assert.equal(view.handle.released, 2);
  assert.equal(view.observer().disconnected, true);
});

test("zero-height containers use the view height and hidden drawers suppress refresh", () => {
  const view = fixture({ containerHeight: 0 });
  view.controller.setHeight(360);
  assert.equal(view.handle.attributes["aria-valuemax"], "536");
  view.drawer.hidden = true;
  view.container.getBoundingClientRect = () => ({ height: 400 });
  view.window.dispatch("resize");
  assert.equal(view.drawer.style.height, "360px");
});
