// Sidebar webview: accessible, keyboard-operable Django model tree with search.

const vscode = acquireVsCodeApi();

const els = {
  clearSearch: document.getElementById("clearSearch"),
  footer: document.getElementById("footer"),
  list: document.getElementById("modelTree"),
  search: document.getElementById("modelSearch"),
  stateAction: document.getElementById("stateAction"),
  status: document.getElementById("catalogStatus")
};

const RENDER_CAP = 500;
const DOM_NODE_BUDGET = 2000;
const SEARCH_DEBOUNCE_MS = 100;
const IDLE_MESSAGE = "Open the Django Shell console first.";
const state = {
  activeKey: "",
  error: "",
  expanded: new Set(),
  groups: [],
  mode: "loading",
  ok: false,
  searchCollapsed: new Set()
};
let debounce;

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "models") {
    receiveModels(message);
  } else if (message?.type === "loading") {
    receiveLoading();
  }
});

els.search.addEventListener("input", () => {
  clearTimeout(debounce);
  state.searchCollapsed.clear();
  debounce = setTimeout(() => render(), SEARCH_DEBOUNCE_MS);
});

els.search.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.search.value) {
    event.preventDefault();
    clearSearch();
  }
});

els.clearSearch.addEventListener("click", clearSearch);
els.stateAction.addEventListener("click", () => {
  if (els.stateAction.dataset.action === "clear-search") {
    clearSearch();
  } else if (els.stateAction.dataset.action === "open-console") {
    vscode.postMessage({ type: "openConsole" });
  } else if (els.stateAction.dataset.action === "retry") {
    vscode.postMessage({ type: "retry" });
  }
});

els.list.addEventListener("click", (event) => {
  const item = event.target.closest('[role="treeitem"]');
  if (!item) {
    return;
  }
  state.activeKey = item.dataset.key || "";
  if (item.dataset.group) {
    toggle(item.dataset.group, state.activeKey);
    return;
  }
  if (item.dataset.model) {
    vscode.postMessage({ type: "open", app: item.dataset.app, model: item.dataset.model });
  }
});

els.list.addEventListener("focusin", (event) => {
  const item = event.target.closest('[role="treeitem"]');
  if (item) {
    state.activeKey = item.dataset.key || "";
    setRovingTabStop(state.activeKey);
  }
});

els.list.addEventListener("keydown", (event) => handleTreeKeydown(event));

vscode.postMessage({ type: "ready" });

/** Applies a catalog response without discarding a previously usable tree on refresh failure. */
function receiveModels(message) {
  if (message.ok) {
    state.ok = true;
    state.error = "";
    state.groups = groupByApp(Array.isArray(message.models) ? message.models : []);
    state.mode = "loaded";
  } else {
    state.error = conciseError(message.error);
    state.ok = state.groups.length > 0;
    state.mode = state.ok ? "error" : message.error === IDLE_MESSAGE ? "disconnected" : "error";
  }
  render();
}

/** Shows load progress without clearing a cached model tree during a refresh. */
function receiveLoading() {
  if (state.ok) {
    state.mode = "refreshing";
    setStatus("Refreshing models…", "refreshing");
    return;
  }
  state.mode = "loading";
  render();
}

/** Clears the model search and restores the unfiltered tree. */
function clearSearch() {
  clearTimeout(debounce);
  els.search.value = "";
  state.searchCollapsed.clear();
  render();
  els.search.focus();
}

/** Groups the backend's flat model list by Django application. */
function groupByApp(models) {
  const map = new Map();
  for (const model of models) {
    const list = map.get(model.app) || [];
    list.push(model);
    map.set(model.app, list);
  }
  return [...map.entries()];
}

/** Toggles one group and restores keyboard focus to its persistent tree item. */
function toggle(app, focusKey) {
  const query = normalizedQuery();
  const expanded = isOpen(app, query);
  if (query) {
    if (expanded) {
      state.searchCollapsed.add(app);
    } else {
      state.searchCollapsed.delete(app);
    }
  } else if (expanded) {
    state.expanded.delete(app);
  } else {
    state.expanded.add(app);
  }
  state.activeKey = focusKey;
  render(focusKey);
}

/** Returns whether an application is visibly expanded in the current search mode. */
function isOpen(app, query) {
  return query ? !state.searchCollapsed.has(app) : state.expanded.has(app);
}

/** Renders the tree, summary, and state feedback while preserving a useful roving tab stop. */
function render(focusKey = "") {
  const query = normalizedQuery();
  const previousKey = focusKey || state.activeKey || activeTreeKey();
  els.clearSearch.classList.toggle("visible", Boolean(query));
  if (!state.ok) {
    renderUnavailable();
    return;
  }
  const result = buildTree(query);
  els.list.replaceChildren(result.fragment);
  els.footer.textContent = footerText(result, query);
  els.footer.title = "";
  setStatus(statusText(result, query), state.mode);
  const noResults = !result.total && Boolean(query);
  setStateAction(noResults || state.mode === "error", noResults ? "Clear search" : "Retry", noResults ? "clear-search" : "retry");
  restoreTreeFocus(previousKey, focusKey);
}

/** Renders loading, disconnected, or error feedback when no prior catalog is available. */
function renderUnavailable() {
  els.list.replaceChildren();
  els.footer.textContent = "";
  if (state.mode === "loading") {
    setStatus("Loading Django models…", "loading");
    setStateAction(false);
    return;
  }
  const disconnected = state.mode === "disconnected";
  setStatus(disconnected ? "Open Django Shell to load models." : state.error || "Could not load Django models.", "error");
  setStateAction(true, disconnected ? "Open Django Shell" : "Retry", disconnected ? "open-console" : "retry");
}

/** Builds no more than the tree-item budget while retaining group hierarchy and counts. */
function buildTree(query) {
  const fragment = document.createDocumentFragment();
  const matchedGroups = state.groups.map(([app, models]) => [app, query ? models.filter((model) => matchesQuery(model, query)) : models]);
  let renderedModels = 0;
  let renderedTreeItems = 0;
  let renderedNodes = 0;
  const total = matchedGroups.reduce((count, [, models]) => count + models.length, 0);
  let capped = false;
  for (const [app, matched] of matchedGroups) {
    if (query && !matched.length) {
      continue;
    }
    const groupNodes = query ? 6 : 5;
    if (renderedTreeItems >= RENDER_CAP || renderedNodes + groupNodes > DOM_NODE_BUDGET) {
      capped = true;
      break;
    }
    const open = isOpen(app, query);
    const group = groupRow(app, matched.length, open, query);
    fragment.appendChild(group.item);
    renderedTreeItems += 1;
    renderedNodes += groupNodes;
    if (!open) {
      continue;
    }
    const children = document.createElement("ul");
    children.className = "tree-children";
    children.setAttribute("role", "group");
    let appended = 0;
    for (const model of matched) {
      const modelNodes = query ? 12 : model.table ? 6 : 5;
      const childListNodes = appended ? 0 : 1;
      if (renderedTreeItems >= RENDER_CAP || renderedNodes + childListNodes + modelNodes > DOM_NODE_BUDGET) {
        capped = true;
        break;
      }
      children.appendChild(itemRow(model, app, query));
      renderedModels += 1;
      renderedTreeItems += 1;
      renderedNodes += childListNodes + modelNodes;
      appended += 1;
    }
    if (appended) {
      group.item.appendChild(children);
    }
    if (capped) {
      break;
    }
  }
  if (!capped && renderedModels < total && renderedTreeItems >= RENDER_CAP) {
    capped = true;
  }
  return { capped, fragment, renderedModels, renderedNodes, renderedTreeItems, total };
}

/** Produces a semantic, expand-capable group tree item. */
function groupRow(app, count, open, query) {
  const item = document.createElement("li");
  item.className = "tree-group";
  item.setAttribute("role", "none");
  const row = document.createElement("button");
  row.className = "treeitem group";
  row.dataset.group = app;
  row.dataset.key = `group:${app}`;
  row.type = "button";
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-expanded", String(open));
  row.setAttribute("aria-level", "1");
  row.appendChild(iconSpan("twistie codicon codicon-chevron-right"));
  row.appendChild(iconSpan("icon app codicon codicon-package"));
  const name = document.createElement("span");
  name.className = "gname";
  highlightInto(name, app, query);
  row.appendChild(name);
  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);
  badge.setAttribute("aria-hidden", "true");
  row.setAttribute("aria-label", `${app}, ${count} model${count === 1 ? "" : "s"}, ${open ? "expanded" : "collapsed"}`);
  row.appendChild(badge);
  item.appendChild(row);
  return { item, row };
}

/** Produces one model tree item with app-qualified model and secondary table context. */
function itemRow(model, app, query) {
  const item = document.createElement("li");
  item.setAttribute("role", "none");
  const row = document.createElement("button");
  const qualified = `${model.app}.${model.model}`;
  row.className = "treeitem item";
  row.dataset.app = model.app;
  row.dataset.model = model.model;
  row.dataset.parent = `group:${app}`;
  row.dataset.key = `model:${qualified}`;
  row.type = "button";
  row.title = `${qualified}\n${model.label || ""}\ntable: ${model.table || ""}`;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", "2");
  row.setAttribute("aria-label", `${qualified}${model.table ? `, table ${model.table}` : ""}`);
  row.appendChild(iconSpan("icon model codicon codicon-table"));
  const copy = document.createElement("span");
  copy.className = "model-copy";
  const name = document.createElement("span");
  name.className = "mname";
  highlightInto(name, qualified, query);
  copy.appendChild(name);
  if (model.table) {
    const table = document.createElement("span");
    table.className = "table-name";
    table.textContent = model.table;
    table.title = model.table;
    table.setAttribute("aria-hidden", "true");
    copy.appendChild(table);
  }
  row.appendChild(copy);
  item.appendChild(row);
  return item;
}

/** Handles roving tree focus and the expected tree-view keyboard commands. */
function handleTreeKeydown(event) {
  const current = event.target.closest('[role="treeitem"]');
  if (!current) {
    return;
  }
  const items = visibleTreeItems();
  const index = items.indexOf(current);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusTreeItem(items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusTreeItem(items[event.key === "Home" ? 0 : items.length - 1]);
  } else if (event.key === "ArrowRight" && current.dataset.group) {
    event.preventDefault();
    if (current.getAttribute("aria-expanded") === "false") {
      toggle(current.dataset.group, current.dataset.key);
    } else {
      focusTreeItem(items[index + 1]);
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (current.dataset.group && current.getAttribute("aria-expanded") === "true") {
      toggle(current.dataset.group, current.dataset.key);
    } else if (current.dataset.parent) {
      focusTreeItem(els.list.querySelector(`[data-key="${cssEscape(current.dataset.parent)}"]`));
    }
  }
}

/** Returns the current visible tree items in document order. */
function visibleTreeItems() {
  return [...els.list.querySelectorAll('[role="treeitem"]')];
}

/** Focuses one tree item and makes it the sole tab stop. */
function focusTreeItem(item) {
  if (!item) {
    return;
  }
  state.activeKey = item.dataset.key || "";
  setRovingTabStop(state.activeKey);
  item.focus();
}

/** Gives exactly one visible tree item tabIndex zero. */
function setRovingTabStop(key) {
  const items = visibleTreeItems();
  const active = items.find((item) => item.dataset.key === key) || items[0];
  for (const item of items) {
    item.tabIndex = item === active ? 0 : -1;
  }
  state.activeKey = active?.dataset.key || "";
}

/** Restores focus only for keyboard interactions that replaced the tree DOM. */
function restoreTreeFocus(previousKey, shouldFocus) {
  setRovingTabStop(previousKey);
  if (shouldFocus) {
    focusTreeItem(visibleTreeItems().find((item) => item.dataset.key === shouldFocus));
  }
}

/** Returns the last focused key when focus is still within the tree. */
function activeTreeKey() {
  const active = document.activeElement?.closest?.('[role="treeitem"]');
  return active?.dataset.key || "";
}

/** Returns a normalized search string used for matching and visibility. */
function normalizedQuery() {
  return els.search.value.trim().toLowerCase();
}

/** Matches a model against its app-qualified name and backend metadata. */
function matchesQuery(model, query) {
  return `${model.app}.${model.model}`.toLowerCase().includes(query) || (model.table || "").toLowerCase().includes(query) || (model.label || "").toLowerCase().includes(query);
}

/** Builds the compact persistent summary for the rendered result. */
function footerText(result, query) {
  if (!result.total) {
    return query ? `No models match “${els.search.value.trim()}”.` : "No models found.";
  }
  if (result.capped) {
    return "Showing first 500 matches. Refine your search.";
  }
  return query ? `${result.total} of ${modelCount()} models` : `${result.total} models`;
}

/** Builds the polite live-state message without duplicating the footer's detailed count. */
function statusText(result, query) {
  if (!result.total) {
    return query ? `No models match “${els.search.value.trim()}”.` : "No models found.";
  }
  if (state.mode === "error") {
    return state.error;
  }
  return query ? `${result.total} matching models` : "";
}

/** Counts every model in the cached catalog for filtered-result context. */
function modelCount() {
  return state.groups.reduce((total, [, models]) => total + models.length, 0);
}

/** Updates the live status region with a compact, non-stack-trace message. */
function setStatus(text, mode) {
  els.status.textContent = text;
  els.status.dataset.state = mode;
}

/** Shows an optional recovery button only for retryable no-catalog errors. */
function setStateAction(visible, label = "", action = "") {
  els.stateAction.hidden = !visible;
  els.stateAction.textContent = label;
  els.stateAction.dataset.action = action;
}

/** Reduces backend error output to one safe, readable line. */
function conciseError(error) {
  const firstLine = String(error || "").split(/\r?\n/, 1)[0].trim();
  return firstLine || "Could not load Django models.";
}

/** Creates a decorative Codicon span that is absent from the accessibility tree. */
function iconSpan(className) {
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("aria-hidden", "true");
  return span;
}

/** Appends highlighted visible text without changing the parent's accessible label. */
function highlightInto(parent, text, query) {
  if (!query) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  const index = lower.indexOf(query);
  if (index < 0) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  if (index > 0) {
    parent.appendChild(document.createTextNode(text.slice(0, index)));
  }
  const mark = document.createElement("span");
  mark.className = "match";
  mark.textContent = text.slice(index, index + query.length);
  mark.setAttribute("aria-hidden", "true");
  parent.appendChild(mark);
  if (index + query.length < text.length) {
    parent.appendChild(document.createTextNode(text.slice(index + query.length)));
  }
}

/** Escapes one data value for its narrow use inside a CSS attribute selector. */
function cssEscape(value) {
  return CSS.escape(value);
}
