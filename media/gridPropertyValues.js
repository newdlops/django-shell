// Coordinates lazy model-property values with the current grid rows and correlated host requests.

/** Returns the current accessible action for a property column's load control. */
export function propertyLoadAction(state, field) {
  if (state.computedPending.has(field)) { return "Loading"; }
  if (state.computedErrors[field]) { return "Retry"; }
  return state.computedActive.has(field) ? "Reload" : "Load";
}

/** Creates a property loader that refreshes active columns and ignores superseded responses. */
export function createPropertyValues({ onChange, onError, onSuccess, post, state }) {
  let sequence = 0;
  let revision;
  const requests = new Map();
  state.computedPending = new Set();
  state.computedErrors = {};

  /** Clears values and requests when the grid changes models. */
  function reset() {
    requests.clear();
    revision = undefined;
    state.computed = {};
    state.computedActive = new Set();
    state.computedPending.clear();
    state.computedErrors = {};
  }

  /** Loads or reloads one property without turning off its visible values. */
  function load(field, notify = true) {
    if (requests.has(field) || !state.columns.some((column) => column.computed && column.attname === field)) { return; }
    state.computedActive.add(field);
    delete state.computedErrors[field];
    delete state.computed[field];
    if (state.rowCount > 0) {
      const requestId = `property-${++sequence}`;
      requests.set(field, requestId);
      state.computedPending.add(field);
      post({ field, requestId, revision, type: "loadComputed" });
    } else {
      state.computed[field] = {};
    }
    if (notify) { onChange(); }
  }

  /** Reloads activated properties after replacement or pagination so their maps cover the displayed rows. */
  function rowsChanged(message) {
    revision = message.revision;
    requests.clear();
    state.computedPending.clear();
    state.computed = {};
    state.computedErrors = {};
    for (const field of state.computedActive) {
      if (!state.columns.some((column) => column.computed && column.attname === field)) { state.computedActive.delete(field); }
      else { load(field, false); }
    }
    if (state.computedActive.size) { onChange(); }
  }

  /** Accepts only the latest request for a property, keeping failures retryable and null values distinct. */
  function accept(message) {
    if (!requests.has(message.field) || requests.get(message.field) !== message.requestId || message.revision !== revision) { return; }
    requests.delete(message.field);
    state.computedPending.delete(message.field);
    if (message.ok) {
      state.computed[message.field] = message.values || {};
      onSuccess(message);
    } else {
      state.computedErrors[message.field] = message.error ? String(message.error).trim().split("\n").pop() : "Could not load property values.";
      onError(`Could not compute ${message.field}: ${state.computedErrors[message.field]}`);
    }
    onChange();
  }

  return { accept, load, reset, rowsChanged };
}
