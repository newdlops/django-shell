// Tests for viewport-safe Query Builder popover geometry.
import assert from "node:assert/strict";
import test from "node:test";
import { __test, createQueryPopover } from "../media/gridQueryPopover.js";

/** Creates one event target with deterministic listener accounting for portal cleanup coverage. */
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener, capture) { listeners.set(`${type}:${Boolean(capture)}`, listener); },
    dispatch(type, capture = false) { listeners.get(`${type}:${Boolean(capture)}`)?.(); },
    listenerCount() { return listeners.size; },
    removeEventListener(type, _listener, capture) { listeners.delete(`${type}:${Boolean(capture)}`); }
  };
}

/** Creates the minimum document, anchor, and layer objects needed to exercise portal scheduling. */
function popoverFixture() {
  const rootEvents = eventTarget();
  const viewEvents = eventTarget();
  const frames = [];
  const view = {
    ...viewEvents,
    innerHeight: 600,
    innerWidth: 800,
    cancelAnimationFrame: (id) => { frames[id] = undefined; },
    requestAnimationFrame: (work) => { frames.push(work); return frames.length - 1; },
    runFrame() { const work = frames.find(Boolean); if (work) { frames[frames.indexOf(work)] = undefined; work(); } }
  };
  const node = { className: "", getBoundingClientRect: () => ({ height: 180, width: 260 }), hidden: false, remove() { this.removed = true; }, replaceChildren(...children) { this.children = children; }, style: {} };
  const layer = { appendChild(child) { this.child = child; } };
  const root = { ...rootEvents, createElement: () => node, defaultView: view };
  const anchor = { getBoundingClientRect: () => ({ bottom: 120, left: 30, top: 100 }) };
  return { anchor, frames, layer, node, root, view };
}

test("popover chooses available space and clamps to the viewport margin", () => {
  const below = __test.popoverPosition({ bottom: 120, left: 30, top: 100 }, { height: 180, width: 260 }, { height: 600, width: 800 });
  assert.equal(below.top, 120);
  assert.equal(below.left, 30);
  const above = __test.popoverPosition({ bottom: 560, left: 750, top: 540 }, { height: 180, width: 260 }, { height: 600, width: 800 });
  assert.equal(above.top, 360);
  assert.equal(above.left, 532);
});

test("popover batches layout events to one animation frame and releases document listeners", () => {
  const fixture = popoverFixture();
  const reasons = [];
  const popover = createQueryPopover({ anchor: fixture.anchor, layer: fixture.layer, onClose: (reason) => reasons.push(reason), root: fixture.root });

  popover.open({});
  fixture.view.dispatch("resize");
  fixture.root.dispatch("scroll", true);
  assert.equal(fixture.frames.filter(Boolean).length, 1, "a burst produces one reposition frame");
  fixture.view.runFrame();
  assert.equal(fixture.node.style.left, "30px");
  assert.equal(fixture.node.style.top, "120px");
  popover.destroy();
  assert.equal(fixture.root.listenerCount(), 0);
  assert.equal(fixture.view.listenerCount(), 0);
  assert.deepEqual(reasons, ["destroy"]);
  assert.equal(fixture.node.removed, true);
});
