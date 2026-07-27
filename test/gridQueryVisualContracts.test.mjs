// Verifies responsive, theme, zoom-safety, and popup CSS contracts without manual UI control.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const files = ["modelQueryBuilder.css", "modelQueryWorkspace.css", "modelQueryControls.css", "modelQueryPopover.css"];
const css = files.map((file) => fs.readFileSync(new URL(`../media/${file}`, import.meta.url), "utf8")).join("\n");
const popoverCss = fs.readFileSync(new URL("../media/modelQueryPopover.css", import.meta.url), "utf8");

test("Query Builder CSS uses explicit responsive, high-contrast, and reduced-motion contracts", () => {
  assert.match(css, /@media \(max-width:959px\)/);
  assert.match(css, /@media \(max-width:639px\)/);
  assert.match(css, /@media \(forced-colors:active\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /query-focus-mode/);
  assert.match(css, /query-stage-select/);
  assert.match(css, /query-popover.*max-inline-size:calc\(100vw - 16px\)/);
});

test("Query Builder CSS avoids theme-breaking color and transition shortcuts", () => {
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../media/${file}`, import.meta.url), "utf8");
    assert.match(source, /^\/\*[^\n]+\*\//, `${file} needs a purpose comment`);
    assert.doesNotMatch(source, /#[0-9A-Fa-f]{3,8}\b/, `${file} must use VS Code theme tokens instead of hard-coded colors`);
    assert.doesNotMatch(source, /transition\s*:\s*all\b/, `${file} must not animate every property`);
  }
  assert.match(css, /query-drawer-resize:focus-visible/);
  assert.match(popoverCss, /@media \(forced-colors:active\).*query-popover/);
});
