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
import { createFilterBar } from "./gridFilter.js";
import { createColumnBuilder, renderAggregateResult } from "./gridAggregate.js";
import { createCombobox } from "./gridCombobox.js";
const vscode = acquireVsCodeApi();
const els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "activefilters", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "groupToggle", "aggregatebar", "aggregateGroupBy", "aggregateTerms", "addGroupBy", "addAggregate", "runAggregate", "aggregateOff", "fieldfinder", "fieldfindslot", "fieldfindClose", "interruptQuery", "openQueryConsole", "detailDrawer", "detailContent"]) {
  els[id] = document.getElementById(id);
}
const announcer = createAnnouncer(); installModelBrowserChrome(document);
const LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "length", "length__gt", "length__gte", "length__lt", "length__lte", "trim"];
const MAX_LOG_ENTRIES = 200;
const ALL_PAGE_SIZE = 1000000000;
const state = { columns: [], pk: "id", relations: [], rowCount: 0, totalCount: undefined, hasMore: false, filters: [], order: [], annotations: [], model: "", pinned: new Set(), widths: {}, computed: {}, computedActive: new Set(), aggregateActive: false, aggregateGroupBy: [], aggregateColumns: [] };
const pendingRelated = new Map();
let relRequestId = 0;
let progressLabel = "";
let progressStartedAt = 0;
let progressTimer = 0;
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
const filterBar = createFilterBar({
  el,
  termsEl: els.filterterms,
  activeEl: els.activefilters,
  getState: () => state,
  postRaw: (message) => vscode.postMessage(message),
  lookups: LOOKUPS,
  onRemove: removeFilter
});
const columnBuilder = createColumnBuilder({
  el,
  groupEl: els.aggregateGroupBy,
  termsEl: els.aggregateTerms,
  getState: () => state,
  lookups: LOOKUPS,
  postRaw: (message) => vscode.postMessage(message)
});
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => send({ type: "reload" }));
els.more.addEventListener("click", () => send({ type: "loadMore" }));
if (els.pageSize) { els.pageSize.addEventListener("change", () => send({ type: "reload" })); }
els.addFilter.addEventListener("click", () => filterBar.addTerm());
els.applyFilter.addEventListener("click", () => applyQuery());
els.clearFilter.addEventListener("click", () => clearQuery());
els.count.addEventListener("click", () => send({ type: "requestCount" }));
els.groupToggle.addEventListener("click", () => toggleColumnPanel());
els.addGroupBy.addEventListener("click", () => columnBuilder.addGroupBy());
els.addAggregate.addEventListener("click", () => columnBuilder.addTerm());
els.runAggregate.addEventListener("click", () => applyColumns());
els.aggregateOff.addEventListener("click", () => clearColumns());
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
    filterBar.onTreeResponse(message);
    columnBuilder.onTreeResponse(message);
  } else if (message.type === "modelList") {
    columnBuilder.onModelListResponse(message);
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    stopProgress();
    els.countinfo.textContent = message.ok ? `· total ${message.count}` : `· count failed`;
    state.totalCount = message.ok && Number.isFinite(Number(message.count)) ? Number(message.count) : undefined;
    els.gridwrap.querySelector("table")?.setAttribute("aria-rowcount", state.totalCount === undefined ? "-1" : String(state.totalCount + 1));
    logSql(`count ${state.model}`, message.sql, message.orm);
  } else if (message.type === "aggregate") {
    onAggregate(message);
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
  exitAggregateView();
  state.model = model;
  els.title.textContent = isQuerySurface() ? "ORM Query" : model;
  els.subtitle.textContent = `${schema.label || ""} · ${schema.table || ""}`;
  filterBar.sync(state.filters);
  filterBar.renderSummary(state.filters);
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
  for (const control of [els.reload, els.more, els.pageSize, els.addFilter, els.applyFilter, els.clearFilter, els.count, els.groupToggle, els.runAggregate, els.aggregateOff, els.transport]) {
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
  if (state.aggregateActive || !document.getElementById("tbody") || columnsChanged) {
    // Rows arrived over the read-only aggregate table (or an error view), or the column set changed — rebuild the grid skeleton.
    exitAggregateView();
    installGridTable();
  }
  logSql(`rows ${state.model}`, rows.sql, rows.orm);
  if (Array.isArray(message.filters)) {
    state.filters = message.filters;
  }
  if (Array.isArray(message.order)) {
    state.order = message.order;
  }
  if (!message.append) {
    state.totalCount = undefined;
    // When `+ Column` added/removed annotation columns, refresh the open filter terms IN PLACE so the new aliases
    // become searchable while keeping any in-progress edit; on a fresh load (no terms yet) build from the applied filters.
    if (columnsChanged && els.filterterms.querySelector(".term")) {
      filterBar.refresh();
    } else {
      filterBar.sync(state.filters);
    }
  }
  updateSortArrows();
  filterBar.renderSummary(state.filters);
  state.rowCount = virtual.setRows(rows.rows || [], Boolean(message.append));
  if (message.append) {
    for (const field of state.computedActive) {
      vscode.postMessage({ type: "loadComputed", field });
    }
  }
  state.hasMore = Boolean(rows.hasMore);
  els.more.disabled = !state.hasMore;
  const filterText = state.filters.length ? ` · ${state.filters.length} filter${state.filters.length === 1 ? "" : "s"}` : "";
  const loaded = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " · more available" : ""}${filterText}` : `No rows${filterText}.`;
  if (isQuerySurface() && !message.append) {
    const queryStatus = queryRunUi.successText(state.rowCount);
    els.status.textContent = queryStatus;
    announcer.announceStatus(queryStatus);
  } else {
    els.status.textContent = loaded;
  }
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
  applyQuery({ collectFilters: false });
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
/** Applies the current row query, optionally preserving the already-applied filters for sort-only changes. */
function applyQuery(options = {}) {
  const collectFilters = options.collectFilters !== false;
  if (collectFilters) {
    state.filters = filterBar.collect();
  }
  filterBar.renderSummary(state.filters);
  if (state.aggregateActive) {
    // A collapse summary is on screen — re-run it so a lookup on an aggregate column applies as HAVING.
    applyColumns(collectFilters ? undefined : state.filters);
    return;
  }
  send({ annotations: state.annotations, filters: state.filters, order: state.order, type: "applyQuery" });
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
  vscode.postMessage({ ...message, pageSize: pageSizeValue() });
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
  if (message.type === "aggregate") {
    return "Running aggregate…";
  }
  if (message.type === "applyQuery") {
    return "Applying filters…";
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
function clearQuery() {
  filterBar.clear();
  state.filters = [];
  state.order = [];
  updateSortArrows();
  filterBar.renderSummary(state.filters);
  applyQuery();
}
/** Shows or hides the "+ Column" builder panel (seeding one term when first opened). */
function toggleColumnPanel() {
  const show = els.aggregatebar.hidden;
  els.aggregatebar.hidden = !show;
  els.groupToggle.classList.toggle("active", show);
  if (show) {
    columnBuilder.ensureRows();
  }
}
/** Removes a single applied filter (the already-reduced set is passed in) and re-runs the current view with it, leaving the rest of the filters and the sort/columns intact. */
function removeFilter(next) {
  state.filters = next;
  filterBar.sync(next);
  if (state.aggregateActive) {
    applyColumns(next);
    return;
  }
  filterBar.renderSummary(next);
  send({ annotations: state.annotations, filters: next, order: state.order, type: "applyQuery" });
}
/** Applies the builder: with group-by fields it collapses rows into per-group summaries; without, it adds the terms as per-row annotation columns to the grid. An explicit `filtersOverride` (from a chip removal) is used instead of re-collecting the builder, avoiding a race with the async term-row sync. */
function applyColumns(filtersOverride) {
  const { droppedToMany, groupBy, invalidConditions, terms } = columnBuilder.collect();
  if (invalidConditions) {
    els.status.textContent = "Complete or remove every column condition before applying.";
    return;
  }
  state.filters = filtersOverride !== undefined ? filtersOverride : filterBar.collect();
  filterBar.renderSummary(state.filters);
  const drillNote = droppedToMany ? " · skipped Sum/Avg/Min/Max with a to-many path (use Count, or group by the related model)" : "";
  if (groupBy.length) {
    const aggregates = terms.filter((term) => term.kind === "aggregate").map((term) => ({ alias: term.alias, conditions: term.conditions, distinct: term.distinct, field: term.field, func: term.func }));
    if (!aggregates.length) {
      els.status.textContent = "Add at least one Aggregate column to summarize per group (Annotate/Window/Expr are per-row only).";
      return;
    }
    state.aggregateActive = true;
    state.aggregateGroupBy = groupBy;
    state.annotations = [];
    els.status.textContent = `Summarizing…${drillNote}`;
    send({ type: "aggregate", aggregates, filters: state.filters, groupBy });
  } else {
    exitAggregateView();
    state.annotations = terms;
    applyQuery();
    if (drillNote) {
      els.status.textContent = `Loading…${drillNote}`;
    }
  }
}
/** Clears the builder and removes any per-row annotation columns / collapsed view, returning to the plain row grid. */
function clearColumns() {
  columnBuilder.clear();
  state.annotations = [];
  exitAggregateView();
  applyQuery();
}
/** Resets the collapsed-summary view state (the panel and its terms persist across row reloads). */
function exitAggregateView() {
  state.aggregateActive = false;
  state.aggregateGroupBy = [];
  state.aggregateColumns = [];
}
/** Renders an aggregate response as a read-only result table in place of the row grid. */
function onAggregate(message) {
  stopProgress();
  const result = message.result || {};
  logSql(`aggregate ${state.model}`, result.sql, result.orm);
  if (!result.ok) {
    renderError(result.error || "Aggregation failed.");
    return;
  }
  // Expose the aggregate (non-group) result columns so the filter bar can offer them as HAVING lookups.
  state.aggregateColumns = (result.columns || []).map((column) => column.attname).filter((name) => !state.aggregateGroupBy.includes(name));
  // Refresh the open filter terms so the just-created aggregate aliases become searchable (keeping in-progress edits).
  filterBar.refresh();
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(renderAggregateResult(result, { el, groupBy: state.aggregateGroupBy, renderValue }));
  const count = (result.rows || []).length;
  const noun = state.aggregateGroupBy.length ? `group${count === 1 ? "" : "s"}` : "aggregate";
  const scan = result.pythonScan ? " · @property computed in Python (full scan)" : "";
  els.status.textContent = `${count} ${noun}${result.hasMore ? " · more available" : ""}${scan}`;
  els.more.disabled = true;
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
