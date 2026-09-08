// Verifies exact FK selection and JSON list editing through real rendered webview controls.

/** Waits for one bounded rendered state and identifies the failed interaction. */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = predicate(); if (result) { return result; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out at ${label}.`);
}

/** Waits for the newly opened webview's focus and grid geometry to settle before typing. */
async function stableForeignKeyCell(document, requestFocus) {
  let previous, signature = "", since = 0, requestedFocus = false;
  return waitFor(() => {
    const cell = document.querySelector('#tbody td[data-attname="company_id"]');
    const rect = cell?.getBoundingClientRect();
    if (rect?.width > 0 && rect?.height > 0 && !requestedFocus) {
      requestedFocus = true;
      requestFocus({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    const current = rect ? [rect.x, rect.y, rect.width, rect.height].join(":") : "";
    if (cell !== previous || current !== signature || !document.hasFocus()) { previous = cell; signature = current; since = performance.now(); }
    return cell && rect.width > 0 && rect.height > 0 && document.hasFocus() && performance.now() - since >= 200 ? cell : undefined;
  }, "focused and stable foreign-key cell");
}

/** Exercises pending, empty, error, selection, numeric precision, and successful save states. */
export async function runModelIntegrityE2eProbe({ document, postMessage, requestId }) {
  const progress = (stage) => postMessage({ requestId, stage, type: "e2eQueryBuilderProbeProgress" });
  let debugCell, debugInput;
  try {
    const cell = (field) => document.querySelector(`#tbody td[data-attname="${field}"]`);
    const fk = await stableForeignKeyCell(document, (point) => postMessage({ requestId, point, type: "e2eFocusIntegrityCell" })); debugCell = fk;
    progress("fk-search-states");
    fk.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = await waitFor(() => fk.querySelector("input"), "foreign-key input"); debugInput = input;
    if (!fk.textContent.includes("Searching")) { throw new Error("FK search has no pending state."); }
    /** Types into the actual search input and waits for the resulting visible state. */
    async function search(text, expected) {
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => fk.textContent.includes(expected), `FK search ${text}`);
    }
    await search("empty", "No matching rows");
    postMessage({ requestId, type: "e2eBlurIntegrityCell" });
    await waitFor(() => !document.hasFocus(), "webview focus departure");
    await search("fail", "Search failed");
    await search("Beta", "#2 · Beta");
    if (!input.isConnected || cell("company_id").dataset.staged !== undefined) { throw new Error("Losing webview focus staged an unconfirmed FK search."); }
    const inputRect = input.getBoundingClientRect();
    postMessage({ requestId, point: { x: inputRect.left + inputRect.width / 2, y: inputRect.top + inputRect.height / 2 }, type: "e2eFocusIntegrityCell" });
    await waitFor(() => document.hasFocus() && document.activeElement === input, "foreign-key focus return");
    if (input.getAttribute("aria-expanded") !== "true" || !input.getAttribute("aria-activedescendant")) { throw new Error("FK keyboard selection is not exposed."); }
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    if (cell("company_id").dataset.staged !== "001") { throw new Error("FK selection lost its alternate key or leading zeros."); }
    document.getElementById("commit").click();
    await waitFor(() => document.getElementById("commit").disabled && cell("company_id")?.dataset.staged === undefined && cell("company_id")?.textContent.startsWith("001"), "foreign-key save");
    progress("exact-json-list-edit");
    const scroller = document.getElementById("gridwrap"); scroller.scrollLeft = scroller.scrollWidth; scroller.dispatchEvent(new Event("scroll"));
    const data = await waitFor(() => cell("data"), "JSON column");
    data.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const modal = await waitFor(() => document.querySelector('.arrayedit-panel[role="dialog"]'), "list editor");
    const arrayPageSize = modal.querySelectorAll("tbody tr").length;
    if (arrayPageSize !== 50) { throw new Error(`Large list rendered ${arrayPageSize} rows instead of one page.`); }
    const integer = modal.querySelector('[aria-label="ref, row 1"]'), name = modal.querySelector('[aria-label="name, row 1"]');
    if (integer?.value !== "9007199254740993" || integer.type !== "text") { throw new Error("List editor rounded its untouched integer."); }
    name.value = "edited"; name.dispatchEvent(new Event("input", { bubbles: true }));
    [...modal.querySelectorAll("button")].find((button) => button.textContent === "Apply").click();
    if (!cell("data").dataset.staged.includes('"ref":9007199254740993')) { throw new Error("Applying the list changed an untouched integer."); }
    document.getElementById("commit").click();
    await waitFor(() => document.getElementById("commit").disabled && cell("data")?.dataset.staged === undefined, "JSON save");
    progress("large-json-pagination");
    cell("data").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const pages = await waitFor(() => document.querySelector('.arrayedit-panel[role="dialog"]'), "paged list editor");
    const pageButton = (label) => [...pages.querySelectorAll("button")].find((button) => button.textContent === label);
    pageButton("Next").click();
    const other = pages.querySelector('[aria-label="name, row 51"]');
    other.value = "page edited"; other.dispatchEvent(new Event("input", { bubbles: true }));
    pageButton("Previous").click();
    if (pages.querySelector('[aria-label="name, row 1"]').value !== "edited") { throw new Error("Previous-page values changed."); }
    pageButton("Next").click();
    if (pages.querySelector('[aria-label="name, row 51"]').value !== "page edited") { throw new Error("Page navigation discarded an edit."); }
    pageButton("+ Add item").click();
    const added = pages.querySelector('[aria-label="name, row 10001"]');
    if (!added || pages.querySelectorAll("tbody tr").length !== 1) { throw new Error("Adding an item did not open its final page."); }
    pages.querySelector('[aria-label="Delete row 10001"]').click();
    if (pages.querySelectorAll("tbody tr").length !== 50 || !pages.contains(document.activeElement)) { throw new Error("Deleting the final item lost the page or keyboard focus."); }
    pageButton("Apply").click();
    document.getElementById("commit").click();
    await waitFor(() => document.getElementById("commit").disabled && cell("data")?.dataset.staged === undefined, "paged JSON save");
    postMessage({ requestId, snapshot: { fkStates: ["pending", "empty", "error", "selected", "saved"], exactJson: true, arrayPageSize, arrayPaging: true, viewport: { width: window.innerWidth, height: window.innerHeight } }, type: "e2eQueryBuilderProbeResult" });
  } catch (error) {
    postMessage({ requestId, snapshot: { error: error.message, focus: document.hasFocus(), activeControl: document.activeElement?.className, cellConnected: debugCell?.isConnected, inputConnected: debugInput?.isConnected }, type: "e2eQueryBuilderProbeResult" });
  }
}
