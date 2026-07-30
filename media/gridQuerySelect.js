// Native allowlist-backed select controls for Query Builder field references.

/** Normalizes option records, preserves group order, and retains unavailable current values. */
export function normalizeQuerySelectOptions(options, current, { unavailableLabel = "Unavailable field" } = {}) {
  const normalizedCurrent = current == null ? "" : String(current);
  const seen = new Set();
  const normalized = [];
  for (const option of options || []) {
    const value = option?.value == null ? "" : String(option.value);
    if (seen.has(value)) { continue; }
    seen.add(value);
    normalized.push({ description: option?.description == null ? "" : String(option.description), disabled: Boolean(option?.disabled), group: option?.group == null || option.group === "" ? "" : String(option.group), label: option?.label == null ? value : String(option.label), value });
  }
  if (normalizedCurrent && !seen.has(normalizedCurrent)) {
    normalized.push({ description: "", disabled: true, group: "Unavailable", label: `${unavailableLabel}: ${normalizedCurrent}`, value: normalizedCurrent });
  }
  return normalized;
}

/** Creates a native, allowlist-backed Query Builder select without a text-entry path. */
export function createQuerySelect({ allowEmpty = false, ariaLabel, className = "", dataset, disabled = false, el, onChange, options = [], unavailableLabel, value } = {}) {
  const records = normalizeQuerySelectOptions(options, value, { unavailableLabel });
  const node = el("select", { ariaLabel, className: ["query-native-select", className].filter(Boolean).join(" ") });
  node.disabled = Boolean(disabled);
  Object.assign(node.dataset, dataset || {});
  const allowlist = new Map(records.map((record) => [record.value, record]));
  const groups = new Map();
  const ungrouped = [];
  for (const record of records) {
    if (!record.group) { ungrouped.push(record); continue; }
    if (!groups.has(record.group)) { groups.set(record.group, []); }
    groups.get(record.group).push(record);
  }

  /** Appends one option with its safe text and metadata. */
  function appendOption(parent, record) {
    const option = el("option", { title: record.description, value: record.value }, record.label);
    option.disabled = record.disabled;
    parent.appendChild(option);
  }

  for (const record of ungrouped) { appendOption(node, record); }
  for (const [group, groupRecords] of groups) {
    const optgroup = el("optgroup", { label: group });
    for (const record of groupRecords) { appendOption(optgroup, record); }
    node.appendChild(optgroup);
  }
  const current = value == null ? "" : String(value);
  const initial = allowlist.has(current) ? current : (allowlist.has("") ? "" : records.find((record) => !record.disabled)?.value);
  node.value = initial === undefined ? "" : initial;
  let lastValidValue = node.value;

  /** Updates native title text from the active normalized record. */
  function updateTitle(selected) { node.title = selected?.description || ""; }

  updateTitle(allowlist.get(lastValidValue));
  /** Rejects unsafe or disabled mutations and emits one valid selection. */
  function handleChange() {
    const selected = allowlist.get(node.value);
    if (!selected || selected.disabled || (!allowEmpty && selected.value === "")) {
      node.value = lastValidValue;
      return;
    }
    lastValidValue = selected.value;
    updateTitle(selected);
    onChange?.(selected.value);
  }
  node.addEventListener("change", handleChange);
  return {
    /** Removes this select's owned event listener. */
    destroy() { node.removeEventListener("change", handleChange); },
    /** Focuses the native select. */
    focus() { node.focus?.(); },
    node,
    /** Returns the normalized active option record. */
    selectedOption() { return allowlist.get(node.value); }
  };
}
