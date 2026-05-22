// Golden-path visual probes for hidden prelude stability in the Python cell.

const assert = require("node:assert/strict");

/** Verifies hidden prelude lines never occupy or replace visible user input. */
async function assertGoldenHiddenPreludeVisualStability({ code, evalInWorkbench, extension }) {
  const result = JSON.parse(await evalInWorkbench(extension, hiddenPreludeVisualProbeExpression(code)));
  assert.equal(result.ok, true, `golden hidden-prelude visual stability failed: ${JSON.stringify(result)}`);
}

/** Builds a renderer expression that samples first and second line rendering while typing. */
function hiddenPreludeVisualProbeExpression(code) {
  const probe = "first_line = Company\nsecond_line = Company.objects";
  return `(async function(){
    const originalCode = ${JSON.stringify(code)};
    const probe = ${JSON.stringify(probe)};
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const root = document.getElementById("django-shell-overlay");
    const editor = root && root.__djangoShellEditor;
    const model = editor && editor.getModel && editor.getModel();
    const node = editor && editor.getDomNode && editor.getDomNode();
    if (!root || !editor || !model || !node) {
      return JSON.stringify({ ok: false, reason: "missing-overlay", hasRoot: !!root, hasEditor: !!editor, hasModel: !!model, hasNode: !!node });
    }
    const visibleText = () => Array.from(node.querySelectorAll(".view-lines .view-line")).filter((line) => {
      const style = getComputedStyle(line);
      const rect = line.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.height > 0 && rect.width > 0;
    }).map((line) => String(line.textContent || "").replace(/\\u00a0/g, " ")).join("\\n");
    const leaks = (value) => {
      const text = String(value || "");
      return /Django shell runtime imports|# ruff: noqa|__dso_large_prelude_|from orm_runtime\\.models import Company|# --- django shell input ---/.test(text)
        || text.split("\\n").some((line) => line.trim() === "pass");
    };
    const sampleOk = (sample, expectedStartLine) => {
      if (leaks(sample.text)) { return false; }
      if (sample.inputStartLine !== expectedStartLine) { return false; }
      if (sample.typed.includes("first_line = Company") && !sample.text.includes("first_line = Company")) { return false; }
      if (sample.typed.includes("second_line = Company.objects") && !sample.text.includes("second_line = Company.objects")) { return false; }
      return true;
    };
    const record = (samples, typed, phase, frameIndex) => samples.push({
      frame: frameIndex,
      inputStartLine: Number(root.__dsoInputStartLine || 0),
      modelLineCount: model.getLineCount(),
      phase,
      text: visibleText(),
      typed
    });
    const restore = () => {
      try {
        model.setValue(originalCode);
        window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor);
      } catch (error) {}
    };
    const oldVisibility = root.style.visibility;
    const samples = [];
    const backspace = [];
    try {
      root.style.visibility = "hidden";
      model.setValue("");
      window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor);
      await frame();
      window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor);
      await delay(80);
      const expectedStartLine = Number(root.__dsoInputStartLine || 0);
      editor.focus && editor.focus();
      editor.setPosition && editor.setPosition({ lineNumber: expectedStartLine, column: model.getLineMaxColumn(expectedStartLine) });
      root.style.visibility = oldVisibility || "visible";
      let typed = "";
      for (const char of probe) {
        const beforeStartLine = Number(root.__dsoInputStartLine || expectedStartLine);
        const pos = editor.getPosition && editor.getPosition() || { lineNumber: expectedStartLine, column: 1 };
        editor.executeEdits("django-shell-e2e-visual-type", [{
          forceMoveMarkers: true,
          range: { endColumn: pos.column, endLineNumber: pos.lineNumber, startColumn: pos.column, startLineNumber: pos.lineNumber },
          text: char
        }]);
        const afterStartLine = Number(root.__dsoInputStartLine || beforeStartLine);
        const targetLine = Math.min(model.getLineCount(), pos.lineNumber + afterStartLine - beforeStartLine + (char === "\\n" ? 1 : 0));
        const targetColumn = char === "\\n" ? 1 : Math.min(model.getLineMaxColumn(targetLine), pos.column + char.length);
        editor.setPosition && editor.setPosition({ lineNumber: targetLine, column: targetColumn });
        typed += char;
        const frameSamples = typed.endsWith("Company") || typed.endsWith("objects") || char === "\\n" ? 2 : 1;
        for (let index = 0; index < frameSamples; index++) {
          await frame();
          record(samples, typed, "raf", index);
        }
        await delay(0);
        record(samples, typed, "delay", 0);
      }
      await frame();
      const before = visibleText();
      const firstLine = Number(root.__dsoInputStartLine || expectedStartLine);
      editor.setPosition && editor.setPosition({ lineNumber: firstLine, column: 1 });
      const input = node.querySelector("textarea.inputarea, textarea") || node;
      input.focus && input.focus();
      for (let index = 0; index < 16; index++) {
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Backspace", composed: true, key: "Backspace", keyCode: 8, which: 8 });
        input.dispatchEvent(event);
        await frame();
        backspace.push({
          defaultPrevented: event.defaultPrevented,
          inputStartLine: Number(root.__dsoInputStartLine || 0),
          index,
          modelLineCount: model.getLineCount(),
          text: visibleText()
        });
        await delay(0);
      }
      const after = visibleText();
      const badSamples = samples.filter((sample) => !sampleOk(sample, expectedStartLine));
      const backspaceLeaks = backspace.filter((sample) => leaks(sample.text) || sample.inputStartLine !== expectedStartLine);
      const ok = badSamples.length === 0
        && backspaceLeaks.length === 0
        && before.includes("first_line = Company")
        && before.includes("second_line = Company.objects")
        && after.includes("first_line = Company")
        && after.includes("second_line = Company.objects")
        && !leaks(before)
        && !leaks(after)
        && Number(root.__dsoInputStartLine || 0) === expectedStartLine
        && model.getLineCount() < 10;
      return JSON.stringify({
        after,
        backspaceLeaks: backspaceLeaks.slice(0, 8),
        badSamples: badSamples.slice(0, 8),
        before,
        inputStartLine: Number(root.__dsoInputStartLine || 0),
        modelLineCount: model.getLineCount(),
        ok,
        sampleCount: samples.length
      });
    } catch (error) {
      return JSON.stringify({ ok: false, reason: "visual-probe", error: String(error && error.message || error), text: visibleText() });
    } finally {
      root.style.visibility = oldVisibility || "visible";
      restore();
    }
  })()`;
}

module.exports = { assertGoldenHiddenPreludeVisualStability };
