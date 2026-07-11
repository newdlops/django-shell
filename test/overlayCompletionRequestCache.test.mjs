// Unit tests for bounded and latest-only overlay completion loading.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const originalLoad = NodeModule._load;
let OverlayCompletionRequestCache;
let OverlayPythonFeatureBridge;
const vscodeState = { executeCalls: 0, executeHandler: undefined };

/** Minimal position value used by completion range mapping. */
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(lineDelta, characterDelta) { return new Position(this.line + lineDelta, this.character + characterDelta); }
}

/** Minimal range value used by completion range mapping. */
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}

/** Minimal completion item retaining mutable VS Code fields. */
class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}

/** Minimal completion list retaining its completeness flag. */
class CompletionList {
  constructor(items, isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; }
}

/** Minimal text edit used when cloning completion ranges. */
class TextEdit {
  constructor(range, newText) { this.range = range; this.newText = newText; }
}

/** Minimal semantic legend constructed when the feature bridge module loads. */
class SemanticTokensLegend {
  constructor(tokenTypes) { this.tokenTypes = tokenTypes; }
}

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? createVscodeMock() : originalLoad.call(this, request, parent, isMain);
  };
  ({ OverlayCompletionRequestCache } = require("../out/overlayCompletionRequestCache.js"));
  ({ OverlayPythonFeatureBridge } = require("../out/overlayPythonFeatureBridge.js"));
} finally {
  NodeModule._load = originalLoad;
}

test("joins one token-extension load and briefly caches empty results", async () => {
  const cache = new OverlayCompletionRequestCache();
  let loads = 0;
  const first = await cache.provide(fakeDocument("Co"), new Position(0, 2), undefined, async () => {
    loads += 1;
    return [new CompletionItem("Company")];
  });
  const extended = await cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async () => {
    loads += 1;
    return [new CompletionItem("Company")];
  });

  assert.equal(loads, 1);
  assert.equal(first[0].range.end.character, 2);
  assert.equal(extended[0].range.end.character, 7);

  const emptyCache = new OverlayCompletionRequestCache();
  let emptyLoads = 0;
  await emptyCache.provide(fakeDocument("missing"), new Position(0, 7), undefined, async () => { emptyLoads += 1; return []; });
  await emptyCache.provide(fakeDocument("missings"), new Position(0, 8), undefined, async () => { emptyLoads += 1; return []; });
  assert.equal(emptyLoads, 1, "a short negative cache prevents immediate cold-load retries");

  const boundedCache = new OverlayCompletionRequestCache();
  for (let index = 0; index < 24; index += 1) {
    const text = `context_${index} `;
    await boundedCache.provide(fakeDocument(text), new Position(0, text.length), undefined, async () => [new CompletionItem(String(index))]);
  }
  assert.equal(boundedCache.completionCache.size, 16, "large completion arrays remain bounded across a long session");
});

test("runs one completion load at a time and retains only the latest pending context", async () => {
  const cache = new OverlayCompletionRequestCache();
  const activeGate = deferred();
  const latestGate = deferred();
  const calls = { active: 0, middle: 0, latest: 0 };

  const active = cache.provide(fakeDocument("active "), new Position(0, 7), undefined, async () => {
    calls.active += 1;
    return activeGate.promise;
  });
  const middle = cache.provide(fakeDocument("middle "), new Position(0, 7), undefined, async () => {
    calls.middle += 1;
    return [new CompletionItem("middle")];
  });
  const latest = cache.provide(fakeDocument("latest "), new Position(0, 7), undefined, async () => {
    calls.latest += 1;
    return latestGate.promise;
  });
  await nextTurn();

  assert.deepEqual(calls, { active: 1, middle: 0, latest: 0 });
  assert.deepEqual(await middle, [], "a superseded pending request resolves without starting its loader");

  activeGate.resolve([new CompletionItem("active")]);
  await active;
  await nextTurn();
  assert.deepEqual(calls, { active: 1, middle: 0, latest: 1 });

  latestGate.resolve([new CompletionItem("latest")]);
  const latestResult = await latest;
  assert.equal(latestResult[0].label, "latest");
});

test("replaces an active token-extension snapshot before it can sync stale text", async () => {
  const cache = new OverlayCompletionRequestCache();
  const activeGate = deferred();
  const calls = { latest: 0 };

  const active = cache.provide(fakeDocument("Co"), new Position(0, 2), undefined, async (isCurrent) => {
    await activeGate.promise;
    assert.equal(isCurrent(), false, "a longer token supersedes the captured short snapshot");
    return [new CompletionItem("Company")];
  });
  const latest = cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async (isCurrent) => {
    calls.latest += 1;
    assert.equal(isCurrent(), true);
    return [new CompletionItem("Company")];
  });
  await nextTurn();
  assert.equal(calls.latest, 0, "the latest snapshot waits behind the single active provider lane");

  activeGate.resolve();
  assert.deepEqual(await active, []);
  const result = await latest;
  assert.equal(calls.latest, 1);
  assert.equal(result[0].range.end.character, 7);
});

test("starts a fresh same-shape load after completion state is invalidated", async () => {
  const cache = new OverlayCompletionRequestCache();
  const oldGate = deferred();
  const freshGate = deferred();
  let freshLoads = 0;
  const document = fakeDocument("Company");
  const position = new Position(0, 7);

  const oldRequest = cache.provide(document, position, undefined, async () => oldGate.promise);
  cache.clear();
  const freshRequest = cache.provide(document, position, undefined, async () => { freshLoads += 1; return freshGate.promise; });
  await nextTurn();
  assert.equal(freshLoads, 0);

  oldGate.resolve([new CompletionItem("old")]);
  await oldRequest;
  await nextTurn();
  assert.equal(freshLoads, 1);
  freshGate.resolve([new CompletionItem("fresh")]);
  const result = await freshRequest;
  assert.equal(result[0].label, "fresh");
});

test("skips the duplicate analysis bridge without a hidden prelude", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = undefined;
  const emptyDocuments = fakeOverlayDocuments("");
  const emptyBridge = new OverlayPythonFeatureBridge(emptyDocuments);
  const emptyResult = await emptyBridge.provideCompletionItems(fakeDocument("print"), new Position(0, 5), { isCancellationRequested: false }, {});

  assert.deepEqual(emptyResult, []);
  assert.equal(emptyDocuments.syncs, 0);
  assert.equal(vscodeState.executeCalls, 0);

  const preludeDocuments = fakeOverlayDocuments("from app.models import Company\n");
  const preludeBridge = new OverlayPythonFeatureBridge(preludeDocuments);
  await preludeBridge.provideCompletionItems(fakeDocument("pri"), new Position(0, 3), { isCancellationRequested: false }, { triggerCharacter: "." });
  assert.equal(preludeDocuments.syncs, 1);
  assert.equal(vscodeState.executeCalls, 1);
  emptyBridge.dispose();
  preludeBridge.dispose();
});

test("keeps signature help from adding a second hidden-provider load", async () => {
  vscodeState.executeCalls = 0;
  const completionGate = deferred();
  vscodeState.executeHandler = (command) => command === "vscode.executeCompletionItemProvider" ? completionGate.promise : { signatures: [] };
  const documents = fakeOverlayDocuments("from app.models import Company\n");
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("Company.objects.filter(");
  const position = new Position(0, 23);

  const completion = bridge.provideCompletionItems(document, position, { isCancellationRequested: false }, { triggerCharacter: "." });
  await nextTurn();
  const signature = await bridge.provideSignatureHelp(document, position, { isCancellationRequested: false }, { triggerCharacter: "(" });

  assert.equal(signature, undefined);
  assert.equal(vscodeState.executeCalls, 1);
  completionGate.resolve([]);
  await completion;
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

/** Creates a one-line text document with stable file identity. */
function fakeDocument(text) {
  return {
    getText: () => text,
    offsetAt: (position) => position.character,
    positionAt: (offset) => new Position(0, offset),
    uri: { toString: () => "file:///workspace/.django-shell/console-cell.py" }
  };
}

/** Creates the generated-document surface consumed by the overlay feature bridge. */
function fakeOverlayDocuments(prelude) {
  return {
    analysisUri: { toString: () => "file:///workspace/.django-shell/analysis.py" },
    editorUri: { toString: () => "file:///workspace/.django-shell/console-cell.py" },
    inputStartLine: () => 1,
    lineOffset: () => prelude ? 1 : 0,
    preludeText: () => prelude,
    syncs: 0,
    async syncAnalysis() { this.syncs += 1; }
  };
}

/** Creates a deferred promise for deterministic loader overlap. */
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

/** Advances pending promise continuations once. */
function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

/** Returns the VS Code constructors required by completion bridge modules. */
function createVscodeMock() {
  return {
    commands: { async executeCommand(command) { vscodeState.executeCalls += 1; return await vscodeState.executeHandler?.(command) ?? []; } },
    CompletionItem,
    CompletionItemKind: { Property: 9 },
    CompletionList,
    Position,
    Range,
    SemanticTokensLegend,
    TextEdit
  };
}
