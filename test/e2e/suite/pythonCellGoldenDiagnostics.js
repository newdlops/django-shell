// Golden-path diagnostics probes for the visible Django shell Python cell.

const assert = require("node:assert/strict");
const vscode = require("vscode");

/** Verifies prelude-only runtime names are not reported as missing imports. */
async function assertGoldenNoPreludeImportDiagnostics({ code, evalInWorkbench, extension, uri }) {
  const probeName = `__dso_missing_probe_${Date.now().toString(36)}`;
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
  assert.ok(document, `missing visible overlay document: ${uri.toString()}`);
  assert.equal(document.languageId, "django-shell-python");
  assert.equal(vscode.languages.match({ language: "python", scheme: "file" }, document), 0, "direct Python providers must not analyze the full unordered shell source");
  assert.ok(vscode.languages.match({ language: "django-shell-python", scheme: "file" }, document) > 0);
  assertNoCompanyDiagnostics(uri, "before probe");
  const started = JSON.parse(await evalInWorkbench(extension, goldenDiagnosticProbeStartExpression(code, probeName)));
  assert.equal(started.ok, true, `golden diagnostic probe failed to start: ${JSON.stringify(started)}`);
  try {
    await delay(500);
    const probeDiagnostics = vscodeDiagnosticSnapshot(uri, probeName).relevantDiagnostics;
    assert.deepEqual(probeDiagnostics, [], `direct Python diagnostics leaked from the full unordered shell source: ${JSON.stringify({ probeDiagnostics })}`);
    assertNoCompanyDiagnostics(uri, "during probe");
  } finally {
    const restored = JSON.parse(await evalInWorkbench(extension, goldenDiagnosticProbeRestoreExpression()));
    assert.equal(restored.ok, true, `golden diagnostic probe failed to restore: ${JSON.stringify(restored)}`);
  }
  assertNoCompanyDiagnostics(uri, "after probe");
}

/** Builds a renderer expression that appends one deliberate unresolved symbol. */
function goldenDiagnosticProbeStartExpression(code, probeName) {
  return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model});}const original=String(model.getValue&&model.getValue()||"");if(!original.includes(${JSON.stringify(code)})){return JSON.stringify({ok:false,reason:"missing-code",text:original.slice(-500),uri:model.uri&&String(model.uri)});}root.__dsoGoldenDiagnosticOriginal=original;model.setValue(original+"\\n"+${JSON.stringify(probeName)}+"\\n");return JSON.stringify({ok:String(model.getValue&&model.getValue()||"").includes(${JSON.stringify(probeName)}),uri:model.uri&&String(model.uri)});})()`;
}

/** Builds a renderer expression that restores the Python cell after a probe. */
function goldenDiagnosticProbeRestoreExpression() {
  return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!model||typeof root.__dsoGoldenDiagnosticOriginal!=="string"){return JSON.stringify({ok:false,reason:"missing-original"});}model.setValue(root.__dsoGoldenDiagnosticOriginal);return JSON.stringify({ok:String(model.getValue&&model.getValue()||"")===root.__dsoGoldenDiagnosticOriginal,uri:model.uri&&String(model.uri)});})()`;
}

/** Asserts that Company does not receive a prelude false-positive diagnostic. */
function assertNoCompanyDiagnostics(uri, stage) {
  const snapshot = vscodeDiagnosticSnapshot(uri, "Company");
  assert.deepEqual(snapshot.relevantDiagnostics, [], `golden prelude-only runtime type produced VS Code missing-import diagnostics ${stage}: ${JSON.stringify(snapshot)}`);
}

/** Returns VS Code API diagnostics for one symbol at the generated editor URI. */
function vscodeDiagnosticSnapshot(uri, name) {
  const diagnostics = vscode.languages.getDiagnostics(uri).map((item) => diagnosticFields(item));
  return { diagnostics, relevantDiagnostics: diagnostics.filter((item) => relevantDiagnosticText(item, name)) };
}

/** Returns stable fields from one VS Code diagnostic. */
function diagnosticFields(diagnostic) {
  return { code: diagnostic.code === undefined ? "" : JSON.stringify(diagnostic.code), message: diagnostic.message || "", range: `${diagnostic.range.start.line}:${diagnostic.range.start.character}-${diagnostic.range.end.line}:${diagnostic.range.end.character}`, severity: diagnostic.severity, source: diagnostic.source || "" };
}

/** Returns whether one diagnostic mentions a missing prelude-only symbol. */
function relevantDiagnosticText(diagnostic, name) {
  const text = `${diagnostic.source || ""} ${diagnostic.code || ""} ${diagnostic.message || ""}`;
  return new RegExp(`\\b${name}\\b`).test(text) && /(not defined|undefined|unresolved|could not be resolved|missing import|reportUndefinedVariable|reportMissingImports)/i.test(text);
}

/** Waits for a short interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertGoldenNoPreludeImportDiagnostics };
