// Direct unit tests for file-backed shell execution-unit selection and cursor advancement.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const originalLoad = NodeModule._load;

/** Minimal zero-based editor position. */
class Position {
  /** Stores one document position. */
  constructor(line, character) { this.line = line; this.character = character; }
}

/** Minimal range supporting both VS Code constructor overloads. */
class Range {
  /** Stores start and end positions from positions or numeric coordinates. */
  constructor(startOrLine, startOrCharacter, endLine, endCharacter) {
    if (typeof startOrLine === "number") {
      this.start = new Position(startOrLine, startOrCharacter);
      this.end = new Position(endLine, endCharacter);
      return;
    }
    this.start = startOrLine;
    this.end = startOrCharacter;
  }
}

/** Minimal collapsed or expanded editor selection. */
class Selection extends Range {
  /** Stores anchor, active, and range endpoints. */
  constructor(anchor, active) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  /** Returns whether the selection contains no source text. */
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

/** Mutable text document with the subset required by overlay shell helpers. */
class MutableDocument {
  /** Stores one source snapshot. */
  constructor(text) {
    this.text = text;
    this.uri = { toString: () => "file:///workspace/console-cell.py" };
  }

  /** Returns the current number of source lines. */
  get lineCount() { return this.lines().length; }

  /** Returns one line object. */
  lineAt(line) { return { text: this.lines()[line] ?? "" }; }

  /** Returns the whole document or text inside one range. */
  getText(range) {
    if (!range) { return this.text; }
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  /** Replaces one source range. */
  replace(range, replacement) {
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    this.text = this.text.slice(0, start) + replacement + this.text.slice(end);
  }

  /** Splits the current source while preserving a final empty line. */
  lines() { return this.text.split("\n"); }

  /** Converts one document position into a string offset. */
  offsetAt(position) {
    let offset = 0;
    const lines = this.lines();
    for (let line = 0; line < position.line; line += 1) { offset += (lines[line] ?? "").length + 1; }
    return offset + position.character;
  }
}

const commandCalls = [];
const vscodeMock = {
  commands: { executeCommand: async (...args) => { commandCalls.push(args); }, registerCommand: () => ({ dispose() {} }) },
  Position,
  Range,
  Selection,
  TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  window: {},
  workspace: { applyEdit: async () => false, getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
  WorkspaceEdit: class WorkspaceEdit {
    /** Creates an empty edit collection. */
    constructor() { this.size = 0; }

    /** Records that one replacement was requested. */
    replace() { this.size += 1; }
  }
};

let advanceAfterRun;
let executionPayload;
let nextInputUnitLine;
let OverlayShellCommandController;
try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? vscodeMock : originalLoad.call(this, request, parent, isMain);
  };
  ({ advanceAfterRun, executionPayload, nextInputUnitLine, OverlayShellCommandController } = require("../out/overlayShellCommand.js"));
} finally {
  NodeModule._load = originalLoad;
}

test("selects strict execution units in arbitrary lower then upper cursor order", () => {
  const document = new MutableDocument("upper_draft = 1\n\n\nlower_first = 2");
  const lower = executionPayload(document, collapsedSelection(3), 0);
  const upper = executionPayload(document, collapsedSelection(0), 0);

  assert.deepEqual({ code: lower.code, end: lower.end, start: lower.start }, { code: "lower_first = 2", end: 3, start: 3 });
  assert.deepEqual({ code: upper.code, end: upper.end, start: upper.start }, { code: "upper_draft = 1", end: 0, start: 0 });
});

test("returns an empty payload on either line of a strict blank separator", () => {
  const document = new MutableDocument("upper = 1\n\n\nlower = 2");

  for (const line of [1, 2]) {
    const payload = executionPayload(document, collapsedSelection(line), 0);
    assert.equal(payload.code, "");
    assert.deepEqual({ end: payload.end, start: payload.start }, { end: line, start: line });
  }
});

test("moves to the next existing execution unit without editing source", async () => {
  const document = new MutableDocument("upper = 1\n\n\n    lower = 2");
  const editor = fakeEditor(document, 0);

  assert.equal(nextInputUnitLine(document, 0), 3);
  await advanceAfterRun(editor, 0);

  assert.equal(document.getText(), "upper = 1\n\n\n    lower = 2");
  assert.equal(editor.editCalls, 0);
  assert.deepEqual(editor.selection.active, new Position(3, 4));
});

test("appends a triple newline after the final execution unit", async () => {
  const document = new MutableDocument("only = 1");
  const editor = fakeEditor(document, 0);

  assert.equal(nextInputUnitLine(document, 0), undefined);
  await advanceAfterRun(editor, 0);

  assert.equal(document.getText(), "only = 1\n\n\n");
  assert.equal(editor.editCalls, 1);
  assert.deepEqual(editor.selection.active, new Position(3, 0));
});

test("leaves editor text untouched when a restart cancels an in-flight execution", async () => {
  const document = new MutableDocument("value = slow_call()\n");
  const editor = fakeEditor(document, 0);
  const documents = { editorUri: document.uri, inputStartLine: () => 0, sync: async () => undefined };
  const controller = new OverlayShellCommandController(documents, async () => undefined, undefined, { registerCommands: false });
  commandCalls.length = 0;
  vscodeMock.window.activeTextEditor = editor;

  await controller.acceptInput();

  assert.equal(document.getText(), "value = slow_call()\n");
  assert.equal(editor.editCalls, 0);
  assert.deepEqual(commandCalls, []);
  controller.dispose();
  vscodeMock.window.activeTextEditor = undefined;
});

/** Creates one collapsed selection on a source line. */
function collapsedSelection(line, character = 0) {
  const position = new Position(line, character);
  return new Selection(position, position);
}

/** Creates a mutable editor that applies replacements synchronously. */
function fakeEditor(document, line) {
  const editor = {
    document,
    editCalls: 0,
    selection: collapsedSelection(line),
    async edit(callback) {
      this.editCalls += 1;
      const replacements = [];
      callback({ replace(range, text) { replacements.push({ range, text }); } });
      for (const replacement of replacements.reverse()) { document.replace(replacement.range, replacement.text); }
      return true;
    },
    revealRange(range, revealType) { this.lastReveal = { range, revealType }; }
  };
  return editor;
}
