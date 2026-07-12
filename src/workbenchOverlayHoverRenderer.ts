// Renderer-side pointer handoff for detached Django shell hover widgets.

/** Builds JavaScript that preserves a native hover while the pointer enters its body portal. */
export function overlayHoverRendererSource(): string {
  return `
    const __dsoDetachedHoverSelector = ".monaco-resizable-hover,.monaco-hover,.monaco-editor-hover";
    const __dsoDetachedHoverResizeSashSelector = ".monaco-sash:not(.disabled)";
    const __dsoDetachedHoverTransitMs = 500;

    /** Returns the owner-matched portal that contains detached Monaco widgets. */
    function __dsoDetachedHoverPortal(root) {
      const portal = root && root.__dsoWidgetRoot;
      if (!portal || !portal.isConnected) { return null; }
      const owner = String(root.__dsoOwnerToken || "");
      const actual = String(portal.dataset && portal.dataset.djangoShellOverlayOwner || "");
      return owner && actual === owner ? portal : null;
    }

    /** Restores the hover portal above workbench webviews that were promoted after it. */
    function __dsoPromoteDetachedHoverPortal(root) {
      const portal = __dsoDetachedHoverPortal(root);
      const host = portal && portal.parentElement;
      if (!portal || !host || !host.appendChild || host.lastElementChild === portal) { return portal; }
      try { host.appendChild(portal); } catch (eHoverPortalPromote) {}
      return portal;
    }

    /** Returns the detached hover containing one event target. */
    function __dsoDetachedHoverForTarget(root, target) {
      const portal = __dsoDetachedHoverPortal(root);
      if (!portal || !target || !target.closest) { return null; }
      const hover = target.closest(__dsoDetachedHoverSelector);
      return hover && portal.contains(hover) ? hover : null;
    }

    /** Returns the enabled resize sash and detached hover under one event target. */
    function __dsoDetachedHoverResizeTarget(root, target) {
      const hover = __dsoDetachedHoverForTarget(root, target);
      if (!hover || !target || !target.closest) { return null; }
      const sash = target.closest(__dsoDetachedHoverResizeSashSelector);
      return sash && hover.contains && hover.contains(sash) ? { hover: hover, sash: sash } : null;
    }

    /** Returns whether a detached hover is still visibly rendered. */
    function __dsoDetachedHoverIsVisible(node) {
      if (!node || !node.isConnected || node.classList && node.classList.contains("hidden") || node.getAttribute && node.getAttribute("aria-hidden") === "true") { return false; }
      try {
        const style = window.getComputedStyle && window.getComputedStyle(node);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) { return false; }
      } catch (eHoverStyle) {}
      try { const rect = node.getBoundingClientRect && node.getBoundingClientRect(); if (rect && (!rect.width || !rect.height)) { return false; } } catch (eHoverRect) {}
      return true;
    }

    /** Returns whether the owner portal currently contains a visible content hover. */
    function __dsoHasVisibleDetachedHover(root) {
      const portal = __dsoDetachedHoverPortal(root);
      if (!portal || !portal.querySelectorAll) { return false; }
      const hovers = portal.querySelectorAll(__dsoDetachedHoverSelector);
      for (let index = 0; index < hovers.length; index++) {
        if (__dsoDetachedHoverIsVisible(hovers[index])) { return true; }
      }
      return false;
    }

    /** Returns Monaco's native content-hover controller when the contribution is available. */
    function __dsoContentHoverController(editor) {
      try { return editor && editor.getContribution && editor.getContribution("editor.contrib.contentHover"); } catch (eHoverContribution) {}
      return null;
    }

    /** Cancels the short editor-to-portal pointer transit deadline. */
    function __dsoClearDetachedHoverTransit(root) {
      if (!root || !root.__dsoDetachedHoverTransitTimer) { return; }
      window.clearTimeout(root.__dsoDetachedHoverTransitTimer);
      root.__dsoDetachedHoverTransitTimer = 0;
    }

    /** Cancels deferred resize completion while a newer drag or cleanup takes ownership. */
    function __dsoClearDetachedHoverResizeEnd(root) {
      if (!root || !root.__dsoDetachedHoverResizeEndTimer) { return; }
      window.clearTimeout(root.__dsoDetachedHoverResizeEndTimer);
      root.__dsoDetachedHoverResizeEndTimer = 0;
    }

    /** Returns whether this keeper acquired the right to dismiss the current native hover. */
    function __dsoCanDismissDetachedHover(root) {
      return !!(root && root.__dsoDetachedHoverHeld && root.__dsoDetachedHoverPreviousKeepOpen === false);
    }

    /** Restores the native hover controller flag captured before pointer handoff. */
    function __dsoReleaseDetachedHover(root) {
      if (!root) { return; }
      __dsoClearDetachedHoverTransit(root);
      const controller = root.__dsoDetachedHoverController;
      if (controller && root.__dsoDetachedHoverHeld) {
        try { controller.shouldKeepOpenOnEditorMouseMoveOrLeave = root.__dsoDetachedHoverPreviousKeepOpen; } catch (eHoverRelease) {}
      }
      root.__dsoDetachedHoverHeld = false;
      root.__dsoDetachedHoverController = null;
      root.__dsoDetachedHoverPreviousKeepOpen = undefined;
    }

    /** Holds Monaco's native content hover across one detached DOM boundary. */
    function __dsoHoldDetachedHover(root, editor) {
      const controller = __dsoContentHoverController(editor);
      if (!root || !controller) { return null; }
      if (root.__dsoDetachedHoverHeld && root.__dsoDetachedHoverController !== controller) { __dsoReleaseDetachedHover(root); }
      if (!root.__dsoDetachedHoverHeld) {
        root.__dsoDetachedHoverController = controller;
        root.__dsoDetachedHoverPreviousKeepOpen = controller.shouldKeepOpenOnEditorMouseMoveOrLeave;
        root.__dsoDetachedHoverHeld = true;
      }
      try { controller.shouldKeepOpenOnEditorMouseMoveOrLeave = true; } catch (eHoverHold) { __dsoReleaseDetachedHover(root); return null; }
      try { controller._cancelScheduler && controller._cancelScheduler(); } catch (eHoverScheduler) {}
      return controller;
    }

    /** Dismisses a hover whose pointer handoff ended outside both editor and portal. */
    function __dsoDismissDetachedHover(editor, controller) {
      try { if (controller && controller.hideContentHover) { controller.hideContentHover(); return; } } catch (eControllerHide) {}
      try { editor && editor.trigger && editor.trigger("django-shell-hover-handoff", "editor.action.hideHover", {}); } catch (eEditorHide) {}
    }

    /** Starts a bounded handoff interval before the pointer reaches the detached hover. */
    function __dsoStartDetachedHoverTransit(root, editor) {
      __dsoPromoteDetachedHoverPortal(root);
      const controller = __dsoHoldDetachedHover(root, editor);
      if (!controller) { return; }
      __dsoClearDetachedHoverTransit(root);
      root.__dsoDetachedHoverTransitTimer = window.setTimeout(function () {
        root.__dsoDetachedHoverTransitTimer = 0;
        if (root.__dsoDetachedHoverPointerInside) { return; }
        const activeController = root.__dsoDetachedHoverController || controller;
        const dismiss = __dsoCanDismissDetachedHover(root);
        __dsoReleaseDetachedHover(root);
        if (dismiss) { __dsoDismissDetachedHover(editor, activeController); }
      }, __dsoDetachedHoverTransitMs);
    }

    /** Finishes a sash drag after Monaco has processed its window-level mouseup. */
    function __dsoFinishDetachedHoverResize(root, editor, editorNode, releaseTarget) {
      if (!root || !root.__dsoDetachedHoverResizeActive) { return; }
      __dsoClearDetachedHoverResizeEnd(root);
      root.__dsoDetachedHoverResizeEndTimer = window.setTimeout(function () {
        root.__dsoDetachedHoverResizeEndTimer = 0;
        if (!root.__dsoDetachedHoverResizeActive) { return; }
        const resizeHover = root.__dsoDetachedHoverResizeHover;
        root.__dsoDetachedHoverResizeActive = false;
        root.__dsoDetachedHoverResizeHover = null;
        const releasedHover = __dsoDetachedHoverForTarget(root, releaseTarget);
        const releasedInsideHover = !!(resizeHover && releasedHover === resizeHover && __dsoDetachedHoverIsVisible(resizeHover));
        root.__dsoDetachedHoverPointerInside = releasedInsideHover;
        if (releasedInsideHover) { __dsoHoldDetachedHover(root, editor); return; }
        const returnedToEditor = !!(releaseTarget && editorNode.contains && editorNode.contains(releaseTarget));
        __dsoReleaseDetachedHover(root);
        if (returnedToEditor) { root.__dsoDetachedHoverPointerInside = false; }
      }, 0);
    }

    /** Installs the scoped native-hover keeper for one overlay editor and its owner portal. */
    window.__dsoInstallDetachedHoverKeeper = function (root, editor) {
      const portal = __dsoDetachedHoverPortal(root);
      const editorNode = editor && editor.getDomNode && editor.getDomNode();
      if (!root || !portal || !editorNode || !editorNode.addEventListener || !portal.addEventListener) { return "missing-hover-handoff-target"; }
      if (root.__dsoDetachedHoverKeeperEditor === editor && root.__dsoDetachedHoverKeeperPortal === portal && root.__dsoDetachedHoverKeeperCleanup) { return "already-installed"; }
      try { root.__dsoDetachedHoverKeeperCleanup && root.__dsoDetachedHoverKeeperCleanup(); } catch (eOldHoverKeeper) {}

      /** Arms the keeper before Monaco receives its non-capture editor leave event. */
      const onEditorMouseLeave = function () {
        if (__dsoHasVisibleDetachedHover(root)) { __dsoStartDetachedHoverTransit(root, editor); }
      };
      /** Arms direct editor-to-hover handoffs before native geometry rejects the portal edge. */
      const onEditorMouseOut = function (event) {
        if (__dsoDetachedHoverForTarget(root, event && event.relatedTarget)) { __dsoStartDetachedHoverTransit(root, editor); }
      };
      /** Returns native lifecycle ownership when the pointer comes back to the editor. */
      const onEditorMouseEnter = function () {
        root.__dsoDetachedHoverPointerInside = false;
        if (root.__dsoDetachedHoverResizeActive) { return; }
        __dsoReleaseDetachedHover(root);
      };
      /** Keeps the hover alive after the pointer reaches any part of its detached subtree. */
      const onPortalMouseOver = function (event) {
        if (!__dsoDetachedHoverForTarget(root, event && event.target)) { return; }
        root.__dsoDetachedHoverPointerInside = true;
        __dsoClearDetachedHoverTransit(root);
        __dsoHoldDetachedHover(root, editor);
      };
      /** Releases or dismisses the hover only after leaving its complete detached subtree. */
      const onPortalMouseOut = function (event) {
        if (!__dsoDetachedHoverForTarget(root, event && event.target) || __dsoDetachedHoverForTarget(root, event && event.relatedTarget)) { return; }
        root.__dsoDetachedHoverPointerInside = false;
        if (root.__dsoDetachedHoverResizeActive) { return; }
        const controller = root.__dsoDetachedHoverController || __dsoContentHoverController(editor);
        const dismiss = __dsoCanDismissDetachedHover(root);
        const returnedToEditor = !!(event && event.relatedTarget && editorNode.contains && editorNode.contains(event.relatedTarget));
        __dsoReleaseDetachedHover(root);
        if (!returnedToEditor && dismiss) { __dsoDismissDetachedHover(editor, controller); }
      };
      /** Acquires explicit hover ownership before Monaco begins an enabled sash drag. */
      const onPortalMouseDown = function (event) {
        if (event && typeof event.button === "number" && event.button !== 0) { return; }
        const resizeTarget = __dsoDetachedHoverResizeTarget(root, event && event.target);
        if (!resizeTarget) { return; }
        __dsoClearDetachedHoverResizeEnd(root);
        root.__dsoDetachedHoverResizeActive = true;
        root.__dsoDetachedHoverResizeHover = resizeTarget.hover;
        root.__dsoDetachedHoverPointerInside = true;
        __dsoClearDetachedHoverTransit(root);
        __dsoHoldDetachedHover(root, editor);
      };
      /** Stops Monaco's wrapper mouseleave from bypassing its own is-resizing guard. */
      const onPortalMouseLeave = function (event) {
        if (!root.__dsoDetachedHoverResizeActive || event && event.target !== root.__dsoDetachedHoverResizeHover) { return; }
        try { event && event.stopPropagation && event.stopPropagation(); } catch (eResizeLeave) {}
      };
      /** Defers resize release until Monaco's window-level sash listener has completed. */
      const onWindowMouseUp = function (event) {
        __dsoFinishDetachedHoverResize(root, editor, editorNode, event && event.target);
      };
      /** Releases a drag lease when the workbench window loses pointer ownership. */
      const onWindowBlur = function () {
        __dsoFinishDetachedHoverResize(root, editor, editorNode, null);
      };
      /** Releases stale controller state when Monaco hides or removes its hover DOM. */
      const onHoverMutation = function () {
        if (__dsoHasVisibleDetachedHover(root)) { __dsoPromoteDetachedHoverPortal(root); }
        if (root.__dsoDetachedHoverResizeActive) {
          const resizeHover = root.__dsoDetachedHoverResizeHover;
          if (resizeHover && resizeHover.isConnected) { return; }
          root.__dsoDetachedHoverResizeActive = false;
          root.__dsoDetachedHoverResizeHover = null;
          __dsoClearDetachedHoverResizeEnd(root);
        }
        if (root.__dsoDetachedHoverHeld && !__dsoHasVisibleDetachedHover(root)) {
          root.__dsoDetachedHoverPointerInside = false;
          __dsoReleaseDetachedHover(root);
        }
      };
      /** Reclaims top paint order when a workbench webview is appended after the live portal. */
      const onPortalHostMutation = function () {
        if (__dsoHasVisibleDetachedHover(root)) { __dsoPromoteDetachedHoverPortal(root); }
      };

      editorNode.addEventListener("mouseleave", onEditorMouseLeave, true);
      editorNode.addEventListener("mouseout", onEditorMouseOut, true);
      editorNode.addEventListener("mouseenter", onEditorMouseEnter, true);
      portal.addEventListener("mouseover", onPortalMouseOver, true);
      portal.addEventListener("mouseout", onPortalMouseOut, true);
      portal.addEventListener("mousedown", onPortalMouseDown, true);
      portal.addEventListener("mouseleave", onPortalMouseLeave, true);
      window.addEventListener("mouseup", onWindowMouseUp, true);
      window.addEventListener("blur", onWindowBlur, true);
      const portalHostObserver = new MutationObserver(onPortalHostMutation);
      if (portal.parentElement) { portalHostObserver.observe(portal.parentElement, { childList: true }); }
      const observer = new MutationObserver(onHoverMutation);
      observer.observe(portal, { attributes: true, childList: true, subtree: true });
      root.__dsoDetachedHoverKeeperEditor = editor;
      root.__dsoDetachedHoverKeeperPortal = portal;
      root.__dsoDetachedHoverKeeperObserver = observer;
      root.__dsoDetachedHoverStackObserver = portalHostObserver;
      /** Removes detached-hover listeners and restores native controller ownership. */
      root.__dsoDetachedHoverKeeperCleanup = function () {
        __dsoClearDetachedHoverResizeEnd(root);
        root.__dsoDetachedHoverResizeActive = false;
        root.__dsoDetachedHoverResizeHover = null;
        __dsoReleaseDetachedHover(root);
        root.__dsoDetachedHoverPointerInside = false;
        try { portalHostObserver.disconnect(); } catch (eHoverStackObserver) {}
        try { observer.disconnect(); } catch (eHoverObserver) {}
        editorNode.removeEventListener("mouseleave", onEditorMouseLeave, true);
        editorNode.removeEventListener("mouseout", onEditorMouseOut, true);
        editorNode.removeEventListener("mouseenter", onEditorMouseEnter, true);
        portal.removeEventListener("mouseover", onPortalMouseOver, true);
        portal.removeEventListener("mouseout", onPortalMouseOut, true);
        portal.removeEventListener("mousedown", onPortalMouseDown, true);
        portal.removeEventListener("mouseleave", onPortalMouseLeave, true);
        window.removeEventListener("mouseup", onWindowMouseUp, true);
        window.removeEventListener("blur", onWindowBlur, true);
        root.__dsoDetachedHoverKeeperEditor = null;
        root.__dsoDetachedHoverKeeperPortal = null;
        root.__dsoDetachedHoverKeeperObserver = null;
        root.__dsoDetachedHoverStackObserver = null;
        root.__dsoDetachedHoverKeeperCleanup = null;
      };
      return "installed";
    };
  `;
}
