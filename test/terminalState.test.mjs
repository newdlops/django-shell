// Unit tests for terminal line tracking and Django REPL mode transitions.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  InputLineTracker,
  detectPrimaryPythonPrompt,
  detectPythonPrompt,
  isDjangoShellCommand,
  nextModeForOutput,
  nextModeForSubmittedLine
} = require("../out/terminalState.js");

test("tracks submitted terminal lines without taking over terminal input", () => {
  const tracker = new InputLineTracker();

  assert.deepEqual(tracker.handleInput("./zz shell\r"), [{ line: "./zz shell" }]);
  assert.equal(tracker.currentLine, "");
});

test("detects common commands that enter django shell", () => {
  assert.equal(isDjangoShellCommand("./zz shell"), true);
  assert.equal(isDjangoShellCommand("python manage.py shell"), true);
  assert.equal(isDjangoShellCommand("python manage.py migrate"), false);
});

test("detects python and ipython repl prompts", () => {
  assert.equal(detectPythonPrompt("banner\r\n>>> "), "python");
  assert.equal(detectPythonPrompt("... "), "python");
  assert.equal(detectPythonPrompt("In [3]: "), "python");
  assert.equal(detectPythonPrompt("\u001b]633;A\u0007>>> \u001b]633;B\u0007"), "python");
  assert.equal(detectPrimaryPythonPrompt("... "), undefined);
  assert.equal(detectPrimaryPythonPrompt("In [3]: "), "python");
  assert.equal(detectPythonPrompt("$ "), undefined);
});

test("moves from terminal shell into django mode after command and prompt", () => {
  const candidate = nextModeForSubmittedLine("shell", "./zz shell");

  assert.equal(candidate, "candidate-django");
  assert.equal(nextModeForOutput(candidate, "Python 3.12\r\n>>> "), "django");
  assert.equal(nextModeForOutput("django", ">>> "), "django");
});

test("returns to shell mode when exiting django repl", () => {
  assert.equal(nextModeForSubmittedLine("django", "exit()"), "shell");
});
