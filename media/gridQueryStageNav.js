// Keyboard roving-tab behavior for Query Builder stage and review navigation.

/** Adds conventional arrow-key roving focus to one compact Query Builder tab list. */
export function installQueryRovingTabs(items, select) {
  items.forEach((item, index) => item.button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { return; }
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    select(items[target].value);
    items[target].button.focus();
  }));
}
