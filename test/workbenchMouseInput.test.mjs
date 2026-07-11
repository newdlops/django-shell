// Unit tests for bounded workbench renderer mouse input expressions.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { mainProcessMouseInputExpression } = require("../out/workbenchMouseInput.js");

test("builds a parseable CDP mouse path for one cached workbench window", () => {
  const expression = mainProcessMouseInputExpression(17, [{ x: 12.5, y: 20 }, { x: 30, y: 45.25 }]);

  assert.doesNotThrow(() => Function(`return ${expression}`));
  assert.ok(expression.includes("BrowserWindow.fromId(17)"));
  assert.ok(expression.includes('sendCommand("Input.dispatchMouseEvent"'));
  assert.ok(expression.includes('type: "mouseMoved"'));
  assert.ok(expression.includes('[{"x":12.5,"y":20},{"x":30,"y":45.25}]'));
});

test("bounds invalid coordinates and path length before embedding renderer input", () => {
  const points = Array.from({ length: 40 }, (_item, index) => ({ x: index === 0 ? -50 : index, y: index === 1 ? Number.POSITIVE_INFINITY : index }));
  const expression = mainProcessMouseInputExpression(2, points);
  const embedded = JSON.parse(expression.match(/const points = (\[[^;]+\]);/)?.[1] ?? "[]");

  assert.equal(embedded.length, 32);
  assert.deepEqual(embedded[0], { x: 0, y: 0 });
  assert.deepEqual(embedded[1], { x: 1, y: 0 });
});

test("builds one held-button CDP sequence for a real sash drag", () => {
  const expression = mainProcessMouseInputExpression(9, [
    { action: "down", x: 320, y: 180 },
    { action: "move", x: 280, y: 210 },
    { action: "up", x: 280, y: 210 }
  ]);
  const embedded = JSON.parse(expression.match(/const points = (\[[^;]+\]);/)?.[1] ?? "[]");

  assert.deepEqual(embedded.map((point) => point.action), ["down", "move", "up"]);
  assert.ok(expression.includes('type: "mousePressed"'));
  assert.ok(expression.includes('buttons: pressed ? 1 : 0'));
  assert.ok(expression.includes('type: "mouseReleased"'));
  assert.ok(expression.includes("if (pressed && lastPoint)"), "failed drags must release the left button before debugger detach");
});
