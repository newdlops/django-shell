// In-place cell editing with client-side staging: nothing is saved or sent until Commit.

import { openArrayEditor, parseEditableArray } from "./gridArrayEdit.js";
import { openFkPicker } from "./gridFkPicker.js";
import { temporalEditorLabel, temporalEditorValue, temporalStoredValue } from "./gridTemporalEdit.js";

let nextEditorId = 0;

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
  input.value = temporalEditorValue(type, start);
  input.ariaLabel = input.title = temporalEditorLabel(type, start);
  return { commitOnChange: false, initial: input.value, input, selectable: false, serialize: (value) => temporalStoredValue(type, start, value) };
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
  const editorId = `editor-${++nextEditorId}`;
  let revision = 0;
  let commitSequence = 0;
  let activeCommit;
  let finishActiveControl;
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
      entry = { fields: {}, pk: tr._pk, versions: {} };
      pending.set(key, entry);
    }
    entry.fields[td.dataset.attname] = value;
    entry.versions[td.dataset.attname] = ++revision;
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
      if (finishActiveControl === finish) { finishActiveControl = undefined; }
      if (save && input.value !== control.initial) {
        stage(td, control.serialize ? control.serialize(input.value) : input.value);
      } else {
        ctx.paintCell(td);
      }
    };
    finishActiveControl = finish;
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
    if (activeCommit) { return; }
    finishActiveControl?.(true);
    if (!pendingCount()) {
      return;
    }
    const snapshot = new Map([...pending].map(([key, entry]) => [key, { fields: { ...entry.fields }, pk: entry.pk, versions: { ...entry.versions } }]));
    const commitId = `${editorId}-${++commitSequence}`;
    activeCommit = { commitId, snapshot };
    ctx.onCommitStart?.(pendingCount());
    ctx.post({ changes: [...snapshot.values()].map(({ fields, pk }) => ({ fields, pk })), commitId, editorId, type: "commitEdits" });
  }

  /** Drops all staged edits and reloads the page to restore original values. */
  function discardEdits() {
    if (!pending.size || activeCommit) {
      return;
    }
    activeArrayEditor?.cancel();
    pending.clear();
    ctx.onChange(0);
    ctx.reload();
  }

  /** Accepts only this editor's active commit and preserves edits made after its snapshot. */
  function handleResult(message) {
    if (!activeCommit || message.editorId !== editorId || message.commitId !== activeCommit.commitId) { return false; }
    finishActiveControl?.(true);
    const { snapshot } = activeCommit;
    activeCommit = undefined;
    const data = message.result || {};
    if (data.ok) {
      for (const [key, sent] of snapshot) {
        const entry = pending.get(key);
        if (!entry) { continue; }
        for (const field of Object.keys(sent.fields)) {
          if (entry.versions[field] === sent.versions[field]) { delete entry.fields[field]; delete entry.versions[field]; }
        }
        if (!Object.keys(entry.fields).length) { pending.delete(key); }
      }
      ctx.onChange(pendingCount());
      ctx.onCommitEnd?.();
      ctx.notify(`Saved ${data.saved} changes.${pendingCount() ? ` ${pendingCount()} uncommitted changes remain.` : ""}`);
      ctx.reload();
      return true;
    }
    ctx.onCommitEnd?.();
    ctx.notify(`Commit failed: ${summarize(data)}`);
    return true;
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
    finishActiveControl?.(false);
    activeCommit = undefined;
    pending.clear();
    ctx.onChange(0);
    ctx.onCommitEnd?.();
  }

  return { applyStaged, commitEdits, discardEdits, editCell, handleResult, isCommitting: () => Boolean(activeCommit), onLookup, pendingCount, reset };
}
