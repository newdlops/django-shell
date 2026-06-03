// In-place cell editing with client-side staging: nothing is saved or sent until Commit.

/** Creates a staged-edit controller; edits live in memory until commitEdits() posts them. */
export function createEditor(ctx) {
  // ctx: { post(msg), reload(), paintCell(td), onChange(count), notify(text) }
  const pending = new Map();

  /** Counts staged field edits across all rows. */
  function pendingCount() {
    let total = 0;
    for (const entry of pending.values()) {
      total += Object.keys(entry.fields).length;
    }
    return total;
  }

  /** Stages one cell edit in memory and repaints the cell as dirty (no server call). */
  function stage(td, value) {
    const tr = td.closest("tr");
    const key = tr.dataset.pk;
    let entry = pending.get(key);
    if (!entry) {
      entry = { fields: {}, pk: tr._pk };
      pending.set(key, entry);
    }
    entry.fields[td.dataset.attname] = value;
    td.dataset.staged = value;
    ctx.paintCell(td);
    ctx.onChange(pendingCount());
  }

  /** Turns an editable cell into a text input; commits on Enter/blur, cancels on Escape. */
  function editCell(td) {
    if (!td.dataset.attname || td.querySelector("input")) {
      return;
    }
    const start = td.dataset.staged !== undefined ? td.dataset.staged : (td._editval ?? "");
    const input = document.createElement("input");
    input.className = "celledit";
    input.value = start;
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      if (save && input.value !== start) {
        stage(td, input.value);
      } else {
        ctx.paintCell(td);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /** Posts all staged edits for an atomic commit (the only point that reaches the server). */
  function commitEdits() {
    if (!pendingCount()) {
      return;
    }
    ctx.post({ changes: [...pending.values()], type: "commitEdits" });
  }

  /** Drops all staged edits and reloads the page to restore original values. */
  function discardEdits() {
    if (!pending.size) {
      return;
    }
    pending.clear();
    ctx.onChange(0);
    ctx.reload();
  }

  /** Handles a commit result: clears and reloads on success, reports field errors on failure. */
  function handleResult(result) {
    const data = result || {};
    if (data.ok) {
      pending.clear();
      ctx.onChange(0);
      ctx.notify(`Committed ${data.saved} row${data.saved === 1 ? "" : "s"}.`);
      ctx.reload();
      return;
    }
    ctx.notify(`Commit failed (nothing saved): ${summarize(data)}`);
  }

  /** Builds a short human summary of commit errors. */
  function summarize(data) {
    if (data.error) {
      return data.error.split("\n").pop();
    }
    const failed = (data.results || []).filter((row) => !row.ok);
    return failed.map((row) => `pk=${row.pk} ${row.error || Object.entries(row.fieldErrors || {}).map(([field, messages]) => `${field}: ${messages[0]}`).join("; ")}`).join(" · ") || "validation error";
  }

  /** Clears all staged edits without reloading (used when the table is rebuilt). */
  function reset() {
    pending.clear();
    ctx.onChange(0);
  }

  return { commitEdits, discardEdits, editCell, handleResult, pendingCount, reset };
}
