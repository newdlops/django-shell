// Verifies bounded native mouse sequences and failed-drag cleanup for the isolated E2E workbench.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { mainProcessMouseInputExpression } = require("../out/workbenchMouseInput.js");

/** Runs the generated main-process expression against observable Electron window/input contracts. */
async function dispatch(points, { failMove = false, missing = false } = {}) {
  const events = [], selected = [], focus = [];
  const win = { isDestroyed: () => false, show: () => focus.push("show"), focus: () => focus.push("window"), webContents: {
    isDestroyed: () => false, focus: () => focus.push("contents"),
    sendInputEvent: (event) => { events.push(event); if (failMove && event.type === "mouseMove") { throw new Error("controlled input failure"); } },
    get debugger() { throw new Error("native input must not wait for renderer debugger acknowledgements"); }
  } };
  const electron = { app: { focus: () => focus.push("app") }, BrowserWindow: { fromId: (id) => { selected.push(id); return missing ? undefined : win; } } };
  const result = await Function("require", "setTimeout", `return ${mainProcessMouseInputExpression(17, points)}`)(() => electron, (callback) => callback());
  return { events, selected, focus, result };
}

test("native pointer input targets only the cached window and focuses it before dispatch", async () => {
  const f = await dispatch([{ x: 12.5, y: 20 }, { x: 30, y: 45.25 }]);
  assert.deepEqual(f.selected, [17]);
  assert.deepEqual(f.focus, ["app", "show", "window", "contents"]);
  assert.deepEqual(f.events, [{ type: "mouseMove", x: 13, y: 20 }, { type: "mouseMove", x: 30, y: 45 }]);
  assert.deepEqual(f.result, { ok: true, points: [{ x: 13, y: 20 }, { x: 30, y: 45 }] });
});

test("bounds invalid coordinates and path length before sending native input", async () => {
  const f = await dispatch(Array.from({ length: 40 }, (_item, index) => ({ x: index === 0 ? -50 : index, y: index === 1 ? Infinity : index })));
  assert.equal(f.events.length, 32);
  assert.deepEqual(f.result.points.slice(0, 2), [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
});

test("a native sash drag retains the pressed button until mouseup", async () => {
  const f = await dispatch([{ action: "down", x: 320, y: 180 }, { action: "move", x: 280, y: 210 }, { action: "up", x: 280, y: 210 }]);
  assert.deepEqual(f.events.map((event) => event.type), ["mouseDown", "mouseMove", "mouseUp"]);
  assert.deepEqual(f.events[1].modifiers, ["leftbuttondown"]);
  assert.equal(f.events[2].modifiers, undefined);
  assert.equal(f.result.ok, true);
});

test("a failed native drag releases its button and reports the original error", async () => {
  const f = await dispatch([{ action: "down", x: 20, y: 20 }, { action: "move", x: 40, y: 40 }], { failMove: true });
  assert.equal(f.result.ok, false);
  assert.match(f.result.error, /controlled input failure/);
  assert.deepEqual(f.events.at(-1), { button: "left", clickCount: 1, type: "mouseUp", x: 40, y: 40 });
});

test("a missing workbench never receives input", async () => {
  const f = await dispatch([{ x: 20, y: 20 }], { missing: true });
  assert.equal(f.result.reason, "missing-workbench-window");
  assert.deepEqual(f.events, []);
});
