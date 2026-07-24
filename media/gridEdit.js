// In-place cell editing with client-side staging: nothing is saved or sent until Commit.

import { openArrayEditor, parseEditableArray } from "./gridArrayEdit.js";
import { openFkPicker } from "./gridFkPicker.js";

/** Builds the editing control best suited to a column: dropdown for choices/booleans, native picker for dates, text otherwise. */
function buildControl(column, start) {
  if (Array.isArray(column.choices) && column.choices.length) {
    return buildSelect(choiceOptions(column), start);
  }
  if (column.type === "BooleanField") {
    return buildSelect(booleanOptions(column.null), start);
  }
  const picker = { DateField: "date", DateTimeField: "datetime-local", TimeField: "time" }[column.type];
  if (picker) {
    return buildPicker(picker, column.type, start);
  }
  return buildText(start);
}

/** Builds a plain text input control (the default for free-form fields). */
function buildText(start) {
  const input = document.createElement("input");
  input.className = "celledit";
  input.value = start;
  return { commitOnChange: false, initial: start, input, selectable: true };
}

/** Builds a native date/time picker, normalizing the stored value to the shape the input accepts. */
function buildPicker(kind, type, start) {
  const input = document.createElement("input");
  input.className = "celledit";
  input.type = kind;
  if (kind !== "date") {
    input.step = "1";
  }
  input.value = normalizeTemporal(type, start);
  return { commitOnChange: false, initial: input.value, input, selectable: false };
}

/** Builds a dropdown control that commits as soon as a value is chosen. */
function buildSelect(options, start) {
  const input = document.createElement("select");
  input.className = "celledit";
  let matched = false;
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    matched = matched || value === start;
    input.appendChild(option);
  }
  if (!matched && start !== "") {
    const option = document.createElement("option");
    option.value = start;
    option.textContent = start;
    input.appendChild(option);
  }
  input.value = start;
  return { commitOnChange: true, initial: input.value, input, selectable: false };
}

/** Returns [value, label] dropdown pairs for a choice column, prefixing a null entry when allowed. */
function choiceOptions(column) {
  const options = column.null ? [["", "(null)"]] : [];
  for (const [value, label] of column.choices) {
    options.push([String(value), label]);
  }
  return options;
}

/** Returns boolean dropdown options, including a null entry when the field is nullable. */
function booleanOptions(nullable) {
  const options = nullable ? [["", "(null)"]] : [];
  options.push(["true", "true"], ["false", "false"]);
  return options;
}

/** Normalizes an ISO date/time string to the value shape a native date/time input requires. */
function normalizeTemporal(type, raw) {
  if (!raw) {
    return "";
  }
  if (type === "DateField") {
    return raw.slice(0, 10);
  }
  if (type === "TimeField") {
    return cleanTime(raw);
  }
  if (type === "DateTimeField") {
    const value = raw.replace(" ", "T");
    const split = value.indexOf("T");
    return split < 0 ? value : `${value.slice(0, split + 1)}${cleanTime(value.slice(split + 1))}`;
  }
  return raw;
}

/** Strips a trailing timezone offset and any sub-second precision from an ISO time component. */
function cleanTime(time) {
  return time.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, "").split(".")[0];
}

/** Returns the human-facing text for a staged edit, mapping choice values back to their labels. */
export function stagedDisplay(column, staged) {
  if (staged === "") {
    return "(empty)";
  }
  if (column && Array.isArray(column.choices)) {
    const match = column.choices.find((choice) => String(choice[0]) === staged);
    if (match) {
      return match[1];
    }
  }
  return staged;
}

/** Creates a staged-edit controller; edits live in memory until commitEdits() posts them. */
export function createEditor(ctx) {
  // ctx: { post(msg), reload(), paintCell(td), onChange(count), notify(text) }
  const pending = new Map();
  let activeArrayEditor = null;
  let activePicker = null;
  let lookupSeq = 0;

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

  /** Re-applies any staged edits to a freshly (re)built row's cells, so windowed re-renders keep dirty values. */
  function applyStaged(tr) {
    const entry = pending.get(tr.dataset.pk);
    if (!entry) {
      return;
    }
    for (const td of tr.children) {
      const attname = td.dataset && td.dataset.attname;
      if (attname && Object.prototype.hasOwnProperty.call(entry.fields, attname)) {
        td.dataset.staged = entry.fields[attname];
        ctx.paintCell(td);
      }
    }
  }

  /** Opens a live searchable picker for an editable foreign-key cell, staging the chosen pk. */
  function editForeignKey(td, column, start) {
    activePicker = openFkPicker(td, column, start, {
      allocId: () => (lookupSeq += 1),
      done: () => ctx.paintCell(td),
      post: (message) => ctx.post(message),
      stage: (value) => stage(td, value)
    });
  }

  /** Opens the list mini-table for an ArrayField or array-valued JSONField cell. */
  function editArray(td, column, start) {
    activeArrayEditor?.cancel();
    let opened;
    opened = openArrayEditor(td, column, start, {
      closed: () => {
        if (activeArrayEditor === opened) {
          activeArrayEditor = null;
        }
      },
      done: () => ctx.paintCell(td),
      stage: (value) => stage(td, value)
    });
    activeArrayEditor = opened || null;
  }

  /** Routes a foreign-key lookup response to the picker that requested it. */
  function onLookup(message) {
    if (activePicker) {
      activePicker.fill(message);
    }
  }

  /** Turns an editable cell into the control fitting its field type; commits on Enter/blur (or change for dropdowns), cancels on Escape. */
  function editCell(td) {
    if (!td || !td.dataset.attname || td.querySelector("input, select, textarea")) {
      return;
    }
    const column = td._column || {};
    const start = td.dataset.staged !== undefined ? td.dataset.staged : (td._editval ?? "");
    if (parseEditableArray(column, start)) {
      editArray(td, column, start);
      return;
    }
    if (column.relation) {
      editForeignKey(td, column, start);
      return;
    }
    const control = buildControl(column, start);
    const input = control.input;
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    if (control.selectable) {
      input.select();
    }
    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      if (save && input.value !== control.initial) {
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
    if (control.commitOnChange) {
      input.addEventListener("change", () => finish(true));
    }
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
    activeArrayEditor?.cancel();
    pending.clear();
    ctx.onChange(0);
    ctx.reload();
  }

  /** Handles a commit result: clears and reloads on success, reports field errors on failure. */
  function handleResult(result) {
    const data = result || {};
    if (data.ok) {
      activeArrayEditor?.cancel();
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
    activeArrayEditor?.cancel();
    pending.clear();
    ctx.onChange(0);
  }

  return { applyStaged, commitEdits, discardEdits, editCell, handleResult, onLookup, pendingCount, reset };
}
