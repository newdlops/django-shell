// Searches foreign-key candidates and stages their exact relation values with visible request states.

const DEBOUNCE_MS = 200;
let pickerSequence = 0;

/** Opens a searchable dropdown over an FK cell; stages the chosen pk via host.stage or restores via host.done. */
export function openFkPicker(td, column, start, host) {
  // host: { post(message), stage(value), done(), allocId() }
  const wrap = document.createElement("div");
  wrap.className = "fkpick";
  const input = document.createElement("input");
  input.className = "celledit";
  input.value = start;
  input.spellcheck = false;
  input.autocomplete = "off";
  const results = document.createElement("div");
  results.className = "fkresults";
  results.id = `fk-results-${++pickerSequence}`;
  results.setAttribute("role", "listbox");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", `Search ${column.relation.target}`);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", results.id);
  results.hidden = true;
  wrap.appendChild(input);
  wrap.appendChild(results);
  td.textContent = "";
  td.appendChild(wrap);
  input.focus();
  input.select();

  const state = { current: 0, highlight: -1, options: [], settled: false, status: "", timer: null };

  /** Returns the exact value required by the source relation, including non-primary unique keys. */
  function storedValue(option) { return String(option.value ?? option.pk); }

  /** Settles the edit once: stages a real change, otherwise restores the cell. */
  function finish(value) {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    if (value !== null && value !== start) {
      host.stage(value);
    } else {
      host.done();
    }
  }

  /** Sends a lookup request for the current query, debounced unless immediate. */
  function query(immediate) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.current = host.allocId();
    state.options = []; state.highlight = -1; state.status = "Searching…";
    render();
    const run = () => {
      if (!state.settled) { host.post({ field: column.attname, q: input.value.trim(), requestId: state.current, target: column.relation.target, type: "lookupRelated" }); }
    };
    if (immediate) {
      run();
    } else {
      state.timer = setTimeout(run, DEBOUNCE_MS);
    }
  }

  /** Redraws the candidate dropdown, marking the highlighted row. */
  function render() {
    results.textContent = "";
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", state.highlight >= 0 ? `${results.id}-${state.highlight}` : "");
    if (state.status) {
      const status = document.createElement("div");
      status.className = "fkstatus";
      status.setAttribute("role", "status");
      status.textContent = state.status;
      results.appendChild(status);
    }
    state.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = index === state.highlight ? "fkopt active" : "fkopt";
      row.id = `${results.id}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === state.highlight));
      row.textContent = option.label;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        finish(storedValue(option));
      });
      results.appendChild(row);
    });
  }

  /** Moves the highlight through the candidate list, wrapping at the ends. */
  function move(delta) {
    if (!state.options.length) {
      return;
    }
    state.highlight = (state.highlight + delta + state.options.length) % state.options.length;
    render();
  }

  input.addEventListener("input", () => query(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish(state.highlight >= 0 ? storedValue(state.options[state.highlight]) : input.value.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (state.settled) { return; }
    if (document.activeElement === input || typeof document.hasFocus === "function" && !document.hasFocus()) { return; }
    finish(input.value.trim());
  }, 0));

  query(true);

  return {
    /** Cancels an obsolete picker before another result or editor replaces its cell. */
    cancel() { finish(null); },
    /** Stages direct key input before a Commit action takes its save snapshot. */
    commit() { finish(input.value.trim()); },
    /** Renders backend candidates when they answer the latest query. */
    fill(message) {
      if (state.settled || message.requestId !== state.current) {
        return;
      }
      const result = message.result || {};
      state.options = result.ok && Array.isArray(result.rows) ? result.rows : [];
      state.highlight = state.options.length ? 0 : -1;
      state.status = !result.ok ? "Search failed. Type again to retry." : state.options.length ? "" : "No matching rows. Enter a key directly.";
      render();
    }
  };
}
