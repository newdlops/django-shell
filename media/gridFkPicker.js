// Searchable foreign-key picker: queries the target model live and stages the chosen primary key.

const DEBOUNCE_MS = 200;

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
  results.hidden = true;
  wrap.appendChild(input);
  wrap.appendChild(results);
  td.textContent = "";
  td.appendChild(wrap);
  input.focus();
  input.select();

  const state = { current: 0, highlight: -1, options: [], settled: false, timer: null };

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
    const run = () => {
      state.current = host.allocId();
      host.post({ q: input.value.trim(), requestId: state.current, target: column.relation.target, type: "lookupRelated" });
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
    results.hidden = !state.options.length;
    state.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = index === state.highlight ? "fkopt active" : "fkopt";
      row.textContent = option.label;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        finish(String(option.pk));
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
      finish(state.highlight >= 0 ? String(state.options[state.highlight].pk) : input.value.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => finish(input.value.trim()), 0));

  query(true);

  return {
    /** Renders backend candidates when they answer the latest query. */
    fill(message) {
      if (state.settled || message.requestId !== state.current) {
        return;
      }
      const result = message.result || {};
      state.options = result.ok && Array.isArray(result.rows) ? result.rows : [];
      state.highlight = state.options.length ? 0 : -1;
      render();
    }
  };
}
