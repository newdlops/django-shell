// Guards the webview asset, landmark, announcement, and responsive-menu contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

/** Reads one repository text asset for structural contract assertions. */
function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("webview builders use CSP-compatible external shared and surface stylesheets", () => {
  const helper = read("src/webviewAssets.ts");
  assert.ok(helper.includes('rel="stylesheet"'), "the helper emits stylesheet link elements");
  assert.ok(helper.includes('webview.asWebviewUri'), "asset URIs remain webview CSP compatible");

  for (const [file, surface] of [
    ["src/customConsoleHtml.ts", "customConsole.css"],
    ["src/modelCatalogHtml.ts", "modelCatalog.css"],
    ["src/modelBrowserHtml.ts", "modelBrowser.css"]
  ]) {
    const source = read(file);
    assert.ok(source.includes('"uiFoundation.css"') && source.includes('"' + surface + '"'), `${file} links the shared and surface styles`);
    assert.equal(source.includes("<style>"), false, `${file} has no inline style block`);
    assert.ok(source.includes('id="politeAnnouncements"'), `${file} has a polite live region`);
    assert.ok(source.includes('id="assertiveAnnouncements"'), `${file} has an assertive live region`);
  }
});

test("model browser chrome preserves primary context and exposes responsive secondary actions", () => {
  const html = read("src/modelBrowserHtml.ts");
  const chrome = read("media/modelBrowserChrome.js");
  const overflow = read("media/uiOverflowMenu.js");
  const css = read("media/modelBrowser.css");

  assert.ok(html.includes('data-overflow-root'), "the header is the responsive overflow boundary");
  assert.ok(html.includes('id="browserOverflowMenu"') && html.includes('role="menu"'), "secondary actions have a semantic popup menu");
  assert.ok(chrome.includes('priority: "secondary"') && chrome.includes('priority: "context"'), "chrome classifies actions by responsive priority");
  assert.ok(overflow.includes("ResizeObserver") && overflow.includes('aria-haspopup'), "overflow reacts to width and has menu semantics");
  assert.ok(overflow.includes('ArrowDown') && overflow.includes('Escape'), "overflow supports keyboard navigation and close");
  assert.ok(css.includes("@media (max-width:959px)") && css.includes("@media (max-width:639px)"), "model browser has compact and narrow breakpoints");
});

test("model and ORM query panels keep distinct identity, query help, recovery, and drawer contracts", () => {
  const html = read("src/modelBrowserHtml.ts");
  const source = read("media/modelBrowserSource.js");
  const surface = read("media/modelBrowserSurface.js");
  const drawer = read("media/modelBrowserLogDrawer.js");
  const queryUi = read("media/queryRunUi.js");

  assert.ok(html.includes('mode: "model" | "query"'), "the builder declares the two supported surfaces");
  assert.ok(html.includes('data-surface="${options.mode}"') && html.includes('options.mode === "query" ? "ORM Query"'), "the title is mode-specific before schema data arrives");
  assert.ok(html.includes('for="queryinput"') && html.includes('id="queryHelp"'), "the query input has a persistent visible label and help text");
  assert.ok(html.includes('id="runQuery" type="button">Run query') && html.includes('id="openQueryConsole"'), "the query primary and interrupt recovery actions have explicit labels");
  assert.ok(html.includes('id="logpanel" hidden'), "new panels keep the query log collapsed");
  assert.ok(source.includes('installModelBrowserChrome(document)') && source.includes('installLogDrawer'), "runtime wires responsive actions and the persisted drawer");
  assert.ok(html.includes('role="separator"') && drawer.includes('ArrowUp') && drawer.includes('shiftKey'), "the Query Log resize handle is semantic and keyboard operable");
  assert.ok(surface.includes('"Retry"') && surface.includes('"Open Django Shell"'), "errors provide explicit recovery actions");
  assert.ok(queryUi.includes("Ready to run a Django ORM query.") && queryUi.includes("Loaded ${rowCount}"), "query lifecycle exposes idle and successful-result status language");
});

test("shared foundation keeps focus, reduced motion, and theme-native status utilities", () => {
  const foundation = read("media/uiFoundation.css");
  assert.ok(foundation.includes(":focus-visible"), "keyboard focus is visible");
  assert.ok(foundation.includes("prefers-reduced-motion:reduce"), "reduced motion is respected");
  assert.ok(foundation.includes("var(--vscode-focusBorder)"), "focus uses VS Code theme tokens");
  assert.ok(foundation.includes(".status-region") && foundation.includes(".error-state"), "status and error utilities are shared");
});

test("wide model grids preserve virtual-column geometry and reset model-specific scroll coordinates", () => {
  const css = read("media/modelBrowser.css");
  const source = read("media/modelBrowserSource.js");
  const html = read("src/modelBrowserHtml.ts");

  assert.match(css, /th,td\{box-sizing:border-box[^}]*max-width:480px/, "cell boxes match the viewport's 480px width ceiling");
  assert.match(css, /\.gridspacer\{[^}]*max-width:none!important/, "virtual spacers are not capped like data cells");
  assert.match(css, /th\.rownum,td\.rownum\{[^}]*width:46px;min-width:46px;max-width:46px/, "the sticky row gutter has one exact geometry");
  assert.match(css, /\.pinned\{[^}]*background-clip:padding-box[^}]*box-shadow:inset -1px 0 0 var\(--vscode-panel-border\)/, "pinned columns paint an opaque boundary over scrolling cells");
  assert.match(css, /th\.rownum,td\.rownum\{[^}]*background-clip:padding-box[^}]*box-shadow:inset -1px 0 0 var\(--vscode-panel-border\)/, "the row-number gutter retains its boundary while scrolling");
  assert.match(source, /if \(!sameModel\) \{[\s\S]*?els\.gridwrap\.scrollLeft = 0;/, "a new model starts at its first field");
  assert.ok(html.includes("font-src data:"), "the webview CSP permits the embedded Codicon font");
});
