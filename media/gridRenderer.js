// Semantic virtual-grid header renderer for the model browser.

import { codicon } from "./modelBrowserIcons.js";

/** Creates the header renderer for the current grid state and its DOM helper. */
export function createGridHeaderRenderer({ el, relationKindLabel, relationModelName, state }) {
  /** Builds the sticky header for the currently visible virtual column band. */
  function buildHead(snapshot) {
    const head = el("thead", {});
    const row = el("tr", { ariaRowIndex: "1", role: "row" });
    row.appendChild(el("th", { ariaColIndex: "1", ariaLabel: "Row number", className: "rownum", role: "columnheader", title: "Row number" }, "#"));
    for (const descriptor of snapshot.pinned) { appendHeaderCell(row, descriptor, snapshot); }
    appendGridSpacer(row, snapshot.leftSpacerWidth, "left");
    for (const descriptor of snapshot.visible) { appendHeaderCell(row, descriptor, snapshot); }
    appendGridSpacer(row, snapshot.rightSpacerWidth, "right");
    head.appendChild(row);
    return head;
  }

  /** Appends one semantic field or relation column header. */
  function appendHeaderCell(row, descriptor, snapshot) {
    const ariaColIndex = String(snapshot.logicalColumnIndices?.[descriptor.key] ?? 1);
    if (descriptor.kind === "relation") {
      const relation = descriptor.source;
      const th = el("th", { ariaColIndex, className: "relcol", dataset: { key: descriptor.key }, role: "columnheader", title: `${relationKindLabel(relation.kind)} → ${relation.target}` }, document.createTextNode(relation.name), el("span", { className: "coltype" }, `${relationKindLabel(relation.kind)} (${relationModelName(relation.target)})`), el("span", { ariaLabel: `Resize ${relation.name} column`, ariaOrientation: "vertical", ariaValueMax: 480, ariaValueMin: 72, ariaValueNow: descriptor.width, className: "colresize", dataset: { key: descriptor.key }, role: "separator", tabIndex: 0, title: "Drag to resize" }));
      th.style.width = `${descriptor.width}px`; row.appendChild(th);
      return;
    }
    const column = descriptor.source;
    const sortable = !column.computed;
    const headClass = column.annotation ? "annotation" : column.computed ? "computed" : "sortable";
    const headTitle = sortable ? `Sort by ${column.name} (${column.type})` : `${column.name} (computed @property — read-only)`;
    const order = state.order.find((term) => term.field === column.attname);
    const th = el("th", { ariaColIndex, ariaSort: sortable ? (order ? (order.desc ? "descending" : "ascending") : "none") : undefined, className: headClass, dataset: { key: column.attname }, role: "columnheader", title: headTitle });
    th.style.width = `${descriptor.width}px`;
    const pinned = state.pinned.has(column.attname);
    th.appendChild(el("button", { ariaLabel: pinned ? `Unpin ${column.attname} column` : `Pin ${column.attname} column`, className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, codicon(pinned ? "pinned" : "pin")));
    if (column.computed) {
      const loading = state.computedActive.has(column.attname);
      const cost = column.annotated ? "DB annotation — single query" : "per-row @property — N+1";
      th.appendChild(el("button", { ariaLabel: `${loading ? "Reload" : "Load"} ${column.attname} computed values`, className: loading ? "loadbtn active" : "loadbtn", dataset: { act: "loadComputed", field: column.attname }, title: `${loading ? "Reload" : "Load"} this column for loaded rows (${cost})` }, codicon(loading ? "refresh" : "triangle-right")));
    }
    if (sortable) { th.appendChild(el("button", { ariaLabel: headTitle, className: "sortbtn", dataset: { act: "sort", col: column.attname } }, column.attname)); } else { th.appendChild(document.createTextNode(column.attname)); }
    if (column.pk) { th.appendChild(el("span", { ariaLabel: "Primary key", className: "pkmark", title: "primary key" }, codicon("key"))); }
    if (sortable) { th.appendChild(el("span", { className: "sortarrow", dataset: { arrow: column.attname } }, "")); }
    th.appendChild(el("span", { className: "coltype" }, column.relation ? `→ ${column.relation.target}` : column.computed ? (column.annotated ? "@property · 1 query" : "@property") : column.type));
    th.appendChild(el("span", { ariaLabel: `Resize ${column.attname} column`, ariaOrientation: "vertical", ariaValueMax: 480, ariaValueMin: 72, ariaValueNow: descriptor.width, className: "colresize", dataset: { key: descriptor.key }, role: "separator", tabIndex: 0, title: "Drag to resize" }));
    row.appendChild(th);
  }

  /** Adds an aria-hidden structural spacer for virtualized offscreen columns. */
  function appendGridSpacer(row, width, side) {
    if (!width) { return; }
    const spacer = el("th", { ariaHidden: "true", className: "gridspacer", role: "presentation" });
    spacer.dataset.side = side; spacer.style.width = `${width}px`;
    row.appendChild(spacer);
  }

  return { buildHead };
}
