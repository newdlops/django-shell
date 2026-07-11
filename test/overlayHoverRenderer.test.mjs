// Behavioral tests for detached overlay hover pointer handoff.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayCleanupRendererSource } = require("../out/workbenchOverlayCleanupRenderer.js");
const { overlayHoverRendererSource } = require("../out/workbenchOverlayHoverRenderer.js");
const { overlayWidgetRendererSource } = require("../out/workbenchOverlayWidgetRenderer.js");

test("keeps a native hover open from editor leave through detached portal entry", () => {
  const harness = createHoverHarness();
  assert.equal(harness.install(), "installed");

  harness.scheduleNativeDismiss();
  harness.editorNode.dispatch("mouseleave", {});
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true);
  assert.equal(harness.controller.cancelSchedulerCalls, 1);
  assert.equal(harness.clock.pending(), 1, "holding cancels the earlier native recompute and leaves only the transit deadline");
  assert.equal(harness.controller.hideCalls, 0);

  harness.portal.dispatch("mouseover", { target: harness.hoverChild });
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true);
  assert.equal(harness.clock.pending(), 0, "entering the hover cancels the transit deadline");
  harness.clock.runNext();
  assert.equal(harness.controller.hideCalls, 0, "a stale native recompute cannot dismiss the entered hover");

  harness.portal.dispatch("mouseout", { relatedTarget: harness.hoverSibling, target: harness.hoverChild });
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true, "moving inside the hover subtree stays held");
  assert.equal(harness.controller.hideCalls, 0);

  harness.portal.dispatch("mouseout", { relatedTarget: harness.outsideNode, target: harness.hoverChild });
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, false);
  assert.equal(harness.controller.hideCalls, 1);
});

test("releases detached hover ownership on editor return, timeout, and hidden DOM", () => {
  const harness = createHoverHarness();
  harness.install();

  harness.editorNode.dispatch("mouseleave", {});
  harness.portal.dispatch("mouseover", { target: harness.hoverChild });
  harness.portal.dispatch("mouseout", { relatedTarget: harness.editorChild, target: harness.hoverChild });
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, false);
  assert.equal(harness.controller.hideCalls, 0, "returning to the editor leaves dismissal to Monaco");

  harness.editorNode.dispatch("mouseleave", {});
  harness.clock.runNext();
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, false);
  assert.equal(harness.controller.hideCalls, 1, "an abandoned handoff is dismissed after the bounded grace period");
  harness.portal.dispatch("mouseout", { relatedTarget: harness.outsideNode, target: harness.hoverChild });
  assert.equal(harness.controller.hideCalls, 1, "a late portal leave cannot dismiss without an active keeper lease");

  harness.editorNode.dispatch("mouseleave", {});
  harness.hover.hidden = true;
  harness.observers.at(-1).notify();
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, false);
  assert.equal(harness.clock.pending(), 0);
});

test("keeps the detached hover visible throughout an enabled sash drag", () => {
  const harness = createHoverHarness();
  harness.install();
  harness.editorNode.dispatch("mouseleave", {});
  harness.portal.dispatch("mouseover", { target: harness.hoverChild });

  harness.portal.dispatch("mousedown", { button: 0, target: harness.hoverSash });
  assert.equal(harness.root.__dsoDetachedHoverResizeActive, true);
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true);

  harness.portal.dispatch("mouseout", { relatedTarget: harness.outsideNode, target: harness.hoverSash });
  const wrapperLeave = createPropagationEvent({ target: harness.hover });
  harness.portal.dispatch("mouseleave", wrapperLeave);
  assert.equal(wrapperLeave.propagationStopped, true, "native wrapper mouseleave must not bypass the resize guard");
  assert.equal(harness.controller.hideCalls, 0);
  assert.equal(harness.root.__dsoDetachedHoverHeld, true);

  harness.hover.hidden = true;
  harness.observers.at(-1).notify();
  assert.equal(harness.root.__dsoDetachedHoverHeld, true, "transient resize layout mutations keep the lease");
  harness.hover.hidden = false;

  harness.windowTarget.dispatch("mouseup", { target: harness.outsideNode });
  assert.equal(harness.root.__dsoDetachedHoverResizeActive, true, "native sash mouseup runs before deferred release");
  harness.clock.runNext();
  assert.equal(harness.root.__dsoDetachedHoverResizeActive, false);
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, false);
  assert.equal(harness.controller.hideCalls, 0, "finishing a drag outside does not immediately dismiss the resized hover");

  harness.portal.dispatch("mouseover", { target: harness.hoverChild });
  harness.portal.dispatch("mouseout", { relatedTarget: harness.outsideNode, target: harness.hoverChild });
  assert.equal(harness.controller.hideCalls, 1, "a later ordinary hover leave still dismisses normally");
});

test("cleans up listeners without stacking installs or clobbering prior controller state", () => {
  const harness = createHoverHarness({ initialKeepOpen: true });
  assert.equal(harness.install(), "installed");
  const counts = { editor: harness.editorNode.listenerCount(), portal: harness.portal.listenerCount() };
  assert.equal(harness.install(), "already-installed");
  assert.deepEqual({ editor: harness.editorNode.listenerCount(), portal: harness.portal.listenerCount() }, counts);

  harness.editorNode.dispatch("mouseleave", {});
  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true);
  harness.clock.runNext();
  assert.equal(harness.controller.hideCalls, 0, "a pre-existing keeper remains responsible for dismissal");
  harness.editorNode.dispatch("mouseleave", {});
  harness.portal.dispatch("mouseover", { target: harness.hoverChild });
  harness.portal.dispatch("mousedown", { button: 0, target: harness.hoverSash });
  harness.root.__dsoDetachedHoverKeeperCleanup();

  assert.equal(harness.controller.shouldKeepOpenOnEditorMouseMoveOrLeave, true, "cleanup restores the value owned before handoff");
  assert.equal(harness.root.__dsoDetachedHoverResizeActive, false);
  assert.equal(harness.editorNode.listenerCount(), 0);
  assert.equal(harness.portal.listenerCount(), 0);
  assert.equal(harness.windowTarget.listenerCount(), 0);
  assert.equal(harness.observers.at(-1).disconnected, true);
});

test("wires the detached hover keeper into widget configuration and overlay cleanup", () => {
  const widgetSource = overlayWidgetRendererSource();
  const cleanupSource = overlayCleanupRendererSource();

  assert.ok(widgetSource.includes("window.__dsoInstallDetachedHoverKeeper(root, editor)"));
  assert.ok(widgetSource.includes(".monaco-resizable-hover"));
  assert.ok(widgetSource.includes(".monaco-sash.disabled"));
  assert.ok(!widgetSource.includes(".monaco-resizable-hover *"), "disabled native sashes must retain pointer-events:none");
  assert.ok(cleanupSource.includes("root.__dsoDetachedHoverKeeperCleanup && root.__dsoDetachedHoverKeeperCleanup()"));
});

/** Creates an isolated generated-renderer harness with fake DOM event targets and timers. */
function createHoverHarness(options = {}) {
  const clock = createClock();
  const observers = [];
  let nativeDismissTimer = 0;
  const hover = createHoverNode();
  const hoverChild = { closest: () => hover };
  const hoverSibling = { closest: () => hover };
  const hoverSash = { closest: (selector) => selector.includes("monaco-sash") ? hoverSash : hover };
  const outsideNode = { closest: () => null };
  const editorChild = { closest: () => null };
  const portal = createEventTarget({
    contains: (node) => node === hover,
    dataset: { djangoShellOverlayOwner: "owner-a" },
    isConnected: true,
    querySelectorAll: () => [hover]
  });
  const editorNode = createEventTarget({ contains: (node) => node === editorChild });
  const controller = {
    cancelSchedulerCalls: 0,
    hideCalls: 0,
    _cancelScheduler() {
      this.cancelSchedulerCalls += 1;
      if (nativeDismissTimer) { clock.clearTimeout(nativeDismissTimer); nativeDismissTimer = 0; }
    },
    hideContentHover() { this.hideCalls += 1; },
    shouldKeepOpenOnEditorMouseMoveOrLeave: options.initialKeepOpen ?? false
  };
  const editor = {
    getContribution(id) { return id === "editor.contrib.contentHover" ? controller : null; },
    getDomNode: () => editorNode,
    trigger() { controller.hideCalls += 1; }
  };
  const root = { __dsoOwnerToken: "owner-a", __dsoWidgetRoot: portal };
  hover.contains = (node) => node === hoverSash;
  const windowTarget = createEventTarget({
    clearTimeout: clock.clearTimeout,
    getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
    setTimeout: clock.setTimeout
  });

  /** Records and manually exposes one generated MutationObserver callback. */
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    disconnect() { this.disconnected = true; }
    notify() { this.callback([]); }
    observe() {}
  }

  const source = overlayHoverRendererSource();
  const api = Function("window", "MutationObserver", `${source}\nreturn { install: window.__dsoInstallDetachedHoverKeeper };`)(windowTarget, FakeMutationObserver);
  /** Schedules the same stale recompute that Monaco can leave pending before editor mouseleave. */
  const scheduleNativeDismiss = () => {
    nativeDismissTimer = clock.setTimeout(() => { nativeDismissTimer = 0; controller.hideContentHover(); });
  };
  return { clock, controller, editorChild, editorNode, hover, hoverChild, hoverSash, hoverSibling, install: () => api.install(root, editor), observers, outsideNode, portal, root, scheduleNativeDismiss, windowTarget };
}

/** Creates a hover-shaped fake element with mutable visibility. */
function createHoverNode() {
  const node = {
    classList: { contains: (name) => name === "hidden" && node.hidden },
    closest: () => node,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ height: 120, width: 320 }),
    hidden: false,
    isConnected: true
  };
  return node;
}

/** Creates an event target that records capture listeners and can dispatch them deterministically. */
function createEventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(type, callback, capture) {
      const entries = listeners.get(type) ?? [];
      entries.push({ callback, capture });
      listeners.set(type, entries);
    },
    dispatch(type, event) {
      for (const entry of listeners.get(type) ?? []) { entry.callback(event); }
    },
    listenerCount() { return [...listeners.values()].reduce((total, entries) => total + entries.length, 0); },
    removeEventListener(type, callback, capture) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
    }
  };
}

/** Creates a fake DOM event that records capture propagation cancellation. */
function createPropagationEvent(properties = {}) {
  return {
    ...properties,
    propagationStopped: false,
    stopPropagation() { this.propagationStopped = true; }
  };
}

/** Creates a deterministic timeout queue for the renderer state machine. */
function createClock() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    clearTimeout(id) { callbacks.delete(id); },
    pending: () => callbacks.size,
    runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) { return; }
      callbacks.delete(entry[0]);
      entry[1]();
    },
    setTimeout(callback) { const id = nextId++; callbacks.set(id, callback); return id; }
  };
}
