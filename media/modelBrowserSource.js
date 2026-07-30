// Webview grid frontend for the Django model data browser.
import { appendLogEntry } from "./sqlHighlight.js";
import { parseEditableArray } from "./gridArrayEdit.js";
import { repaintPins, togglePin } from "./gridPin.js";
import { createEditor, stagedDisplay } from "./gridEdit.js";
import { enterQueryMode, measureQueryEditor, setQueryDraft } from "./gridQuery.js";
import { makeResizable } from "./gridResize.js";
import { buildEditableRelatedTable } from "./gridRelated.js";
import { createVirtualRows } from "./gridVirtual.js";
import { createGridViewport, DOM_CELL_BUDGET, logicalColumns } from "./gridViewport.js";
import { installGridKeyboard } from "./gridKeyboard.js";
import { reportGridRender } from "./gridDiagnostics.js";
import { createGridHeaderRenderer } from "./gridRenderer.js";
import { installLogDrawer, toggleLogPanel } from "./modelBrowserLogDrawer.js";
import { codicon } from "./modelBrowserIcons.js";
import { createQueryRunUi } from "./queryRunUi.js";
import { createAnnouncer } from "./uiAnnouncer.js";
import { installModelBrowserChrome } from "./modelBrowserChrome.js";
import { isQuerySurface, renderBrowserError } from "./modelBrowserSurface.js";
import { createCombobox } from "./gridCombobox.js";
import { createQueryController } from "./gridQueryController.js";
import { recipeLogLabel, resultCountLabel } from "./gridQueryResultBuilder.js";
import { renderQuerySummaryTable } from "./gridQuerySummaryTable.js";
import { runModelQueryBuilderE2eProbe } from "./modelQueryBuilderE2eProbe.js";
const vscode = acquireVsCodeApi();
const els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "fieldfinder", "fieldfindslot", "fieldfindClose", "interruptQuery", "openQueryConsole", "detailDrawer", "detailContent"]) {
  els[id] = document.getElementById(id);
}
const announcer = createAnnouncer(); installModelBrowserChrome(document);
const MAX_LOG_ENTRIES = 200;
const ALL_PAGE_SIZE = 1000000000;
const state = { columns: [], pk: "id", relations: [], rowCount: 0, totalCount: undefined, hasMore: false, order: [], model: "", pinned: new Set(), widths: {}, computed: {}, computedActive: new Set() };
let queryController;
queryController = createQueryController({ announcer, getPersisted: () => vscode.getState() || {}, gridAdapter: createQueryFocusGridAdapter(), onCount: onQueryCount, onRejected: onQueryRejected, onRows, onSummary: onQuerySummary, persist: (preferences) => vscode.setState({ ...(vscode.getState() || {}), ...preferences }), post: (message) => send(message), root: document, status: els.status });

/** Captures and restores grid scroll plus active-cell navigation for Focus Builder mode. */
function createQueryFocusGridAdapter() {
  let saved;
  return {
    /** Temporarily removes the grid from keyboard traversal without requesting data. */
    enterQueryFocusMode() {
      const active = els.gridwrap.querySelector('[role="gridcell"][tabindex="0"]');
      saved = { activeKey: active?.dataset.key || "", rowIndex: active?.closest("tr")?.dataset.rowIndex || "", scrollLeft: els.gridwrap.scrollLeft, scrollTop: els.gridwrap.scrollTop };
      els.gridwrap.inert = true;
      els.gridwrap.setAttribute("aria-hidden", "true");
      els.gridwrap.hidden = true;
    },
    /** Restores the exact captured view state when query focus mode ends. */
    exitQueryFocusMode() {
      els.gridwrap.inert = false;
      els.gridwrap.removeAttribute("aria-hidden");
      els.gridwrap.hidden = false;
      if (!saved) { return; }
      els.gridwrap.scrollLeft = saved.scrollLeft;
      els.gridwrap.scrollTop = saved.scrollTop;
      const row = [...els.gridwrap.querySelectorAll("tr[data-row-index]")].find((node) => node.dataset.rowIndex === saved.rowIndex);
      row?.querySelectorAll('[role="gridcell"]').forEach((cell) => { if (cell.dataset.key === saved.activeKey) { cell.focus(); } });
      saved = undefined;
    },
    /** Returns the documented non-mutating grid view projection. */
    getGridViewState() {
      const active = els.gridwrap.querySelector('[role="gridcell"][tabindex="0"]');
      return { activeGridFocusKey: active?.dataset.key || "", scrollLeft: els.gridwrap.scrollLeft, scrollTop: els.gridwrap.scrollTop, selectedRowKey: active?.closest("tr")?.dataset.rowIndex || "" };
    }
  };
}
const pendingRelated = new Map();
let relRequestId = 0; let progressLabel = ""; let progressStartedAt = 0; let progressTimer = 0;
let gridSnapshot; let gridViewport;
let detailTrigger;
let commitInFlight = false;
const editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => send({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  onCommitEnd: () => { commitInFlight = false; setCommitBlocked(false); updateEditButtons(editor.pendingCount()); },
  onCommitStart: (count) => { commitInFlight = true; setCommitBlocked(true); els.status.textContent = `Committing ${count} changes…`; announcer.announceStatus(`Committing ${count} changes…`); },
  notify: (text) => { els.status.textContent = text; }
});
const virtual = createVirtualRows({
  scroller: els.gridwrap,
  getBody: () => document.getElementById("tbody"),
  columnSpan: () => 1 + (gridSnapshot?.pinned.length || 0) + (gridSnapshot?.visible.length || 0) + Number(Boolean(gridSnapshot?.leftSpacerWidth)) + Number(Boolean(gridSnapshot?.rightSpacerWidth)),
  buildRow: (row, index) => { const tr = buildRow(row, index); editor.applyStaged(tr); return tr; },
  maxRows: () => Math.max(1, Math.floor(DOM_CELL_BUDGET / Math.max(1, (gridSnapshot?.pinned.length || 0) + (gridSnapshot?.visible.length || 0)))),
  onRender: () => repaintPins(els.gridwrap, state),
  shouldWindow: (rowCount) => gridViewport?.shouldVirtualizeRows(rowCount) ?? rowCount > 80
});
gridViewport = createGridViewport({
  onChange: (snapshot) => renderViewport(snapshot),
  pinned: () => state.pinned,
  scroller: els.gridwrap,
  widths: () => state.widths
});
const queryRunUi = createQueryRunUi({ announcer, post: (message) => vscode.postMessage(message), status: els.status });
const gridHeader = createGridHeaderRenderer({ el, relationKindLabel, relationModelName, state });
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => send({ type: "reload" }));
els.more.addEventListener("click", () => send({ type: "loadMore" }));
if (els.pageSize) { els.pageSize.addEventListener("change", () => send({ type: "reload" })); }
els.count.addEventListener("click", () => send({ type: "requestCount" }));
els.commit.addEventListener("click", () => editor.commitEdits());
els.discard.addEventListener("click", () => editor.discardEdits());
els.transport.addEventListener("change", () => vscode.postMessage({ type: "setTransport", mode: els.transport.value }));
els.logToggle.addEventListener("click", () => { const open = els.logpanel.hidden; toggleLogPanel({ open, panel: els.logpanel, toggle: els.logToggle }); vscode.setState({ ...(vscode.getState() || {}), logOpen: open }); });
els.logClear.addEventListener("click", () => { els.logbody.innerHTML = ""; });
els.logMode.addEventListener("click", () => {
  const showOrm = els.logbody.classList.toggle("mode-orm"); els.logbody.classList.toggle("mode-sql", !showOrm);
  els.logMode.textContent = showOrm ? "View: Django ORM" : "View: SQL";
});
installLogDrawer({ panel: els.logpanel, resizeHandle: els.logresize, toggle: els.logToggle, vscode });
els.fieldfindClose.addEventListener("click", () => closeFieldFinder());
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "f" || event.key === "F")) {
    event.preventDefault();
    toggleFieldFinder();
  } else if (event.key === "Escape" && !els.fieldfinder.hidden) {
    closeFieldFinder();
  }
});
vscode.postMessage({ type: "ready" });
function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (message.type === "e2eQueryBuilderProbe") {
    void runModelQueryBuilderE2eProbe({ document, postMessage: (value) => vscode.postMessage(value), requestId: message.requestId }).catch(() => vscode.postMessage({ requestId: message.requestId, snapshot: { error: "Query Builder E2E probe bootstrap failed." }, type: "e2eQueryBuilderProbeResult" }));
    return;
  }
  if (queryController.onMessage(message)) {
    return;
  }
  if (message.type === "loading") {
    renderLoading(message);
  } else if (message.type === "schema") {
    onSchema(message.schema);
  } else if (message.type === "rows") {
    onRows(message);
  } else if (message.type === "related") {
    onRelated(message);
  } else if (message.type === "lookup") {
    editor.onLookup(message);
  } else if (message.type === "filterFields") {
    // Recipe metadata editor requests are introduced by the next builder phase.
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    onQueryCount(message, queryController.getSnapshot());
  } else if (message.type === "commit") {
    logSql(`commit ${state.model}`, message.result && message.result.sql, message.result && message.result.orm);
    editor.handleResult(message.result);
  } else if (message.type === "transport") {
    els.transport.value = message.mode || "auto";
    els.transportInfo.innerHTML = message.mode === "orm" ? '<span class="pty">● ORM cell</span>' : message.active === "tcp" ? '<span class="on">● socket</span>' : message.active === "pty" ? '<span class="pty">● terminal</span>' : '<span class="off">○ not connected</span>';
  } else if (message.type === "queryMode") {
    enterQueryMode((payload) => send(payload), message.code || "");
  } else if (message.type === "measureQueryEditor") {
    measureQueryEditor(Boolean(message.show));
  } else if (message.type === "queryDraft") {
    setQueryDraft(message.code);
  } else if (message.type === "queryStarted") {
    queryRunUi.render({ startedAt: Date.now(), state: "running" });
  } else if (message.type === "queryRunState") {
    queryRunUi.render(message.snapshot || { state: "idle" });
  } else if (message.type === "overlayRunPython") {
    const code = typeof message.text === "string" ? message.text : String(message.code || "");
    send({ code, type: "runQuery", useOverlay: false });
  } else if (message.type === "busy") {
    renderBusy(message.message);
  } else if (message.type === "error") {
    renderError(message.message);
  }
}

function renderLoading(message) {
  if (!isQuerySurface()) {
    els.title.textContent = message.model || "Model Data";
  }
  els.subtitle.textContent = message.label || "";
  const labels = { aggregate: "Running aggregate…", filters: "Applying filters…", more: "Loading more rows…", rows: "Loading model rows…", schema: "Loading model schema…" };
  const label = labels[message.phase] || "Loading model rows…";
  if (!document.getElementById("tbody")) {
    els.gridwrap.innerHTML = "";
    els.gridwrap.appendChild(el("div", { className: "empty" }, label));
  }
  startProgress(label);
  els.more.disabled = true;
}
/** Shows a non-destructive busy state, preserving any loaded table instead of leaving a spinner active. */
function renderBusy(messageText) {
  stopProgress();
  if (!document.getElementById("tbody")) {
    els.gridwrap.innerHTML = "";
    els.gridwrap.appendChild(el("div", { className: "empty" }, messageText || "Django shell is busy."));
  }
  els.status.textContent = messageText || "Django shell is busy.";
  els.more.disabled = true;
}
function onSchema(schema) {
  const model = `${schema.app}.${schema.model}`;
  // ORM/Terminal mode re-posts the schema on every re-query (filter / annotate / sort); preserve pins, loaded @property
  // columns, and staged edits across a same-model reload so they aren't silently lost — only a genuine model change resets them.
  const sameModel = model === state.model && state.columns.length > 0;
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.totalCount = undefined;
  state.order = [];
  if (!sameModel) {
    state.pinned = new Set();
    state.computed = {};
    state.computedActive = new Set();
    // A different model has a different column coordinate system. Starting it at the prior model's horizontal
    // offset can place the row-number gutter at the far edge and initially expose only reverse relations.
    els.gridwrap.scrollLeft = 0;
    els.gridwrap.scrollTop = 0;
  }
  state.model = model;
  queryController.setSource({ app: schema.app, columns: state.columns, model: schema.model, relations: state.relations });
  els.title.textContent = isQuerySurface() ? "ORM Query" : model;
  els.subtitle.textContent = `${schema.label || ""} · ${schema.table || ""}`;
  els.countinfo.textContent = "";
  installGridTable();
  if (!sameModel) {
    editor.reset();
  }
}
/** Builds the virtualized row-grid shell and delegates header/body rendering to the current viewport. */
function installGridTable() {
  const table = el("table", { ariaLabel: `${state.model || "Model"} data`, ariaReadOnly: "false", role: "grid" });
  els.gridwrap.innerHTML = ""; els.gridwrap.appendChild(table);
  table.addEventListener("click", onTableClick);
  table.addEventListener("dblclick", onTableDblClick);
  installGridKeyboard(table, {
    activate: (cell) => {
      const button = cell.querySelector("button");
      if (button) { button.click(); } else { editor.editCell(cell); }
    },
    logicalKeys: () => [...(gridSnapshot?.pinned || []), ...(gridSnapshot?.scrollable || [])].map((column) => column.key),
    reveal: revealGridCell,
    closeDetail: closeOpenDetail, rowCount: () => state.rowCount,
    viewportRows: () => Math.floor(els.gridwrap.clientHeight / 24)
  });
  gridViewport.setColumns(logicalColumns(state.columns, state.relations, state.widths));
}
function onTableDblClick(event) {
  const td = event.target.closest("td.editable");
  if (td) {
    editor.editCell(td);
  }
}
function updateEditButtons(count) {
  els.commit.textContent = count ? `Commit ${count} changes` : "Commit";
  els.commit.disabled = !count || commitInFlight;
  els.discard.hidden = !count;
  els.discard.disabled = !count || commitInFlight;
  if (count && !commitInFlight) {
    els.status.textContent = `${count} uncommitted changes`;
  }
}
/** Disables actions that could race an atomic staged-edit commit, preserving their prior disabled state. */
function setCommitBlocked(blocked) {
  for (const control of [els.reload, els.more, els.pageSize, els.count, els.transport, document.getElementById("queryApply"), document.getElementById("queryDrawerApply")]) {
    if (!control) { continue; }
    if (blocked) {
      control.dataset.commitDisabled = control.disabled ? "preserve" : "restore";
      control.disabled = true;
    } else if (control.dataset.commitDisabled === "restore") {
      control.disabled = false;
      delete control.dataset.commitDisabled;
    } else {
      delete control.dataset.commitDisabled;
    }
  }
}
/** Maps a backend relation kind code to a compact header label (reverse-fk → reverseFK). */
function relationKindLabel(kind) {
  return { "fk": "FK", "m2m": "m2m", "o2o": "o2o", "reverse-fk": "reverseFK" }[kind] || kind;
}
/** Returns the bare model name from an app-qualified relation target label (app.Model → Model). */
function relationModelName(target) {
  return String(target || "").split(".").pop();
}
/** Replaces the table structure with just the columns visible in the current horizontal viewport. */
function renderViewport(snapshot) {
  const startedAt = performance.now();
  const table = els.gridwrap.querySelector("table");
  if (!table) {
    return;
  }
  gridSnapshot = snapshot;
  table.setAttribute("aria-colcount", String(1 + snapshot.pinned.length + snapshot.scrollable.length));
  table.setAttribute("aria-rowcount", state.totalCount === undefined ? "-1" : String(state.totalCount + 1));
  table.style.width = `${Math.max(snapshot.totalWidth, els.gridwrap.clientWidth)}px`;
  table.replaceChildren(gridHeader.buildHead(snapshot), el("tbody", { id: "tbody" }));
  makeResizable(table, state, () => gridViewport.refresh(true));
  virtual.refresh();
  reportGridRender({ logicalRows: state.rowCount, post: vscode.postMessage.bind(vscode), snapshot, startedAt, table });
}
/** Returns a stable signature of a column set's attnames, for detecting when annotation columns are added/removed. */
function columnAttnames(columns) {
  return (columns || []).map((column) => column.attname).join(",");
}
function onRows(message) {
  stopProgress();
  const rows = message.rows || {};
  if (!rows.ok) {
    renderError(rows.error || "Could not load rows.");
    return;
  }
  const fallbackColumns = !state.columns.length ? inferColumnsFromRows(rows.rows) : [];
  const responseColumns = Array.isArray(rows.columns) && rows.columns.length ? rows.columns : fallbackColumns;
  const columnsChanged = !message.append && responseColumns.length > 0 && columnAttnames(responseColumns) !== columnAttnames(state.columns);
  if (columnsChanged) {
    // Per-row annotation columns were added/removed — adopt the new column set for the grid head. When a terminal
    // response loses schema metadata, infer a read-only column set from its own rows rather than rendering blank lines.
    state.columns = responseColumns;
  }
  if (!document.getElementById("tbody") || columnsChanged) {
    // Rows arrived over an error view, or the column set changed — rebuild the grid skeleton.
    installGridTable();
  }
  logSql(recipeLogLabel(`rows ${state.model}`, message.queryLog), rows.sql, rows.orm);
  if (!message.append) {
    state.totalCount = undefined;
  }
  updateSortArrows();
  state.rowCount = virtual.setRows(rows.rows || [], Boolean(message.append));
  if (message.append) {
    for (const field of state.computedActive) {
      vscode.postMessage({ type: "loadComputed", field });
    }
  }
  state.hasMore = Boolean(rows.hasMore);
  els.more.disabled = !state.hasMore;
  const loaded = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " · more available" : ""}` : "No rows.";
  if (isQuerySurface() && !message.append) {
    const queryStatus = queryRunUi.successText(state.rowCount);
    els.status.textContent = queryStatus;
    announcer.announceStatus(queryStatus);
  } else {
    els.status.textContent = loaded;
  }
}
/** Updates count text for the exact applied Recipe revision, including summary semantics. */
function onQueryCount(message, snapshot) {
  stopProgress();
  const summary = snapshot?.applied?.mode === "summary";
  const global = summary && !(snapshot.applied.groupBy || []).length;
  els.countinfo.textContent = global ? "· 1 summary row" : message.ok ? `· ${resultCountLabel(snapshot?.applied, message.count)}` : "· count failed";
  state.totalCount = message.ok && Number.isFinite(Number(message.count)) ? Number(message.count) : undefined;
  els.gridwrap.querySelector("table")?.setAttribute("aria-rowcount", state.totalCount === undefined ? "-1" : String(state.totalCount + 1));
  logSql(recipeLogLabel(`count ${state.model}`, message.queryLog), message.sql, message.orm);
}
/** Renders a v2 summary Recipe response as a read-only bounded result grid. */
function onQuerySummary(message, snapshot) {
  stopProgress();
  const result = message.result || {};
  logSql(recipeLogLabel(`summary ${state.model}`, message.queryLog), result.sql, result.orm);
  if (!result.ok) {
    renderError(result.error || "Summary query failed.");
    return;
  }
  const groupBy = (snapshot?.applied?.groupBy || []).map((field) => field.path);
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(renderQuerySummaryTable(result, { el, groupBy, renderValue }));
  const count = (result.rows || []).length;
  els.status.textContent = `${resultCountLabel(snapshot?.applied, count)}${result.hasMore ? " · more available" : ""}`;
  els.more.disabled = true;
}
/** Keeps the existing grid visible after an authoritative Recipe runtime rejection. */
function onQueryRejected() {
  stopProgress();
  els.more.disabled = !state.hasMore;
}
/** Derives a safe read-only schema from one backend row when a degraded transport omitted column metadata. */
function inferColumnsFromRows(rows) {
  const sample = Array.isArray(rows) ? rows.find((row) => row && typeof row === "object" && !Array.isArray(row)) : undefined;
  if (!sample) {
    return [];
  }
  return Object.keys(sample).map((attname) => ({ attname, editable: false, name: attname, type: "Unknown" }));
}
/** Builds one visible virtual row using pinned fields, spacers, and the current column band. */
function buildRow(row, index) {
  const pk = rawValue(row[state.pk]);
  const tr = el("tr", { ariaRowIndex: String((index ?? 0) + 2), role: "row" });
  tr.dataset.pk = String(pk);
  tr.dataset.rowIndex = String(index ?? 0);
  tr._pk = pk;
  tr.appendChild(el("td", { ariaColIndex: "1", className: "rownum", role: "rowheader", title: "Row number" }, String((index ?? 0) + 1)));
  const snapshot = gridSnapshot || { leftSpacerWidth: 0, logicalColumnIndices: {}, pinned: [], rightSpacerWidth: 0, visible: [] };
  for (const descriptor of snapshot.pinned) {
    appendRowCell(tr, row, descriptor, pk, snapshot.logicalColumnIndices[descriptor.key]);
  }
  appendRowSpacer(tr, snapshot.leftSpacerWidth, "left");
  for (const descriptor of snapshot.visible) {
    appendRowCell(tr, row, descriptor, pk, snapshot.logicalColumnIndices[descriptor.key]);
  }
  appendRowSpacer(tr, snapshot.rightSpacerWidth, "right");
  if (index === 0) {
    tr.querySelector('[role="gridcell"]')?.setAttribute("tabindex", "0");
  }
  return tr;
}
/** Appends one field cell or relation action cell for a logical descriptor. */
function appendRowCell(tr, row, descriptor, pk, columnIndex) {
  if (descriptor.kind === "relation") {
    const relation = descriptor.source;
    const td = el("td", { ariaColIndex: String(columnIndex ?? 1), ariaReadOnly: "true", className: "relcell", dataset: { key: descriptor.key }, role: "gridcell", tabIndex: -1 });
    td.style.width = `${descriptor.width}px`;
    td.appendChild(el("button", { ariaLabel: `Open ${relation.name} related rows`, className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk), single: String(Boolean(relation.single)) }, title: `${relation.kind} → ${relation.target}` }, `${relation.name} →`));
    tr.appendChild(td);
    return;
  }
  const td = buildCell(row, descriptor.source, pk);
  td.dataset.key = descriptor.key;
  td.setAttribute("aria-colindex", String(columnIndex ?? 1));
  td.setAttribute("role", "gridcell");
  td.setAttribute("aria-readonly", String(!descriptor.source.editable));
  td.tabIndex = -1;
  td.style.width = `${descriptor.width}px`;
  tr.appendChild(td);
}
/** Appends a structural row spacer matching a virtualized header spacer. */
function appendRowSpacer(tr, width, side) {
  if (!width) {
    return;
  }
  const td = el("td", { ariaHidden: "true", className: "gridspacer", role: "presentation" });
  td.dataset.side = side; td.style.width = `${width}px`;
  tr.appendChild(td);
}
function buildCell(row, column, pk) {
  const td = el("td", {});
  td._column = column;
  td._pk = pk;
  if (column.computed) {
    td.classList.add("computed");
    paintComputedCell(td, column, pk);
    return td;
  }
  td._cell = row[column.attname];
  if (column.editable) {
    td.classList.add("editable");
    td.dataset.attname = column.attname;
    td.title = parseEditableArray(column, cellRawText(td._cell)) ? "Double-click to edit list items" : "Double-click to edit";
    td._editval = cellRawText(td._cell);
  }
  paintCell(td);
  return td;
}
/** Renders a lazy @property cell from the computed store: the value if loaded, a spinner if its column is loading, else a muted placeholder prompting activation. */
function paintComputedCell(td, column, pk) {
  const store = state.computed[column.attname];
  const key = String(pk);
  td.textContent = "";
  if (store && Object.prototype.hasOwnProperty.call(store, key)) {
    td._cell = store[key];
    td.appendChild(renderValue(store[key]));
    td.title = "Computed @property (read-only)";
  } else if (state.computedActive.has(column.attname)) {
    td.appendChild(el("span", { className: "cellnull" }, "…"));
    td.title = "Loading @property…";
  } else {
    td.appendChild(el("span", { className: "cellnull" }, "·"));
    td.title = "Computed @property — use Load in the header (lazy)";
  }
}
function paintCell(td) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== undefined) {
    td.classList.add("dirty");
    td.setAttribute("aria-description", "modified, not committed");
    td.appendChild(el("span", {}, stagedDisplay(column, td.dataset.staged)));
    appendArrayEditButton(td, column, td.dataset.staged);
    return;
  }
  td.classList.remove("dirty");
  td.removeAttribute("aria-description");
  const cell = td._cell;
  td.appendChild(renderValue(cell));
  appendArrayEditButton(td, column, cellRawText(cell));
  if (column.relation && rawValue(cell) !== null && rawValue(cell) !== undefined) {
    const wrap = el("span", { className: "fk" });
    wrap.appendChild(el("button", { ariaLabel: "Expand related row", className: "linkbtn", title: "Expand related row", dataset: { act: "fk", rel: column.relation.field, pk: String(td._pk), val: String(rawValue(cell)) } }, codicon("copy")));
    wrap.appendChild(el("button", { ariaLabel: `Open ${column.relation.target} filtered to this row`, className: "linkbtn", title: `Open ${column.relation.target} filtered to this row`, dataset: { act: "open", target: column.relation.target, val: String(rawValue(cell)) } }, codicon("open-preview")));
    td.appendChild(document.createTextNode(" "));
    td.appendChild(wrap);
  }
}
function cellRawText(cell) {
  if (cell === null || cell === undefined) {
    return "";
  }
  return typeof cell === "object" ? ((cell.edit ?? cell.v) == null ? "" : String(cell.edit ?? cell.v)) : String(cell);
}
/** Adds a compact item-count button that opens the list mini-table with one click. */
function appendArrayEditButton(td, column, text) {
  if (!column.editable) {
    return;
  }
  const parsed = parseEditableArray(column, text);
  if (!parsed) {
    return;
  }
  const button = el("button", { className: "arrayedit-open", dataset: { act: "editArray" }, title: `Edit ${parsed.items.length} list item${parsed.items.length === 1 ? "" : "s"}` }, `▦ ${parsed.items.length}`);
  td.insertBefore(button, td.firstChild);
}
function renderValue(cell) {
  if (cell === null || cell === undefined) {
    return el("span", { className: "cellnull" }, "null");
  }
  if (typeof cell !== "object") {
    return document.createTextNode(String(cell));
  }
  const span = el("span", {});
  if (cell.t === "bytes") {
    span.appendChild(el("span", { className: "tag" }, `‹bytes ${cell.len}›`));
    return span;
  }
  span.appendChild(document.createTextNode(cell.v));
  if (cell.t && cell.t !== "json" && cell.t !== "repr") {
    span.appendChild(document.createTextNode(" "));
    span.appendChild(el("span", { className: "tag" }, cell.t));
  }
  return span;
}
function onTableClick(event) {
  const node = event.target.closest("[data-act]");
  if (!node || event.target.closest(".colresize")) {
    return;
  }
  const data = node.dataset;
  if (data.act === "editArray") {
    editor.editCell(node.closest("td"));
  } else if (data.act === "pin") {
    if (!state.pinned.has(data.col) && !canPinColumn(data.col)) {
      els.status.textContent = "Unpin a field before pinning another; pinned fields can use at most half of the grid width.";
      return;
    }
    togglePin(data.col, node, state, els.gridwrap);
    gridViewport.refresh(true);
  } else if (data.act === "loadComputed") {
    toggleComputed(data.field, node);
  } else if (data.act === "sort") {
    toggleSort(data.col);
  } else if (data.act === "open") {
    const split = data.target.lastIndexOf(".");
    // Pass the pk as the raw string; the backend coerces it against the target model's real pk type (a numeric
    // coerce here would turn a char/slug pk like "007" into 7 and miss the row).
    vscode.postMessage({ type: "openModel", app: data.target.slice(0, split), model: data.target.slice(split + 1), filterPk: data.val });
  } else if (data.act === "fk") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk), value: coerce(data.val), single: true });
  } else if (data.act === "rel") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk), single: data.single === "true" });
  }
}
/** Returns whether adding one field to the frozen region keeps it below half the available grid width. */
function canPinColumn(key) {
  const snapshot = gridViewport.snapshot();
  const next = snapshot.pinned.find((column) => column.key === key) || snapshot.scrollable.find((column) => column.key === key);
  const pinnedWidth = snapshot.pinned.reduce((sum, column) => sum + column.width, 0);
  return Boolean(next) && pinnedWidth + next.width <= Math.max(1, els.gridwrap.clientWidth) / 2;
}
function toggleSort(col) {
  const current = state.order[0];
  if (current && current.field === col && !current.desc) {
    state.order = [{ field: col, desc: true }];
  } else if (current && current.field === col && current.desc) {
    state.order = [];
  } else {
    state.order = [{ field: col, desc: false }];
  }
  updateSortArrows();
  queryController.toggleGridOrder(col, state.order[0]?.desc);
}
/** Activates (loads) or deactivates a lazy @property column, updating its header button in place and repainting cells. */
function toggleComputed(field, button) {
  const active = !state.computedActive.has(field);
  if (active) {
    state.computedActive.add(field);
    vscode.postMessage({ type: "loadComputed", field });
  } else {
    state.computedActive.delete(field);
    delete state.computed[field];
  }
  if (button) {
    button.classList.toggle("active", active);
    button.replaceChildren(codicon(active ? "refresh" : "triangle-right"));
    button.title = active ? "Reload computed values for loaded rows" : "Load this @property for loaded rows (lazy — not auto-computed)";
  }
  virtual.refresh();
}
/** Stores a fetched @property column's values (pk→cell) and repaints, ignoring late responses for a since-deactivated column. */
function onComputed(message) {
  stopProgress();
  if (!state.computedActive.has(message.field)) {
    return;
  }
  if (!message.ok) {
    els.status.textContent = `Could not compute ${message.field}: ${message.error ? String(message.error).split("\n").pop() : "failed"}`;
    return;
  }
  state.computed[message.field] = message.values || {};
  virtual.refresh();
  if (typeof message.queryCount === "number") {
    const rows = typeof message.rowCount === "number" ? message.rowCount : Object.keys(message.values || {}).length;
    const shape = message.queryCount > rows ? " · N+1 (per-row property queries)" : message.queryCount <= 2 ? " · batched" : "";
    els.status.textContent = `${message.field}: ${rows} rows · ${message.queryCount} SQL queries${shape}`;
  }
}
function updateSortArrows() {
  const arrows = {};
  for (const term of state.order) {
    arrows[term.field] = term.desc ? "arrow-down" : "arrow-up";
  }
  for (const span of els.gridwrap.querySelectorAll(".sortarrow")) {
    const direction = arrows[span.dataset.arrow];
    span.textContent = "";
    span.className = direction ? `sortarrow codicon codicon-${direction}` : "sortarrow";
    span.setAttribute("aria-hidden", "true");
  }
}
function pageSizeValue() {
  const value = els.pageSize ? els.pageSize.value : "50";
  const parsed = Number(value);
  return value === "all" ? ALL_PAGE_SIZE : (parsed > 0 ? parsed : 50);
}
function send(message) {
  const label = progressLabelForMessage(message);
  if (label) {
    startProgress(label);
  }
  const applied = queryController?.getSnapshot?.();
  const revisioned = ["loadMore", "reload", "requestCount"].includes(message.type) && Number.isSafeInteger(applied?.appliedRevision)
    ? { ...message, revision: applied.appliedRevision }
    : message;
  vscode.postMessage({ ...revisioned, pageSize: pageSizeValue() });
}
/** Returns the visible progress label for a request initiated from this webview. */
function progressLabelForMessage(message) {
  if (message.type === "runQuery") {
    return "Running query";
  }
  if (message.type === "loadMore") {
    return "Loading more rows…";
  }
  if (message.type === "reload") {
    return "Reloading rows";
  }
  if (message.type === "requestCount") {
    return "Counting rows";
  }
  if (message.type === "applyQueryRecipe") {
    return "Applying query…";
  }
  return "";
}
/** Starts an elapsed progress message for long-running model or ORM queries. */
function startProgress(label) {
  progressLabel = label;
  progressStartedAt = Date.now();
  updateProgress();
  if (progressTimer) {
    window.clearInterval(progressTimer);
  }
  progressTimer = window.setInterval(updateProgress, 1000);
}
/** Updates the footer with the latest elapsed progress message. */
function updateProgress() {
  if (!progressLabel || !progressStartedAt) {
    return;
  }
  els.status.textContent = `${progressLabel} · ${durationText(progressStartedAt)} elapsed`;
}
/** Stops the active elapsed progress message. */
function stopProgress() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = 0;
  }
  progressLabel = "";
  progressStartedAt = 0;
}
/** Formats a compact duration from one start timestamp. */
function durationText(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function expandInto(button, request) {
  if (button.dataset.open === "1") {
    closeDetail(button);
    return;
  }
  const body = el("div", { className: "nestedscroll" }, "Loading…");
  els.detailDrawer.hidden = false; els.detailContent.replaceChildren(nestedPanel(request.relation, button, body));
  const requestId = (relRequestId += 1);
  pendingRelated.set(requestId, { body, label: request.relation });
  button.dataset.open = "1";
  detailTrigger = button;
  vscode.postMessage({ type: "expandRelated", requestId, relation: request.relation, pk: request.pk, value: request.value, single: request.single });
}
function nestedPanel(title, trigger, body) {
  const head = el("div", { className: "nestedhead" });
  head.appendChild(el("span", { className: "tag" }, codicon("chevron-down"), ` ${title}`));
  head.appendChild(el("span", { className: "grow" }));
  const close = el("button", { ariaLabel: "Close related rows", className: "linkbtn", title: "Close" }, codicon("close"));
  close.addEventListener("click", () => closeDetail(trigger));
  head.appendChild(close);
  const wrap = el("div", {});
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}
function closeDetail(button) {
  els.detailDrawer.hidden = true; els.detailContent.innerHTML = "";
  button.dataset.open = "";
  detailTrigger = undefined; button.focus();
}
/** Closes the currently opened related-rows drawer for keyboard Escape handling. */
function closeOpenDetail() { if (!detailTrigger) { return false; } closeDetail(detailTrigger); return true; }
function onRelated(message) {
  const pending = pendingRelated.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingRelated.delete(message.requestId);
  const container = pending.body;
  container.innerHTML = "";
  const result = message.result || {};
  logSql(`related ${pending.label}`, result.sql, result.orm);
  if (!result.ok) {
    container.appendChild(el("span", { className: "err" }, result.error || "Could not load related rows."));
    return;
  }
  if (!result.rows.length) {
    container.appendChild(el("span", { className: "tag" }, "No related rows."));
    return;
  }
  container.appendChild(buildEditableRelatedTable(result, { el, post: (message) => vscode.postMessage(message), renderValue }));
}
function renderError(messageText) {
  stopProgress();
  const detail = renderBrowserError({ create: el, grid: els.gridwrap, message: messageText, onOpenConsole: () => send({ type: "openConsole" }), onRetry: () => send({ type: "reload" }), status: els.status });
  announcer.announceError(detail);
  els.more.disabled = true;
}
function logSql(action, sql, orm) {
  appendLogEntry(els.logbody, action, sql, orm, MAX_LOG_ENTRIES);
}
function rawValue(cell) {
  return cell !== null && typeof cell === "object" ? cell.v : cell;
}
function coerce(text) {
  if (text === "true" || text === "false") {
    return text === "true";
  }
  if (text !== "" && !Number.isNaN(Number(text))) {
    return Number(text);
  }
  return text;
}
/** Toggles the Cmd/Ctrl+F field finder (a searchable list of the grid's columns/relations). */
function toggleFieldFinder() {
  if (els.fieldfinder.hidden) {
    openFieldFinder();
  } else {
    closeFieldFinder();
  }
}
/** Opens the field finder, building a fresh combobox from the current columns + relations and focusing it. */
function openFieldFinder() {
  const options = [];
  for (const column of state.columns || []) {
    const kind = column.annotation ? "computed column" : column.computed ? "@property" : (column.type || "");
    options.push({ label: column.attname, title: kind, value: column.attname });
  }
  for (const relation of state.relations || []) {
    options.push({ group: "relations", label: `${relation.name} →`, title: relation.target || "", value: `rel:${relation.name}` });
  }
  els.fieldfindslot.innerHTML = "";
  const combo = createCombobox({ el, onChange: (value) => scrollToField(value), options, placeholder: "type a field name…" });
  els.fieldfindslot.appendChild(combo.node);
  els.fieldfinder.hidden = false;
  combo.focus();
}
/** Closes the field finder and clears its combobox. */
function closeFieldFinder() {
  els.fieldfinder.hidden = true;
  els.fieldfindslot.innerHTML = "";
}
/** Scrolls the grid horizontally so the chosen column header is centered, and briefly highlights it. */
function scrollToField(key) {
  if (!key) {
    return;
  }
  if (gridViewport.scrollToKey(key)) {
    requestAnimationFrame(() => focusFoundField(key));
    return;
  }
  focusFoundField(key);
}
/** Highlights and focuses a rendered field header after the viewport has brought it on screen. */
function focusFoundField(key) {
  const th = els.gridwrap.querySelector(`thead th[data-key="${key}"]`);
  if (!th) {
    return;
  }
  th.querySelector("button")?.focus();
  th.classList.add("colfound");
  setTimeout(() => th.classList.remove("colfound"), 1200);
}
/** Scrolls virtual row and column windows until a keyboard target can receive focus. */
function revealGridCell(rowIndex, key) {
  els.gridwrap.scrollTop = Math.max(0, rowIndex * 24);
  gridViewport.scrollToKey(key);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const cell = els.gridwrap.querySelector(`tr[data-row-index="${rowIndex}"] [role="gridcell"][data-key="${key}"]`);
    if (cell) {
      for (const peer of els.gridwrap.querySelectorAll('[role="gridcell"][tabindex="0"]')) { peer.tabIndex = -1; }
      cell.tabIndex = 0; cell.focus();
    }
  }));
}
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
