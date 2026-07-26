// Surface-state helpers for model and ORM query webviews.

/** Returns whether this webview is the standalone custom ORM query surface. */
export function isQuerySurface(root = document) {
  return root.querySelector(".app")?.dataset.surface === "query";
}

/** Restores and persists the query-log drawer's explicit open state. */
export function setQueryLogOpen({ open, panel, persist, toggle }) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  persist?.({ ...(persist.state?.() || {}), logOpen: open });
}

/** Renders a concise recovery surface without exposing a raw backend stack trace. */
export function renderBrowserError({ create, grid, message, onOpenConsole, onRetry, status }) {
  const detail = conciseError(message);
  grid.innerHTML = "";
  const box = create("div", { className: "error-state" }, create("strong", {}, "Could not load Django data"), create("span", {}, detail));
  box.append(create("button", { className: "secondary", type: "button" }, "Retry"), create("button", { className: "secondary", type: "button" }, "Open Django Shell"));
  const [retry, openConsole] = box.querySelectorAll("button");
  retry.addEventListener("click", onRetry);
  openConsole.addEventListener("click", onOpenConsole);
  grid.appendChild(box);
  status.textContent = detail;
  return detail;
}

/** Removes implementation prefixes and bounds error copy to one readable sentence. */
function conciseError(message) {
  const text = String(message || "Django Shell could not load this result.").split(/\r?\n/)[0].replace(/^[\w.]+(?:Error|Exception):\s*/, "").trim();
  return text.length <= 220 ? text || "Django Shell could not load this result." : `${text.slice(0, 217)}...`;
}
