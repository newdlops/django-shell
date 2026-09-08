// Editable nested table for an expanded reverse relation (FK/O2O/M2M set); edits commit to the related model.

import { createEditor, stagedDisplay } from "./gridEdit.js";

/** Returns the raw value behind a grid cell ({ v } wrapper or scalar). */
function rawOf(cell) {
  return cell !== null && typeof cell === "object" ? cell.v : cell;
}

/** Returns editable text for a related cell. */
function textOf(cell) {
  return cell === null || cell === undefined ? "" : typeof cell === "object" ? ((cell.edit ?? cell.v) == null ? "" : String(cell.edit ?? cell.v)) : String(cell);
}

/** Paints one related cell: staged value when dirty, else the value plus an Open link for foreign keys. */
function paintRelatedCell(td, el, renderValue) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== undefined) {
    td.classList.add("dirty");
    td.appendChild(el("span", {}, stagedDisplay(column, td.dataset.staged)));
    return;
  }
  td.classList.remove("dirty");
  td.appendChild(renderValue(td._cell));
  if (column.relation && rawOf(td._cell) !== null && rawOf(td._cell) !== undefined) {
    td.appendChild(document.createTextNode(" "));
    td.appendChild(el("button", { ariaLabel: `Open ${column.relation.target} filtered to this row`, className: "linkbtn", dataset: { act: "open", field: column.relation.filterField || "pk", target: column.relation.target, val: String(rawOf(td._cell)) }, title: `Open ${column.relation.target} filtered to this row` }, el("span", { ariaHidden: "true", className: "codicon codicon-open-preview" })));
  }
}

/** Builds an editable related-rows table: scalar fields edit inline and commit to the related model; FK cells link out. */
export function buildEditableRelatedTable(result, deps) {
  const { el, renderValue, post } = deps;
  const columns = result.columns || [];
  const pkName = result.pk || "id";
  const canEdit = Boolean(result.app && result.model && !result.single);
  const wrap = el("div", {});
  const status = el("span", { className: "tag", role: "status", ariaLive: "polite" });
  let commitBtn = null;
  const editor = canEdit
    ? createEditor({
        notify: (text) => { status.textContent = text; },
        onChange: (count) => { if (commitBtn) { commitBtn.textContent = count ? `Commit ${result.model} (${count})` : `Commit ${result.model}`; commitBtn.disabled = !count || editor.isCommitting(); } },
        onCommitStart: () => { commitBtn.disabled = true; status.textContent = "Committing changes…"; },
        onCommitEnd: () => { commitBtn.disabled = !editor.pendingCount(); },
        paintCell: (td) => paintRelatedCell(td, el, renderValue),
        post: (message) => { if (message.type === "commitEdits") { post({ ...message, app: result.app, columns, database: result.database, model: result.model, type: "commitRelated" }); } },
        reload: () => deps.reload?.(wrap)
      })
    : null;
  if (editor) {
    commitBtn = el("button", { className: "linkbtn", title: "Commit edits to the related model" }, `Commit ${result.model}`);
    commitBtn.disabled = true;
    commitBtn.addEventListener("click", () => editor.commitEdits());
    const bar = el("div", { className: "nestedhead" });
    bar.appendChild(commitBtn);
    bar.appendChild(status);
    wrap.appendChild(bar);
  }
  const table = el("table", {});
  const headRow = el("tr", {});
  for (const column of columns) {
    headRow.appendChild(el("th", {}, column.attname));
  }
  table.appendChild(el("thead", {}, headRow));
  const tbody = el("tbody", {});
  /** Rebuilds authoritative related rows while reapplying this editor's newer unsaved fields. */
  function renderRows(rows) {
    tbody.replaceChildren();
    for (const row of rows) {
      const pk = rawOf(row[pkName]);
      const tr = el("tr", {});
      tr.dataset.pk = String(pk);
      tr._pk = pk;
      for (const column of columns) {
        const td = el("td", {});
        td._cell = row[column.attname];
        td._column = column;
        td._pk = pk;
        if (canEdit && column.editable && !column.relation) {
          td.classList.add("editable");
          td.dataset.attname = column.attname;
          td._editval = textOf(td._cell);
          td.title = "Double-click to edit";
        }
        paintRelatedCell(td, el, renderValue);
        tr.appendChild(td);
      }
      editor?.applyStaged(tr);
      tbody.appendChild(tr);
    }
  }
  renderRows(result.rows);
  table.appendChild(tbody);
  if (editor) {
    table.addEventListener("dblclick", (event) => {
      const td = event.target.closest("td.editable");
      if (td) {
        event.stopPropagation();
        editor.editCell(td);
      }
    });
  }
  wrap.appendChild(table);
  wrap.handleCommit = (message) => editor?.handleResult(message) || false;
  wrap.refreshRows = (next) => {
    if (!next.ok) { status.textContent = next.error || "Saved, but related rows could not be reloaded."; return; }
    renderRows(next.rows || []);
  };
  return wrap;
}
