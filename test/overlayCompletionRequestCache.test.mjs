// Unit tests for bounded and latest-only overlay completion loading.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const originalLoad = NodeModule._load;
let OverlayCompletionRequestCache;
let OverlayPythonFeatureBridge;
let overlayPythonFeatureBridgeTest;
const vscodeState = { executeCalls: 0, executeHandler: undefined, selectors: [] };

/** Minimal position value used by completion range mapping. */
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(lineDelta, characterDelta) { return new Position(this.line + lineDelta, this.character + characterDelta); }
}

/** Minimal range value used by completion range mapping. */
class Range {
  constructor(startOrLine, startCharacterOrEnd, endLine, endCharacter) {
    if (typeof startOrLine === "number") {
      this.start = new Position(startOrLine, startCharacterOrEnd);
      this.end = new Position(endLine, endCharacter);
      return;
    }
    this.start = startOrLine;
    this.end = startCharacterOrEnd;
  }
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

/** Minimal event emitter used by semantic-token invalidation. */
class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  dispose() {}
  fire() {}
}

/** Minimal semantic legend constructed when the feature bridge module loads. */
class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers = []) { this.tokenModifiers = tokenModifiers; this.tokenTypes = tokenTypes; }
}

/** Minimal semantic-token result used by forwarding tests. */
class SemanticTokens {
  constructor(data, resultId) { this.data = data; this.resultId = resultId; }
}

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? createVscodeMock() : originalLoad.call(this, request, parent, isMain);
  };
  ({ OverlayCompletionRequestCache } = require("../out/overlayCompletionRequestCache.js"));
  ({ OverlayPythonFeatureBridge, __test: overlayPythonFeatureBridgeTest } = require("../out/overlayPythonFeatureBridge.js"));
} finally {
  NodeModule._load = originalLoad;
}

test("reloads token extensions and only caches an exact empty request", async () => {
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

  assert.equal(loads, 2);
  assert.equal(first[0].range.end.character, 2);
  assert.equal(extended[0].range.end.character, 7);

  const emptyCache = new OverlayCompletionRequestCache();
  let emptyLoads = 0;
  await emptyCache.provide(fakeDocument("missing"), new Position(0, 7), undefined, async () => { emptyLoads += 1; return []; });
  await emptyCache.provide(fakeDocument("missings"), new Position(0, 8), undefined, async () => { emptyLoads += 1; return []; });
  assert.equal(emptyLoads, 2, "a longer token cannot reuse an empty short-prefix result");

  const boundedCache = new OverlayCompletionRequestCache();
  for (let index = 0; index < 24; index += 1) {
    const text = `context_${index} `;
    await boundedCache.provide(fakeDocument(text), new Position(0, text.length), undefined, async () => [new CompletionItem(String(index))]);
  }
  assert.equal(boundedCache.completionCache.size, 16, "large completion arrays remain bounded across a long session");
});

test("does not cache incomplete completion lists at an exact token", async () => {
  const cache = new OverlayCompletionRequestCache();
  let loads = 0;
  const document = fakeDocument("AutoImportedClient");
  const position = new Position(0, 18);
  const load = async () => {
    loads += 1;
    return new CompletionList([new CompletionItem("AutoImportedClient")], true);
  };

  await cache.provide(document, position, undefined, load);
  await cache.provide(document, position, undefined, load);

  assert.equal(loads, 2);
});

test("waits for the latest slow completion instead of losing the result at the final character", async () => {
  const cache = new OverlayCompletionRequestCache();
  const document = fakeDocument("AutoImportedClient");
  const position = new Position(0, 18);

  const result = await cache.provide(document, position, undefined, async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return [new CompletionItem("AutoImportedClient")];
  });

  assert.equal(result[0].label, "AutoImportedClient");
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

test("routes an isolated shell language through full-source analysis without a runtime prelude", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = (command) => command === "vscode.executeCompletionItemProvider" ? [new CompletionItem("focused_name")] : [];
  const documents = fakeOverlayDocuments("");
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("focused_na", "django-shell-python");

  const result = await bridge.provideCompletionItems(document, new Position(0, 10), { isCancellationRequested: false }, { triggerCharacter: "." });

  assert.equal(documents.syncs, 1);
  assert.equal(vscodeState.executeCalls, 1);
  assert.deepEqual(result.map((item) => item.label), ["focused_name"]);
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("does not retry a partial identifier when the exact query already returns a prefix match", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = (command) => command === "vscode.executeCompletionItemProvider" ? [new CompletionItem("AutoImportedClient")] : [];
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments(""));
  const document = fakeDocument("client = AutoImportedCli", "django-shell-python");

  const result = await bridge.provideCompletionItems(document, new Position(0, 24), { isCancellationRequested: false }, {});

  assert.equal(vscodeState.executeCalls, 1);
  assert.equal(result[0].label, "AutoImportedClient");
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("registers only the isolated language for shell files and Python for query files", () => {
  vscodeState.selectors.length = 0;
  const shell = new OverlayPythonFeatureBridge(fakeOverlayDocuments(""));
  shell.activate();
  assert.equal(vscodeState.selectors.length, 6);
  assert.ok(vscodeState.selectors.every((selector) => selector.length === 1 && selector[0].language === "django-shell-python"));
  shell.dispose();

  vscodeState.selectors.length = 0;
  const queryDocuments = fakeOverlayDocuments("");
  queryDocuments.editorUri = { fsPath: "/workspace/.django-shell/query-cell.py", toString: () => "file:///workspace/.django-shell/query-cell.py" };
  const query = new OverlayPythonFeatureBridge(queryDocuments);
  query.activate();
  assert.equal(vscodeState.selectors.length, 6);
  assert.ok(vscodeState.selectors.every((selector) => selector.length === 1 && selector[0].language === "python"));
  query.dispose();
});

test("registers semantic forwarding only for the isolated shell language", async () => {
  vscodeState.selectors.length = 0;
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments(""));

  bridge.activate();
  await nextTurn();

  assert.equal(vscodeState.selectors.length, 7);
  assert.deepEqual(vscodeState.selectors[6], [{ language: "django-shell-python", pattern: "**/.django-shell/console-cell.py", scheme: "file" }]);
  bridge.dispose();
});

test("forwards hidden Pylance semantic tokens onto visible user lines", async () => {
  vscodeState.executeHandler = (command) => command === "vscode.provideDocumentSemanticTokens"
    ? new SemanticTokens(Uint32Array.from([0, 0, 4, 1, 0, 1, 0, 5, 2, 8]), "semantic-result")
    : [];
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments("from hidden import Name\n"));

  const result = await bridge.provideDocumentSemanticTokens(fakeDocument("value = 1", "django-shell-python"), { isCancellationRequested: false });

  assert.deepEqual([...result.data], [0, 0, 5, 2, 8]);
  assert.equal(result.resultId, "semantic-result");
  bridge.dispose();
  vscodeState.executeHandler = undefined;
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

test("serializes each full-source analysis snapshot through the provider that reads it", async () => {
  vscodeState.executeCalls = 0;
  const firstGate = deferred();
  const documents = fakeOverlayDocuments("");
  const syncLines = [];
  const observed = [];
  let leaseQueue = Promise.resolve();
  documents.withAnalysisSnapshot = (_text, line, request) => {
    const pending = leaseQueue.then(async () => {
      documents.activeLine = line;
      syncLines.push(line);
      return await request();
    });
    leaseQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  vscodeState.executeHandler = (command) => {
    observed.push([command, documents.activeLine]);
    return command === "vscode.executeHoverProvider" ? firstGate.promise : [];
  };
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("upper = 1\n\n\nlower = 2");

  const upper = bridge.provideHover(document, new Position(0, 2));
  await nextTurn();
  const lower = bridge.provideDefinition(document, new Position(3, 2));
  await nextTurn();

  assert.deepEqual(syncLines, [0], "the second unit cannot replace analysis.py while the first provider is reading it");
  assert.deepEqual(observed, [["vscode.executeHoverProvider", 0]]);
  firstGate.resolve([]);
  await upper;
  await lower;
  assert.deepEqual(syncLines, [0, 3]);
  assert.deepEqual(observed, [["vscode.executeHoverProvider", 0], ["vscode.executeDefinitionProvider", 3]]);
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("relocates a protected Pylance auto-import to the focused lower execution unit", () => {
  const source = "upper = 1\n\n\nclient = WorkspaceCli";
  const item = completionWithImport(5, "from workspace_context import WorkspaceClient\n");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 3, text: source });

  assert.equal(mapped.textEdit.range.start.line, 3);
  assert.equal(mapped.additionalTextEdits.length, 1);
  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(3, 0, 3, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\n\n");
});

test("keeps auto-imports local when the focused execution unit is first", () => {
  const source = "client = WorkspaceCli\n\n\nlower = 1";
  const item = completionWithImport(2, "import workspace_context\n");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 0, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(0, 0, 0, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "import workspace_context\n\n");
});

test("relocates an auto-import aimed at another unit without changing that unit", () => {
  const source = "from workspace_context import Existing\nupper = Existing()\n\n\nclient = WorkspaceCli";
  const item = completionWithImport(6, "from workspace_context import Existing, WorkspaceClient\n", 2);

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 4, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(4, 0, 4, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import Existing, WorkspaceClient\n\n");
});

test("preserves a completion edit that already targets an import in the focused unit", () => {
  const source = "from workspace_context import Existing\nclient = WorkspaceCli";
  const item = completionWithImport(3, "from workspace_context import Existing, WorkspaceClient", 2);
  item.additionalTextEdits[0].range = new Range(2, 0, 2, "from workspace_context import Existing".length);

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 1, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(0, 0, 0, "from workspace_context import Existing".length));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import Existing, WorkspaceClient");
});

test("prefers a focused-unit import merge over duplicate lazy metadata", () => {
  const existing = "from workspace_context import Existing";
  const source = `${existing}\nclient = WorkspaceCli`;
  const item = new CompletionItem({ description: "workspace_context", label: "WorkspaceClient" });
  item.documentation = "```\nfrom workspace_context import WorkspaceClient\n```";
  item.textEdit = new TextEdit(new Range(3, 9, 3, 21), "WorkspaceClient");
  item.additionalTextEdits = [new TextEdit(new Range(2, existing.length, 2, existing.length), ", WorkspaceClient")];

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 1, text: source });

  assert.equal(mapped.additionalTextEdits.length, 1);
  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(0, existing.length, 0, existing.length));
  assert.equal(mapped.additionalTextEdits[0].newText, ", WorkspaceClient");
});

test("deduplicates only against imports in the focused execution unit", () => {
  const imported = "from workspace_context import WorkspaceClient";
  const localSource = `upper = 1\n\n\n${imported}\nclient = WorkspaceCli`;
  const localItem = completionWithImport(6, `${imported}\n`);

  const [local] = overlayPythonFeatureBridgeTest.mapCompletionResult([localItem], 2, 2, { focusLine: 4, text: localSource });

  assert.equal(local.additionalTextEdits, undefined);

  const upperSource = `${imported}\nupper = WorkspaceClient()\n\n\nclient = WorkspaceCli`;
  const upperItem = completionWithImport(6, `${imported}\n`);
  const [upper] = overlayPythonFeatureBridgeTest.mapCompletionResult([upperItem], 2, 2, { focusLine: 4, text: upperSource });

  assert.deepEqual(upper.additionalTextEdits[0].range, new Range(4, 0, 4, 0));
  assert.equal(upper.additionalTextEdits[0].newText, `${imported}\n\n`);
});

test("normalizes and deduplicates relocated auto-import text for CRLF input", () => {
  const source = "upper = 1\r\n\r\n\r\nclient = WorkspaceCli";
  const item = completionWithImport(5, "from workspace_context import WorkspaceClient\n");
  item.additionalTextEdits.push(new TextEdit(new Range(0, 0, 0, 0), "from workspace_context import WorkspaceClient\n"));

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 3, text: source });

  assert.equal(mapped.additionalTextEdits.length, 1);
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\r\n\r\n");
});

test("normalizes auto-imports in the first unit and preserves a lone carriage-return EOL", () => {
  const crlfItem = completionWithImport(2, "from workspace_context import WorkspaceClient\n");
  const [crlf] = overlayPythonFeatureBridgeTest.mapCompletionResult([crlfItem], 2, 2, {
    focusLine: 0,
    text: "client = WorkspaceCli\r\n\r\n\r\nlower = 1"
  });
  assert.equal(crlf.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\r\n\r\n");

  const carriageItem = completionWithImport(5, "from . import WorkspaceClient\n");
  const [carriage] = overlayPythonFeatureBridgeTest.mapCompletionResult([carriageItem], 2, 2, {
    focusLine: 3,
    text: "upper = 1\r\r\rclient = WorkspaceCli"
  });
  assert.equal(carriage.additionalTextEdits[0].newText, "from . import WorkspaceClient\r\r");
});

test("inserts ordinary auto-imports after leading future imports", () => {
  const source = "from __future__ import annotations\nclient = WorkspaceCli";
  const item = completionWithImport(3, "from workspace_context import WorkspaceClient\n");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 1, text: source });

  const futureLength = "from __future__ import annotations".length;
  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(0, futureLength, 0, futureLength));
  assert.equal(mapped.additionalTextEdits[0].newText, "\nfrom workspace_context import WorkspaceClient\n");
});

test("drops protected non-import completion edits", () => {
  const source = "upper = 1\n\n\nclient = WorkspaceCli";
  const item = completionWithImport(5, "__all__ = ['WorkspaceClient']\n");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 3, text: source });

  assert.equal(mapped.additionalTextEdits, undefined);
});

test("relocates rather than clamping an import edit that crosses the protected prefix", () => {
  const source = "client = WorkspaceCli";
  const item = completionWithImport(2, "from workspace_context import WorkspaceClient\n");
  item.additionalTextEdits[0].range = new Range(0, 0, 2, 6);

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 0, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(0, 0, 0, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\n\n");
});

test("synthesizes a unit-local edit from lazy Pylance auto-import metadata", () => {
  const source = "upper = 1\n\n\nclient = WorkspaceCli";
  const item = new CompletionItem({ description: "workspace_context", label: "WorkspaceClient" });
  item.documentation = "```\nfrom workspace_context import WorkspaceClient\n```";
  item.textEdit = new TextEdit(new Range(5, 9, 5, 21), "WorkspaceClient");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 3, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(3, 0, 3, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\n\n");
});

test("copies an upper-unit import when full-source analysis suppresses Pylance auto-import metadata", () => {
  const source = "from workspace_context import WorkspaceClient\nupper = WorkspaceClient()\n\n\nclient = WorkspaceCli";
  const item = new CompletionItem("WorkspaceClient");
  item.textEdit = new TextEdit(new Range(6, 9, 6, 21), "WorkspaceClient");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, { focusLine: 4, text: source });

  assert.deepEqual(mapped.additionalTextEdits[0].range, new Range(4, 0, 4, 0));
  assert.equal(mapped.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\n\n");
});

test("does not copy a same-named upper import for attribute completion", () => {
  const source = "from workspace_context import objects\nupper = objects\n\n\nclient.obj";
  const item = new CompletionItem("objects");
  item.textEdit = new TextEdit(new Range(6, 7, 6, 10), "objects");

  const [mapped] = overlayPythonFeatureBridgeTest.mapCompletionResult([item], 2, 2, {
    focusCharacter: "client.obj".length,
    focusLine: 4,
    text: source
  });

  assert.equal(mapped.additionalTextEdits, undefined);
});

test("resolves a lazy hidden completion edit and maps it through the public provider", async () => {
  vscodeState.executeCalls = 0;
  let completionCalls = 0;
  vscodeState.executeHandler = (command, _uri, _position, _trigger, resolveCount) => {
    if (command !== "vscode.executeCompletionItemProvider") { return []; }
    completionCalls += 1;
    const item = new CompletionItem("WorkspaceClient");
    item.textEdit = new TextEdit(new Range(4, 9, 4, 21), "WorkspaceClient");
    if (resolveCount === 1) {
      item.additionalTextEdits = [new TextEdit(new Range(0, 0, 0, 0), "from workspace_context import WorkspaceClient\n")];
    }
    return [item];
  };
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments("from hidden import Prelude\n"));
  const source = "upper = 1\n\n\nclient = WorkspaceCli";
  const document = fakeDocument(source, "django-shell-python");

  const completions = await bridge.provideCompletionItems(document, new Position(3, 21), { isCancellationRequested: false }, { triggerCharacter: "." });
  assert.equal(completions[0].additionalTextEdits, undefined);
  const resolved = await bridge.resolveCompletionItem(completions[0], { isCancellationRequested: false });

  assert.equal(completionCalls, 2);
  assert.deepEqual(resolved.additionalTextEdits[0].range, new Range(3, 0, 3, 0));
  assert.equal(resolved.additionalTextEdits[0].newText, "from workspace_context import WorkspaceClient\n\n");
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("retries inside a completed import name and preserves that position for lazy resolution", async () => {
  vscodeState.executeCalls = 0;
  const observed = [];
  vscodeState.executeHandler = (command, _uri, position, _trigger, resolveCount) => {
    if (command !== "vscode.executeCompletionItemProvider") { return []; }
    observed.push({ character: position.character, resolveCount });
    if (position.character === 27) { return [new CompletionItem("generic_name")]; }
    const item = new CompletionItem("AutoImportedClient");
    item.textEdit = new TextEdit(new Range(4, 9, 4, 27), "AutoImportedClient");
    if (resolveCount === 1) {
      item.additionalTextEdits = [new TextEdit(new Range(0, 0, 0, 0), "from workspace_context import AutoImportedClient\n")];
    }
    return [item];
  };
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments("from hidden import Prelude\n"));
  const source = "upper = 1\n\n\nclient = AutoImportedClient";
  const document = fakeDocument(source, "django-shell-python");

  const completions = await bridge.provideCompletionItems(document, new Position(3, 27), { isCancellationRequested: false }, {});
  assert.equal(completions[0].label, "AutoImportedClient");
  const resolved = await bridge.resolveCompletionItem(completions[0], { isCancellationRequested: false });

  assert.deepEqual(observed, [
    { character: 27, resolveCount: undefined },
    { character: 26, resolveCount: undefined },
    { character: 26, resolveCount: 1 }
  ]);
  assert.deepEqual(resolved.additionalTextEdits[0].range, new Range(3, 0, 3, 0));
  assert.equal(resolved.additionalTextEdits[0].newText, "from workspace_context import AutoImportedClient\n\n");
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

/** Creates a one-line text document with stable file identity. */
function fakeDocument(text, languageId = "python") {
  return {
    getText: () => text,
    languageId,
    lineCount: text.split(/\r\n|\n|\r/).length,
    offsetAt: (position) => offsetAtText(text, position),
    positionAt: (offset) => positionAtText(text, offset),
    uri: { toString: () => "file:///workspace/.django-shell/console-cell.py" }
  };
}

/** Converts one test position to an offset across LF and CRLF source. */
function offsetAtText(text, position) {
  const starts = lineStartOffsets(text);
  const line = Math.max(0, Math.min(position.line, starts.length - 1));
  return Math.min(text.length, starts[line] + Math.max(0, position.character));
}

/** Converts one test offset to a position across LF and CRLF source. */
function positionAtText(text, offset) {
  const starts = lineStartOffsets(text);
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= bounded) { line += 1; }
  return new Position(line, bounded - starts[line]);
}

/** Returns every logical line-start offset in one test source. */
function lineStartOffsets(text) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\n|\r/g)) { starts.push(match.index + match[0].length); }
  return starts;
}

/** Creates one completion item with a primary replacement and one additional edit. */
function completionWithImport(analysisLine, importText, importLine = 0) {
  const item = new CompletionItem("WorkspaceClient");
  item.textEdit = new TextEdit(new Range(analysisLine, 9, analysisLine, 21), "WorkspaceClient");
  item.additionalTextEdits = [new TextEdit(new Range(importLine, 0, importLine, 0), importText)];
  return item;
}

/** Creates the generated-document surface consumed by the overlay feature bridge. */
function fakeOverlayDocuments(prelude) {
  return {
    analysisUri: { fsPath: "/workspace/.django-shell/analysis.py", toString: () => "file:///workspace/.django-shell/analysis.py" },
    editorUri: { fsPath: "/workspace/.django-shell/console-cell.py", toString: () => "file:///workspace/.django-shell/console-cell.py" },
    inputStartLine: () => 1,
    lineOffset: () => prelude ? 1 : 0,
    preludeText: () => prelude,
    syncs: 0,
    async withAnalysisSnapshot(_text, _line, request) { this.syncs += 1; return await request(); },
    async withTransientAnalysisSnapshot(_text, _line, request) { this.syncs += 1; return await request(); }
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
  const register = (selector) => { vscodeState.selectors.push(selector); return { dispose() {} }; };
  return {
    commands: { async executeCommand(command, ...args) { vscodeState.executeCalls += 1; if (command === "vscode.provideDocumentSemanticTokensLegend") { return new SemanticTokensLegend([]); } return await vscodeState.executeHandler?.(command, ...args) ?? []; } },
    CompletionItem,
    CompletionItemKind: { Property: 9 },
    CompletionList,
    EventEmitter,
    Position,
    Range,
    SemanticTokens,
    SemanticTokensLegend,
    TextEdit,
    languages: {
      registerCompletionItemProvider: register,
      registerDefinitionProvider: register,
      registerDocumentHighlightProvider: register,
      registerDocumentSemanticTokensProvider: register,
      registerHoverProvider: register,
      registerReferenceProvider: register,
      registerSignatureHelpProvider: register
    },
    workspace: { async openTextDocument() { return {}; } }
  };
}
