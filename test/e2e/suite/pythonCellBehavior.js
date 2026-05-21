// Strict E2E checks for the v0.0.2-style file-backed Python cell.

const assert = require("node:assert/strict");
const vscode = require("vscode");

const INPUT_MARKER = "# --- django shell input ---";
const PRELUDE = "# Django shell runtime imports for analysis.\n# ruff: noqa\nfrom orm_runtime.models import Company\n\n";
const USER_CODE = "company = Company()\nprint(company.name.upper())\ncompanies = Company.objects.filter(name__icontains='Acme')\nfor item in companies:\n    print(item)";
const THEMED_SYMBOLS = ["company", "Company", "print", "name", "upper", "companies", "objects", "filter", "name__icontains", "Acme", "item"];

/** Verifies theme, completion, latency, and extension behavior on the current Python cell path. */
async function assertPythonCellBehavior(extension) {
  const root = vscode.workspace.workspaceFolders[0].uri;
  await writeDjangoOrmRuntimeFixture(root);
  await activatePythonExtensions();
  await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", ["from orm_runtime.models import Company"]);
  await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  await assertGeneratedOverlayFilesHidden("initial overlay show");
  const generatedText = `${PRELUDE}${INPUT_MARKER}\n${USER_CODE}`;
  await installOverlayDocument(generatedText);
  await assertGeneratedOverlayFilesHidden("overlay document install");
  await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  await assertGeneratedOverlayFilesHidden("overlay editor show");
  await assertExternalEnterDoesNotRun(extension);
  await assertGeneratedOverlayFilesHidden("external enter dispatch");
  const text = await waitForOpenDocumentText((value) => value.includes(USER_CODE));
  await assertGeneratedOverlayFilesHidden("overlay document open");
  await assertProviderFeatures(overlayUris().editor, text);
  await assertGeneratedOverlayFilesHidden("provider feature checks");
  await assertRendererTheme(extension);
  await assertGeneratedOverlayFilesHidden("renderer theme checks");
  await assertInputLatency(extension);
  await assertGeneratedOverlayFilesHidden("input latency checks");
}

/** Verifies Enter outside the overlay editor is not captured by stale focused CSS. */
async function assertExternalEnterDoesNotRun(extension) {
  const before = await e2eExecutionCount();
  let result = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    result = JSON.parse(await evalInWorkbench(extension, externalEnterExpression()));
    if (result.ok) {
      break;
    }
    await delay(150);
  }
  assert.equal(result.ok, true, `external enter probe failed: ${JSON.stringify(result)}`);
  await delay(500);
  assert.equal(await e2eExecutionCount(), before, "external Enter keydown triggered Python execution");
}

/** Writes a small Django-like runtime fixture for Python and ORM extension probes. */
async function writeDjangoOrmRuntimeFixture(root) {
  await writeFile(root, "manage.py", "import os\n\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'orm_project.settings')\n");
  await writeFile(root, "orm_project/__init__.py", "");
  await writeFile(root, "orm_project/settings.py", "INSTALLED_APPS = ['orm_runtime']\nSECRET_KEY = 'e2e'\n");
  await writeFile(root, "django/__init__.py", "def setup():\n    return None\n");
  await writeFile(root, "django/db/__init__.py", "from . import models\n");
  await writeFile(root, "django/db/models.py", [
    "from __future__ import annotations",
    "from typing import Generic, TypeVar",
    "_T = TypeVar('_T')",
    "class QuerySet(list[_T], Generic[_T]):",
    "    pass",
    "class Manager(Generic[_T]):",
    "    def __init__(self, model_name='Model'):",
    "        self.model_name = model_name",
    "    def filter(self, **kwargs: object) -> QuerySet[_T]:",
    "        return QuerySet([f'{self.model_name}:{kwargs}'])",
    "class Field:",
    "    def __init__(self, *args, **kwargs):",
    "        pass",
    "class CharField(Field):",
    "    pass",
    "class Model:",
    "    pass",
    ""
  ].join("\n"));
  await writeFile(root, "django/db/models.pyi", [
    "from __future__ import annotations",
    "from typing import Generic, TypeVar",
    "_T = TypeVar('_T')",
    "class QuerySet(list[_T], Generic[_T]):",
    "    pass",
    "class Manager(Generic[_T]):",
    "    def __init__(self, model_name: str = 'Model') -> None: ...",
    "    def filter(self, **kwargs: object) -> QuerySet[_T]: ...",
    "class Field:",
    "    def __init__(self, *args: object, **kwargs: object) -> None: ...",
    "class CharField(Field):",
    "    pass",
    "class Model:",
    "    pass",
    ""
  ].join("\n"));
  await writeFile(root, "orm_runtime/__init__.py", "");
  await writeFile(root, "orm_runtime/models.py", [
    "from __future__ import annotations",
    "from django.db import models",
    "class Company(models.Model):",
    "    name = models.CharField(max_length=100)",
    "    objects: models.Manager[Company] = models.Manager('Company')",
    ""
  ].join("\n"));
  await writeFile(root, "orm_runtime/models.pyi", [
    "from __future__ import annotations",
    "from django.db import models",
    "class Company(models.Model):",
    "    name: str",
    "    objects: models.Manager[Company]",
    ""
  ].join("\n"));
}

/** Writes one UTF-8 fixture file under the E2E workspace root. */
async function writeFile(root, relativePath, text) {
  const parts = relativePath.split("/");
  const fileName = parts.pop();
  const directory = parts.length ? vscode.Uri.joinPath(root, ...parts) : root;
  assert.ok(fileName, `file path required: ${relativePath}`);
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, fileName), Buffer.from(text, "utf8"));
}

/** Activates the real Python, Pylance, and Django ORM extensions. */
async function activatePythonExtensions() {
  await assertExtensionLoaded("ms-python.python");
  await assertExtensionLoaded("ms-python.vscode-pylance");
  await assertExtensionLoaded("newdlops.django-orm-intellisense");
}

/** Activates one required extension by id. */
async function assertExtensionLoaded(id) {
  const extension = vscode.extensions.getExtension(id);
  assert.ok(extension, `${id} must be available for strict Python cell E2E.`);
  await extension.activate();
  assert.equal(extension.isActive, true);
}

/** Installs the full generated overlay file text into both editor and analysis files. */
async function installOverlayDocument(text) {
  const uris = overlayUris();
  await replaceDocument(uris.editor, text);
  await replaceDocument(uris.analysis, text);
  await waitForOpenDocumentText((value) => value === text);
}

/** Replaces one workspace text document. */
async function replaceDocument(uri, text) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".django-shell"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  const opened = await vscode.workspace.openTextDocument(uri);
  const document = opened.languageId === "python" ? opened : await vscode.languages.setTextDocumentLanguage(opened, "python");
  if (document.getText() !== text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
  }
  await document.save();
}

/** Waits until the visible overlay file document matches one predicate. */
async function waitForOpenDocumentText(predicate) {
  const uri = overlayUris().editor;
  for (let attempt = 0; attempt < 80; attempt++) {
    const text = await readTextFile(uri);
    if (predicate(text)) {
      return text;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for overlay document: ${uri.toString()}`);
}

/** Verifies generated provider files are open only as hidden documents, never visible UI tabs. */
async function assertGeneratedOverlayFilesHidden(stage) {
  let exposed = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    exposed = generatedOverlayFileExposure();
    if (!exposed.length) {
      return;
    }
    await delay(100);
  }
  assert.deepEqual(exposed, [], `generated overlay files are visible after ${stage}`);
}

/** Returns UI-visible generated overlay file exposures. */
function generatedOverlayFileExposure() {
  const generated = new Set(Object.values(overlayUris()).map((uri) => uri.toString()));
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  const visibleEditors = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString());
  const tabUris = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.input?.uri?.toString?.()).filter(Boolean));
  return [
    ...visibleEditors.filter((uri) => generated.has(uri)).map((uri) => `visible:${uri}`),
    ...tabUris.filter((uri) => generated.has(uri)).map((uri) => `tab:${uri}`),
    ...(active && generated.has(active) ? [`active:${active}`] : [])
  ];
}

/** Verifies Python/Pylance completion, type hover, definition, and Django ORM hover. */
async function assertProviderFeatures(uri, text) {
  const labels = completionLabels(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, positionOfText(text, "Company.objects").translate(0, "Company.".length), "."));
  assert.ok(labels.includes("objects"), `missing objects completion: ${labels.slice(0, 40).join(",")}`);
  const companyHover = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, positionOfText(text, "company =").translate(0, 1)));
  assert.match(companyHover, /\bCompany\b/, `missing concrete Company hover: ${companyHover}`);
  assert.doesNotMatch(companyHover, /\b(Any|Unknown)\b/, `Company hover degraded: ${companyHover}`);
  const nameHover = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, positionOfText(text, "name.upper").translate(0, 1)));
  assert.match(nameHover, /\bstr\b|Field kind:\s*`?CharField`?/, `missing concrete name hover: ${nameHover}`);
  assert.doesNotMatch(nameHover, /\b(Any|Unknown)\b/, `name hover degraded: ${nameHover}`);
  const ormHover = await waitForHoverText(uri, positionOfText(text, "name__icontains").translate(0, 2), /Resolved from lookup path `?name__icontains`?/);
  assert.match(ormHover, /Base model:\s*`?(?:orm_runtime\.)?Company`?/, `missing Django ORM extension hover: ${ormHover}`);
  const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, positionOfText(text, "Company()").translate(0, 1));
  assert.ok(definitionUris(definitions).some((uri) => uri.includes("/orm_runtime/models")), `definition failed for Company: ${JSON.stringify(definitionUris(definitions))}`);
}

/** Waits for one hover provider result matching a pattern. */
async function waitForHoverText(uri, position, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    text = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position));
    if (pattern.test(text)) {
      return text;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for hover: ${text}`);
}

/** Reads a UTF-8 workspace file, returning an empty string while it is absent. */
async function readTextFile(uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

/** Verifies rendered Monaco theme colors are applied to every expected symbol. */
async function assertRendererTheme(extension) {
  const snapshot = await waitForRendererSnapshot(extension);
  assert.equal(snapshot.language, "python");
  assert.ok(String(snapshot.uri).endsWith("/.django-shell/console-cell.py"), String(snapshot.uri));
  assert.ok(renderedText(snapshot).includes("name__icontains"), JSON.stringify(snapshot.tokens));
  assert.ok(themeColorCount(snapshot) >= 3, `expected multiple theme colors: ${JSON.stringify(snapshot.tokens)}`);
  for (const symbol of THEMED_SYMBOLS) {
    const token = symbolToken(snapshot, symbol);
    assert.ok(token, `missing rendered symbol ${symbol}: ${JSON.stringify(snapshot.tokens)}`);
    assert.ok(visibleColor(token.color), `symbol ${symbol} has no theme color: ${JSON.stringify(token)}`);
    assert.match(String(token.className), /\bmtk\d+\b/, `symbol ${symbol} has no Monaco token class: ${JSON.stringify(token)}`);
  }
}

/** Waits for renderer syntax token data to become available. */
async function waitForRendererSnapshot(extension) {
  let last = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    last = JSON.parse(await evalInWorkbench(extension, rendererSnapshotExpression()));
    if (last.hasEditor && last.tokens?.length && renderedText(last).includes("Acme")) {
      return last;
    }
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await delay(150);
  }
  throw new Error(`Timed out waiting for renderer syntax snapshot: ${JSON.stringify(last)}`);
}

/** Verifies overlay input render latency stays within regular editor latency plus 20ms. */
async function assertInputLatency(extension) {
  await evalInWorkbench(extension, `(function(){try{if(typeof __dsoStartCapture==="function"){__dsoStartCapture();return "ok";}return "missing-start-capture";}catch(e){return "capture-error:"+String(e&&e.message||e);}})()`);
  const baselineUri = await openLatencyBaselineEditor();
  try {
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    const latency = JSON.parse(await evalInWorkbench(extension, rendererLatencyExpression()));
    assert.equal(latency.reason, undefined, `latency probe failed: ${JSON.stringify(latency)}`);
    assert.equal(latency.graceMs, 20, `latency grace changed: ${JSON.stringify(latency)}`);
    assert.ok(latency.overlayMedianMs <= latency.baselineMedianMs + 20, `input latency exceeded baseline + 20ms: ${JSON.stringify(latency)}`);
  } finally {
    await closeTabForUri(baselineUri);
  }
}

/** Opens a normal Python editor used as the latency baseline. */
async function openLatencyBaselineEditor() {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "latency-baseline.py");
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${USER_CODE}\n`, "utf8"));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside });
  await delay(300);
  return uri;
}

/** Closes the tab for one URI if it is open. */
async function closeTabForUri(uri) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input?.uri?.toString?.() === uri.toString()) {
        await vscode.window.tabGroups.close(tab, true);
      }
    }
  }
}

/** Evaluates one expression in the active VS Code workbench renderer. */
async function evalInWorkbench(extension, rendererExpression) {
  return vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", rendererExpression);
}

/** Builds the renderer expression that captures tokens and theme colors. */
function rendererSnapshotExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));await delay(220);const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();const css=(el)=>{const s=el&&window.getComputedStyle?window.getComputedStyle(el):null;return s?{backgroundColor:s.backgroundColor,borderColor:s.borderColor,color:s.color}:{};};const allSpans=Array.from((node||root||document).querySelectorAll(".view-line span"));const leafSpans=allSpans.filter((span)=>!span.querySelector("span"));const spans=leafSpans.length?leafSpans:allSpans;const tokens=spans.map((span)=>Object.assign({className:String(span.className||""),text:String(span.textContent||"")},css(span))).filter((token)=>token.text.trim());return JSON.stringify({editorBackground:css(node).backgroundColor,hasEditor:!!editor,language:model&&model.getLanguageId&&model.getLanguageId(),overlayBackground:css(root).backgroundColor,text:model&&model.getValue&&model.getValue(),tokens,uri:model&&model.uri&&String(model.uri)});})()`;
}

/** Builds a renderer expression that dispatches Enter from outside the overlay editor. */
function externalEnterExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!node){return JSON.stringify({ok:false,reason:"missing-overlay"});}const button=document.createElement("button");const hadFocused=!!(node.classList&&node.classList.contains("focused"));button.textContent="outside";button.style.cssText="position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";document.body.appendChild(button);try{node.classList.add("focused");button.focus();const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Enter",composed:true,key:"Enter",keyCode:13,which:13});button.dispatchEvent(event);await delay(120);return JSON.stringify({active:document.activeElement===button,defaultPrevented:event.defaultPrevented,ok:true});}finally{if(!hadFocused){try{node.classList.remove("focused");}catch(e){}}button.remove();try{editor.focus&&editor.focus();}catch(eFocus){}}})()`;
}

/** Builds the renderer expression that compares overlay and regular editor input latency. */
function rendererLatencyExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const frame=()=>new Promise((resolve)=>requestAnimationFrame(resolve));const clock=()=>performance&&performance.now?performance.now():Date.now();const round=(v)=>Math.round(v*100)/100;const median=(values)=>{const s=values.slice().sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay-editor"});}try{if(typeof __dsoScanDom==="function"){__dsoScanDom();}}catch(e){}const api=(globalThis.monaco&&globalThis.monaco.editor)?globalThis.monaco:((window.monaco&&window.monaco.editor)?window.monaco:null);const widgets=window.__dsoCaptures&&Array.isArray(window.__dsoCaptures.widgets)?window.__dsoCaptures.widgets:[];const publicEditors=api&&typeof api.editor.getEditors==="function"?api.editor.getEditors():[];const usable=(candidate)=>{const node=candidate&&candidate.getDomNode&&candidate.getDomNode();const candidateModel=candidate&&candidate.getModel&&candidate.getModel();const rect=node&&node.getBoundingClientRect&&node.getBoundingClientRect();const modelUri=String(candidateModel&&candidateModel.uri||"");return candidate!==editor&&node&&candidateModel&&modelUri.indexOf("/.django-shell/")<0&&typeof candidate.executeEdits==="function"&&(!root||!root.contains(node))&&rect&&rect.width>40&&rect.height>40;};let createError="";let createdEditor=null;let createdHost=null;let createdModel=null;const host=()=>{createdHost=document.createElement("div");createdHost.style.cssText="position:fixed;left:8px;top:8px;width:640px;height:220px;opacity:0;pointer-events:none;z-index:-1";document.body.appendChild(createdHost);return createdHost;};const createWorkbenchBaseline=()=>{if(typeof __dsoCreateWorkbenchEditor!=="function"){return null;}try{createdEditor=__dsoCreateWorkbenchEditor(host());try{createdEditor&&createdEditor.layout&&createdEditor.layout({width:640,height:220});}catch(eLayout){}return createdEditor;}catch(eWorkbench){createError="workbench:"+String(eWorkbench&&eWorkbench.message||eWorkbench);return null;}};const createBaseline=()=>{if(!api||!api.editor||typeof api.editor.create!=="function"){return null;}try{const uri=api.Uri&&api.Uri.parse?api.Uri.parse("inmemory://django-shell/latency-baseline-"+Date.now()+".py"):undefined;createdModel=typeof api.editor.createModel==="function"?api.editor.createModel(model.getValue(),"python",uri):null;}catch(eModel){createdModel=null;}try{createdEditor=api.editor.create(host(),{acceptSuggestionOnEnter:"on",automaticLayout:false,fixedOverflowWidgets:false,folding:true,formatOnPaste:false,formatOnType:false,glyphMargin:false,hover:{enabled:true},language:"python",lineNumbers:"on",lineNumbersMinChars:3,minimap:{enabled:false},model:createdModel||undefined,parameterHints:{enabled:true},quickSuggestions:true,scrollBeyondLastLine:false,suggestOnTriggerCharacters:true,value:createdModel?undefined:model.getValue()});try{createdEditor.layout&&createdEditor.layout({width:640,height:220});}catch(eLayout){}return createdEditor;}catch(ePublic){createError="public:"+String(ePublic&&ePublic.message||ePublic);return null;}};const baseline=widgets.find(usable)||publicEditors.find(usable)||createWorkbenchBaseline()||createBaseline();await frame();if(!baseline||!baseline.getModel||!baseline.getModel()){return JSON.stringify({canCreateBaseline:!!(typeof __dsoCreateWorkbenchEditor==="function"||(api&&api.editor&&api.editor.create)),createError,ok:false,publicEditors:publicEditors.length,reason:"missing-baseline-editor",widgets:widgets.length});}const baselineModel=baseline.getModel();const original=model.getValue();const baselineOriginal=baselineModel.getValue();const endRange=(m)=>{const lineNumber=m.getLineCount();const column=m.getLineMaxColumn(lineNumber);return{endColumn:column,endLineNumber:lineNumber,startColumn:column,startLineNumber:lineNumber};};const rendered=(ed)=>String((ed.getDomNode&&ed.getDomNode()||{}).textContent||"");const waitRendered=async(ed,marker,start)=>{for(let i=0;i<20;i++){if(rendered(ed).includes(marker)){return clock()-start;}await frame();}return 250;};const measure=async(ed,m,marker)=>{const range=endRange(m);try{ed.setPosition&&ed.setPosition({column:range.startColumn,lineNumber:range.startLineNumber});ed.revealPosition&&ed.revealPosition({column:range.startColumn,lineNumber:range.startLineNumber});}catch(e){}const start=clock();ed.executeEdits("django-shell-e2e-latency",[{forceMoveMarkers:true,range,text:"\\n"+marker+" = 1"}]);return waitRendered(ed,marker,start);};const overlaySamples=[];const baselineSamples=[];try{for(let i=0;i<3;i++){const marker="__dso_latency_"+Date.now().toString(36)+"_"+i;baselineModel.setValue(baselineOriginal);await delay(5);baselineSamples.push(await measure(baseline,baselineModel,marker+"_base"));model.setValue(original);await delay(5);overlaySamples.push(await measure(editor,model,marker+"_overlay"));model.setValue(original);}}finally{baselineModel.setValue(baselineOriginal);model.setValue(original);try{if(createdModel&&createdEditor&&createdEditor.dispose){createdEditor.dispose();}}catch(eDisposeEditor){}try{if(createdModel&&/^inmemory:\\/\\/django-shell\\/latency-baseline-/.test(String(createdModel.uri||""))){createdModel.dispose&&createdModel.dispose();}}catch(eDisposeModel){}try{if(createdModel&&createdHost&&createdHost.remove){createdHost.remove();}else if(createdHost){createdHost.style.display="none";}}catch(eRemove){}}const baselineMedianMs=median(baselineSamples);const overlayMedianMs=median(overlaySamples);return JSON.stringify({baselineMedianMs:round(baselineMedianMs),baselineSamplesMs:baselineSamples.map(round),graceMs:20,ok:overlayMedianMs<=baselineMedianMs+20,overlayMedianMs:round(overlayMedianMs),overlaySamplesMs:overlaySamples.map(round),samples:3});})()`;
}

/** Returns completion labels from a provider result. */
function completionLabels(result) {
  const items = result instanceof vscode.CompletionList ? result.items : result ?? [];
  return items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
}

/** Returns the next Python execution id from the custom console E2E snapshot. */
async function e2eExecutionCount() {
  const snapshot = await vscode.commands.executeCommand("djangoShell.e2eSnapshot");
  assert.equal(typeof snapshot.executionCount, "number", `missing execution count: ${JSON.stringify(snapshot)}`);
  return snapshot.executionCount;
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

/** Returns the zero-based position where a snippet starts in source text. */
function positionOfText(source, snippet) {
  const index = source.indexOf(snippet);
  assert.notEqual(index, -1, `missing source snippet: ${snippet}`);
  const lines = source.slice(0, index).split(/\r?\n/);
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

/** Returns normalized rendered text from one syntax snapshot. */
function renderedText(snapshot) {
  return (snapshot.tokens || []).map((token) => token.text).join("").replace(/\u00a0/g, " ");
}

/** Returns the token containing one symbol. */
function symbolToken(snapshot, symbol) {
  return (snapshot.tokens || []).find((token) => String(token.text).includes(symbol));
}

/** Returns whether one CSS color is visible. */
function visibleColor(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /^rgb/.test(text) && text !== "rgba(0,0,0,0)";
}

/** Returns how many distinct token colors are present. */
function themeColorCount(snapshot) {
  return new Set((snapshot.tokens || []).filter((token) => visibleColor(token.color)).map((token) => token.color)).size;
}

/** Returns generated overlay document URIs. */
function overlayUris() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  return { analysis: vscode.Uri.joinPath(root, ".django-shell", "analysis.py"), editor: vscode.Uri.joinPath(root, ".django-shell", "console-cell.py") };
}

/** Waits for a short interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertPythonCellBehavior };
