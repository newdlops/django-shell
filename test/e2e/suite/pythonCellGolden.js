// Golden-path E2E checks for setup, prelude loading, Python execution, and output.

const assert = require("node:assert/strict");
const vscode = require("vscode");
const { assertGoldenNoPreludeImportDiagnostics } = require("./pythonCellGoldenDiagnostics.js");
const { assertGoldenHiddenPreludeVisualStability } = require("./pythonCellGoldenVisual.js");

const INPUT_MARKER = "# --- django shell input ---";

/** Verifies backend setup, prelude-backed execution, and overlay output. */
async function assertGoldenPythonExecution({ extension, generatedText, importLines, inputMarker, installOverlayDocument, prelude, restoreImportLines, waitForOpenDocumentText }) {
  await ensureBackendReady();
  await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", importLines);
  await assertGoldenLargePreludeDisk(prelude, inputMarker);
  const djangoMarker = "E2E_DJANGO_SHELL orm_project.settings True orm_runtime.models";
  const completionPrefix = "import os; from django.apps import apps; print('E2E_DJANGO_SHELL', os.environ.get('DJANGO_SETTINGS_MODULE'), apps.ready, Company.__module__); print('E2E_GOLDEN', Company.";
  const completionSuffix = "objects.filter(name__icontains='Acme')[0])";
  const code = `${completionPrefix}${completionSuffix}`;
  const marker = "E2E_GOLDEN Company:{'name__icontains': 'Acme'}";
  await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  const preRunDisk = await generatedDiskSnapshot();
  const watcher = startGoldenFileObserver();
  const load = createGoldenRepoWatcherLoad();
  const visibility = createGoldenVisibilityMonitor(extension);
  try {
    await typeGoldenCode(extension, prelude, inputMarker, visibility, [
      { after: async () => assertGoldenCompletion(await waitForOpenDocumentText((value) => value.includes(completionPrefix))), text: completionPrefix },
      { text: completionSuffix }
    ]);
    await visibility.assertClean();
    const loaded = JSON.parse(await evalInWorkbench(extension, goldenInputSnapshotExpression(code)));
    assert.equal(loaded.ok, true, `golden input failed: ${JSON.stringify(loaded)}`);
    assert.equal(loaded.modelHasPrelude, false, `golden prelude occupied editor model: ${JSON.stringify(loaded)}`);
    assert.ok(Number(loaded.modelLineCount) < 40, `golden editor model grew with hidden prelude: ${JSON.stringify(loaded)}`);
    assert.ok(Number(loaded.inputStartLine) <= 3, `golden prelude occupied input layout: ${JSON.stringify(loaded)}`);
    assert.ok(Number(loaded.scrollTop) < 200, `golden prelude was hidden by scrolling instead of being removed: ${JSON.stringify(loaded)}`);
    assert.equal(loaded.preludeVisible, false, `golden prelude was rendered in Python cell: ${JSON.stringify(loaded)}`);
    await waitForOpenDocumentText((value) => value.includes(code));
    await assertGoldenPreludeLanguageFeatures(extension, code);
    await assertGoldenHiddenPreludeVisualStability({ code, evalInWorkbench, extension });
    await assertNoPreRunGeneratedSideEffects(extension, preRunDisk);
    const before = await e2eExecutionCount();
    assert.equal(await vscode.commands.executeCommand("djangoShell.overlayRunCurrentInput"), "host-requested", "golden command did not request host execution");
    await assertGoldenBackingFiles(prelude, inputMarker, code, watcher);
    const result = await waitForGoldenExecution(before, marker);
    assert.equal(result.ok, true, `golden execution failed: ${JSON.stringify(result)}`);
    assert.ok(String(result.text || "").includes(djangoMarker), `golden execution did not run inside manage.py shell: ${JSON.stringify(result)}`);
    const rendered = await waitForRenderedOutput(before, marker);
    assert.equal(rendered.ok, true, `golden Python cell output missing: ${JSON.stringify(rendered)}`);
    assert.equal(rendered.sawShellPrompt, false, `golden webview cell leaked raw shell prompt: ${JSON.stringify(rendered)}`);
    assert.equal(rendered.outputVisible, true, `golden output panel was not visible: ${JSON.stringify(rendered)}`);
    assert.ok(Number(rendered.outputCount) > 0, `golden output panel did not render an output item: ${JSON.stringify(rendered)}`);
    const postRun = JSON.parse(await evalInWorkbench(extension, goldenPostRunOverlayExpression(code)));
    assert.equal(postRun.ok, true, `golden overlay lost visible input after run: ${JSON.stringify(postRun)}`);
    const output = JSON.parse(await evalInWorkbench(extension, overlayOutputExpression(marker)));
    assert.equal(output.ok, true, `golden overlay output missing: ${JSON.stringify(output)} result=${JSON.stringify(result)}`);
    const enterMarker = await assertGoldenEnterExecution(extension);
    const enterOutput = JSON.parse(await evalInWorkbench(extension, overlayOutputExpression(enterMarker)));
    assert.equal(enterOutput.ok, true, `golden Enter overlay output missing: ${JSON.stringify(enterOutput)}`);
    const restored = JSON.parse(await evalInWorkbench(extension, overlayTextExpression(userTextFromGenerated(generatedText, inputMarker))));
    assert.equal(restored.ok, true, `golden restore failed: ${JSON.stringify(restored)}`);
    await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", restoreImportLines);
    await installOverlayDocument(generatedText);
  } finally {
    watcher.dispose();
    await load.catch(() => undefined);
  }
}

/** Starts the fixture Django manage.py shell and waits for backend attachment. */
async function ensureBackendReady() {
  if ((await e2eSnapshot()).runtimeReady) { return; }
  const python = process.env.DJANGO_SHELL_E2E_PYTHON || "python3";
  await vscode.commands.executeCommand("djangoShell.e2eWriteTerminal", `${JSON.stringify(python)} manage.py shell\r`);
  let snapshot = {};
  for (let attempt = 0; attempt < 160; attempt++) {
    snapshot = await e2eSnapshot();
    if (snapshot.runtimeReady) { return; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for backend readiness: ${JSON.stringify(snapshot)}`);
}

/** Waits until the backend reports the golden Python execution result. */
async function waitForGoldenExecution(before, marker) {
  let snapshot = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await e2eSnapshot();
    const result = snapshot.lastPythonResult || {};
    if (snapshot.executionCount > before && String(result.text || "").includes(marker)) { return result; }
    if (snapshot.executionCount > before && result.text && result.ok === false) { return result; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for golden output: ${JSON.stringify(snapshot)}`);
}

/** Waits until the custom console webview reports rendered Python cell output. */
async function waitForRenderedOutput(before, marker) {
  let snapshot = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await e2eSnapshot();
    const output = snapshot.lastRenderedOutput || {};
    if (output.execution >= before && String(output.text || "").includes(marker)) { return output; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for rendered Python cell output: ${JSON.stringify(snapshot)}`);
}

/** Returns the current custom console E2E snapshot. */
async function e2eSnapshot() {
  return vscode.commands.executeCommand("djangoShell.e2eSnapshot");
}

/** Returns the next Python execution id from the custom console E2E snapshot. */
async function e2eExecutionCount() {
  const snapshot = await e2eSnapshot();
  assert.equal(typeof snapshot.executionCount, "number", `missing execution count: ${JSON.stringify(snapshot)}`);
  return snapshot.executionCount;
}

/** Loads the hidden prelude and positions the overlay cursor at the user input line. */
async function assertGoldenPreludeLoaded(extension, prelude, inputMarker) {
  let loaded = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    loaded = JSON.parse(await evalInWorkbench(extension, goldenPreludeExpression(prelude, inputMarker)));
    if (loaded.ok) { return; }
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await delay(150);
  }
  assert.equal(loaded.ok, true, `golden prelude load failed: ${JSON.stringify(loaded)}`);
}

/** Types golden code at a user-like cadence, restarting if generated cleanup recreated the overlay. */
async function typeGoldenCode(extension, prelude, inputMarker, visibility, segments) {
  const sequence = Array.isArray(segments) ? segments : [{ text: segments }];
  let last = {};
  for (let restart = 0; restart < 6; restart++) {
    await assertGoldenPreludeLoaded(extension, prelude, inputMarker);
    await visibility.start();
    let completed = true;
    for (const segment of sequence) {
      for (const char of segment.text) {
        last = JSON.parse(await evalInWorkbench(extension, typeGoldenCharacterExpression(char)));
        if (!last.ok && last.reason === "missing-overlay") { completed = false; break; }
        assert.equal(last.ok, true, `golden character input failed for ${JSON.stringify(char)}: ${JSON.stringify(last)}`);
        await delay(18);
      }
      if (!completed) { break; }
      if (segment.after) { await segment.after(); }
    }
    if (completed) { return; }
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await delay(150);
  }
  assert.equal(last.ok, true, `golden character input failed after overlay restarts: ${JSON.stringify(last)}`);
}

/** Verifies completion is available at the ORM dot typed by the golden path. */
async function assertGoldenCompletion(documentText) {
  let labels = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const position = positionOfText(documentText, "Company.").translate(0, "Company.".length);
    labels = completionLabels(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", overlayUris().editor, position, "."));
    if (labels.includes("objects")) { return; }
    await delay(150);
  }
  assert.ok(labels.includes("objects"), `golden completion did not offer objects: ${labels.slice(0, 40).join(",")}`);
}

/** Verifies prelude-only symbols still drive type inference, navigation, and highlighting. */
async function assertGoldenPreludeLanguageFeatures(extension, code) {
  const uri = overlayUris().editor;
  const text = await readOpenOrFileText(uri);
  const userText = text.includes(INPUT_MARKER) ? text.slice(text.lastIndexOf(`${INPUT_MARKER}\n`) + INPUT_MARKER.length + 1) : text;
  assert.equal(userText.includes("from orm_runtime.models import Company"), false, `golden user code imported Company instead of relying on prelude: ${text}`);
  assert.ok(text.includes(code), `golden language feature text did not include user code: ${text.slice(-400)}`);
  const company = positionOfText(text, "Company.").translate(0, 1);
  const hover = await waitForGoldenHover(uri, company, /\bCompany\b|orm_runtime\.models\.Company|from orm_runtime\.models import Company/);
  const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, company);
  assert.ok(definitionUris(definitions).some((value) => value.includes("/orm_runtime/models")), `golden prelude definition failed for Company: hover=${hover} definitions=${JSON.stringify(definitionUris(definitions))}`);
  const highlight = JSON.parse(await evalInWorkbench(extension, goldenSyntaxHighlightExpression("Company")));
  assert.equal(highlight.ok, true, `golden prelude symbol syntax highlight failed: ${JSON.stringify(highlight)}`);
  await assertGoldenNoPreludeImportDiagnostics({ code, evalInWorkbench, extension, uri });
}

/** Verifies a real Enter key event executes code in the attached Django shell. */
async function assertGoldenEnterExecution(extension) {
  const marker = `E2E_ENTER_${Date.now().toString(36)}`;
  const before = await e2eExecutionCount();
  const dispatched = JSON.parse(await evalInWorkbench(extension, goldenEnterExecutionExpression(marker)));
  assert.equal(dispatched.ok, true, `golden Enter dispatch failed: ${JSON.stringify(dispatched)}`);
  let result;
  try {
    result = await waitForGoldenExecution(before, marker);
  } catch (error) {
    throw new Error(`golden Enter did not execute: dispatched=${JSON.stringify(dispatched)} error=${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(result.ok, true, `golden Enter did not execute in Django shell: ${JSON.stringify(result)}`);
  return marker;
}

/** Waits for a hover result matching one concrete type signal. */
async function waitForGoldenHover(uri, position, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    text = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position));
    if (pattern.test(text)) { return text; }
    await delay(150);
  }
  throw new Error(`golden prelude hover missing concrete signal: ${text}`);
}

/** Verifies console-cell.py and analysis.py receive the exact hidden-prelude/user-code split. */
async function assertGoldenBackingFiles(prelude, inputMarker, code, watcher) {
  const uris = overlayUris();
  let snapshot = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    const editor = await readOpenOrFileText(uris.editor);
    const analysis = await readOpenOrFileText(uris.analysis);
    const editorDisk = await readDiskTextFile(uris.editor);
    const analysisDisk = await readDiskTextFile(uris.analysis);
    const editorVisibleOk = editor.includes(code) && !editor.includes("__dso_large_prelude_");
    const editorDiskOk = editorDisk.includes(`${inputMarker}\n`) && editorDisk.includes(code);
    const analysisOk = [analysis, analysisDisk].every((text) => text.includes(code) && !text.includes(inputMarker));
    snapshot = { analysisDiskLines: lineCount(analysisDisk), analysisHasCode: analysis.includes(code), analysisHasMarker: analysis.includes(inputMarker), analysisLines: lineCount(analysis), editorDiskLines: lineCount(editorDisk), editorDiskOk, editorHasCode: editor.includes(code), editorLines: lineCount(editor), editorVisibleOk, analysisOk };
    if (editorVisibleOk && editorDiskOk && analysisOk) { await watcher.waitFor(prelude, inputMarker, code); return; }
    await delay(100);
  }
  assert.deepEqual(snapshot, { ...snapshot, editorVisibleOk: true, editorDiskOk: true, analysisOk: true }, `golden backing files did not sync: ${JSON.stringify(snapshot)}`);
}

/** Verifies live typing did not save generated files or expose generated tabs before execution. */
async function assertNoPreRunGeneratedSideEffects(extension, baseline) {
  const current = await generatedDiskSnapshot();
  const visual = JSON.parse(await evalInWorkbench(extension, generatedOverlayVisualExposureExpression()));
  assert.deepEqual(current, baseline, `generated files changed before execution: ${JSON.stringify({ before: diskSizes(baseline), after: diskSizes(current), exposure: generatedOverlayExposureDetails(), visual })}`);
  assert.deepEqual(visual.visible, [], `generated files became visible tabs before execution: ${JSON.stringify({ api: generatedOverlayExposureDetails(), visual })}`);
}

/** Returns generated file disk text for pre-run write detection. */
async function generatedDiskSnapshot() {
  const uris = overlayUris();
  return { analysis: await readDiskTextFile(uris.analysis), editor: await readDiskTextFile(uris.editor) };
}

/** Returns compact generated disk sizes for assertion messages. */
function diskSizes(snapshot) {
  return { analysisChars: snapshot.analysis.length, analysisLines: lineCount(snapshot.analysis), editorChars: snapshot.editor.length, editorLines: lineCount(snapshot.editor) };
}

/** Verifies the large prelude is really written to generated backing files before execution. */
async function assertGoldenLargePreludeDisk(prelude, inputMarker) {
  const uris = overlayUris();
  let snapshot = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    const editor = await readDiskTextFile(uris.editor);
    const analysis = await readDiskTextFile(uris.analysis);
    const editorOk = editor.startsWith(`${prelude}${inputMarker}\n`);
    const analysisOk = analysis.startsWith(prelude) && !analysis.includes(inputMarker);
    snapshot = { analysisLines: lineCount(analysis), analysisOk, editorLines: lineCount(editor), editorOk };
    if (editorOk && analysisOk && lineCount(editor) > 4000 && lineCount(analysis) > 4000) { return; }
    await delay(100);
  }
  assert.deepEqual(snapshot, { ...snapshot, editorOk: true, analysisOk: true }, `golden large prelude was not written to disk: ${JSON.stringify(snapshot)}`);
}

/** Starts throttled disk-reading watchers around generated files and noisy repo writes. */
function startGoldenFileObserver() {
  const uris = overlayUris();
  const state = { analysisEvents: 0, analysisReads: 0, analysisText: "", editorEvents: 0, editorReads: 0, editorText: "", loadEvents: 0 };
  let queue = Promise.resolve();
  const same = (a, b) => a.toString() === b.toString();
  const keyFor = (uri) => same(uri, uris.analysis) ? "analysis" : same(uri, uris.editor) ? "editor" : "";
  const enqueue = (uri, observed = true) => {
    const key = keyFor(uri);
    if (!key) { return; }
    if (observed) { state[`${key}Events`] += 1; }
    queue = queue.catch(() => undefined).then(async () => {
      await delay(140);
      state[`${key}Text`] = await readDiskTextFile(uri);
      state[`${key}Reads`] += 1;
    });
  };
  const generated = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0].uri, ".django-shell/*.py"));
  const load = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0].uri, "large_repo/**/*.py"));
  const document = vscode.workspace.onDidChangeTextDocument((event) => enqueue(event.document.uri));
  generated.onDidChange(enqueue); generated.onDidCreate(enqueue);
  load.onDidChange(() => { state.loadEvents += 1; }); load.onDidCreate(() => { state.loadEvents += 1; });
  return { dispose: () => { document.dispose(); generated.dispose(); load.dispose(); }, waitFor: (prelude, inputMarker, code) => waitForGoldenWatcher(state, () => { enqueue(uris.editor, false); enqueue(uris.analysis, false); return queue; }, prelude, inputMarker, code) };
}

/** Writes noisy Python files while golden typing runs to simulate large-repo watcher pressure. */
async function createGoldenRepoWatcherLoad() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const directory = vscode.Uri.joinPath(root, "large_repo", "watcher_load");
  await vscode.workspace.fs.createDirectory(directory);
  for (let index = 0; index < 120; index++) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, `noise_${index}.py`), Buffer.from(`value_${index} = ${index}\n`, "utf8"));
    if (index % 4 === 0) { await delay(8); }
  }
}

/** Waits until throttled watchers have read saved generated files from disk. */
async function waitForGoldenWatcher(state, queueOf, prelude, inputMarker, code) {
  let snapshot = {};
  for (let attempt = 0; attempt < 120; attempt++) {
    await queueOf().catch(() => undefined);
    const editorOk = state.editorText.includes(`${inputMarker}\n`) && state.editorText.includes(code);
    const analysisOk = state.analysisText.includes(code) && !state.analysisText.includes(inputMarker);
    snapshot = { analysisEvents: state.analysisEvents, analysisReads: state.analysisReads, analysisOk, editorEvents: state.editorEvents, editorReads: state.editorReads, editorOk, loadEvents: state.loadEvents };
    if (editorOk && analysisOk && state.editorReads > 0 && state.analysisReads > 0 && state.loadEvents > 0) { return; }
    await delay(100);
  }
  assert.deepEqual(snapshot, { ...snapshot, editorOk: true, analysisOk: true }, `golden throttled watchers did not observe saved files: ${JSON.stringify(snapshot)}`);
}

/** Builds a monitor that fails if hidden prelude becomes visible while typing. */
function createGoldenVisibilityMonitor(extension) {
  let started = false;
  return {
    assertClean: async () => {
      if (!started) { return; }
      const result = JSON.parse(await evalInWorkbench(extension, goldenVisibilityStopExpression()));
      assert.equal(result.preludeSamples, 0, `golden prelude flickered while typing: ${JSON.stringify(result)}`);
    },
    start: async () => {
      if (started) { return; }
      started = true;
      await evalInWorkbench(extension, goldenVisibilityStartExpression());
    }
  };
}

/** Evaluates one expression in the active VS Code workbench renderer. */
async function evalInWorkbench(extension, rendererExpression) {
  return vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", rendererExpression);
}

/** Builds a renderer expression that loads generated prelude text into the overlay model. */
function goldenPreludeExpression(prelude, inputMarker) {
  return `(async function(){const frame=()=>new Promise((resolve)=>setTimeout(resolve,32));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}const oldVisibility=root.style.visibility;root.style.visibility="hidden";try{root.__dsoSuppressModelSync=(root.__dsoSuppressModelSync||0)+1;try{model.setValue("");root.__dsoUseVisiblePrelude=false;root.__dsoPreludeText=${JSON.stringify(prelude)};window.__djangoShellOverlayPrelude=${JSON.stringify(prelude)};}finally{root.__dsoSuppressModelSync=Math.max(0,(root.__dsoSuppressModelSync||1)-1);}window.__dsoApplyPreludeHiddenArea&&window.__dsoApplyPreludeHiddenArea(root,editor);await frame();window.__dsoApplyPreludeHiddenArea&&window.__dsoApplyPreludeHiddenArea(root,editor);await frame();window.__dsoApplyPreludeHiddenArea&&window.__dsoApplyPreludeHiddenArea(root,editor);const line=model.getLineCount();editor.focus&&editor.focus();editor.setPosition&&editor.setPosition({lineNumber:line,column:model.getLineMaxColumn(line)});const text=String(model.getValue&&model.getValue()||"");return JSON.stringify({hasMarker:text.includes(${JSON.stringify(inputMarker)}),inputStartLine:root.__dsoInputStartLine,modelLineCount:model.getLineCount(),ok:!text.includes("__dso_large_prelude_")&&Number(root.__dsoInputStartLine||0)<=3,uri:model.uri&&String(model.uri)});}catch(error){return JSON.stringify({ok:false,reason:"prelude",error:String(error&&error.message||error)});}finally{root.style.visibility=oldVisibility||"visible";}})()`;
}

/** Builds a renderer expression that inserts one user-typed Python character. */
function typeGoldenCharacterExpression(char) {
  return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model});}try{let pos=editor.getPosition&&editor.getPosition();if(!pos){pos={lineNumber:model.getLineCount(),column:model.getLineMaxColumn(model.getLineCount())};editor.setPosition&&editor.setPosition(pos);}const text=${JSON.stringify(char)};const startLine=Number(root.__dsoInputStartLine||1);const range={endColumn:pos.column,endLineNumber:pos.lineNumber,startColumn:pos.column,startLineNumber:pos.lineNumber};editor.executeEdits("django-shell-e2e-golden-type",[{forceMoveMarkers:true,range,text}]);const targetLine=Math.min(model.getLineCount(),pos.lineNumber+Number(root.__dsoInputStartLine||startLine)-startLine);const targetColumn=Math.min(model.getLineMaxColumn(targetLine),pos.column+text.length);editor.setPosition&&editor.setPosition({lineNumber:targetLine,column:targetColumn});return JSON.stringify({column:targetColumn,lineNumber:targetLine,ok:true});}catch(error){return JSON.stringify({ok:false,reason:"type",error:String(error&&error.message||error)});}})()`;
}

/** Builds a renderer expression that verifies visible golden input state. */
function goldenInputSnapshotExpression(code) {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const rendered=(node)=>Array.from((node||document).querySelectorAll(".view-line")).filter((line)=>{const style=getComputedStyle(line);const rect=line.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.height>0&&rect.width>0;}).map((line)=>String(line.textContent||"").replace(/\\u00a0/g," ")).join("\\n");const leaks=(value)=>/Django shell runtime imports|# ruff: noqa|__dso_large_prelude_|from orm_runtime\\.models import Company|# --- django shell input ---/.test(String(value||""))||String(value||"").split("\\n").some((line)=>line.trim()==="pass");const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}await delay(180);const text=String(model.getValue&&model.getValue()||"");const renderedText=rendered(node);const modelHasPrelude=text.includes("Django shell runtime imports")||text.includes("__dso_large_prelude_");const preludeVisible=leaks(renderedText);const hasVisibleCode=renderedText.includes("Company.objects.filter");const inputStartLine=Number(root.__dsoInputStartLine||0);const modelLineCount=model.getLineCount&&model.getLineCount()||0;const scrollTop=Number(editor.getScrollTop&&editor.getScrollTop()||0);return JSON.stringify({chars:text.length,hasVisibleCode,inputStartLine,modelHasPrelude,modelLineCount,ok:text.includes(${JSON.stringify(code)})&&!modelHasPrelude&&!preludeVisible&&hasVisibleCode&&modelLineCount<40&&inputStartLine<=3&&scrollTop<200,preludeVisible,renderedText,scrollTop,uri:model.uri&&String(model.uri)});})()`;
}

/** Builds a renderer expression that ensures execution did not leave a prompt-only scrolled editor. */
function goldenPostRunOverlayExpression(code) {
  return `(function(){const visible=(line)=>{const style=getComputedStyle(line);const rect=line.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.height>0&&rect.width>0;};const textOf=(items)=>Array.from(items).filter(visible).map((line)=>String(line.textContent||"").replace(/\\u00a0/g," ")).join("\\n");const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}const renderedText=textOf(node.querySelectorAll(".view-line"));const promptText=textOf(node.querySelectorAll(".line-numbers"));const hasVisibleCode=renderedText.includes("Company.objects.filter");const hasPrompt=promptText.includes(">>>");const promptOnly=hasPrompt&&!hasVisibleCode;const text=String(model.getValue&&model.getValue()||"");return JSON.stringify({hasPrompt,hasVisibleCode,modelHasCode:text.includes(${JSON.stringify(code)}),ok:hasVisibleCode&&hasPrompt&&!promptOnly,promptOnly,promptText,renderedText,scrollTop:editor.getScrollTop&&editor.getScrollTop()});})()`;
}

/** Builds a renderer expression that executes a simple statement via real Enter dispatch. */
function goldenEnterExecutionExpression(marker) {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}const popupVisible=()=>Array.from(document.querySelectorAll(".suggest-widget,.parameter-hints-widget")).some((item)=>{const aria=item.getAttribute&&item.getAttribute("aria-hidden");if(item.classList&&item.classList.contains("hidden")){return false;}if(aria==="true"){return false;}if(item.classList&&(item.classList.contains("suggest-widget")||item.classList.contains("parameter-hints-widget"))&&!item.classList.contains("visible")&&aria!=="false"){return false;}const style=getComputedStyle(item);const rect=item.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&style.opacity!=="0"&&rect.width>0&&rect.height>0;});const line=${JSON.stringify(`print('${marker}')`)};try{const last=model.getLineCount();const column=model.getLineMaxColumn(last);const prefix=model.getLineContent(last).trim()?"\\n":"";editor.executeEdits("django-shell-e2e-enter-exec",[{forceMoveMarkers:true,range:{endColumn:column,endLineNumber:last,startColumn:column,startLineNumber:last},text:prefix+line}]);const target=last+(prefix?1:0);editor.focus&&editor.focus();editor.setPosition&&editor.setPosition({lineNumber:target,column:model.getLineMaxColumn(target)});const input=node.querySelector("textarea.inputarea, textarea")||node;try{input.focus&&input.focus();}catch(eInputFocus){}const escape=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Escape",composed:true,key:"Escape",keyCode:27,which:27});input.dispatchEvent(escape);await delay(140);root.__dsoLastEnterRunAt=0;window.__dsoLastRunOutcome=undefined;const payloadBefore=root.__dsoCurrentInputPayload&&root.__dsoCurrentInputPayload();const suggestBefore=popupVisible();const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Enter",composed:true,key:"Enter",keyCode:13,which:13});input.dispatchEvent(event);await delay(500);return JSON.stringify({active:document.activeElement&&document.activeElement.className,defaultPrevented:event.defaultPrevented,dispatchTarget:String(input.className||input.tagName||""),hasCleanup:!!root.__dsoEnterCleanup,hasLine:String(model.getValue&&model.getValue()||"").includes(line),hasRunner:!!root.__dsoRunCurrentInput,lastEnterRunAt:root.__dsoLastEnterRunAt,lastRunOutcome:window.__dsoLastRunOutcome,nodeContainsInput:node.contains&&node.contains(input),ok:true,payloadBefore,suggestBefore,suggestAfter:popupVisible(),textFocus:editor.hasTextFocus&&editor.hasTextFocus()});}catch(error){return JSON.stringify({ok:false,reason:"enter-exec",error:String(error&&error.message||error)});}})()`;
}

/** Builds a renderer expression that verifies the overlay output node text. */
function overlayOutputExpression(marker) { return `(function(){const root=document.getElementById("django-shell-overlay");const output=root&&root.querySelector(".django-shell-overlay-output");const text=String(output&&output.textContent||"");return JSON.stringify({className:String(output&&output.className||""),hasOutput:!!output,ok:text.includes(${JSON.stringify(marker)}),text});})()`; }

/** Builds a renderer expression that verifies Monaco rendered one visible token. */
function goldenSyntaxHighlightExpression(symbol) {
  return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const node=editor&&editor.getDomNode&&editor.getDomNode();const visible=(el)=>{const style=getComputedStyle(el);const rect=el.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.height>0&&rect.width>0;};const spans=Array.from((node||document).querySelectorAll(".view-line span")).filter((span)=>visible(span)&&String(span.textContent||"").includes(${JSON.stringify(symbol)}));const tokens=spans.map((span)=>({className:String(span.className||""),color:getComputedStyle(span).color,text:String(span.textContent||"")}));const token=tokens.find((item)=>/\\bmtk\\d+\\b/.test(item.className)&&/^rgb/.test(item.color));return JSON.stringify({ok:!!token,token,tokens:tokens.slice(0,8)});})()`;
}

/** Builds a renderer expression that replaces the current overlay model text. */
function overlayTextExpression(text) { return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!model){return JSON.stringify({ok:false,reason:"missing-model"});}model.setValue(${JSON.stringify(text)});return JSON.stringify({ok:String(model.getValue()).includes(${JSON.stringify(text.slice(-80))})});})()`; }

/** Returns visible user code from one generated console-cell text. */
function userTextFromGenerated(text, inputMarker) {
  const marker = `${inputMarker}\n`;
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

/** Builds a renderer expression that starts visible-prelude sampling. */
function goldenVisibilityStartExpression() { return `(function(){const leak=(text)=>/Django shell runtime imports|# ruff: noqa|__dso_large_prelude_|from orm_runtime\\.models import Company|# --- django shell input ---/.test(String(text||""))||String(text||"").split("\\n").some((line)=>line.trim()==="pass");const sample=()=>{const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const node=editor&&editor.getDomNode&&editor.getDomNode();const text=Array.from((node||document).querySelectorAll(".view-line")).filter((line)=>{const style=getComputedStyle(line);const rect=line.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.height>0&&rect.width>0;}).map((line)=>String(line.textContent||"").replace(/\\u00a0/g," ")).join("\\n");const state=window.__dsoGoldenVisibility||(window.__dsoGoldenVisibility={preludeSamples:0,samples:0,lastText:""});state.samples+=1;if(leak(text)){state.preludeSamples+=1;state.lastText=text.slice(0,500);}};clearInterval(window.__dsoGoldenVisibilityTimer);window.__dsoGoldenVisibility={preludeSamples:0,samples:0,lastText:""};window.__dsoGoldenVisibilityTimer=setInterval(sample,16);sample();return "ok";})()`; }

/** Builds a renderer expression that stops visible-prelude sampling. */
function goldenVisibilityStopExpression() { return `(function(){clearInterval(window.__dsoGoldenVisibilityTimer);const state=window.__dsoGoldenVisibility||{preludeSamples:0,samples:0,lastText:""};return JSON.stringify(state);})()`; }

/** Returns completion labels from a provider result. */
function completionLabels(result) {
  const items = result instanceof vscode.CompletionList ? result.items : result ?? [];
  return items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
}

/** Returns hover contents as plain text. */
function hoverText(hovers) {
  return (hovers || []).flatMap((hover) => hover.contents || []).map((content) => typeof content === "string" ? content : content.value || "").join("\n");
}

/** Returns URI strings from definition provider output. */
function definitionUris(result) {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  return items.map((item) => item.targetUri?.toString?.() || item.uri?.toString?.() || "");
}

/** Returns the number of logical lines in one text value. */
function lineCount(text) {
  return text ? String(text).split(/\r?\n/).length : 0;
}

/** Returns generated overlay document URIs. */
function overlayUris() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  return { analysis: vscode.Uri.joinPath(root, ".django-shell", "analysis.py"), editor: vscode.Uri.joinPath(root, ".django-shell", "console-cell.py") };
}

/** Returns UI-visible generated overlay file tabs. */
function generatedOverlayExposure() {
  const generated = new Set([overlayUris().analysis.toString(), overlayUris().editor.toString()]);
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.input?.uri?.toString?.()).filter((uri) => generated.has(uri)));
}

/** Returns detailed generated tab state for golden failure diagnostics. */
function generatedOverlayExposureDetails() {
  const generated = new Set([overlayUris().analysis.toString(), overlayUris().editor.toString()]);
  return {
    documents: vscode.workspace.textDocuments.filter((document) => generated.has(document.uri.toString())).map((document) => ({ dirty: document.isDirty, uri: document.uri.toString() })),
    tabs: vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter((tab) => generated.has(tab.input?.uri?.toString?.())).map((tab) => ({ active: tab.isActive, dirty: tab.isDirty, label: tab.label, preview: tab.isPreview, uri: tab.input?.uri?.toString?.() })))
  };
}

/** Builds a renderer expression that returns generated tabs still visible in the workbench DOM. */
function generatedOverlayVisualExposureExpression() {
  return `(function(){const visible=[];document.querySelectorAll(".tab").forEach((tab)=>{const label=[tab.getAttribute("aria-label")||"",tab.getAttribute("title")||"",tab.textContent||""].join(" ");if(!/analysis\\.py|console-cell\\.py/.test(label)){return;}const style=getComputedStyle(tab);const rect=tab.getBoundingClientRect();if(style.display!=="none"&&style.visibility!=="hidden"&&rect.width>0&&rect.height>0){visible.push({attrs:Array.from(tab.attributes).map((attr)=>[attr.name,attr.value]).slice(0,20),display:style.display,label:label.slice(0,240),visibility:style.visibility});}});return JSON.stringify({visible});})()`;
}

/** Returns the zero-based position where a snippet starts in source text. */
function positionOfText(source, snippet) {
  const index = source.indexOf(snippet);
  assert.notEqual(index, -1, `missing source snippet: ${snippet}`);
  const lines = source.slice(0, index).split(/\r?\n/);
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

/** Reads an open dirty document first, falling back to the saved workspace file. */
async function readOpenOrFileText(uri) {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  return open ? open.getText() : readTextFile(uri);
}

/** Reads a UTF-8 workspace file from disk, without consulting open text documents. */
async function readDiskTextFile(uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

/** Reads a UTF-8 workspace file, returning an empty string while it is absent. */
async function readTextFile(uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

/** Waits for a short interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertGoldenPythonExecution };
