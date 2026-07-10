// Query-mode bar: lets the user run custom ORM code whose result fills the existing grid.

let queryPost;
let geometryFrame = 0;
let lastGeometryKey = "";

/** Switches the grid into custom-query mode and wires its workbench overlay anchor. */
export function enterQueryMode(post, initialCode = "") {
  const input = document.getElementById("queryinput");
  queryPost = post;
  if (typeof initialCode === "string") { input.value = initialCode; }
  document.getElementById("querybar").hidden = false;
  document.getElementById("filterbar").hidden = true;
  const count = document.getElementById("count");
  if (count) {
    count.hidden = true;
  }
  if (input.dataset.queryOverlayWired) { requestQueryOverlay(true); return; }
  input.dataset.queryOverlayWired = "true";
  const run = () => post({ code: input.value, type: "runQuery", useOverlay: true });
  document.getElementById("runQuery").addEventListener("click", run);
  input.addEventListener("input", () => post({ code: input.value, type: "queryDraftChanged" }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  });
  input.addEventListener("click", () => requestQueryOverlay(true));
  if (typeof ResizeObserver === "function") { new ResizeObserver(() => scheduleQueryGeometry()).observe(input); }
  window.addEventListener("resize", scheduleQueryGeometry);
  window.addEventListener("scroll", scheduleQueryGeometry, true);
  window.visualViewport?.addEventListener("resize", scheduleQueryGeometry);
  window.visualViewport?.addEventListener("scroll", scheduleQueryGeometry);
  requestQueryOverlay(true);
}

/** Remeasures the query editor after the host reveals or refocuses its panel. */
export function measureQueryEditor(show = false) {
  if (show) { requestQueryOverlay(true); } else { scheduleQueryGeometry(); }
}

/** Mirrors the latest hidden overlay draft into the textarea fallback. */
export function setQueryDraft(code) {
  const input = document.getElementById("queryinput");
  if (input && typeof code === "string") { input.value = code; }
}

/** Schedules a coalesced query editor geometry update. */
function scheduleQueryGeometry() {
  if (geometryFrame) { return; }
  geometryFrame = requestAnimationFrame(() => { geometryFrame = 0; requestQueryOverlay(false); });
}

/** Posts the current textarea anchor geometry to the extension host. */
function requestQueryOverlay(show) {
  const input = document.getElementById("queryinput");
  if (!input || !queryPost) { return; }
  const rect = input.getBoundingClientRect();
  if (rect.width <= 40 || rect.height <= 40) { return; }
  const geometry = { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
  const key = `${geometry.left}:${geometry.top}:${geometry.width}:${geometry.height}`;
  if (!show && key === lastGeometryKey) { return; }
  lastGeometryKey = key;
  queryPost({ rect: geometry, type: show ? "showQueryOverlay" : "queryEditorGeometry" });
}
