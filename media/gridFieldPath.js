// Shared relation-tree fetcher + a reusable cascading field-path picker (field → ▸relation → field → …).
// Lets the aggregate "+ Column" builder drill through foreign keys to a traversal path (author__profile__city),
// reusing the backend `filterfields` tree the filter bar uses. In ORM/Terminal mode the tree RPC is suppressed, so
// the picker falls back to the model's own flat fields (no drill), exactly like the filter bar.

import { createCombobox } from "./gridCombobox.js";

const REL = "r:";
const FIELD = "f:";

/** Returns the {app, model} parts of an "app.Model" label (app labels never contain dots). */
function splitTarget(target) {
  const at = String(target || "").lastIndexOf(".");
  return at < 0 ? { app: "", model: String(target || "") } : { app: target.slice(0, at), model: target.slice(at + 1) };
}

/** Returns the bare model name from an "app.Model" label. */
function bareModel(target) {
  return splitTarget(target).model;
}

/** Creates a relation-tree fetcher backed by the backend `filterfields` RPC; requestIds are prefixed so they never collide with the filter bar's own numeric ids. */
export function createTreeService(postRaw) {
  const cache = new Map();
  const pending = new Map();
  let seq = 0;

  /** Resolves a previously requested tree (null on failure → caller falls back to flat fields). */
  function onTreeResponse(message) {
    const entry = pending.get(message.requestId);
    if (!entry) {
      return;
    }
    pending.delete(message.requestId);
    const tree = message.result && message.result.ok ? message.result : null;
    if (tree) {
      cache.set(entry.target, tree);
    }
    entry.resolve(tree);
  }

  /** Returns the field/relation tree for one "app.Model" target, fetched once and cached. */
  function fetchTree(target) {
    if (cache.has(target)) {
      return Promise.resolve(cache.get(target));
    }
    const parts = splitTarget(target);
    return new Promise((resolve) => {
      const requestId = `ftp-${(seq += 1)}`;
      pending.set(requestId, { resolve, target });
      postRaw({ app: parts.app, model: parts.model, requestId, type: "filterFields" });
    });
  }

  return { fetchTree, onTreeResponse };
}

/** Creates a cascading field-path picker. `rootOptions(tree)` builds the first level (caller-specific, null tree → flat
 * fallback); relations drill into their target's tree. Returns { node, getPath, terminal }; onChange(terminal, path) fires on change. */
export function createPathPicker(deps) {
  const { el, fetchTree, getModel, rootOptions, onChange, placeholder } = deps;
  const node = el("span", { className: "pathpick" });
  const segs = [];
  let token = 0;

  /** Returns nested-level options for a related model's tree (concrete leaves + further relations). */
  function nestedOptions(tree) {
    const options = [];
    for (const field of (tree && tree.fields) || []) {
      options.push({ label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
    }
    for (const relation of (tree && tree.relations) || []) {
      options.push({ kind: relation.kind, label: `${relation.name} →`, role: "relation", target: relation.target, title: `${relation.kind} → ${bareModel(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }

  /** Returns the option object currently selected in one segment. */
  function currentOption(select) {
    return (select._options || []).find((option) => option.value === select.value) || null;
  }

  /** Returns the deepest selected segment (the terminal field or relation), or null. */
  function terminal() {
    for (let level = segs.length - 1; level >= 0; level -= 1) {
      if (segs[level] && segs[level].select.value) {
        return currentOption(segs[level].select);
      }
    }
    return null;
  }

  /** Returns the `__`-joined query-name path up to the terminal segment. */
  function getPath() {
    const names = [];
    for (const seg of segs) {
      if (seg && seg.select.value) {
        names.push(seg.select.value.slice(2));
      }
    }
    return names.join("__");
  }

  /** Returns whether the chosen path crosses a to-many relation (reverse-FK / M2M) — those need distinct Count and can't be safely Summed. */
  function toMany() {
    for (const seg of segs) {
      if (seg && seg.select.value) {
        const option = currentOption(seg.select);
        if (option && option.role === "relation" && (option.kind === "reverse-fk" || option.kind === "m2m")) {
          return true;
        }
      }
    }
    return false;
  }

  /** Notifies the caller of the current terminal and path. */
  function notify() {
    if (onChange) {
      onChange(terminal(), getPath());
    }
  }

  /** Builds one cascading segment combobox at a level. */
  function buildSegment(level, options) {
    const comboOptions = options.map((option) => ({ group: option.role === "relation" ? "relations (drill in →)" : "", label: option.label, title: option.title || "", value: option.value }));
    const combo = createCombobox({ el, onChange: () => void onSegmentChange(level), options: comboOptions, placeholder: level === 0 ? placeholder || "— field —" : "— field / relation —", value: "" });
    combo.node._options = options;
    segs[level] = { combo, select: combo.node };
    node.appendChild(combo.node);
  }

  /** Truncates deeper segments, expands a chosen relation (async, guarded), then notifies. */
  async function onSegmentChange(level) {
    for (let deeper = segs.length - 1; deeper > level; deeper -= 1) {
      if (segs[deeper]) {
        segs[deeper].select.remove();
      }
      segs.pop();
    }
    const select = segs[level].select;
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && select.value) {
      const expected = select.value;
      const myToken = (token += 1);
      const tree = await fetchTree(chosen.target);
      if (myToken !== token || select.value !== expected || !segs[level] || segs[level].select !== select) {
        return;
      }
      buildSegment(level + 1, nestedOptions(tree));
    }
    notify();
  }

  /** Fetches the root model's tree and builds the first segment (flat fallback when the RPC is unavailable). */
  async function init() {
    const myToken = (token += 1);
    const tree = await fetchTree(getModel());
    if (myToken !== token) {
      return;
    }
    buildSegment(0, rootOptions(tree));
  }

  void init();
  return { getPath, node, terminal, toMany };
}
