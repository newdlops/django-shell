// Verifies responsive, theme, zoom-safety, and popup CSS contracts without manual UI control.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const files = ["modelQueryBuilder.css", "modelQueryWorkspace.css", "modelQueryControls.css", "modelQueryAssistant.css", "modelQueryPopover.css"];
const css = files.map((file) => fs.readFileSync(new URL(`../media/${file}`, import.meta.url), "utf8")).join("\n");
const popoverCss = fs.readFileSync(new URL("../media/modelQueryPopover.css", import.meta.url), "utf8");

test("Query Builder CSS uses explicit responsive, high-contrast, and reduced-motion contracts", () => {
  assert.match(css, /@media \(max-width:959px\)/);
  assert.match(css, /@media \(max-width:639px\)/);
  assert.match(css, /@media \(forced-colors:active\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /query-focus-mode/);
  assert.match(css, /query-stage-select/);
  assert.match(css, /query-assistant-settings/);
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
  assert.match(css, /query-assistant-actions\{display:flex;flex-wrap:wrap;gap:6px;min-width:0\}/);
  assert.match(css, /query-assistant-panel :focus-visible/);
  assert.match(css, /@media \(max-width:959px\).*query-assistant-actions/s);
  assert.match(css, /@media \(max-width:639px\).*query-assistant-actions/s);
  assert.match(css, /@media \(forced-colors:active\).*query-assistant-panel/s);
  const workspace = fs.readFileSync(new URL("../media/modelQueryWorkspace.css", import.meta.url), "utf8");
  const builder = fs.readFileSync(new URL("../media/modelQueryBuilder.css", import.meta.url), "utf8");
  assert.match(workspace, /query-drawer-resize\{position:relative;height:9px/);
  assert.match(workspace, /touch-action:none/);
  assert.match(workspace, /::before.*height:1px/);
  assert.match(workspace, /CanvasText.*Highlight/);
  assert.match(popoverCss, /@media \(forced-colors:active\).*query-popover/);
});

test("examples strip keeps its compact responsive and forced-color contracts", () => {
  const controls = fs.readFileSync(new URL("../media/modelQueryControls.css", import.meta.url), "utf8");
  assert.match(controls, /\.query-examples\{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 12px;border-bottom:1px solid var\(--vscode-panel-border\);background:var\(--vscode-editorGroupHeader-tabsBackground,var\(--vscode-editor-background\)\);font-size:11px\}/);
  assert.match(controls, /\.query-examples\[hidden\]\{display:none\}/);
  assert.match(controls, /\.query-examples-title\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600\}/);
  assert.match(controls, /\.query-examples-help,\.query-examples-empty\{color:var\(--vscode-descriptionForeground\)\}/);
  assert.match(controls, /\.query-examples-actions\{display:flex;flex:1 1 auto;flex-wrap:wrap;gap:5px;min-width:0\}/);
  assert.match(controls, /\.query-example-action\{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(controls, /\.query-example-action:focus-visible\{outline:1px solid var\(--vscode-focusBorder\);outline-offset:1px\}/);
  assert.match(controls, /@media \(max-width:959px\)\{\.query-examples\{padding-right:8px;padding-left:8px\}\}/);
  assert.match(controls, /@media \(max-width:639px\)\{\.query-examples\{align-items:flex-start;flex-wrap:wrap\}.*\.query-examples-actions,\.query-examples-empty\{flex:1 0 100%\}.*\.query-example-action\{flex:1 1 150px\}\}/);
  assert.match(controls, /@media \(forced-colors:active\)\{\.query-examples\{border-bottom-color:CanvasText\}\.query-example-action:focus-visible\{outline:2px solid Highlight\}\}/);
  const examplesRules = controls.slice(controls.indexOf("/* Compact schema-derived"));
  assert.doesNotMatch(examplesRules, /#[0-9A-Fa-f]{3,8}\b|\brgba?\(|transition:|box-shadow|border-radius/);
  assert.match(fs.readFileSync(new URL("../media/modelQueryBuilder.css", import.meta.url), "utf8"), /grid-template-rows:auto auto minmax\(0,1fr\) auto auto/);
  assert.match(fs.readFileSync(new URL("../media/modelQueryBuilder.css", import.meta.url), "utf8"), /\.query-drawer>\.query-drawer-header\{grid-row:1\}\.query-drawer>\.query-examples\{grid-row:2\}\.query-drawer>\.query-workspace\{grid-row:3\}\.query-drawer>\.query-drawer-footer\{grid-row:4\}\.query-drawer>\.query-drawer-resize\{grid-row:5\}/);
});

test("applied filter chips stay bounded, theme-native, and responsive", () => {
  const builder = fs.readFileSync(new URL("../media/modelQueryBuilder.css", import.meta.url), "utf8");
  const start = builder.indexOf(".query-applied-filter-row");
  const rules = builder.slice(start, builder.indexOf(".query-drawer", start));
  assert.match(builder, /\.query-summary-band\{[^}]*flex-wrap:wrap/);
  assert.match(rules, /\.query-applied-filter-row\{[^}]*flex:1 0 100%[^}]*min-width:0/);
  assert.match(rules, /\.query-applied-filter-row\{[^}]*gap:5px/);
  assert.match(rules, /\.query-applied-filters-label,\.query-applied-filters-empty\{[^}]*color:var\(--vscode-descriptionForeground\)[^}]*font-size:11px/);
  assert.match(rules, /\.query-applied-filters\{[^}]*gap:5px[^}]*flex-wrap:wrap[^}]*min-width:0/);
  assert.match(rules, /\.query-applied-filters\[hidden\]\{display:none\}/);
  assert.match(rules, /\.query-applied-filter-chip\{[^}]*max-width:100%[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);
  assert.match(rules, /border:1px solid var\(--vscode-panel-border\)/);
  assert.match(rules, /border-radius:999px/);
  assert.match(rules, /background:var\(--vscode-editorGroupHeader-tabsBackground,var\(--vscode-editor-background\)\)/);
  assert.match(rules, /color:var\(--vscode-foreground\)/);
  assert.match(rules, /font-family:var\(--vscode-editor-font-family\)/);
  assert.match(builder, /@media \(max-width:639px\)\{[\s\S]*?\.query-applied-filter-row\{order:6\}[\s\S]*?\.query-applied-filters\{flex-basis:100%\}[\s\S]*?\.query-applied-filter-chip\{flex:1 1 100%\}/);
  assert.match(builder, /@media \(forced-colors:active\)\{[\s\S]*?\.query-applied-filter-chip\{border-color:CanvasText;box-shadow:none\}/);
  assert.doesNotMatch(rules, /#[0-9A-Fa-f]{3,8}\b|\brgba?\(|gradient|transition|box-shadow|position:(?:absolute|fixed)|width:\d+px/);
});
