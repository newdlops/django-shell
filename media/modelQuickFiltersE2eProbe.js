// Exercises compact filters through production webview controls and the real VS Code host message boundary.

/** Waits for one rendered state without changing the Recipe or bypassing validation. */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = predicate(); if (value) { return value; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Quick filters timed out at ${label}.`);
}

/** Includes host validation diagnostics when a supposedly complete draft cannot be applied. */
async function readyToApply(document) {
  try { await waitFor(() => !document.getElementById("queryDrawerApply").disabled, "validated draft"); }
  catch (error) {
    throw new Error(`${error.message} ${JSON.stringify({ status: document.getElementById("queryDrawerStatus")?.textContent, issues: document.getElementById("queryIssueSummary")?.textContent, fields: [...document.querySelectorAll('#queryWhereRoot input,#queryWhereRoot select')].map((node) => [node.getAttribute("aria-label"), node.value]) })}`);
  }
}

/** Selects an allowlisted field and types into the resulting scalar control. */
async function addTextCondition(document, field, value) {
  const existing = new Set([...document.querySelectorAll('#queryWhereRoot [data-role="comparison"]')].map((node) => node.dataset.queryNodeId));
  document.querySelector('#queryWhereRoot button[aria-label="Add condition to this group"]').click();
  const row = await waitFor(() => [...document.querySelectorAll('#queryWhereRoot [data-role="comparison"]')].find((node) => !existing.has(node.dataset.queryNodeId)), "new condition");
  const select = await waitFor(() => {
    const control = row.querySelector('select[aria-label="Condition field"]');
    return control && [...control.options].some((option) => option.value === `field:${field}`) ? control : undefined;
  }, "field metadata");
  const nodeId = row.dataset.queryNodeId;
  select.value = `field:${field}`; select.dispatchEvent(new Event("change", { bubbles: true }));
  const input = await waitFor(() => {
    const control = document.querySelector(`[data-query-node-id="${nodeId}"] input[aria-label="Comparison value"]`);
    return control && document.activeElement === control ? control : undefined;
  }, "value focus");
  input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

/** Applies two OR conditions, clears and undoes them, then restores the initial unfiltered query. */
export async function runModelQuickFiltersE2eProbe(document, progress) {
  const get = (id) => document.getElementById(id);
  const filterButton = await waitFor(() => get("queryFilterButton"), "filter action");
  filterButton.click();
  await waitFor(() => get("queryBuilderTitle").textContent === "Filters", "compact editor");
  if (get("queryDirtyState").hidden !== true || !get("queryReviewPane").hidden) { throw new Error("Opening compact filters changed the draft or exposed the review pane."); }
  await addTextCondition(document, "username", "demo");
  await addTextCondition(document, "status", "active");
  const join = document.querySelector('#queryWhereRoot select[aria-label="Join conditions"]');
  join.value = "or"; join.dispatchEvent(new Event("change", { bubbles: true }));
  await readyToApply(document);
  if (get("queryFilterButton").textContent !== "Filters 0") { throw new Error("Editing filters applied the draft prematurely."); }
  progress("quick-filters-draft");
  const currentInput = document.querySelector('#queryWhereRoot input[aria-label="Comparison value"]');
  currentInput.focus(); currentInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }));
  await waitFor(() => get("queryFilterButton").textContent === "Filters 2" && get("queryDrawerStatus").textContent === "Applied query is current.", "keyboard Apply");
  get("queryClearFilters").click();
  if (get("queryFilterButton").textContent !== "Filters 2") { throw new Error("Clear filters executed without Apply."); }
  get("queryUndo").click();
  await waitFor(() => document.querySelectorAll('#queryWhereRoot [data-role="comparison"]').length === 2, "Undo clear");
  get("queryClearFilters").click();
  await readyToApply(document);
  get("queryDrawerApply").click();
  await waitFor(() => get("queryFilterButton").textContent === "Filters 0" && get("queryDrawerStatus").textContent === "Applied query is current.", "Apply clear");
  get("queryClose").click();
  if (document.activeElement !== get("queryFilterButton")) { throw new Error("Closing compact filters lost keyboard focus."); }
  progress("quick-filters-passed");
  return { cleared: true, keyboardApply: true, undo: true };
}
