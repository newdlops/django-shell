// Runtime and source contracts for paused inline values in native source editors.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const navigationSource = fs.readFileSync(new URL("../src/debugFrameNavigation.ts", import.meta.url), "utf8");
const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const mockState = { decorationTypes: [], decorationWrites: [], showCalls: [] };
const vscodeMock = createVscodeMock();
const originalLoad = NodeModule._load;
let navigation;

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? vscodeMock : originalLoad.call(this, request, parent, isMain);
  };
  navigation = require("../out/debugFrameNavigation.js");
} finally {
  NodeModule._load = originalLoad;
}

test("external source inlays render at EOL and refresh enriched values without reopening the document", async () => {
  assert.equal(typeof navigation.refreshExternalDebugFrameDecoration, "function", "navigation exposes a no-reveal decoration refresh path");
  assert.match(navigationSource, /import\s*\{[^}]*debugInlineValueText[^}]*\}\s*from\s*["']\.\/debugInlineValues["']/s);
  assert.ok(navigationSource.includes("debugInlineValueText(info.scopes)"), "native editors reuse the overlay's bounded and filtered value formatter");

  const info = pausedFrame("/workspace/payroll/service.py", 4, "count", "1");
  assert.equal(await navigation.revealExternalDebugFrame(info), true);
  assert.equal(mockState.showCalls.length, 1);

  const write = latestNonEmptyDecorationWrite();
  const option = write.decorations[0];
  assert.equal(option.range.start.line, 3);
  assert.equal(option.range.start.character, mockState.sourceLines[3].length, "inline values attach to the source line end, not the paused column");
  assert.equal(option.range.end.character, mockState.sourceLines[3].length);
  assert.match(option.renderOptions.after.contentText, /count\s*=\s*1/);

  const renderOptions = mockState.decorationTypes[0].options.after;
  assert.equal(renderOptions.color.id, "editor.inlineValuesForeground");
  assert.equal(renderOptions.backgroundColor.id, "editor.inlineValuesBackground");
  assert.match(renderOptions.fontStyle, /italic/);

  const initialShowCount = mockState.showCalls.length;
  const refreshed = navigation.refreshExternalDebugFrameDecoration(pausedFrame("/workspace/payroll/service.py", 4, "count", "2"));
  assert.equal(await Promise.resolve(refreshed), true);
  assert.equal(mockState.showCalls.length, initialShowCount, "enriched scope values must not call showTextDocument again");
  const refreshedOption = latestNonEmptyDecorationWrite().decorations[0];
  assert.match(refreshedOption.renderOptions.after.contentText, /count\s*=\s*2/);
  assert.doesNotMatch(refreshedOption.renderOptions.after.contentText, /count\s*=\s*1/);

  navigation.clearExternalDebugFrameDecoration();
  assert.deepEqual(mockState.decorationWrites.at(-1).decorations, []);
});

test("realpath-expanded Python pseudo sources are never opened as workspace files", async () => {
  const showCount = mockState.showCalls.length;
  const pseudoFrame = pausedFrame("/workspace/<django-shell-backend>", 1700, "source", "backend");

  assert.equal(await navigation.revealExternalDebugFrame(pseudoFrame), false);
  assert.equal(navigation.refreshExternalDebugFrameDecoration(pseudoFrame), false);
  assert.equal(mockState.showCalls.length, showCount);
});

test("same-location refresh runs before presentation dedupe and terminal states clear native inlays", () => {
  const body = customConsoleSource.slice(customConsoleSource.indexOf("private postDebugInfo(info"), customConsoleSource.indexOf("private async inspectDebugVariableChildren"));
  const refresh = body.indexOf("refreshExternalDebugFrameDecoration(info)");
  const duplicateGuard = body.indexOf("presentationKey === this.lastDebugPresentationKey");
  const reveal = body.indexOf("revealExternalDebugFrame(info, this.logger)");
  const nonPaused = body.slice(body.indexOf('if (info.state !== "paused")'), body.indexOf("const path ="));

  assert.ok(refresh >= 0 && refresh < duplicateGuard, "same-line enriched scopes refresh before location-only navigation dedupe returns");
  assert.ok(reveal > duplicateGuard, "only a new frame location performs source navigation");
  assert.ok(nonPaused.includes("clearExternalDebugFrameDecoration()"), "idle/error states clear line and inline decorations");
});

/** Creates one paused external-frame payload with a single local value. */
function pausedFrame(path, line, name, value) {
  return { frame: { column: 2, line, path }, scopes: [{ name: "Locals", variables: [{ name, value }] }], state: "paused" };
}

/** Returns the latest native-editor decoration write that carries a rendered range. */
function latestNonEmptyDecorationWrite() {
  const write = mockState.decorationWrites.findLast((entry) => entry.decorations.length > 0);
  assert.ok(write, "expected a non-empty native editor decoration");
  return write;
}

/** Creates the minimal VS Code surface used by debug-frame navigation. */
function createVscodeMock() {
  class Position {
    /** Stores a zero-based editor position. */
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Range {
    /** Stores a start and end editor position. */
    constructor(start, end) { this.start = start; this.end = end; }
  }
  class Selection extends Range {}
  class ThemeColor {
    /** Stores a VS Code theme token identifier. */
    constructor(id) { this.id = id; }
  }
  mockState.sourceLines = ["def calculate():", "    count = 0", "    count += 1", "    return count", ""];
  const editor = {
    document: {
      lineAt(line) { const text = mockState.sourceLines[line] ?? ""; return { range: new Range(new Position(line, 0), new Position(line, text.length)), text }; },
      uri: { fsPath: "/workspace/payroll/service.py" }
    },
    setDecorations(decorationType, decorations) { mockState.decorationWrites.push({ decorationType, decorations }); }
  };
  return {
    OverviewRulerLane: { Center: 2 },
    Position,
    Range,
    Selection,
    ThemeColor,
    Uri: {
      file(fsPath) { return { fsPath }; },
      parse(value) { return { fsPath: value.replace(/^file:\/\//, "") }; }
    },
    ViewColumn: { Active: 1 },
    window: {
      createTextEditorDecorationType(options) { const type = { options }; mockState.decorationTypes.push(type); return type; },
      async showTextDocument(uri, options) { mockState.showCalls.push({ options, uri }); editor.document.uri = uri; return editor; }
    }
  };
}
