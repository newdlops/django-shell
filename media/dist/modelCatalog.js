// media/modelCatalogSource.js
var vscode = acquireVsCodeApi();
var els = {
  search: document.getElementById("search"),
  list: document.getElementById("list"),
  footer: document.getElementById("footer")
};
var RENDER_CAP = 500;
var state = { groups: [], ok: false, error: "", expanded: /* @__PURE__ */ new Set() };
var debounce;
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.type === "models") {
    state.ok = Boolean(message.ok);
    state.error = message.error || "";
    state.groups = groupByApp(Array.isArray(message.models) ? message.models : []);
    render();
  }
});
els.search.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(render, 150);
});
els.list.addEventListener("click", (event) => {
  const group = event.target.closest("[data-group]");
  if (group) {
    toggle(group.dataset.group);
    return;
  }
  const item = event.target.closest("[data-model]");
  if (item) {
    vscode.postMessage({ type: "open", app: item.dataset.app, model: item.dataset.model });
  }
});
vscode.postMessage({ type: "ready" });
function groupByApp(models) {
  const map = /* @__PURE__ */ new Map();
  for (const model of models) {
    const list = map.get(model.app) || [];
    list.push(model);
    map.set(model.app, list);
  }
  return [...map.entries()];
}
function toggle(app) {
  if (state.expanded.has(app)) {
    state.expanded.delete(app);
  } else {
    state.expanded.add(app);
  }
  render();
}
function render() {
  const query = els.search.value.trim().toLowerCase();
  if (!state.ok) {
    els.list.innerHTML = "";
    els.footer.textContent = state.error || "Open the Django Shell console first.";
    return;
  }
  const fragment = document.createDocumentFragment();
  let rendered = 0;
  let total = 0;
  let capped = false;
  for (const [app, models] of state.groups) {
    const matched = query ? models.filter((model) => matchesQuery(model, query)) : models;
    if (query && !matched.length) {
      continue;
    }
    total += matched.length;
    const open = query ? true : state.expanded.has(app);
    fragment.appendChild(groupRow(app, matched.length, open, query));
    if (open && !capped) {
      for (const model of matched) {
        if (rendered >= RENDER_CAP) {
          capped = true;
          break;
        }
        fragment.appendChild(itemRow(model, query));
        rendered += 1;
      }
    }
  }
  els.list.innerHTML = "";
  els.list.appendChild(fragment);
  els.footer.textContent = footerText(total, capped, query);
}
function footerText(total, capped, query) {
  if (!total) {
    return query ? "No models match." : "No models found.";
  }
  if (capped) {
    return `Showing ${RENDER_CAP} of ${total} \u2014 refine search`;
  }
  return query ? `${total} match${total === 1 ? "" : "es"}` : `${total} models`;
}
function matchesQuery(model, query) {
  return `${model.app}.${model.model}`.toLowerCase().includes(query) || (model.table || "").toLowerCase().includes(query) || (model.label || "").toLowerCase().includes(query);
}
function groupRow(app, count, open, query) {
  const row = document.createElement("div");
  row.className = open ? "row group expanded" : "row group";
  row.dataset.group = app;
  row.appendChild(iconSpan("twistie codicon codicon-chevron-right"));
  row.appendChild(iconSpan("icon app codicon codicon-package"));
  const name = document.createElement("span");
  name.className = "gname";
  highlightInto(name, app, query);
  row.appendChild(name);
  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);
  row.appendChild(badge);
  return row;
}
function itemRow(model, query) {
  const row = document.createElement("div");
  row.className = "row item";
  row.dataset.app = model.app;
  row.dataset.model = model.model;
  row.title = `${model.app}.${model.model}
${model.label || ""}
table: ${model.table || ""}`;
  row.appendChild(iconSpan("icon model codicon codicon-table"));
  const name = document.createElement("span");
  name.className = "mname";
  highlightInto(name, model.model, query);
  row.appendChild(name);
  return row;
}
function iconSpan(className) {
  const span = document.createElement("span");
  span.className = className;
  return span;
}
function highlightInto(parent, text, query) {
  if (!query) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  let from = 0;
  let index = lower.indexOf(query);
  while (index !== -1) {
    if (index > from) {
      parent.appendChild(document.createTextNode(text.slice(from, index)));
    }
    const mark = document.createElement("span");
    mark.className = "match";
    mark.textContent = text.slice(index, index + query.length);
    parent.appendChild(mark);
    from = index + query.length;
    index = lower.indexOf(query, from);
  }
  if (from < text.length) {
    parent.appendChild(document.createTextNode(text.slice(from)));
  }
}
