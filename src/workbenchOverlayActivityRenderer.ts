// Renderer-side active and parked lifecycle controls for the Django shell overlay.

/** Builds JavaScript that pauses and restores overlay observers without rebuilding Monaco. */
export function overlayActivityRendererSource(): string {
  return `
    /** Stops recurring overlay observers and frame work while the warm editor is parked. */
    window.__dsoPauseOverlayActivity = function (root) {
      if (!root || root.__dsoOverlayActive === false) { return; }
      root.__dsoOverlayActive = false;
      try { if (root.__dsoGeometryMissTimer) { window.clearTimeout(root.__dsoGeometryMissTimer); root.__dsoGeometryMissTimer = 0; } } catch (eActivityMissTimer) {}
      try { root.__dsoGeometrySyncCleanup && root.__dsoGeometrySyncCleanup(); } catch (eActivityGeometry) {}
      try { root.__dsoWidgetClampCleanup && root.__dsoWidgetClampCleanup(); } catch (eActivityWidget) {}
      try { root.__dsoDetachedHoverKeeperCleanup && root.__dsoDetachedHoverKeeperCleanup(); } catch (eActivityHover) {}
      try { root.__dsoResizeObserver && root.__dsoResizeObserver.disconnect && root.__dsoResizeObserver.disconnect(); } catch (eActivityResize) {}
      try { if (root.__dsoGeometrySyncFrame) { window.cancelAnimationFrame(root.__dsoGeometrySyncFrame); root.__dsoGeometrySyncFrame = 0; } } catch (eActivityGeometryFrame) {}
      try { if (root.__dsoWidgetClampFrame) { window.cancelAnimationFrame(root.__dsoWidgetClampFrame); root.__dsoWidgetClampFrame = 0; } } catch (eActivityWidgetFrame) {}
      try { if (root.__dsoPreludeGuardFrame) { root.__dsoPreludeGuardPending = true; window.cancelAnimationFrame(root.__dsoPreludeGuardFrame); root.__dsoPreludeGuardFrame = 0; } } catch (eActivityPreludeFrame) {}
      try { if (root.__dsoSemanticTimer) { window.clearTimeout(root.__dsoSemanticTimer); root.__dsoSemanticTimer = 0; root.__dsoSemanticPending = true; } } catch (eActivitySemantic) {}
    };
    /** Restores each paused observer once and applies the newest geometry before showing widgets. */
    window.__dsoResumeOverlayActivity = function (root) {
      if (!root || root.__dsoOverlayActive === true) { return; }
      root.__dsoOverlayActive = true;
      try { __dsoInstallGeometrySync(root); } catch (eResumeGeometry) {}
      try { window.__dsoInstallWidgetClamp && window.__dsoInstallWidgetClamp(root); } catch (eResumeWidget) {}
      const editor = root.__djangoShellEditor;
      const host = root.querySelector && root.querySelector(".django-shell-overlay-editor");
      try { if (host && typeof ResizeObserver !== "undefined") { root.__dsoResizeObserver && root.__dsoResizeObserver.disconnect && root.__dsoResizeObserver.disconnect(); root.__dsoResizeObserver = new ResizeObserver(function () { try { __dsoLayoutOverlayEditor(root); } catch (eResumeLayout) {} }); root.__dsoResizeObserver.observe(host); } } catch (eResumeResize) {}
      try { if (editor && window.__dsoInstallDetachedHoverKeeper) { window.__dsoInstallDetachedHoverKeeper(root, editor); } } catch (eResumeHover) {}
      try { if (editor && window.__dsoInstallPreludeSemanticDecorations) { window.__dsoInstallPreludeSemanticDecorations(root, editor); } } catch (eResumeSemantic) {}
      try { if (root.__dsoPreludeGuardPending && editor && window.__dsoSchedulePreludeGuard) { root.__dsoPreludeGuardPending = false; window.__dsoSchedulePreludeGuard(root, editor); } } catch (eResumePrelude) {}
      try { if (root.__dsoSemanticPending && window.__dsoSchedulePreludeSemanticDecorations) { root.__dsoSemanticPending = false; window.__dsoSchedulePreludeSemanticDecorations(root); } } catch (eResumeSemanticPending) {}
    };
  `;
}
