// Accessible validation summary and node-focus mapping for the Query Builder.

import { presentQueryIssue } from "./gridQueryIssueGuidance.js";

/** Returns normalized issues from a validation response without trusting its shape. */
function issuesOf(validation) {
  return Array.isArray(validation?.issues) ? validation.issues.filter((issue) => issue && typeof issue === "object") : [];
}

/** Builds a short validation label that always includes text, not color alone. */
export function validationLabel(validation, checking = false) {
  if (checking) { return { state: "checking", text: "Checking…" }; }
  const issues = issuesOf(validation);
  const errors = issues.filter((issue) => issue.severity !== "warning");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (errors.length) { return { state: "error", text: `${errors.length} error${errors.length === 1 ? "" : "s"}` }; }
  if (warnings.length) { return { state: "warning", text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` }; }
  return { state: "valid", text: "Valid" };
}

/** Renders the visible validation badge and focusable issue summary using safe text nodes. */
export function renderQueryValidation({ issueSummary, validationState }, validation, options = {}) {
  const label = validationLabel(validation, Boolean(options.checking));
  validationState.dataset.state = label.state;
  validationState.textContent = label.text;
  issueSummary.replaceChildren();
  for (const [index, issue] of issuesOf(validation).entries()) {
    const presentation = presentQueryIssue(issue);
    const item = document.createElement("article");
    item.className = "query-issue-item";
    item.dataset.severity = presentation.severity;
    const button = document.createElement("button");
    button.className = "query-issue";
    button.dataset.severity = issue.severity === "warning" ? "warning" : "error";
    button.type = "button";
    button.textContent = `${presentation.severity === "warning" ? "Warning" : "Error"}: ${presentation.title}`;
    const detailId = `query-issue-detail-${issue.nodeId || issue.code || "unknown"}-${index}`;
    button.setAttribute("aria-describedby", detailId);
    button.addEventListener("click", () => options.onFocusIssue?.(issue));
    const detail = document.createElement("p");
    detail.className = "query-issue-detail";
    detail.id = detailId;
    detail.textContent = `${presentation.explanation} Fix: ${presentation.fix}`;
    item.append(button, detail);
    issueSummary.appendChild(item);
  }
}

/** Synchronizes invalid state and one visible issue description with mounted query controls. */
export function applyQueryValidationAnnotations(root = document, validation) {
  for (const control of root.querySelectorAll?.("[data-query-validation-message]") || []) {
    removeDescription(control, control.dataset.queryValidationMessage);
    control.removeAttribute?.("aria-invalid");
    delete control.dataset.queryValidationMessage;
  }
  for (const issue of issuesOf(validation).filter((entry) => entry.severity !== "warning")) {
    const nodeId = typeof issue.nodeId === "string" ? issue.nodeId : "";
    if (!nodeId) { continue; }
    const messageId = `query-node-issues-${nodeId}`;
    const target = controlForIssue(root, issue, nodeId);
    if (!target) { continue; }
    target.setAttribute?.("aria-invalid", "true");
    addDescription(target, messageId);
    target.dataset.queryValidationMessage = messageId;
  }
}

/** Finds the precise control key when supplied, falling back to the node's first editor control. */
function controlForIssue(root, issue, nodeId) {
  const controlKey = typeof issue.controlKey === "string" ? issue.controlKey : "";
  if (controlKey) {
    const exact = root.querySelector?.(`[data-query-control-key="${cssEscape(controlKey)}"]`);
    if (exact) { return exact; }
  }
  const node = root.querySelector?.(`[data-query-node-id="${cssEscape(nodeId)}"]`);
  return node?.querySelector?.("[data-focus-role=lhs], input, select, textarea, button");
}

/** Adds one stable issue-description token without dropping existing field help. */
function addDescription(control, messageId) {
  const tokens = new Set(String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter(Boolean));
  tokens.add(messageId);
  control.setAttribute?.("aria-describedby", [...tokens].join(" "));
}

/** Removes only the validation token while leaving shared help and labels intact. */
function removeDescription(control, messageId) {
  const tokens = String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter((token) => token && token !== messageId);
  if (tokens.length) { control.setAttribute?.("aria-describedby", tokens.join(" ")); }
  else { control.removeAttribute?.("aria-describedby"); }
}

/** Focuses the first query-builder control associated with an issue's stable node identifier. */
export function focusQueryIssue(issue, root = document) {
  const nodeId = typeof issue?.nodeId === "string" ? issue.nodeId : "";
  if (!nodeId) { root.getElementById("queryDrawer")?.scrollIntoView({ block: "nearest" }); return false; }
  const section = root.querySelector(`[data-query-node-id="${cssEscape(nodeId)}"]`);
  if (!section) { return false; }
  section.open = true;
  let ancestor = section.closest?.("details");
  while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement?.closest?.("details"); }
  section.scrollIntoView({ block: "nearest" });
  section.querySelector("input,select,textarea,button,[tabindex]")?.focus();
  return true;
}

/** Escapes a stable identifier for the only selector used by the validation focus bridge. */
function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}
