// Exercises staged-save recovery and related-table isolation through rendered webview controls.

/** Waits for one observable UI state with bounded, useful failure diagnostics. */
async function waitFor(document, predicate, label) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const result = predicate(); if (result) { return result; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out at ${label}: ${document.getElementById("status")?.textContent}`);
}

/** Opens a rendered scalar cell with the normal double-click and Enter interactions. */
function editCell(document, selector, value) {
  const cell = document.querySelector(selector);
  if (!cell) { throw new Error(`Missing editable cell: ${selector}`); }
  cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const input = cell.querySelector("input");
  if (!input) { throw new Error(`Cell did not open an input: ${selector}`); }
  const label = input.ariaLabel;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  return label;
}

/** Verifies save snapshots, failure recovery, native datetime input, and parent/child editor separation. */
export async function runModelStabilityE2eProbe({ document, postMessage, requestId }) {
  const progress = (stage) => postMessage({ requestId, stage, type: "e2eQueryBuilderProbeProgress" });
  try {
    const commit = document.getElementById("commit"), reload = document.getElementById("reload");
    const cell = (field) => document.querySelector(`#tbody td[data-attname="${field}"]`);
    const main = (field) => `#tbody td[data-attname="${field}"]`;
    await waitFor(document, () => cell("name"), "initial model rows");
    progress("commit-newer-edit");
    editCell(document, main("name"), "saved name"); commit.click();
    if (!commit.disabled || !reload.disabled) { throw new Error("Commit pending controls remain enabled."); }
    editCell(document, main("notes"), "newer notes");
    await waitFor(document, () => !commit.disabled && cell("name")?.dataset.staged === undefined && cell("notes")?.dataset.staged === "newer notes", "newer draft survives save reload");
    progress("commit-failure-retry"); commit.click();
    await waitFor(document, () => !commit.disabled && !reload.disabled && document.getElementById("status")?.textContent?.includes("Commit failed"), "failed save releases controls");
    if (cell("notes")?.dataset.staged !== "newer notes") { throw new Error("Failed save lost staged notes."); }
    commit.click();
    await waitFor(document, () => commit.disabled && cell("notes")?.dataset.staged === undefined && cell("notes")?.textContent === "newer notes", "retry saves notes");
    progress("datetime-offset");
    const scroller = document.getElementById("gridwrap"); scroller.scrollLeft = scroller.scrollWidth;
    scroller.dispatchEvent(new Event("scroll"));
    await waitFor(document, () => cell("at"), "datetime column");
    const datetimeLabel = editCell(document, main("at"), "2026-09-07T12:01");
    if (!cell("at").dataset.staged.endsWith(".123456+00:00")) { throw new Error("Datetime input lost its offset or precision."); }
    commit.click();
    await waitFor(document, () => commit.disabled && cell("at")?.dataset.staged === undefined, "datetime saved");
    progress("related-editor-isolation");
    scroller.scrollLeft = 0; scroller.dispatchEvent(new Event("scroll"));
    await waitFor(document, () => cell("name"), "parent name column");
    editCell(document, main("name"), "keep parent draft");
    scroller.scrollLeft = scroller.scrollWidth; scroller.dispatchEvent(new Event("scroll"));
    const related = await waitFor(document, () => document.querySelector('button[data-act="rel"][data-rel="children"]'), "related rows control");
    related.click();
    const child = '#detailContent td[data-attname="name"]';
    await waitFor(document, () => document.querySelector(child), "related rows");
    editCell(document, child, "saved child");
    const childCommit = [...document.querySelectorAll("#detailContent button")].find((button) => button.textContent.startsWith("Commit Child"));
    if (!childCommit) { throw new Error("Related Commit button is missing."); }
    childCommit.click();
    await waitFor(document, () => !childCommit.disabled && document.querySelector('#detailContent [role="status"]')?.textContent.includes("Commit failed"), "related failure recovery");
    childCommit.click();
    await waitFor(document, () => childCommit.disabled && document.querySelector(child)?.textContent === "saved child" && document.querySelector(child)?.dataset.staged === undefined, "related retry and row refresh");
    scroller.scrollLeft = 0; scroller.dispatchEvent(new Event("scroll"));
    await waitFor(document, () => cell("name")?.dataset.staged === "keep parent draft", "parent draft after related save");
    if (commit.disabled || !commit.textContent.includes("1")) { throw new Error("Parent draft commit state was changed by the related response."); }
    postMessage({ requestId, snapshot: { datetimeLabel, newerEditPreserved: true, parentDraftPreserved: true, saveFailureRecovered: true, relatedFailureRecovered: true }, type: "e2eQueryBuilderProbeResult" });
  } catch (error) {
    postMessage({ requestId, snapshot: { error: error.message }, type: "e2eQueryBuilderProbeResult" });
  }
}
