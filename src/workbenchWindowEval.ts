// Main-process expression builder that targets only the owning VS Code workbench window.

/** Extracts one unexecuted focused-window claim returned by the Electron main process. */
export function parseFocusedWorkbenchCandidate(raw: string): number | undefined {
  const match = /^__DSO_FOCUSED_WINDOW_CANDIDATE__:(\d+)$/.exec(raw.trim());
  const candidate = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
}

/** Builds a bounded Electron-main expression that evaluates JavaScript in one confirmed workbench renderer. */
export function mainProcessEvalExpression(rendererExpression: string, windowId: number | undefined, rendererTimeoutMs: number, ownerToken: string, panelTitle: string, workspaceTitle: string, allowFocusedPanelClaim: boolean): string {
  const wrappedRendererExpression = `
    (async function () {
      try {
        return await (${rendererExpression});
      } catch (error) {
        return "renderer-throw:" + String(error && (error.stack || error.message) || error);
      }
    })()
  `.trim();
  const ownershipProbeExpression = `
    (function () {
      const owner = ${JSON.stringify(ownerToken)}, title = ${JSON.stringify(panelTitle)}, workspace = ${JSON.stringify(workspaceTitle)};
      const root = document.getElementById("django-shell-overlay");
      if ((root && root.__dsoOwnerToken === owner) || window.__djangoShellOverlayOwnerToken === owner || (window.__djangoShellOverlayBridge && window.__djangoShellOverlayBridge.token === owner)) { return "owner"; }
      const tabs = document.querySelectorAll(".tab.active,.tab.checked,.tab[aria-selected='true']");
      for (let index = 0; index < tabs.length; index++) {
        const label = tabs[index].getAttribute("aria-label") || tabs[index].getAttribute("title") || "";
        if (label.indexOf(title) >= 0) {
          const suffix = " — " + workspace;
          return workspace && String(document.title || "").endsWith(suffix) ? "workspace-panel" : "panel";
        }
      }
      return "";
    })()
  `.trim();
  return `
    (async function () {
      const req = typeof require === "function"
        ? require
        : (process && process.mainModule && typeof process.mainModule.require === "function" ? process.mainModule.require.bind(process.mainModule) : undefined);
      if (!req) { return "no-main-require"; }
      const BW = req("electron").BrowserWindow;
      const wins = BW.getAllWindows().filter((win) => /workbench\\.(?:esm\\.)?html/.test(win.webContents.getURL()));
      const requestedId = ${JSON.stringify(windowId ?? null)};
      const allowFocusedClaim = ${JSON.stringify(allowFocusedPanelClaim)};
      const requested = requestedId ? BW.fromId(requestedId) : undefined;
      let target = requested && wins.includes(requested) ? requested : undefined;
      if (!target && !requestedId && wins.length === 1) { target = wins[0]; }
      if (!target && !requestedId && wins.length > 1) {
        const focusedBefore = allowFocusedClaim ? BW.getFocusedWindow() : undefined;
        /** Probes one renderer without allowing a suspended window to block selection. */
        const probeWindow = function (win) {
          let timeoutHandle;
          try {
            const execution = win.webContents.executeJavaScript(${JSON.stringify(ownershipProbeExpression)}, true).then(function (value) { return String(value || ""); }, function () { return ""; });
            return Promise.race([execution, new Promise(function (resolve) { timeoutHandle = setTimeout(function () { resolve(""); }, 180); })]).then(function (match) { if (timeoutHandle) { clearTimeout(timeoutHandle); } return { match: match, win: win }; });
          } catch (error) { return Promise.resolve({ match: "", win: win }); }
        };
        const probes = await Promise.all(wins.map(probeWindow));
        const focusedAfter = allowFocusedClaim ? BW.getFocusedWindow() : undefined;
        const ownerMatches = probes.filter(function (probe) { return probe.match === "owner"; });
        const workspaceMatches = probes.filter(function (probe) { return probe.match === "workspace-panel"; });
        const panelMatches = probes.filter(function (probe) { return probe.match === "panel"; });
        if (ownerMatches.length === 1) { target = ownerMatches[0].win; }
        else if (ownerMatches.length > 1) { return "ambiguous-owned-workbench-window:" + ownerMatches.length; }
        else if (workspaceMatches.length === 1) { target = workspaceMatches[0].win; }
        else {
          const focusedCandidates = workspaceMatches.length ? workspaceMatches : panelMatches;
          const stableFocusedPanel = focusedBefore && focusedBefore === focusedAfter && wins.includes(focusedBefore) && focusedCandidates.some(function (probe) { return probe.win === focusedBefore; });
          if (stableFocusedPanel) { return "__DSO_FOCUSED_WINDOW_CANDIDATE__:" + focusedBefore.id; }
          if (workspaceMatches.length > 1) { return "ambiguous-workspace-workbench-window:" + workspaceMatches.length; }
          if (panelMatches.length > 1) { return "ambiguous-panel-workbench-window:" + panelMatches.length; }
          if (panelMatches.length === 1) { return "unclaimed-panel-workbench-window:1"; }
        }
      }
      if (!target) { return requestedId ? "no-owned-workbench-window:" + requestedId : "no-focused-workbench-window:" + wins.length; }
      if (!requestedId) {
        const orphanCleanup = "try{const root=document.getElementById('django-shell-overlay');if(root&&!root.__dsoOwnerToken){if(window.__dsoDisposeOverlay){window.__dsoDisposeOverlay(root,true);}else{root.remove();}}}catch(e){}";
        wins.filter(function (win) { return win !== target; }).forEach(function (win) { try { void win.webContents.executeJavaScript(orphanCleanup, true).catch(function () { return undefined; }); } catch (eOrphanCleanup) {} });
      }
      let timeoutHandle;
      const execution = target.webContents.executeJavaScript(${JSON.stringify(wrappedRendererExpression)}, true).then(
        function (value) { return { kind: "value", value: value }; },
        function (error) { return { error: error, kind: "error" }; }
      );
      const outcome = await Promise.race([execution, new Promise(function (resolve) { timeoutHandle = setTimeout(function () { resolve({ kind: "timeout" }); }, ${JSON.stringify(rendererTimeoutMs)}); })]);
      if (timeoutHandle) { clearTimeout(timeoutHandle); }
      if (outcome.kind === "timeout") { return "__DSO_WINDOW_ID__:" + target.id + "\\nrenderer-execute-timeout:" + ${JSON.stringify(rendererTimeoutMs)}; }
      if (outcome.kind === "error") { const error = outcome.error; return "renderer-execute-error:" + String(error && (error.stack || error.message) || error); }
      const value = outcome.value;
      return "__DSO_WINDOW_ID__:" + target.id + "\\n" + (value === undefined || value === null ? "" : String(value));
    })()
  `.trim();
}
