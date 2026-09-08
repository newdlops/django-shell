// Verifies hover E2E input isolation cannot fabricate delivery or leave normal pointer input blocked.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const { installHoverInputGuard } = createRequire(import.meta.url)("./e2e/suite/overlayHoverInputGuard.js");

/** Installs the real guard with observable window listeners and pointer delivery. */
function fixture() {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { if (!listeners.has(type)) { listeners.set(type, new Set()); } listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
  vm.runInNewContext(`(${installHoverInputGuard.toString()})()`, { window });
  return { window, guard: window.__dsoE2eHoverInput,
    emit(type, x, y) {
      const event = { type, clientX: x, clientY: y, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
      for (const listener of listeners.get(type) || []) { listener(event); if (event.stopped) { break; } }
      return event;
    }
  };
}

test("hover guard blocks off-path hardware input while requested native movement still reaches production", () => {
  const { guard, emit } = fixture();
  guard.setPath([{ x: 100, y: 200 }, { x: 120, y: 180 }]);
  assert.equal(emit("mousemove", 700, 500).stopped, true);
  assert.equal(guard.snapshot().pending.length, 1, "ignoring interference must not count as successful input");
  assert.equal(emit("mousemove", 100, 200).stopped, false);
  assert.equal(emit("mousemove", 120, 180).stopped, false);
  assert.equal(guard.snapshot().pending.length, 0);
  assert.equal(guard.snapshot().ignored, 1);
  guard.setPath([{ x: 140, y: 160 }]);
  assert.equal(emit("mouseout", 120, 180).stopped, false, "the prior pointer location can leave normally");
  assert.equal(guard.snapshot().pending.length, 1, "a new path needs new delivery evidence");
  guard.cleanup();
  assert.equal(emit("mousemove", 700, 500).stopped, false);
});

test("hover resize requires actual press and release events, and replacing a guard cleans its old listeners", () => {
  const { window, guard, emit } = fixture();
  guard.setPath([{ x: 100, y: 200, action: "down" }, { x: 140, y: 220, action: "up" }]);
  emit("mousemove", 140, 220);
  assert.equal(guard.snapshot().pending.length, 2);
  assert.equal(emit("mousedown", 100, 200).stopped, false);
  assert.equal(guard.snapshot().pending.length, 1);
  assert.equal(emit("mouseup", 140, 220).stopped, false);
  assert.equal(guard.snapshot().pending.length, 0);
  vm.runInNewContext(`(${installHoverInputGuard.toString()})()`, { window });
  window.__dsoE2eHoverInput.setPath([{ x: 400, y: 300 }]);
  assert.equal(emit("mousemove", 400, 300).stopped, false, "the old guard must not block the new path");
  assert.equal(window.__dsoE2eHoverInput.snapshot().pending.length, 0);
  window.__dsoE2eHoverInput.cleanup();
});
