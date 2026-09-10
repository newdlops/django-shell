// Accessible execution disclosures that retain output and explicit expansion choices while logs stream.

const LONG_OUTPUT_LINES = 12;
const LONG_OUTPUT_CHARACTERS = 2000;

/** Builds an independently collapsible execution without changing its source or result text. */
export function createOutputAccordionItem(count, code, onToggle) {
  const item = document.createElement("section");
  item.className = "outputItem";
  item.dataset.execution = String(count || "");
  const id = `execution-output-${count || 0}`;
  const heading = document.createElement("h3");
  heading.className = "outputHeading";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "outputHeader";
  toggle.dataset.role = "toggle";
  toggle.setAttribute("aria-controls", id);
  toggle.setAttribute("aria-labelledby", `${id}-execution ${id}-code`);
  toggle.setAttribute("aria-describedby", `${id}-status ${id}-summary`);
  const chevron = document.createElement("span");
  chevron.className = "outputChevron codicon codicon-chevron-down";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.id = `${id}-execution`;
  label.className = "outputExecution";
  label.dataset.role = "header-label";
  label.textContent = `In [${count || ""}]`;
  const preview = document.createElement("span");
  preview.id = `${id}-code`;
  preview.className = "outputCodePreview";
  preview.textContent = code.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240) || "Python execution";
  preview.title = preview.textContent;
  const metadata = document.createElement("span");
  metadata.className = "outputMetadata";
  const status = document.createElement("span");
  status.id = `${id}-status`;
  status.className = "outputStatus";
  status.dataset.role = "status";
  const summary = document.createElement("span");
  summary.id = `${id}-summary`;
  summary.className = "outputSummary";
  summary.dataset.role = "summary";
  metadata.append(status, summary);
  toggle.append(chevron, label, preview, metadata);
  heading.append(toggle);
  const content = document.createElement("div");
  content.id = id;
  content.className = "outputDetails";
  content.dataset.role = "details";
  const source = document.createElement("pre");
  source.className = "inputSource";
  source.dataset.role = "source";
  source.textContent = code;
  const outputLabel = document.createElement("div");
  outputLabel.className = "outputItemLabel";
  outputLabel.dataset.role = "out-label";
  outputLabel.textContent = `Out[${count || ""}]:`;
  const result = document.createElement("pre");
  result.className = "result pending";
  result.dataset.role = "result";
  content.append(source, outputLabel, result);
  item.append(heading, content);
  setOutputExpanded(item, true);
  toggle.addEventListener("click", () => {
    setOutputExpanded(item, toggle.getAttribute("aria-expanded") !== "true", true);
    onToggle();
  });
  return item;
}

/** Changes only disclosure visibility, retaining the exact output and any running execution. */
export function setOutputExpanded(item, expanded, manual = false) {
  const toggle = item.querySelector('[data-role="toggle"]');
  item.querySelector('[data-role="details"]').hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.title = `${expanded ? "Collapse" : "Expand"} execution`;
  item.querySelector(".outputChevron").className = `outputChevron codicon codicon-chevron-${expanded ? "down" : "right"}`;
  if (manual) { item.dataset.expansionTouched = "true"; }
}

/** Updates output size and folds only untouched, successful long results after completion. */
export function updateOutputDisclosure(item, text, completed = false, ok = true) {
  const lines = text ? (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1) : 0;
  item.querySelector('[data-role="summary"]').textContent = lines ? `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}` : completed ? "No output" : "";
  if (!completed || item.dataset.expansionTouched === "true") { return; }
  const selection = window.getSelection();
  const reading = item.contains(document.activeElement) || (selection && !selection.isCollapsed && selection.containsNode(item, true));
  const long = lines > LONG_OUTPUT_LINES || text.length > LONG_OUTPUT_CHARACTERS;
  if (!reading) { setOutputExpanded(item, !ok || !long); }
}
