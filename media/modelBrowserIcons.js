// Codicon element helper for compact accessible model-browser controls.

/** Creates an aria-hidden Codicon span for a labeled parent control. */
export function codicon(name) {
  const icon = document.createElement("span");
  icon.className = `codicon codicon-${name}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
