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
const vscodeState = { executeCalls: 0, executeHandler: undefined, selectors: [], textDocuments: [] };

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

/** Minimal source location used by definition mapping tests. */
class Location {
  constructor(uri, range) { this.range = range; this.uri = uri; }
}

/** Minimal markdown value used by synthetic runtime completion documentation. */
class MarkdownString {
  constructor(value = "") { this.value = value; }
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

test("caches only exact non-empty completion requests", async () => {
  const cache = new OverlayCompletionRequestCache();
  let loads = 0;
  const first = await cache.provide(fakeDocument("Co"), new Position(0, 2), undefined, async () => {
    loads += 1;
    return [new CompletionItem("Company"), new CompletionItem("Other")];
  });
  const extended = await cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async () => {
    loads += 1;
    return [new CompletionItem("Company")];
  });
  const repeated = await cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async () => {
    loads += 1;
    return [new CompletionItem("unexpected")];
  });

  assert.equal(loads, 2);
  assert.equal(first[0].range.end.character, 2);
  assert.equal(extended[0].range.end.character, 7);
  assert.equal(repeated[0].label, "Company");

  const unrelated = await cache.provide(fakeDocument("Other"), new Position(0, 5), undefined, async () => {
    loads += 1;
    return [new CompletionItem("Other")];
  });
  assert.equal(loads, 3, "a broad cached prefix list cannot hide a later token's candidates");
  assert.equal(unrelated[0].label, "Other");

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

test("keeps a recent complete candidate visible only after an extended-prefix provider returns empty", async () => {
  const cache = new OverlayCompletionRequestCache();
  let loads = 0;
  await cache.provide(fakeDocument("WidgetImp"), new Position(0, 9), undefined, async () => {
    loads += 1;
    return new CompletionList([new CompletionItem("WidgetImportedClient")]);
  });
  const extended = await cache.provide(fakeDocument("WidgetImportedCli"), new Position(0, 17), undefined, async () => {
    loads += 1;
    return [];
  });

  assert.equal(loads, 2, "a compatible fallback must not skip the latest provider request");
  assert.equal(extended.items[0].label, "WidgetImportedClient");
  assert.equal(extended.items[0].range.end.character, 17);
  assert.equal(extended.isIncomplete, true);
});

test("retains an incomplete list for fallback without treating it as an exact cache hit", async () => {
  const cache = new OverlayCompletionRequestCache();
  let loads = 0;
  await cache.provide(fakeDocument("WidgetImp"), new Position(0, 9), undefined, async () => {
    loads += 1;
    return new CompletionList([new CompletionItem("WidgetImportedClient")], true);
  });
  await cache.provide(fakeDocument("WidgetImp"), new Position(0, 9), undefined, async () => {
    loads += 1;
    return [];
  });
  const extended = await cache.provide(fakeDocument("WidgetImportedCli"), new Position(0, 17), undefined, async () => {
    loads += 1;
    return [];
  });

  assert.equal(loads, 3);
  assert.equal(extended.items[0].label, "WidgetImportedClient");
  assert.equal(extended.isIncomplete, true);
});

test("uses a matching array only as an incomplete empty-result fallback", async () => {
  const cache = new OverlayCompletionRequestCache();
  await cache.provide(fakeDocument("WidgetImp"), new Position(0, 9), undefined, async () => [
    new CompletionItem("OtherName"),
    new CompletionItem("WidgetImportedClient")
  ]);

  const extended = await cache.provide(fakeDocument("WidgetImportedCli"), new Position(0, 17), undefined, async () => []);

  assert.deepEqual(extended.items.map((item) => item.label), ["WidgetImportedClient"]);
  assert.equal(extended.isIncomplete, true);
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

test("drops a completion canceled before it enters the analysis lane", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = () => { throw new Error("canceled completion reached a provider"); };
  const documents = fakeOverlayDocuments("from app.models import Company\n");
  const bridge = new OverlayPythonFeatureBridge(documents);
  const token = { isCancellationRequested: false };

  const pending = bridge.provideCompletionItems(fakeDocument("Company.ob"), new Position(0, 10), token, { triggerCharacter: "." });
  token.isCancellationRequested = true;

  assert.equal(await pending, undefined);
  assert.equal(vscodeState.executeCalls, 0);
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("keeps an exact active completion alive when a fresh caller replaces its canceled token", async () => {
  vscodeState.executeCalls = 0;
  const gate = deferred();
  vscodeState.executeHandler = (command) => command === "vscode.executeCompletionItemProvider" ? gate.promise : [];
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments("from app.models import Widget\n"));
  const document = fakeDocument("Widget.imported");
  const firstToken = { isCancellationRequested: false };
  const secondToken = { isCancellationRequested: false };

  const first = bridge.provideCompletionItems(document, new Position(0, 15), firstToken, { triggerCharacter: "." });
  await nextTurn();
  assert.equal(vscodeState.executeCalls, 1);
  firstToken.isCancellationRequested = true;
  const second = bridge.provideCompletionItems(document, new Position(0, 15), secondToken, { triggerCharacter: "." });
  gate.resolve(new CompletionList([new CompletionItem("WidgetImportedClient")]));

  assert.equal(await first, undefined);
  assert.ok((await second).items.some((item) => item.label === "WidgetImportedClient"));
  assert.equal(vscodeState.executeCalls, 1);
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("runs one completion load at a time and transfers pending callers to the latest context", async () => {
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
  let middleSettled = false;
  void middle.then(() => { middleSettled = true; });
  await nextTurn();

  assert.deepEqual(calls, { active: 1, middle: 0, latest: 0 });
  assert.equal(middleSettled, false, "a superseded pending request must not emit a false empty result");

  activeGate.resolve([new CompletionItem("active")]);
  assert.equal((await active)[0].label, "active");
  await nextTurn();
  assert.deepEqual(calls, { active: 1, middle: 0, latest: 1 });

  latestGate.resolve([new CompletionItem("latest")]);
  const [middleResult, latestResult] = await Promise.all([middle, latest]);
  assert.equal(middleResult[0].label, "latest");
  assert.equal(latestResult[0].label, "latest");
});

test("shares an active compatible prefix snapshot across token extensions", async () => {
  const cache = new OverlayCompletionRequestCache();
  const activeGate = deferred();
  const calls = { latest: 0 };

  const active = cache.provide(fakeDocument("Co"), new Position(0, 2), undefined, async (isCurrent) => {
    await activeGate.promise;
    assert.equal(isCurrent(), false, "a longer token supersedes the captured short snapshot");
    return new CompletionList([new CompletionItem("Company")]);
  });
  const latest = cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async (isCurrent) => {
    calls.latest += 1;
    assert.equal(isCurrent(), true);
    return [new CompletionItem("Company")];
  });
  await nextTurn();
  assert.equal(calls.latest, 0, "the latest snapshot waits behind the single active provider lane");

  activeGate.resolve();
  assert.equal((await active).items[0].label, "Company");
  const result = await latest;
  assert.equal(calls.latest, 0);
  assert.equal(result.items[0].range.end.character, 7);
});

test("loads the latest token once when an active prefix result is empty", async () => {
  const cache = new OverlayCompletionRequestCache();
  const activeGate = deferred();
  let latestLoads = 0;

  const active = cache.provide(fakeDocument("Au"), new Position(0, 2), undefined, async () => activeGate.promise);
  const latest = cache.provide(fakeDocument("AutoImportedClient"), new Position(0, 18), undefined, async () => {
    latestLoads += 1;
    return [new CompletionItem("AutoImportedClient")];
  });
  activeGate.resolve([]);

  assert.deepEqual(await active, []);
  assert.equal((await latest)[0].label, "AutoImportedClient");
  assert.equal(latestLoads, 1);
});

test("keeps same-position trigger and quick-suggest results distinct without settling pending empty", async () => {
  const cache = new OverlayCompletionRequestCache();
  const gate = deferred();
  let quickLoads = 0;
  const document = fakeDocument("Company");
  const position = new Position(0, 7);

  const triggered = cache.provide(document, position, ".", async () => gate.promise);
  const quick = cache.provide(document, position, undefined, async () => { quickLoads += 1; return [new CompletionItem("QuickCompany")]; });
  gate.resolve([new CompletionItem("Company")]);

  assert.equal((await triggered)[0].label, "Company");
  assert.equal((await quick)[0].label, "QuickCompany");
  assert.equal(quickLoads, 1);
});

test("does not reuse an unbounded array as a complete prefix result", async () => {
  const cache = new OverlayCompletionRequestCache();
  const activeGate = deferred();
  let latestLoads = 0;

  const active = cache.provide(fakeDocument("Co"), new Position(0, 2), undefined, async () => activeGate.promise);
  const latest = cache.provide(fakeDocument("Company"), new Position(0, 7), undefined, async () => {
    latestLoads += 1;
    return [new CompletionItem("Company")];
  });
  activeGate.resolve([new CompletionItem("Company")]);

  await active;
  assert.equal((await latest)[0].label, "Company");
  assert.equal(latestLoads, 1);
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

test("leaves ordinary Python completion to native providers even when a runtime prelude exists", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = undefined;
  const emptyDocuments = fakeOverlayDocuments("");
  const emptyBridge = new OverlayPythonFeatureBridge(emptyDocuments);
  const emptyResult = await emptyBridge.provideCompletionItems(fakeDocument("print"), new Position(0, 5), { isCancellationRequested: false }, {});

  assert.equal(emptyResult, undefined);
  assert.equal(emptyDocuments.syncs, 0);
  assert.equal(vscodeState.executeCalls, 0);

  const preludeDocuments = fakeOverlayDocuments("from app.models import Company\n");
  const preludeBridge = new OverlayPythonFeatureBridge(preludeDocuments);
  const ordinary = await preludeBridge.provideCompletionItems(fakeDocument("pri"), new Position(0, 3), { isCancellationRequested: false }, {});
  assert.equal(ordinary, undefined);
  assert.equal(preludeDocuments.syncs, 0);
  assert.equal(vscodeState.executeCalls, 0);
  emptyBridge.dispose();
  preludeBridge.dispose();
});

test("synthesizes top-level runtime names without invoking hidden Python providers", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = () => { throw new Error("synthetic runtime name reached a hidden provider"); };
  const documents = fakeOverlayDocuments("from app.models import Company\ncurrent_user: User\n");
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("value = Com");

  const result = await bridge.provideCompletionItems(document, new Position(0, 11), { isCancellationRequested: false }, {});

  assert.equal(documents.syncs, 0);
  assert.equal(vscodeState.executeCalls, 0);
  assert.deepEqual(result.items.map((item) => item.label), ["Company"]);
  assert.equal(result.items[0].range.start.character, 8);
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("forwards only a runtime-rooted member completion through hidden analysis", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = (command) => command === "vscode.executeCompletionItemProvider" ? [new CompletionItem("objects")] : [];
  const documents = fakeOverlayDocuments("from app.models import Company\n");
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("Company.ob");

  const result = await bridge.provideCompletionItems(document, new Position(0, 10), { isCancellationRequested: false }, { triggerCharacter: "." });

  assert.equal(documents.syncs, 1);
  assert.equal(vscodeState.executeCalls, 1);
  assert.equal(result[0].label, "objects");
  bridge.dispose();
  vscodeState.executeHandler = undefined;
});

test("registers exact Python file selectors for shell and query augmenters", () => {
  vscodeState.selectors.length = 0;
  const shell = new OverlayPythonFeatureBridge(fakeOverlayDocuments(""));
  shell.activate();
  assert.equal(vscodeState.selectors.length, 6);
  assert.ok(vscodeState.selectors.every((selector) => selector.length === 1 && selector[0].language === "python" && selector[0].pattern === "**/.django-shell/console-cell.py" && selector[0].scheme === "file"));
  shell.dispose();

  vscodeState.selectors.length = 0;
  const queryDocuments = fakeOverlayDocuments("");
  queryDocuments.editorUri = { fsPath: "/workspace/.django-shell/query-cell.py", toString: () => "file:///workspace/.django-shell/query-cell.py" };
  const query = new OverlayPythonFeatureBridge(queryDocuments);
  query.activate();
  assert.equal(vscodeState.selectors.length, 6);
  assert.ok(vscodeState.selectors.every((selector) => selector.length === 1 && selector[0].language === "python" && selector[0].pattern === "**/.django-shell/query-cell.py" && selector[0].scheme === "file"));
  query.dispose();
});

test("does not register a semantic bridge over native Python semantic providers", () => {
  vscodeState.selectors.length = 0;
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments(""));

  bridge.activate();

  assert.equal(vscodeState.selectors.length, 6);
  assert.equal(typeof bridge.provideDocumentSemanticTokens, "undefined");
  bridge.dispose();
});

test("drops canceled hover and highlight work before either background provider starts", async () => {
  vscodeState.executeCalls = 0;
  vscodeState.executeHandler = () => { throw new Error("canceled background work reached a provider"); };
  const bridge = new OverlayPythonFeatureBridge(fakeOverlayDocuments("from hidden import Name\n"));
  const document = fakeDocument("Name", "django-shell-python");
  const hoverToken = { isCancellationRequested: false };
  const highlightToken = { isCancellationRequested: false };

  const hover = bridge.provideHover(document, new Position(0, 2), hoverToken);
  const highlights = bridge.provideDocumentHighlights(document, new Position(0, 2), highlightToken);
  hoverToken.isCancellationRequested = true;
  highlightToken.isCancellationRequested = true;

  assert.equal(await hover, undefined);
  assert.equal(await highlights, undefined);
  assert.equal(vscodeState.executeCalls, 0);
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
  const completionPosition = new Position(0, 8);
  const signaturePosition = new Position(0, 23);

  const completion = bridge.provideCompletionItems(document, completionPosition, { isCancellationRequested: false }, { triggerCharacter: "." });
  await nextTurn();
  const signature = await bridge.provideSignatureHelp(document, signaturePosition, { isCancellationRequested: false }, { triggerCharacter: "(" });

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
  const documents = fakeOverlayDocuments("Name: object\n");
  const syncLines = [];
  const observed = [];
  let leaseQueue = Promise.resolve();
  const enqueueLease = (line, request) => {
    const pending = leaseQueue.then(async () => {
      documents.activeLine = line;
      syncLines.push(line);
      return await request();
    });
    leaseQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  documents.withAnalysisSnapshot = (_text, line, request) => enqueueLease(line, request);
  documents.withCancellableAnalysisSnapshot = (_text, line, isCancelled, request) => enqueueLease(line, () => isCancelled() ? undefined : request());
  vscodeState.executeHandler = (command) => {
    observed.push([command, documents.activeLine]);
    return command === "vscode.executeHoverProvider" ? firstGate.promise : [new Location(documents.analysisUri, new Range(3, 0, 3, 4))];
  };
  const bridge = new OverlayPythonFeatureBridge(documents);
  const document = fakeDocument("Name.upper\n\n\nName.lower");

  const upper = bridge.provideHover(document, new Position(0, 7));
  await new Promise((resolve) => setTimeout(resolve, 110));
  const lower = bridge.provideDefinition(document, new Position(3, 7));
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

test("maps generated definition locations and links back to the visible overlay", () => {
  const documents = fakeOverlayDocuments("from hidden import Name\n");
  const externalUri = { toString: () => "file:///workspace/app/models.py" };
  const generatedLocation = new Location(documents.analysisUri, new Range(3, 1, 3, 5));
  const externalLocation = new Location(externalUri, new Range(8, 0, 8, 4));
  const generatedLink = {
    originSelectionRange: new Range(4, 2, 4, 6),
    targetRange: new Range(5, 0, 6, 0),
    targetSelectionRange: new Range(5, 4, 5, 8),
    targetUri: documents.analysisUri
  };

  const mapped = overlayPythonFeatureBridgeTest.mapDefinitions([generatedLocation, externalLocation, generatedLink], documents.analysisUri, documents.editorUri, 2);

  assert.equal(mapped[0].uri, documents.editorUri);
  assert.deepEqual(mapped[0].range, new Range(1, 1, 1, 5));
  assert.equal(mapped[1], externalLocation);
  assert.equal(mapped[2].targetUri, documents.editorUri);
  assert.deepEqual(mapped[2].originSelectionRange, new Range(2, 2, 2, 6));
  assert.deepEqual(mapped[2].targetRange, new Range(3, 0, 4, 0));
  assert.deepEqual(mapped[2].targetSelectionRange, new Range(3, 4, 3, 8));
});

test("keeps external definition targets while remapping their generated origin", () => {
  const documents = fakeOverlayDocuments("from hidden import Name\n");
  const externalUri = { toString: () => "file:///workspace/app/models.py" };
  const link = {
    originSelectionRange: new Range(3, 1, 3, 5),
    targetRange: new Range(20, 0, 24, 0),
    targetSelectionRange: new Range(20, 6, 20, 10),
    targetUri: externalUri
  };

  const [mapped] = overlayPythonFeatureBridgeTest.mapDefinitions([link], documents.analysisUri, documents.editorUri, 2);

  assert.equal(mapped.targetUri, externalUri);
  assert.deepEqual(mapped.originSelectionRange, new Range(1, 1, 1, 5));
  assert.equal(mapped.targetRange, link.targetRange);
  assert.equal(mapped.targetSelectionRange, link.targetSelectionRange);
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
    async withCancellableAnalysisSnapshot(_text, _line, isCancelled, request) { this.syncs += 1; return isCancelled() ? undefined : await request(); },
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
    commands: { async executeCommand(command, ...args) { vscodeState.executeCalls += 1; return await vscodeState.executeHandler?.(command, ...args) ?? []; } },
    CompletionItem,
    CompletionItemKind: { Class: 6, Module: 8, Property: 9, Variable: 5 },
    CompletionList,
    Location,
    MarkdownString,
    Position,
    Range,
    TextEdit,
    languages: {
      registerCompletionItemProvider: register,
      registerDefinitionProvider: register,
      registerDocumentHighlightProvider: register,
      registerHoverProvider: register,
      registerReferenceProvider: register,
      registerSignatureHelpProvider: register
    },
    window: { tabGroups: { all: [], async close() {} } },
    workspace: { async openTextDocument() { return {}; }, get textDocuments() { return vscodeState.textDocuments; } }
  };
}
