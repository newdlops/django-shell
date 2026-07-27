// Verifies Query Builder workspace stage and review-panel lifecycle without a browser window.
import assert from "node:assert/strict";
import test from "node:test";

import { createQueryWorkspace } from "../media/gridQueryWorkspace.js";

/** Creates a small mutable element double that records Query Builder accessibility state. */
function node() {
  const attributes = new Map();
  return {
    addEventListener() {},
    attributes,
    children: [],
    classList: { toggle(name, value) { this[name] = value; } },
    dataset: {},
    hidden: false,
    inert: false,
    parentElement: undefined,
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    style: {},
    tabIndex: 0,
    value: ""
  };
}

/** Creates all persistent workspace nodes required by the render-only presenter. */
function workspaceElements() {
  const workspace = node();
  workspace.insertBefore = (child) => { child.parentElement = workspace; };
  return {
    queryCalculatedValuesPanel: node(), queryDrawer: node(), queryEditorPane: node(), queryFilterResultsPanel: node(), queryFilterRowsPanel: node(), queryFocusMode: node(), queryInspectorMeaning: node(), queryInspectorOrm: node(), queryInspectorProblems: node(), queryMeaningPanel: node(), queryMobilePaneSwitch: node(), queryOrmPanel: node(), queryPreviewSection: node(), queryProblemsPanel: node(), queryResultPanel: node(), queryReviewPane: node(), queryStageCalculatedValues: node(), queryStageFilterResults: node(), queryStageFilterRows: node(), queryStageResult: node(), queryStageSelect: node(), queryWorkspace: workspace
  };
}

test("workspace exposes exactly one active stage and one active review panel", () => {
  const elements = workspaceElements();
  const workspace = createQueryWorkspace({ drawerResize: { setHeight() {} }, element: (tag, properties) => ({ ...node(), ...properties, tag }), elements, root: {}, uiState: { dispatch() {}, getSnapshot: () => ({ drawerHeight: 320 }) } });

  workspace.render({ activeStage: "calculatedValues", drawerHeight: 360, focusMode: true, inspectorScrollTops: {}, inspectorTab: "orm", mobilePane: "editor", stageScrollTops: {} });

  assert.equal(elements.queryDrawer.style.height, "360px");
  assert.equal(elements.queryFocusMode.textContent, "Exit Focus Builder");
  assert.equal(elements.queryCalculatedValuesPanel.hidden, false);
  assert.equal(elements.queryCalculatedValuesPanel.inert, false);
  assert.equal(elements.queryFilterRowsPanel.hidden, true);
  assert.equal(elements.queryFilterRowsPanel.inert, true);
  assert.equal(elements.queryStageCalculatedValues.attributes.get("aria-selected"), "true");
  assert.equal(elements.queryStageFilterRows.attributes.get("aria-selected"), "false");
  assert.equal(elements.queryOrmPanel.hidden, false);
  assert.equal(elements.queryMeaningPanel.hidden, true);
  assert.equal(elements.queryMeaningPanel.inert, true);
  assert.equal(elements.queryInspectorOrm.attributes.get("aria-selected"), "true");
});
