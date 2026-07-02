// Renderer-side webview-frame targeting for the Django shell workbench overlay.

/** Builds JavaScript that binds the overlay to the Django Shell console webview frame, preferring it over any other webview. */
export function overlayFrameRendererSource(): string {
  return `
    /** Returns bounding rects of editor groups whose ACTIVE tab is the Django Shell console (title set in customConsole.ts createWebviewPanel(..., "Django Shell", ...)); never the model browser ("… — data") or the catalog ("Models"). */
    function __dsoConsoleGroups() {
      const tabs = document.querySelectorAll(".tab.active,.tab.checked,.tab[aria-selected='true']");
      const rects = [];
      for (let i = 0; i < tabs.length; i++) {
        const label = tabs[i].getAttribute("aria-label") || tabs[i].getAttribute("title") || "";
        if (label.indexOf("Django Shell") < 0) { continue; }
        const group = tabs[i].closest(".editor-group-container,.split-view-view,.editor-group,.part.editor");
        if (group) { rects.push(group.getBoundingClientRect()); }
      }
      return rects;
    }
    /** Returns whether a webview frame sits over a Django Shell console editor group (works whether the webview is hoisted into a shared layer or nested in the group DOM, since both are positioned within the group rect). */
    function __dsoFrameIsConsole(frame, rects) {
      const fr = frame.getBoundingClientRect();
      const frameArea = Math.max(1, (fr.right - fr.left) * (fr.bottom - fr.top));
      for (let i = 0; i < rects.length; i++) {
        const gr = rects[i];
        const overlap = Math.max(0, Math.min(fr.right, gr.right) - Math.max(fr.left, gr.left)) * Math.max(0, Math.min(fr.bottom, gr.bottom) - Math.max(fr.top, gr.top));
        if (overlap / frameArea > 0.6) { return true; }
      }
      return false;
    }
    /** Returns the on-screen area of a webview frame, or 0 when it is hidden. */
    function __dsoFrameArea(frame) {
      const style = window.getComputedStyle(frame);
      if (style.display === "none" || style.visibility === "hidden") { return 0; }
      const rect = frame.getBoundingClientRect();
      return Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    }
    /** Returns every webview-like frame element in the workbench window. */
    function __dsoWebviewFrames() {
      return document.querySelectorAll("iframe.webview,.webview iframe,iframe[src^='vscode-webview'],iframe[id*='webview'],webview");
    }
    /** Returns the largest visible webview owned by the Django Shell console, or null when none is detectable. */
    function __dsoConsoleFrame(rects) {
      if (!rects || !rects.length) { return null; }
      const frames = __dsoWebviewFrames();
      let best = null, bestArea = 0;
      for (let i = 0; i < frames.length; i++) {
        const area = __dsoFrameArea(frames[i]);
        if (area > 4000 && area > bestArea && __dsoFrameIsConsole(frames[i], rects)) { best = frames[i]; bestArea = area; }
      }
      return best;
    }
    /** Finds the console webview frame without falling through to unrelated webviews. */
    function __dsoFindWebviewFrame(rects) {
      rects = rects || __dsoConsoleGroups();
      return __dsoConsoleFrame(rects);
    }
    /** Returns the top-level portal host outside webview iframe clipping. */
    function __dsoOverlayPortalHost() {
      return document.body || document.documentElement;
    }
    /** Binds the overlay to the console webview without letting a closed console fall through to an unrelated webview. */
    function __dsoAttachRoot(root) {
      const rects = __dsoConsoleGroups();
      const owned = __dsoConsoleFrame(rects);
      if (owned) { root.__dsoHadConsoleFrame = true; }
      if (!rects.length) { root.__dsoFrame = null; return null; }
      const cached = root.__dsoFrame && root.__dsoFrame.isConnected && __dsoFrameIsConsole(root.__dsoFrame, rects) ? root.__dsoFrame : null;
      const frame = owned || cached || __dsoFindWebviewFrame(rects);
      const host = __dsoOverlayPortalHost();
      if (!frame || !host) { root.__dsoFrame = null; return null; }
      root.__dsoFrame = frame;
      if (host !== document.body && host !== document.documentElement && window.getComputedStyle(host).position === "static") { host.style.position = "relative"; }
      if (root.parentElement !== host) { host.appendChild(root); }
      return { frame: frame, host: host };
    }
  `;
}
