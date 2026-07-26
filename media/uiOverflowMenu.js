// Responsive secondary-action overflow menu with keyboard and focus management.

/** Creates a responsive overflow menu that moves, rather than duplicates, action elements. */
export function createOverflowMenu({
  actions,
  compactContainer,
  menu,
  narrowAt = 640,
  trigger,
  wideAt = 960,
  wideContainer
}) {
  let open = false;
  let lastCompact = false;
  const root = trigger.closest("[data-overflow-root]") || document.body;

  /** Returns actions that are currently visible in the menu. */
  function menuItems() {
    return [...menu.querySelectorAll('[role="menuitem"]:not([hidden]):not([disabled])')];
  }

  /** Closes the popup and optionally restores focus to its trigger. */
  function close({ restoreFocus = false } = {}) {
    if (!open) {
      return;
    }
    open = false;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      trigger.focus();
    }
  }

  /** Opens the popup when at least one action is available. */
  function show() {
    const items = menuItems();
    if (!items.length) {
      return;
    }
    open = true;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    items[0].focus();
  }

  /** Moves each secondary/context action into the appropriate single container. */
  function layout(width = root.clientWidth) {
    const compact = width < wideAt;
    const narrow = width < narrowAt;
    for (const action of actions) {
      const { element, priority } = action;
      const overflow = priority === "secondary" || (priority === "context" && narrow);
      const destination = compact && overflow ? menu : compact && priority === "context" ? compactContainer : wideContainer;
      if (element.parentElement !== destination) {
        destination.appendChild(element);
      }
      element.hidden = false;
      if (destination === menu) {
        element.setAttribute("role", "menuitem");
      } else {
        element.removeAttribute("role");
      }
    }
    compactContainer.hidden = !compactContainer.childElementCount;
    lastCompact = compact;
    const hasMenuItems = menu.querySelectorAll('[role="menuitem"]').length > 0;
    trigger.hidden = !hasMenuItems;
    if (!hasMenuItems) {
      close();
    }
  }

  /** Handles menu navigation without changing the action's native click behavior. */
  function onMenuKeydown(event) {
    const items = menuItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items.at(-1)?.focus();
    }
  }

  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.addEventListener("click", () => open ? close({ restoreFocus: true }) : show());
  menu.addEventListener("keydown", onMenuKeydown);
  menu.addEventListener("click", () => close());
  document.addEventListener("pointerdown", (event) => {
    if (open && !root.contains(event.target)) {
      close();
    }
  });
  root.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (open && !root.contains(document.activeElement)) {
        close();
      }
    });
  });
  const observer = new ResizeObserver((entries) => layout(entries[0]?.contentRect.width));
  observer.observe(root);
  layout();

  return {
    /** Closes the menu and disconnects its observer. */
    dispose() {
      observer.disconnect();
      close();
    },
    /** Re-evaluates action placement after a caller changes visibility. */
    refresh() {
      layout();
    },
    /** Reports whether actions are currently using compact placement. */
    isCompact() {
      return lastCompact;
    }
  };
}
