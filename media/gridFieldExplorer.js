// Presents searchable Django field paths in a compact, keyboard-accessible workbench explorer.
import { createQueryPopover } from "./gridQueryPopover.js";
import { resolveFieldExplorer } from "./gridFieldExplorerOptions.js";

let sequence = 0;

/** Creates a retained field explorer whose incomplete navigation never changes the query draft. */
export function createFieldExplorer({ ariaLabel = "Condition field", computed = [], controlKey, current = "", el, metadata, navigation = {}, onChange, popoverLayer, source }) {
  const sourceKey = `${source?.app}.${source?.model}`;
  if (navigation.source !== sourceKey || navigation.current !== current) {
    Object.assign(navigation, { source: sourceKey, current, open: false, prefix: current.split("__").slice(0, -1), query: "" });
  }
  const id = `query-field-explorer-${++sequence}`;
  const trigger = el("button", { ariaLabel, className: "query-field-trigger", dataset: { queryControlKey: `${controlKey}-0` }, title: current || "Search fields or paste a Django lookup", type: "button" });
  trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-describedby", `${id}-current`);
  trigger.append(el("span", { id: `${id}-current`, className: current ? "query-field-path" : "query-field-placeholder" }, current ? current.split("__").join(" › ") : "Choose a field…"), el("span", { ariaHidden: "true", className: "codicon codicon-search" }));
  const node = el("div", { className: "query-field-picker query-field-explorer" }, trigger);
  let disposed = false, generation = 0, active = -1, view, failedTarget;
  const search = el("input", { ariaLabel: "Search fields or paste a lookup", autocomplete: "off", className: "query-field-search", dataset: { queryControlKey: `${controlKey}-search` }, name: "filter-field-search", placeholder: "Search or paste company__user__email…", role: "combobox", spellcheck: false, type: "text", value: navigation.query || "" });
  search.setAttribute("aria-autocomplete", "list"); search.setAttribute("aria-expanded", "true");
  search.setAttribute("aria-controls", `${id}-list`);
  const crumbs = el("nav", { ariaLabel: "Field path", className: "query-field-breadcrumbs" });
  const list = el("div", { className: "query-field-results", id: `${id}-list`, role: "listbox", ariaLabel: "Available fields" });
  const status = el("div", { className: "query-field-status", role: "status" });
  const closeButton = el("button", { ariaLabel: "Close field picker", className: "query-field-close", type: "button" }, el("span", { ariaHidden: "true", className: "codicon codicon-close" }));
  const content = el("section", { ariaLabel: "Choose filter field", className: "query-field-dialog", role: "dialog" }, el("div", { className: "query-field-searchbar" }, search, closeButton), crumbs, list, status);
  const portal = createQueryPopover({ anchor: trigger, layer: popoverLayer, onClose: closed });
  portal.node.classList.add("query-field-portal");

  /** Updates focus and retained open state only for a user-initiated dismissal. */
  function closed(reason) {
    trigger.setAttribute("aria-expanded", "false");
    if (reason === "destroy") { return; }
    navigation.open = false; generation += 1;
    if (["escape", "close"].includes(reason)) { trigger.focus(); }
  }

  /** Loads metadata once and retains the exact failed model for an explicit retry. */
  async function loadTree(model) {
    const state = metadata?.getState?.(model);
    if (state?.tree) { return state.tree; }
    try {
      if (state?.error) { throw new Error(state.error); }
      return await metadata.loadTree(model);
    } catch (error) { failedTarget = model; throw error; }
  }

  /** Opens the explorer at its retained path and focuses its searchable option list. */
  function open() {
    if (disposed) { return; }
    navigation.open = true; trigger.setAttribute("aria-expanded", "true");
    portal.open(content); search.focus(); render();
  }

  /** Moves to one ancestor without committing a partial relationship path. */
  function browse(prefix) {
    navigation.prefix = prefix; navigation.query = ""; search.value = "";
    render(); search.focus();
  }

  /** Rebuilds the model breadcrumb while preserving all ancestor navigation targets. */
  function renderCrumbs(prefix) {
    crumbs.replaceChildren();
    for (const [index, label] of [source.model, ...prefix].entries()) {
      const crumb = el("button", { ariaLabel: index ? `Browse ${prefix.slice(0, index).join("__")}` : "Browse root fields", type: "button" }, label);
      if (index) { crumbs.appendChild(el("span", { ariaHidden: "true" }, "›")); }
      crumb.addEventListener("click", () => browse(prefix.slice(0, index)));
      crumbs.appendChild(crumb);
    }
  }

  /** Resolves the current search while ignoring responses from discarded or superseded renders. */
  async function render() {
    const token = ++generation;
    list.replaceChildren(); active = -1; view = undefined; search.removeAttribute("aria-activedescendant");
    renderCrumbs(navigation.prefix || []);
    status.textContent = "Loading fields…"; list.setAttribute("aria-busy", "true");
    try {
      const next = await resolveFieldExplorer({ source, prefix: navigation.prefix || [], query: navigation.query || "", computed, loadTree });
      if (disposed || token !== generation || !navigation.open) { return; }
      view = next; renderCrumbs(next.prefix || []); list.replaceChildren();
      let group;
      for (const [index, item] of next.items.entries()) {
        if (group !== item.group) { group = item.group; list.appendChild(el("div", { ariaHidden: "true", className: "query-field-section" }, group)); }
        const option = el("div", { ariaLabel: `${item.kind === "relation" ? "Browse" : "Choose"} ${item.path}${item.lookup ? `__${item.lookup}` : ""}`, className: "query-field-option", dataset: { index: String(index) }, id: `${id}-option-${index}`, role: "option", title: item.path });
        option.setAttribute("aria-selected", "false");
        option.append(el("span", { className: "query-field-option-name" }, item.label), el("span", { className: "query-field-option-detail" }, item.detail));
        if (item.kind === "relation") { option.appendChild(el("span", { ariaHidden: "true", className: "codicon codicon-chevron-right" })); }
        option.addEventListener("click", () => choose(item));
        option.addEventListener("pointermove", () => highlight(index));
        list.appendChild(option);
      }
      status.textContent = next.message || (!next.items.length ? "No matching fields. Try a shorter name or return to the model above." : next.total > 60 ? `${next.total} matches. Showing 60; type more to narrow the list.` : next.partial ? "Related fields are unavailable on this connection. Choose a local field or retry after reconnecting." : "↑ ↓ to navigate · Enter to select · Esc to close");
      list.setAttribute("aria-busy", "false");
      if (next.items.length) { highlight(0); }
    } catch {
      if (disposed || token !== generation || !navigation.open) { return; }
      view = undefined; list.setAttribute("aria-busy", "false");
      status.replaceChildren("Field details could not be loaded. ");
      const retry = el("button", { type: "button" }, "Retry");
      retry.addEventListener("click", () => { retry.disabled = true; metadata.retry(failedTarget).then(() => { if (!disposed) { render(); } }).catch(() => { if (!disposed) { render(); } }); });
      status.appendChild(retry);
    }
    portal.reposition();
  }

  /** Keeps one active option exposed through the search combobox's active descendant. */
  function highlight(index) {
    if (!view?.items.length) { return; }
    active = (index + view.items.length) % view.items.length;
    for (const option of list.querySelectorAll('[role="option"]')) { option.setAttribute("aria-selected", String(Number(option.dataset.index) === active)); }
    const selected = list.querySelector(`[data-index="${active}"]`);
    if (!selected) { search.removeAttribute("aria-activedescendant"); return; }
    search.setAttribute("aria-activedescendant", selected.id);
    selected.scrollIntoView({ block: "nearest" });
  }

  /** Drills into a relation or emits one complete field and optional pasted lookup atomically. */
  function choose(item) {
    if (!item || disposed) { return; }
    if (item.kind === "relation") { browse(item.path.split("__")); return; }
    navigation.current = item.path; navigation.query = ""; navigation.prefix = item.path.split("__").slice(0, -1);
    portal.close("selected"); onChange?.(item.path, item.kind, item.descriptor, item.lookup);
  }

  /** Handles list navigation while preserving normal text editing and tab navigation. */
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); portal.close("escape"); }
    else if (event.target !== search) { return; }
    else if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); highlight(active + (event.key === "ArrowDown" ? 1 : -1)); }
    else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.preventDefault(); choose(view?.items[active]); }
    else if (event.key === "ArrowLeft" && !search.value && navigation.prefix?.length) { event.preventDefault(); browse(navigation.prefix.slice(0, -1)); }
  }

  /** Dismisses an open explorer after a pointer moves to another workbench control. */
  function outside(event) { if (navigation.open && !node.contains(event.target) && !portal.node.contains(event.target)) { portal.close("outside"); } }

  /** Dismisses the explorer when keyboard focus leaves both its trigger and portal. */
  function focusOutside(event) { if (navigation.open && !node.contains(event.target) && !portal.node.contains(event.target)) { portal.close("blur"); } }

  trigger.addEventListener("click", () => navigation.open ? portal.close("close") : open());
  closeButton.addEventListener("click", () => portal.close("close"));
  search.addEventListener("input", () => { navigation.query = search.value; render(); });
  content.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", focusOutside);
  if (navigation.open) { queueMicrotask(open); }
  return { node, focus: () => trigger.focus(), open, /** Releases this generation while retaining unfinished navigation for a metadata render. */ dispose() { disposed = true; generation += 1; document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focusOutside); portal.destroy(); } };
}
