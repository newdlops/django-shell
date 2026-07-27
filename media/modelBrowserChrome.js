// Responsive header and query-log chrome for the Django model data browser.

import { createOverflowMenu } from "./uiOverflowMenu.js";

/** Installs secondary-action overflow behavior for the model browser header. */
export function installModelBrowserChrome(root = document) {
  const trigger = root.getElementById("browserOverflow");
  const menu = root.getElementById("browserOverflowMenu");
  const wideContainer = root.getElementById("browserWideActions");
  const compactContainer = root.getElementById("browserCompactActions");
  if (!trigger || !menu || !wideContainer || !compactContainer) {
    return { dispose() {}, refresh() {} };
  }
  const actions = [
    { element: root.getElementById("queryDrawerToggle") || root.getElementById("groupToggle"), priority: "secondary" },
    { element: root.getElementById("logToggle"), priority: "secondary" },
    { element: root.getElementById("reload"), priority: "context" }
  ].filter((action) => action.element);
  return createOverflowMenu({ actions, compactContainer, menu, trigger, wideContainer });
}
