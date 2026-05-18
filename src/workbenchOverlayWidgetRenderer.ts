// Renderer-side overflow widget layer for Django shell Monaco popups.

/** Builds JavaScript that keeps hover and completion popups inside the tab. */
export function overlayWidgetRendererSource(): string {
  return `
    /** Copies VS Code theme variables into the detached widget layer. */
    function __dsoSyncWidgetTheme(node) {
      try {
        const source = document.querySelector(".monaco-workbench") || document.body;
        if (!source || !node || !window.getComputedStyle) { return; }
        const style = window.getComputedStyle(source);
        for (let i = 0; i < style.length; i++) {
          const name = style[i];
          if (name && name.indexOf("--vscode-") === 0) { node.style.setProperty(name, style.getPropertyValue(name)); }
        }
        node.style.setProperty("color", style.getPropertyValue("--vscode-foreground") || style.color || "inherit");
        node.style.setProperty("font-family", style.getPropertyValue("--vscode-font-family") || style.fontFamily || "inherit");
        node.style.setProperty("font-size", style.getPropertyValue("--vscode-font-size") || style.fontSize || "inherit");
      } catch (eTheme) {}
    }

    /** Installs CSS for the tab-scoped Monaco overflow widget layer. */
    function __dsoEnsureWidgetStyle() {
      let style = document.getElementById("django-shell-overlay-widget-style");
      if (!style) { style = document.createElement("style"); }
      style.id = "django-shell-overlay-widget-style";
      style.textContent = ".django-shell-overlay-widget-root{position:absolute;left:0;top:0;width:0!important;height:0!important;min-width:0!important;min-height:0!important;overflow:visible;z-index:30;pointer-events:none;background:transparent!important}.django-shell-overlay-widget-layer{position:fixed;left:0;top:0;width:0!important;height:0!important;min-width:0!important;min-height:0!important;overflow:visible;z-index:31;pointer-events:none;background:transparent!important}.django-shell-overlay-widget-layer .monaco-hover,.django-shell-overlay-widget-layer .monaco-hover *,.django-shell-overlay-widget-layer .monaco-editor-hover,.django-shell-overlay-widget-layer .monaco-editor-hover *,.django-shell-overlay-widget-layer .suggest-widget,.django-shell-overlay-widget-layer .suggest-widget *,.django-shell-overlay-widget-layer .parameter-hints-widget,.django-shell-overlay-widget-layer .parameter-hints-widget *,.django-shell-overlay-widget-layer .context-view,.django-shell-overlay-widget-layer .context-view *{pointer-events:auto!important}.django-shell-overlay-widget-layer .monaco-hover,.django-shell-overlay-widget-layer .monaco-editor-hover,.django-shell-overlay-widget-layer .suggest-widget,.django-shell-overlay-widget-layer .parameter-hints-widget,.django-shell-overlay-widget-layer .context-view{box-sizing:border-box!important}";
      if (!style.parentElement) { document.head.appendChild(style); }
    }

    /** Returns the tab-hosted node used by Monaco for hover and completion widgets. */
    function __dsoOverlayWidgetNode(root) {
      if (!root) { return undefined; }
      const attach = __dsoAttachRoot(root);
      const host = attach && attach.host ? attach.host : root.parentElement;
      if (!host) { return undefined; }
      __dsoEnsureWidgetStyle();
      let layerRoot = host.querySelector(".django-shell-overlay-widget-root");
      let layer = layerRoot && layerRoot.querySelector(".django-shell-overlay-widget-layer");
      if (!layerRoot) {
        layerRoot = document.createElement("div");
        layerRoot.className = "monaco-workbench django-shell-overlay-widget-root";
        host.appendChild(layerRoot);
      }
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "monaco-editor django-shell-overlay-widget-layer";
        layerRoot.appendChild(layer);
      }
      root.__dsoWidgetRoot = layerRoot;
      root.__dsoWidgetLayer = layer;
      __dsoSyncWidgetTheme(layerRoot);
      __dsoInstallWidgetClamp(root);
      return layer;
    }

    /** Attaches Monaco overflow widgets after the editor has been created. */
    window.__dsoConfigureOverlayWidgets = function (root, editor) {
      if (!root || !editor || !editor.updateOptions) { return; }
      const node = __dsoOverlayWidgetNode(root);
      if (!node) { return; }
      editor.updateOptions({ fixedOverflowWidgets: true, overflowWidgetsDomNode: node });
    };

    /** Returns the visible tab rectangle in viewport coordinates. */
    function __dsoWidgetBoundary(root) {
      const attach = __dsoAttachRoot(root);
      const host = attach && attach.host ? attach.host : root.parentElement;
      if (!host) { return { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 }; }
      const rect = host.getBoundingClientRect();
      return { bottom: Math.min(window.innerHeight, rect.bottom), left: Math.max(0, rect.left), right: Math.min(window.innerWidth, rect.right), top: Math.max(0, rect.top) };
    }

    /** Applies one clamp pass to a visible Monaco popup widget. */
    function __dsoClampWidget(root, node) {
      if (!node || !node.getBoundingClientRect || node.classList.contains("hidden")) { return; }
      let original = node.getAttribute("data-dso-original-transform");
      if (original === null) {
        original = node.style.transform || "";
        node.setAttribute("data-dso-original-transform", original);
      }
      const boundary = __dsoWidgetBoundary(root);
      const margin = 6;
      const maxWidth = Math.max(160, boundary.right - boundary.left - margin * 2);
      const maxHeight = Math.max(80, boundary.bottom - boundary.top - margin * 2);
      if (node.style.maxWidth !== maxWidth + "px") { node.style.maxWidth = maxWidth + "px"; }
      if (node.style.maxHeight !== maxHeight + "px") { node.style.maxHeight = maxHeight + "px"; }
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) { return; }
      const prevDx = Number(node.getAttribute("data-dso-shift-x") || 0);
      const prevDy = Number(node.getAttribute("data-dso-shift-y") || 0);
      const base = { bottom: rect.bottom - prevDy, left: rect.left - prevDx, right: rect.right - prevDx, top: rect.top - prevDy };
      let dx = 0;
      let dy = 0;
      if (base.right > boundary.right - margin) { dx = boundary.right - margin - base.right; }
      if (base.left + dx < boundary.left + margin) { dx += boundary.left + margin - (base.left + dx); }
      if (base.bottom > boundary.bottom - margin) { dy = boundary.bottom - margin - base.bottom; }
      if (base.top + dy < boundary.top + margin) { dy += boundary.top + margin - (base.top + dy); }
      const nextTransform = (original ? original + " " : "") + "translate(" + Math.round(dx) + "px," + Math.round(dy) + "px)";
      if (node.style.transform !== nextTransform) { node.style.transform = nextTransform; }
      if (node.getAttribute("data-dso-shift-x") !== String(Math.round(dx))) { node.setAttribute("data-dso-shift-x", String(Math.round(dx))); }
      if (node.getAttribute("data-dso-shift-y") !== String(Math.round(dy))) { node.setAttribute("data-dso-shift-y", String(Math.round(dy))); }
    }

    /** Runs a clamp pass for hover, completion, and parameter widgets. */
    function __dsoClampOverlayWidgets(root) {
      const layer = root && root.__dsoWidgetLayer;
      if (!layer) { return; }
      const selectors = ".monaco-hover,.monaco-editor-hover,.suggest-widget,.parameter-hints-widget,.context-view";
      const widgets = layer.querySelectorAll(selectors);
      for (let i = 0; i < widgets.length; i++) { __dsoClampWidget(root, widgets[i]); }
    }

    /** Schedules popup clamping after Monaco has placed its widgets. */
    window.__dsoScheduleWidgetClamp = function (root) {
      if (!root || root.__dsoWidgetClampFrame) { return; }
      root.__dsoWidgetClampFrame = window.requestAnimationFrame(function () {
        root.__dsoWidgetClampFrame = 0;
        __dsoClampOverlayWidgets(root);
      });
    };

    /** Observes the tab-level popup layer so popup placement stays bounded. */
    function __dsoInstallWidgetClamp(root) {
      if (!root || root.__dsoWidgetClampInstalled || !root.__dsoWidgetLayer) { return; }
      const schedule = function () { window.__dsoScheduleWidgetClamp(root); };
      const observer = new MutationObserver(schedule);
      observer.observe(root.__dsoWidgetLayer, { attributes: true, childList: true, subtree: true });
      window.addEventListener("resize", schedule, true);
      document.addEventListener("scroll", schedule, true);
      root.__dsoWidgetClampInstalled = true;
      root.__dsoWidgetClampObserver = observer;
      schedule();
    }
  `;
}
