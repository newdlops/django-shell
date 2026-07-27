// Read-only bounded result-table renderer shared by Recipe summary responses.

/** Builds a read-only summary table and emphasizes declared group-by columns. */
export function renderQuerySummaryTable(result, helpers) {
  const { el, groupBy, renderValue } = helpers;
  const groups = new Set(groupBy || []);
  const columns = result.columns || [];
  const table = el("table", { className: "aggresult" });
  const head = el("thead", {});
  const headRow = el("tr", {});
  for (const column of columns) {
    headRow.appendChild(el("th", { className: groups.has(column.attname) ? "agggroupcol" : "" }, column.attname));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody", {});
  for (const row of result.rows || []) {
    const tr = el("tr", {});
    for (const column of columns) {
      const td = el("td", { className: groups.has(column.attname) ? "agggroupcol" : "" });
      td.appendChild(renderValue(row[column.attname]));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}
