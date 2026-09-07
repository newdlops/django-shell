// Covers correlated main/related commit outcomes and exception recovery at the webview host boundary.

import assert from "node:assert/strict";
import test from "node:test";
import { hostHarness } from "./stabilityHostHarness.mjs";
const harness = hostHarness();

for (const type of ["commitEdits", "commitRelated"]) {
  test(`${type} always posts the originating editor and commit identity after a rejected save`, async () => {
    harness.posted.length = 0;
    const browser = new harness.ModelBrowser("/extension", { modelTransportInfo: () => ({ active: "tcp", mode: "auto" }), modelCommit: async () => { throw new Error("PTY process exited"); } });
    await browser.openModel({ app: "fixture", model: "Parent" });
    const panel = [...browser.panels][0];
    await panel.handleMessage({ app: "fixture", model: "Child", type, editorId: "editor-2", commitId: "editor-2-1", changes: [{ pk: 1, fields: { name: "changed" } }] });
    const response = harness.posted.find((message) => message.type === "commit");
    assert.equal(response.editorId, "editor-2"); assert.equal(response.commitId, "editor-2-1");
    assert.equal(response.result.ok, false); assert.match(response.result.error, /could not be confirmed.*PTY process exited/);
    assert.equal(response.model, type === "commitRelated" ? "fixture.Child" : "fixture.Parent");
    browser.dispose();
  });
}
