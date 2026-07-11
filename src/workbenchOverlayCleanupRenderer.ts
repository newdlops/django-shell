// Renderer-side cleanup helpers for the Django shell workbench overlay.

/** Builds JavaScript that tears down renderer-owned overlay resources. */
export function overlayCleanupRendererSource(): string {
  return `
    /** Disposes one VS Code or Monaco disposable-like value. */
    function __dsoDisposeValue(value) {
      try { value && value.dispose && value.dispose(); } catch (eDisposeValue) {}
    }

    /** Returns the Monaco model owned by one overlay editor. */
    function __dsoOverlayModel(editor) {
      try { return editor && editor.getModel && editor.getModel(); } catch (eOverlayModel) {}
      return null;
    }

    /** Returns whether a model belongs to the generated overlay URI. */
    function __dsoIsOverlayModel(model) {
      try { return !!(model && model.uri && String(model.uri) === String(window.__djangoShellOverlayModelUri)); } catch (eModelUri) {}
      return false;
    }

    /** Removes one value from a captured object list. */
    function __dsoForgetFromList(list, value) {
      if (!list || !value) { return; }
      for (let index = list.length - 1; index >= 0; index--) {
        if (list[index] === value) { list.splice(index, 1); }
      }
    }

    /** Drops overlay-owned widgets from global workbench capture lists. */
    function __dsoForgetOverlayCapture(editor) {
      const caps = window.__dsoCaptures || {};
      if (editor) { __dsoForgetFromList(caps.widgets, editor); }
      else if (caps.widgets) { caps.widgets.length = 0; }
      const exact = window.__dsoExactCapture || {};
      if (!editor || exact.widget === editor) { exact.widget = null; }
    }

    /** Saves the latest editor text before the overlay editor is destroyed. */
    function __dsoRememberOverlayText(root, editor) {
      let code = String(window.__djangoShellOverlayInitialText || "");
      try { if (editor) { code = __dsoEditorValue(editor); } } catch (eReadOverlayText) {}
      window.__djangoShellOverlayInitialText = code;
      try { if (root && root.__dsoSyncTimer) { window.clearTimeout(root.__dsoSyncTimer); root.__dsoSyncTimer = 0; } } catch (eClearSyncTimer) {}
      try { __dsoPost({ type: "change", code: code }); } catch (ePostOverlayText) {}
    }

    /** Replaces live overlay text before disposing it during a kernel restart. */
    function __dsoResetOverlayText(root, text) {
      const nextText = String(text || "");
      window.__djangoShellOverlayInitialText = nextText;
      window.__djangoShellOverlayPrelude = "";
      try { if (root) { root.__dsoPreludeText = ""; root.__dsoProtectedPrefix = nextText; } } catch (eRootPrelude) {}
      try {
        const editor = root && root.__djangoShellEditor;
        const model = editor && editor.getModel && editor.getModel();
        if (model && model.setValue) { model.setValue(nextText); }
      } catch (eResetModel) {}
    }

    /** Disconnects DOM observers and timers owned by one overlay root. */
    function __dsoStopOverlayObservers(root) {
      try { if (root.__dsoGeometryTimer) { window.clearInterval(root.__dsoGeometryTimer); root.__dsoGeometryTimer = 0; } } catch (eGeometryTimer) {}
      try { if (root.__dsoPendingRetryTimer) { window.clearTimeout(root.__dsoPendingRetryTimer); root.__dsoPendingRetryTimer = 0; } } catch (eRetryTimer) {}
      try { if (root.__dsoPreludeGuardTimer) { window.clearTimeout(root.__dsoPreludeGuardTimer); root.__dsoPreludeGuardTimer = 0; } } catch (ePreludeTimer) {}
      try { if (root.__dsoSemanticTimer) { window.clearTimeout(root.__dsoSemanticTimer); root.__dsoSemanticTimer = 0; } } catch (eSemanticTimer) {}
      try { if (root.__dsoCursorRevealTimer) { window.clearTimeout(root.__dsoCursorRevealTimer); root.__dsoCursorRevealTimer = 0; } } catch (eCursorRevealTimer) {}
      try { if (root.__dsoWidgetClampFrame) { window.cancelAnimationFrame(root.__dsoWidgetClampFrame); root.__dsoWidgetClampFrame = 0; } } catch (eWidgetFrame) {}
      try { if (root.__dsoGeometrySyncFrame) { window.cancelAnimationFrame(root.__dsoGeometrySyncFrame); root.__dsoGeometrySyncFrame = 0; } } catch (eGeometrySyncFrame) {}
      try { root.__dsoResizeObserver && root.__dsoResizeObserver.disconnect && root.__dsoResizeObserver.disconnect(); } catch (eResizeObserver) {}
      try { root.__dsoGeometrySyncCleanup && root.__dsoGeometrySyncCleanup(); } catch (eGeometrySyncCleanup) {}
      try { root.__dsoWidgetClampCleanup && root.__dsoWidgetClampCleanup(); } catch (eWidgetCleanup) {}
    }

    /** Disposes all listeners and models owned by the overlay root. */
    window.__dsoDisposeOverlay = function (root, force) {
      root = root || document.getElementById("django-shell-overlay");
      if (!root) {
        try { if (window.__dsoStopOverlayCapture) { window.__dsoStopOverlayCapture(window.__djangoShellOverlayOwnerToken); } } catch (eStopOrphanCapture) {}
        try { const report = window.__dsoRemoveOverlayWidgetPortal ? window.__dsoRemoveOverlayWidgetPortal(null, window.__djangoShellOverlayOwnerToken) : ""; return report === "removed" ? "orphan-widget-removed" : "no-overlay"; } catch (eRemoveOrphanWidgetRoot) { return "no-overlay"; }
      }
      if (!force && root.__dsoOwnerToken && root.__dsoOwnerToken !== window.__djangoShellOverlayOwnerToken) { return "owner-mismatch"; }
      try { if (window.__dsoStopOverlayCapture) { window.__dsoStopOverlayCapture(root.__dsoOwnerToken); } } catch (eStopCapture) {}
      const editor = root.__djangoShellEditor;
      const model = __dsoOverlayModel(editor);
      __dsoRememberOverlayText(root, editor);
      try { root.__dsoEnterCleanup && root.__dsoEnterCleanup(); } catch (eEnterCleanup) {}
      __dsoDisposeValue(root.__dsoSyncDisposable);
      __dsoDisposeValue(root.__dsoPreludeCursorDisposable);
      __dsoDisposeValue(root.__dsoPreludeModelDisposable);
      __dsoDisposeValue(root.__dsoPreludeKeyDisposable);
      __dsoDisposeValue(root.__dsoSemanticDisposable);
      __dsoStopOverlayObservers(root);
      __dsoForgetOverlayCapture(editor);
      __dsoDisposeValue(editor);
      if (__dsoIsOverlayModel(model)) { __dsoDisposeValue(model); }
      try { if (window.__dsoRemoveOverlayWidgetPortal) { window.__dsoRemoveOverlayWidgetPortal(root, root.__dsoOwnerToken); } else if (root.__dsoWidgetRoot && root.__dsoWidgetRoot.parentElement) { root.__dsoWidgetRoot.parentElement.removeChild(root.__dsoWidgetRoot); } } catch (eRemoveWidgetRoot) {}
      try { root.parentElement ? root.parentElement.removeChild(root) : (root.style.display = "none"); } catch (eRemoveRoot) {}
      try { __dsoPost({ type: "log", event: "dispose", hadEditor: !!editor, hadModel: !!model }); } catch (eLogDispose) {}
      return "ok";
    };

    /** Clears stale shell input before tearing down the overlay for a fresh backend. */
    window.__djangoShellOverlayReset = function (initialText, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      __dsoResetOverlayText(root, initialText);
      return window.__dsoDisposeOverlay(root);
    };
  `;
}
