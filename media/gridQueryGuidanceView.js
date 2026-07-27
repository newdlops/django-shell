// DOM helpers for accessible, reusable Query Builder guidance surfaces.

/** Appends a unique helper id without removing any existing aria-describedby token. */
export function appendDescribedBy(control, id) {
  if (!control || !id) { return; }
  const tokens = new Set(String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter(Boolean));
  tokens.add(id);
  control.setAttribute?.("aria-describedby", [...tokens].join(" "));
}

/** Creates a persistent control helper and associates it with its control when supplied. */
export function createControlHelp({ control, el, id, text, technical }) {
  const help = el("p", { className: "query-control-help", id }, text || "");
  if (technical) { help.appendChild(el("span", { className: "query-technical-detail" }, ` ${technical}`)); }
  appendDescribedBy(control, id);
  return help;
}

/** Creates a non-live plain-language meaning sentence for an editable item. */
export function createMeaningLine({ el, explanation, id }) {
  const state = explanation?.state || "empty";
  const prefix = state === "error" ? "Needs attention: " : state === "incomplete" ? "Next: " : state === "warning" ? "Note: " : "Meaning: ";
  const node = el("p", { className: "query-meaning", dataset: { state }, id }, `${prefix}${explanation?.text || ""}`);
  if (explanation?.technical) { node.appendChild(el("span", { className: "query-technical-detail" }, ` ${explanation.technical}`)); }
  return node;
}

/** Creates native disclosure help that preserves browser keyboard semantics. */
export function createConceptHelp({ el, summary, paragraphs = [], examples = [] }) {
  const details = el("details", { className: "query-concept-help" });
  details.appendChild(el("summary", {}, summary));
  const body = el("div", { className: "query-concept-help-body" });
  for (const paragraph of paragraphs) { body.appendChild(el("p", {}, paragraph)); }
  if (examples.length) { body.appendChild(el("ul", { className: "query-example-list" }, ...examples.map((example) => el("li", {}, example)))); }
  details.appendChild(body);
  return details;
}

/** Renders one fixed section title, technical label, and intro into a stable mount. */
export function renderSectionGuidance({ el, mount, guidance }) {
  if (!mount || !guidance) { return; }
  mount.replaceChildren(el("div", { className: "query-section-heading" }, el("span", {}, guidance.label), el("span", { className: "query-section-technical-name" }, guidance.technical || "")), el("p", { className: "query-section-intro" }, guidance.description));
}

/** Displays an Apply explanation matching the current availability state. */
export function renderApplyHelp(element, availability) {
  if (!element) { return; }
  element.dataset.state = availability?.state || "";
  element.textContent = availability?.text || "";
}
