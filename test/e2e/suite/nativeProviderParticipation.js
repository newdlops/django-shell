// E2E checks for direct third-party Python completion participation in the overlay editor.

const assert = require("node:assert/strict");
const vscode = require("vscode");

const FIXTURE_EXTENSION_ID = "django-shell-e2e.django-shell-native-provider-fixture";
const INPUT_MARKER = "# --- django shell input ---";
const SENTINEL = "NativeProviderSentinel";
const RUNTIME_SENTINEL = "NativeProviderSentinelRuntime";
const SENTINEL_DETAIL = "Django Shell native provider E2E sentinel";
const AUTO_IMPORT = "from native_provider_fixture import NativeProviderSentinel";
const SOURCE = "upper = 1\n\n\nvalue = NativeProviderSent";
const ACCEPTED_SOURCE = `upper = 1\n\n\n${AUTO_IMPORT}\n\nvalue = ${SENTINEL}`;
const PROBE_PRELUDE_LINES = ["from orm_runtime.models import Company", `from native_provider_fixture import ${RUNTIME_SENTINEL}`];
const PROBE_DOCUMENT = `# Django shell runtime imports for analysis.\n# ruff: noqa\n${PROBE_PRELUDE_LINES.join("\n")}\n\n${INPUT_MARKER}\n${SOURCE}`;

/** Verifies generic Python providers run directly and keep accepted imports unit-local. */
async function assertNativeProviderParticipation({ extension, installOverlayDocument, restoreDocumentText, restorePrelude }) {
  const fixture = vscode.extensions.getExtension(FIXTURE_EXTENSION_ID);
  assert.ok(fixture, `${FIXTURE_EXTENSION_ID} should be loaded as a second development extension.`);
  await fixture.activate();
  assert.equal(fixture.isActive, true);
  try {
    await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", PROBE_PRELUDE_LINES);
    const visibleText = await installOverlayDocument(PROBE_DOCUMENT);
    assert.equal(visibleText, SOURCE);
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await assertDirectProviderApi(overlayUri(), visibleText);
    await assertNativeSuggestAcceptance(extension, installOverlayDocument);
  } finally {
    await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", restorePrelude);
    await installOverlayDocument(restoreDocumentText);
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  }
}

/** Verifies one bare completion reaches the visible file without recursively querying analysis.py. */
async function assertDirectProviderApi(uri, text) {
  await vscode.commands.executeCommand("djangoShellNativeProvider.reset");
  const position = positionAfter(text, "value = NativeProviderSent");
  const first = completionItems(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position));
  assert.equal(itemsWithLabel(first, SENTINEL).length, 1, completionLabels(first));
  assert.equal(itemsWithLabel(first, RUNTIME_SENTINEL).length, 1, completionLabels(first));
  const sentinelIndex = first.findIndex((item) => completionLabel(item) === SENTINEL);
  assert.ok(sentinelIndex >= 0, completionLabels(first));
  const resolved = completionItems(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position, undefined, sentinelIndex + 1));
  const resolvedSentinels = itemsWithLabel(resolved, SENTINEL);
  assert.equal(resolvedSentinels.length, 1, completionLabels(resolved));
  const importEdit = resolvedSentinels[0].additionalTextEdits?.find((edit) => edit.newText.includes(AUTO_IMPORT));
  assert.ok(importEdit, `native provider resolve lost its auto-import: ${JSON.stringify(resolvedSentinels[0])}`);
  assert.equal(importEdit.range.start.line, 0, "the provider fixture should expose its original file-top edit before UI relocation");
  assert.equal(importEdit.range.start.character, 0);
  assertProviderCalls(await providerSnapshot(), "completion API", 1);
}

/** Verifies native SuggestController acceptance relocates one lazy import and preserves undo/redo. */
async function assertNativeSuggestAcceptance(extension, installOverlayDocument) {
  await installOverlayDocument(PROBE_DOCUMENT);
  await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  await vscode.commands.executeCommand("djangoShellNativeProvider.reset");
  const started = await rendererJson(nativeSuggestionStartExpression());
  assert.equal(started.ok, true, `native suggestion start failed: ${JSON.stringify(started)}`);
  try {
    const suggestion = await waitForRendererState(nativeSuggestionSnapshotExpression(), (state) => state.shown || state.suggestMs > 1500);
    if (!suggestion.shown) { suggestion.provider = await providerSnapshot(); }
    assert.equal(suggestion.shown, true, `native suggestion did not appear: ${JSON.stringify(suggestion)}`);
    assert.equal(suggestion.sentinelRows, 1, `native provider result was duplicated in the suggest widget: ${JSON.stringify(suggestion)}`);
    assert.equal(suggestion.selectedFixture, true, `native provider result was not the selected suggestion: ${JSON.stringify(suggestion)}`);
    assert.ok(suggestion.suggestMs <= 500, `native provider suggestion exceeded the 500ms warm latency budget: ${JSON.stringify(suggestion)}`);
    const accept = await rendererJson(nativeActionExpression("acceptSelectedSuggestion"));
    assert.equal(accept.ok, true, `native suggestion acceptance did not dispatch: ${JSON.stringify(accept)}`);
    const accepted = await waitForRendererState(nativeModelSnapshotExpression(), (state) => state.text === ACCEPTED_SOURCE);
    assert.equal(accepted.text, ACCEPTED_SOURCE, `native auto-import was not moved into the lower execution unit: ${JSON.stringify(accepted)}`);
    assert.ok(accepted.relocationsAfter > started.relocationsBefore, `native completion relocation hook did not run: ${JSON.stringify({ accepted, started })}`);
    assert.equal(accepted.nativeError, "", `native completion relocation hook reported an error: ${JSON.stringify(accepted)}`);
    const undoAction = await rendererJson(nativeActionExpression("undo"));
    const undo = await waitForRendererState(nativeModelSnapshotExpression(), (state) => state.text === SOURCE);
    assert.equal(undo.text, SOURCE, `one undo did not remove the completion and its import together: ${JSON.stringify({ undo, undoAction })}`);
    const redoAction = await rendererJson(nativeActionExpression("redo"));
    const redo = await waitForRendererState(nativeModelSnapshotExpression(), (state) => state.text === ACCEPTED_SOURCE);
    assert.equal(redo.text, ACCEPTED_SOURCE, `one redo did not restore the completion and its import together: ${JSON.stringify({ redo, redoAction })}`);
  } finally {
    await rendererJson(nativeSuggestionCleanupExpression());
  }
  assertProviderCalls(await providerSnapshot(), "suggest acceptance", 1);
  await waitForDocumentText(overlayUri(), ACCEPTED_SOURCE);
}

/** Asserts fixture call telemetry proves direct visible-Python participation. */
function assertProviderCalls(snapshot, stage, minimumResolves) {
  const matchingProvides = snapshot.calls.filter((call) => call.phase === "provide" && call.matched);
  const visibleProvides = matchingProvides.filter((call) => call.uri.endsWith("/.django-shell/console-cell.py"));
  const analysisProvides = matchingProvides.filter((call) => call.uri.endsWith("/.django-shell/analysis.py"));
  const visibleResolves = snapshot.calls.filter((call) => call.phase === "resolve" && call.matched && call.uri.endsWith("/.django-shell/console-cell.py"));
  assert.ok(visibleProvides.length >= 1, `${stage} never called the native provider on console-cell.py: ${JSON.stringify(snapshot)}`);
  assert.equal(analysisProvides.length, 0, `${stage} recursively called the native provider on analysis.py: ${JSON.stringify(snapshot)}`);
  assert.ok(visibleProvides.every((call) => call.language === "python"), `${stage} did not expose console-cell.py as Python: ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.provideCount >= visibleProvides.length, `${stage} reported inconsistent provide counts: ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.resolveCount >= minimumResolves, `${stage} did not resolve the native completion: ${JSON.stringify(snapshot)}`);
  assert.ok(visibleResolves.length >= minimumResolves, `${stage} resolved against a non-visible document: ${JSON.stringify(snapshot)}`);
}

/** Returns the fixture extension's serializable provider telemetry. */
async function providerSnapshot() {
  return vscode.commands.executeCommand("djangoShellNativeProvider.snapshot");
}

/** Returns completion items independently of their result container. */
function completionItems(result) {
  return result instanceof vscode.CompletionList ? result.items : result ?? [];
}

/** Returns one completion item's visible label. */
function completionLabel(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Returns all items with one exact visible label. */
function itemsWithLabel(items, label) {
  return items.filter((item) => completionLabel(item) === label);
}

/** Returns compact completion labels for assertion diagnostics. */
function completionLabels(items) {
  return JSON.stringify(items.slice(0, 100).map(completionLabel));
}

/** Returns the document position immediately after one source snippet. */
function positionAfter(source, snippet) {
  const index = source.indexOf(snippet);
  assert.notEqual(index, -1, `missing source snippet: ${snippet}`);
  const before = source.slice(0, index + snippet.length).split(/\r?\n/);
  return new vscode.Position(before.length - 1, before[before.length - 1].length);
}

/** Returns the visible console-cell.py URI. */
function overlayUri() {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".django-shell", "console-cell.py");
}

/** Waits until the visible TextDocument reflects one exact renderer value. */
async function waitForDocumentText(uri, expected) {
  let last = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    last = document?.getText() ?? "";
    if (last === expected) { return; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for native completion document sync: ${JSON.stringify(last)}`);
}

/** Builds a synchronous renderer probe that starts native suggestion loading. */
function nativeSuggestionStartExpression() {
  return `(function(){const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay"});}root.__dsoNativeProviderE2E={priorQuick:editor.getRawOptions&&editor.getRawOptions().quickSuggestions,startedAt:Date.now()};editor.updateOptions&&editor.updateOptions({quickSuggestions:false});model.setValue(${JSON.stringify(SOURCE)});const line=model.getLineCount(),column=model.getLineMaxColumn(line);editor.setPosition&&editor.setPosition({lineNumber:line,column});editor.focus&&editor.focus();const relocationsBefore=Number(root.__dsoNativeCompletionRelocations||0);editor.trigger&&editor.trigger("django-shell-e2e-native-provider","editor.action.triggerSuggest",{});return JSON.stringify({ok:true,relocationsBefore});})()`;
}

/** Builds a synchronous renderer snapshot of the native suggestion widget. */
function nativeSuggestionSnapshotExpression() {
  return `(function(){const visible=(node)=>{if(!node){return false;}const style=getComputedStyle(node),rect=node.getBoundingClientRect();return !(node.classList&&node.classList.contains("hidden"))&&node.getAttribute("aria-hidden")!=="true"&&style.display!=="none"&&style.visibility!=="hidden"&&rect.width>0&&rect.height>0;};const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,state=root&&root.__dsoNativeProviderE2E,controller=editor&&editor.getContribution&&editor.getContribution("editor.contrib.suggestController"),widget=Array.from(document.querySelectorAll(".suggest-widget")).find(visible)||null,rows=widget?Array.from(widget.querySelectorAll(".monaco-list-row")):[],label=${JSON.stringify(SENTINEL)},detail=${JSON.stringify(SENTINEL_DETAIL)},matches=(row)=>String(row.querySelector(".label-name")&&row.querySelector(".label-name").textContent||"").trim()===label||String(row.textContent||"").includes(detail),sentinel=rows.filter(matches),selected=rows.find((row)=>row.classList&&row.classList.contains("focused"));let focused=null;try{focused=controller&&controller.widget&&controller.widget.value&&controller.widget.value.getFocusedItem&&controller.widget.value.getFocusedItem();}catch(error){}const completion=focused&&focused.item&&focused.item.completion,focusedLabel=String(completion&&completion.label&&typeof completion.label==="object"?completion.label.label:completion&&completion.label||""),focusedDetail=String(completion&&completion.detail||""),selectedFixture=focusedLabel===label||!!selected&&matches(selected),modelState=Number(controller&&controller.model&&controller.model.state||0),sentinelRows=Math.max(sentinel.length,selectedFixture?1:0);return JSON.stringify({focusedDetail,focusedLabel,modelState,selectedFixture,sentinelRows,shown:selectedFixture&&modelState!==0,suggestMs:state?Math.max(0,Date.now()-state.startedAt):-1,widgetText:String(widget&&widget.textContent||"").slice(0,800)});})()`;
}

/** Builds a synchronous renderer probe for one editor action. */
function nativeActionExpression(action) {
  return `(function(){const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,model=editor&&editor.getModel&&editor.getModel(),action=${JSON.stringify(action)};if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay"});}const beforeCanUndo=!!(model.canUndo&&model.canUndo()),beforeCanRedo=!!(model.canRedo&&model.canRedo());let route="",triggerType="";try{let result;if(action==="undo"&&model.undo){route="model.undo";result=model.undo();}else if(action==="redo"&&model.redo){route="model.redo";result=model.redo();}else{route="editor.trigger";result=editor.trigger&&editor.trigger("django-shell-e2e-native-provider",action,{});}triggerType=typeof result;}catch(error){return JSON.stringify({ok:false,reason:"trigger-error",error:String(error&&error.message||error),route});}return JSON.stringify({afterCanRedo:!!(model.canRedo&&model.canRedo()),afterCanUndo:!!(model.canUndo&&model.canUndo()),beforeCanRedo,beforeCanUndo,ok:true,route,triggerType});})()`;
}

/** Builds a synchronous renderer snapshot of completion text and hook state. */
function nativeModelSnapshotExpression() {
  return `(function(){const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,model=editor&&editor.getModel&&editor.getModel();return JSON.stringify({nativeError:String(root&&root.__dsoNativeCompletionError||""),relocationsAfter:Number(root&&root.__dsoNativeCompletionRelocations||0),text:String(model&&model.getValue&&model.getValue()||"")});})()`;
}

/** Builds a renderer probe that restores the editor option changed by the fixture. */
function nativeSuggestionCleanupExpression() {
  return `(function(){const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,state=root&&root.__dsoNativeProviderE2E;if(editor&&editor.updateOptions&&state&&state.priorQuick!==undefined){editor.updateOptions({quickSuggestions:state.priorQuick});}if(root){root.__dsoNativeProviderE2E=null;}return JSON.stringify({ok:true});})()`;
}

/** Evaluates one renderer expression and parses its JSON result. */
async function rendererJson(expression) {
  return JSON.parse(await vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", expression));
}

/** Polls one renderer snapshot while leaving the extension host free to serve providers. */
async function waitForRendererState(expression, predicate) {
  let state = {};
  for (let attempt = 0; attempt < 60; attempt += 1) {
    state = await rendererJson(expression);
    if (predicate(state)) { return state; }
    await delay(20);
  }
  return state;
}

/** Waits for a short interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertNativeProviderParticipation };
