// Renderer-side workbench overlay source for the Django shell Python cell.
import { overlaySyncRendererSource } from "./workbenchOverlaySyncRenderer";
import { overlayWidgetRendererSource } from "./workbenchOverlayWidgetRenderer";
import { overlayCleanupRendererSource } from "./workbenchOverlayCleanupRenderer";
import { overlayFrameRendererSource } from "./workbenchOverlayFrameRenderer";
/** Builds the JavaScript injected into the focused VS Code workbench window. */
export function overlayRendererSource(modelUri: string): string {
  return `
    window.__djangoShellOverlayModelUri = window.__djangoShellOverlayModelUri || ${JSON.stringify(modelUri)};
    window.__dsoCaptures = window.__dsoCaptures || { widgets: [], insts: [], modelSvcs: [], ctors: [] };
    window.__dsoBadModelSvcs = window.__dsoBadModelSvcs || []; window.__dsoGoodModelSvcs = window.__dsoGoodModelSvcs || [];
    window.__dsoWidgetCache = window.__dsoWidgetCache || (typeof WeakMap !== "undefined" ? new WeakMap() : null);
    /** Posts one renderer event to the extension-host bridge. */
    function __dsoPost(payload) {
      const bridge = window.__djangoShellOverlayBridge || {};
      const url = "http://127.0.0.1:" + bridge.port + "/django-shell-overlay?token=" + encodeURIComponent(bridge.token || "");
      const body = JSON.stringify(payload);
      const request = function (mode) { return fetch(url, { body: body, headers: { "content-type": "text/plain" }, method: "POST", mode: mode }); };
      const fallback = function (error) { window.__dsoLastPostError = String(error && error.message || error); window.__dsoLastPostType = payload && payload.type; window.__djangoShellOverlayBridgeFailedAt = Date.now(); window.__djangoShellOverlayBridgeFailedPort = bridge.port; return request("no-cors"); };
      return payload && payload.type === "run" ? request("cors").catch(fallback) : request("cors").catch(function (error) { return fallback(error).catch(function () { return undefined; }); });
    }
    /** Returns whether a value looks like VS Code's CodeEditorWidget. */
    function __dsoIsWidget(value) {
      return !!(value && typeof value.layout === "function" && typeof value.getModel === "function" && typeof value.getDomNode === "function");
    }
    /** Returns whether a value looks like VS Code's instantiation service. */
    function __dsoIsInst(value) {
      return !!(value && typeof value.createInstance === "function" && typeof value.invokeFunction === "function" && typeof value.createModel !== "function" && typeof value.getModel !== "function");
    }
    /** Returns whether an object owns one property without invoking proxy traps. */
    function __dsoOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
    /** Returns whether a value looks like VS Code's model service. */
    function __dsoIsModelSvc(value) {
      return !!(value && typeof value.createModel === "function" && typeof value.getModel === "function" && typeof value.getModels === "function" && (__dsoOwn(value, "onModelAdded") || __dsoOwn(value, "onModelRemoved") || __dsoOwn(value, "destroyModel")));
    }
    /** Returns whether a value looks like VS Code's text model. */
    function __dsoIsTextModel(value) { return !!(value && value.uri && typeof value.getLanguageId === "function" && typeof value.getValue === "function" && typeof value.onDidChangeContent === "function"); }
    /** Stores one captured object in a bounded unique list. */
    function __dsoRemember(list, value, limit) {
      if (!value || list.indexOf(value) >= 0 || list.length >= limit) { return; }
      list[list.length] = value;
    }
    /** Returns whether a captured model service already failed a safe probe. */ function __dsoBadModelSvc(value) { return window.__dsoBadModelSvcs && window.__dsoBadModelSvcs.indexOf(value) >= 0; }
    /** Marks a captured model service so later probes skip it. */ function __dsoRememberBadModelSvc(value) { if (value && !__dsoBadModelSvc(value)) { window.__dsoBadModelSvcs[window.__dsoBadModelSvcs.length] = value; } }
    /** Returns whether a captured model service already passed a safe probe. */ function __dsoGoodModelSvc(value) { return window.__dsoGoodModelSvcs && window.__dsoGoodModelSvcs.indexOf(value) >= 0; }
    /** Marks a captured model service as usable for later probes. */ function __dsoRememberGoodModelSvc(value) { if (value && !__dsoGoodModelSvc(value)) { window.__dsoGoodModelSvcs[window.__dsoGoodModelSvcs.length] = value; } }
    /** Finds the real CodeEditorWidget constructor through the prototype chain. */
    function __dsoRealCtor(widget) {
      if (!widget) { return null; }
      let proto = Object.getPrototypeOf(widget);
      while (proto) {
        const keys = Object.getOwnPropertyNames(proto);
        if (keys.indexOf("layout") >= 0 && keys.indexOf("getModel") >= 0 && keys.indexOf("getDomNode") >= 0) {
          return proto.constructor || widget.constructor || null;
        }
        proto = Object.getPrototypeOf(proto);
      }
      return widget.constructor || null;
    }
    /** Returns an error string when an instantiation service is not usable. */
    function __dsoValidateInst(inst) {
      if (!__dsoIsInst(inst)) { return "missing-inst"; }
      try {
        inst.invokeFunction(function () { return true; });
        return "";
      } catch (e) {
        return "bad-inst:" + String(e && e.message || e).slice(0, 120);
      }
    }
    /** Returns an error string when a model service is not usable. */
    function __dsoValidateModelSvc(modelSvc) {
      if (!__dsoIsModelSvc(modelSvc)) { return "missing-modelSvc"; }
      if (__dsoBadModelSvc(modelSvc)) { return "bad-modelSvc:cached"; }
      __dsoRememberGoodModelSvc(modelSvc);
      return "";
    }
    /** Scans one object for editor widget, instantiation service, and model service references. */
    function __dsoSniff(value) {
      const caps = window.__dsoCaptures;
      if (!value || typeof value !== "object") { return; }
      if (__dsoIsWidget(value)) {
        __dsoRemember(caps.widgets, value, 40);
        __dsoRemember(caps.ctors, __dsoRealCtor(value), 8);
        try { const model = value.getModel && value.getModel(); const URI = model && model.uri && model.uri.constructor; if (URI && typeof URI.parse === "function") { window.__dsoUriCtor = URI; } } catch (eWidgetUri) {}
        try { __dsoSniff(value._instantiationService); } catch (eDirectInst) {}
      }
      if (__dsoIsInst(value)) { __dsoRemember(caps.insts, value, 24); }
      if (__dsoIsModelSvc(value)) { __dsoRemember(caps.modelSvcs, value, 24); }
      try {
        const keys = Object.getOwnPropertyNames(value);
        for (let i = 0; i < keys.length; i++) {
          let child;
          try { child = value[keys[i]]; } catch (eChildRead) { continue; }
          if (__dsoIsInst(child)) { __dsoRemember(caps.insts, child, 24); }
          if (__dsoIsModelSvc(child)) { __dsoRemember(caps.modelSvcs, child, 24); }
          if (child && typeof child === "object") { try { const nested = Object.getOwnPropertyNames(child); for (let j = 0; j < nested.length; j++) { let grand; try { grand = child[nested[j]]; } catch (eGrandRead) { continue; } if (__dsoIsInst(grand)) { __dsoRemember(caps.insts, grand, 24); } if (__dsoIsModelSvc(grand)) { __dsoRemember(caps.modelSvcs, grand, 24); } } } catch (eNestedKeys) {} }
        }
      } catch (eKeys) {}
    }

    /** Searches a DOM node for an attached editor widget reference. */
    function __dsoFindWidgetOn(element) {
      if (!element) { return null; }
      const cache = window.__dsoWidgetCache;
      try { const cached = cache && cache.get(element); if (__dsoIsWidget(cached)) { return cached; } } catch (eWidgetCacheRead) {}
      const keys = [];
      const seen = Object.create(null);
      try {
        const own = Object.getOwnPropertyNames(element);
        for (let i = 0; i < own.length; i++) { keys.push(own[i]); seen[own[i]] = true; }
      } catch (eOwn) {}
      try {
        for (const key in element) {
          if (!seen[key]) { keys.push(key); seen[key] = true; }
        }
      } catch (eEnum) {}
      for (let i = 0; i < keys.length; i++) {
        let value;
        try { value = element[keys[i]]; } catch (eRead) { continue; }
        if (__dsoIsWidget(value)) { try { cache && cache.set(element, value); } catch (eWidgetCacheWidget) {} return value; }
        try {
          if (__dsoIsWidget(value && value.editor)) { try { cache && cache.set(element, value.editor); } catch (eWidgetCacheEditor) {} return value.editor; }
          if (__dsoIsWidget(value && value._editor)) { try { cache && cache.set(element, value._editor); } catch (eWidgetCacheUnderscore) {} return value._editor; }
        } catch (eNested) {}
      }
      try {
        const symbols = Object.getOwnPropertySymbols(element);
        for (let i = 0; i < symbols.length; i++) {
          let value;
          try { value = element[symbols[i]]; } catch (eSymbolRead) { continue; }
          if (__dsoIsWidget(value)) { try { cache && cache.set(element, value); } catch (eWidgetCacheSymbol) {} return value; }
        }
      } catch (eSymbols) {}
      return null;
    }

    /** Searches an editor DOM subtree and nearby ancestors for an editor widget reference. */
    function __dsoFindWidget(start) {
      const cache = window.__dsoWidgetCache;
      try { const cached = cache && start && cache.get(start); if (__dsoIsWidget(cached)) { return cached; } } catch (eFindWidgetCacheRead) {}
      const candidates = [];
      if (start) { candidates.push(start); }
      let parent = start && start.parentElement;
      for (let i = 0; i < 6 && parent; i++, parent = parent.parentElement) {
        candidates.push(parent);
      }
      const selectors = [".overflow-guard", ".monaco-scrollable-element", ".margin", ".lines-content"];
      for (let i = 0; start && i < selectors.length; i++) {
        const child = start.querySelector(selectors[i]);
        if (child) { candidates.push(child); }
      }
      for (let i = 0; i < candidates.length; i++) {
        const widget = __dsoFindWidgetOn(candidates[i]);
        if (widget) { try { cache && start && cache.set(start, widget); } catch (eFindWidgetCacheSet) {} return widget; }
      }
      return null;
    }

    /** Captures widgets and services from already-visible workbench editors. */
    function __dsoScanDom() {
      const editors = document.querySelectorAll(".editor-group-container .monaco-editor, .monaco-editor");
      for (let i = 0; i < editors.length; i++) {
        const root = editors[i];
        if (root.closest && root.closest("#django-shell-overlay")) { continue; }
        const widget = __dsoFindWidget(root);
        if (widget) { __dsoSniff(widget); }
      }
    }

    /** Starts short-lived prototype capture for editor services created after injection. */
    function __dsoStartCapture() {
      if (window.__dsoCaptureOriginals) { return; }
      const originals = {
        arrayPush: Array.prototype.push,
        mapSet: Map.prototype.set,
        reflectConstruct: Reflect.construct,
        setAdd: Set.prototype.add,
        weakMapSet: WeakMap.prototype.set
      };
      window.__dsoCaptureOriginals = originals;
      Map.prototype.set = function (key, value) { try { __dsoSniff(value); } catch (eMap) {} return originals.mapSet.call(this, key, value); };
      WeakMap.prototype.set = function (key, value) { try { __dsoSniff(value); } catch (eWeak) {} return originals.weakMapSet.call(this, key, value); };
      Set.prototype.add = function (value) { try { __dsoSniff(value); } catch (eSet) {} return originals.setAdd.call(this, value); };
      Array.prototype.push = function () {
        try { for (let i = 0; i < arguments.length; i++) { __dsoSniff(arguments[i]); } } catch (eArray) {}
        return originals.arrayPush.apply(this, arguments);
      };
      Reflect.construct = function (target, args, newTarget) {
        try {
          if (target && target.prototype && __dsoIsWidget(target.prototype)) {
            __dsoRemember(window.__dsoCaptures.ctors, target, 8);
          }
        } catch (eReflectSniff) {}
        return originals.reflectConstruct.apply(Reflect, arguments);
      };
      window.setTimeout(function () { try { __dsoStopCapture(); } catch (eStopTimer) {} }, 2500);
    }

    /** Stops prototype capture and restores renderer built-ins. */
    function __dsoStopCapture() {
      const originals = window.__dsoCaptureOriginals;
      if (!originals) { return; }
      try { Map.prototype.set = originals.mapSet; } catch (eMapRestore) {}
      try { WeakMap.prototype.set = originals.weakMapSet; } catch (eWeakRestore) {}
      try { Set.prototype.add = originals.setAdd; } catch (eSetRestore) {}
      try { Array.prototype.push = originals.arrayPush; } catch (eArrayRestore) {}
      try { Reflect.construct = originals.reflectConstruct; } catch (eReflectRestore) {}
      window.__dsoCaptureOriginals = null;
    }

    /** Returns a captured editor factory when enough workbench internals are available. */
    function __dsoFactory() {
      __dsoScanDom();
      const caps = window.__dsoCaptures;
      for (let i = 0; i < caps.widgets.length; i++) {
        const widget = caps.widgets[i];
        __dsoRemember(caps.ctors, __dsoRealCtor(widget), 8);
        __dsoSniff(widget);
      }
      let inst = null;
      let modelSvc = null;
      for (let i = 0; i < caps.insts.length; i++) {
        if (!__dsoValidateInst(caps.insts[i])) { inst = caps.insts[i]; break; }
      }
      for (let i = 0; i < caps.modelSvcs.length; i++) {
        if (!__dsoValidateModelSvc(caps.modelSvcs[i])) { modelSvc = caps.modelSvcs[i]; break; }
      }
      let model = null;
      if (!modelSvc) { for (let i = 0; i < caps.widgets.length; i++) { try { const candidate = caps.widgets[i].getModel && caps.widgets[i].getModel(); if (candidate && String(candidate.uri) === window.__djangoShellOverlayModelUri) { model = candidate; break; } } catch (eModel) {} } }
      return caps.ctors[0] && inst && (modelSvc || model) ? { ctor: caps.ctors[0], inst: inst, model: model, modelSvc: modelSvc } : null;
    }

    /** Returns a lightweight capture state summary. */
    function __dsoStatus() {
      try {
        const caps = window.__dsoCaptures || {};
        const factory = __dsoFactory();
        const root = document.getElementById("django-shell-overlay");
        const consoleRects = __dsoConsoleGroups();
        const boundFrame = root && root.__dsoFrame;
        return "widgets=" + ((caps.widgets || []).length) +
          " insts=" + ((caps.insts || []).length) +
          " modelSvcs=" + ((caps.modelSvcs || []).length) +
          " ctors=" + ((caps.ctors || []).length) +
          " factory=" + !!factory +
          " consoleGroups=" + consoleRects.length +
          " consoleFrame=" + (boundFrame && consoleRects.length && __dsoFrameIsConsole(boundFrame, consoleRects) ? 1 : 0) +
          " editorError=" + String(root && root.__dsoLastEditorError || "").slice(0, 120) +
          " widgetError=" + String(root && root.__dsoLastWidgetError || "").slice(0, 120) +
          " captureError=" + String(window.__dsoCaptureStartError || "");
      } catch (e) {
        return "status-err:" + String(e && e.message || e);
      }
    }
    /** Builds a Monaco URI from an already captured editor model or global Monaco. */
    function __dsoUri() {
      try { if (window.__dsoUriCtor && typeof window.__dsoUriCtor.parse === "function") { return window.__dsoUriCtor.parse(window.__djangoShellOverlayModelUri); } } catch (eCachedUri) {}
      try {
        const widgets = (window.__dsoCaptures && window.__dsoCaptures.widgets) || [];
        for (let i = 0; i < widgets.length; i++) {
          const model = widgets[i] && widgets[i].getModel && widgets[i].getModel();
          const URI = model && model.uri && model.uri.constructor;
          if (URI && typeof URI.parse === "function") { return URI.parse(window.__djangoShellOverlayModelUri); }
        }
      } catch (eUri) {}
      try { const URI = globalThis.monaco && globalThis.monaco.Uri || window.monaco && window.monaco.Uri; if (URI && typeof URI.parse === "function") { return URI.parse(window.__djangoShellOverlayModelUri); } } catch (eGlobalUri) {}
      return null;
    }
    /** Returns a workbench-compatible Python language selection. */
    function __dsoPythonLanguage() { return { getLanguageId: function () { return "python"; }, languageId: "python", onDidChange: function () { return { dispose: function () {} }; } }; }
    /** Returns a body-level overflow widget portal before Monaco editor construction. */
    function __dsoOverflowWidgetsNode(root) {
      return window.__dsoPrepareOverlayWidgetNode ? window.__dsoPrepareOverlayWidgetNode(root) : undefined;
    }
    /** Returns whether the editor must be rebuilt so constructor-only widget portal options apply. */
    function __dsoNeedsWidgetPortalRebuild(root) {
      return !!(root && root.__djangoShellEditor && root.__dsoWidgetPortalVersion !== "body-constructor-v1");
    }
    /** Creates a real workbench CodeEditorWidget using captured VS Code services. */
    function __dsoCreateWorkbenchEditor(root, host, overflowWidgetsNode) {
      const factory = __dsoFactory();
      if (!factory) { return null; }
      const uri = __dsoUri();
      let model = factory.model || null;
      if (!model && factory.modelSvc && uri) {
        const text = window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", language = __dsoPythonLanguage();
        try { model = factory.modelSvc.createModel(text, language, uri, false); } catch (eCreateModel) {
        try { model = factory.modelSvc.getModel(uri); if (model && model.isDisposed && model.isDisposed()) { model = null; } if (model && model.getValue) { try { model.getValue(); } catch (eDisposedValue) { model = null; } } } catch (eGetModel) {}
          if (!model) { __dsoRememberBadModelSvc(factory.modelSvc); return null; }
        }
      }
      if (!model || !model.uri) { __dsoRememberBadModelSvc(factory.modelSvc); return null; }
      try { if (model && model.setLanguage) { model.setLanguage(__dsoPythonLanguage()); } } catch (eSetLanguage) {}
      try { if (globalThis.monaco && globalThis.monaco.editor && globalThis.monaco.editor.setModelLanguage) { globalThis.monaco.editor.setModelLanguage(model, "python"); } } catch (eSetModelLanguage) {}
      const options = { acceptSuggestionOnEnter: "on", automaticLayout: false, fixedOverflowWidgets: false, folding: true, formatOnPaste: false, formatOnType: false, glyphMargin: true, hover: { enabled: true }, lineDecorationsWidth: 0, lineNumbers: "on", lineNumbersMinChars: 1, minimap: { enabled: false }, overflowWidgetsDomNode: overflowWidgetsNode, parameterHints: { enabled: true }, quickSuggestions: true, scrollBeyondLastLine: false, suggestOnTriggerCharacters: true };
      const widgetOptions = { isSimpleWidget: false };
      const editor = factory.inst.createInstance(factory.ctor, host, options, widgetOptions);
      if (editor && editor.setModel) { editor.setModel(model); }
      if (editor && editor.layout) { editor.layout(__dsoLayoutSize(root, host)); }
      return editor;
    }
    /** Creates a standalone Monaco editor only when the workbench exposes the public API. */
    function __dsoCreateGlobalMonacoEditor(root, host, overflowWidgetsNode) {
      const monacoApi = (globalThis.monaco && globalThis.monaco.editor) ? globalThis.monaco : ((window.monaco && window.monaco.editor) ? window.monaco : null);
      if (!monacoApi) { return null; }
      const uri = monacoApi.Uri.parse(window.__djangoShellOverlayModelUri);
      let model = monacoApi.editor.getModel(uri); if (model && model.isDisposed && model.isDisposed()) { model = null; } if (model && model.getValue) { try { model.getValue(); } catch (eDisposedValue) { model = null; } } model = model || monacoApi.editor.createModel(window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", "python", uri);
      const editor = monacoApi.editor.create(host, { acceptSuggestionOnEnter: "on", automaticLayout: false, fixedOverflowWidgets: false, folding: true, formatOnPaste: false, formatOnType: false, glyphMargin: true, hover: { enabled: true }, isSimpleWidget: false, lineDecorationsWidth: 0, lineNumbers: "on", lineNumbersMinChars: 1, minimap: { enabled: false }, model: model, overflowWidgetsDomNode: overflowWidgetsNode, parameterHints: { enabled: true }, quickSuggestions: true, scrollBeyondLastLine: false, suggestOnTriggerCharacters: true });
      try { editor.layout && editor.layout(__dsoLayoutSize(root, host)); } catch (eGlobalLayout) {}
      return editor;
    }
    /** Creates or focuses the overlay editor widget. */
    function __dsoEnsureEditor(root) {
      if (__dsoNeedsWidgetPortalRebuild(root)) { try { root.__djangoShellEditor.dispose && root.__djangoShellEditor.dispose(); } catch (eWidgetPortalRebuild) {} root.__djangoShellEditor = null; root.__dsoWidgetPortalVersion = ""; }
      if (root.__djangoShellEditor) { try { const model = root.__djangoShellEditor.getModel && root.__djangoShellEditor.getModel(); if (!model || (model.isDisposed && model.isDisposed())) { root.__djangoShellEditor.dispose && root.__djangoShellEditor.dispose(); root.__djangoShellEditor = null; } else if (model.getValue) { try { model.getValue(); } catch (eDisposedValue) { root.__djangoShellEditor.dispose && root.__djangoShellEditor.dispose(); root.__djangoShellEditor = null; } } } catch (eDisposedModel) { root.__djangoShellEditor = null; } if (root.__djangoShellEditor) { return root.__djangoShellEditor; } }
      const host = root.querySelector(".django-shell-overlay-editor");
      host.textContent = "";
      const overflowWidgetsNode = __dsoOverflowWidgetsNode(root);
      if (!root.__djangoShellEditor && !window.__dsoSkipWorkbenchEditor) { try { root.__djangoShellEditor = __dsoCreateWorkbenchEditor(root, host, overflowWidgetsNode); } catch (eWorkbench) { const msg = String(eWorkbench && eWorkbench.message || eWorkbench); root.__dsoLastEditorError = msg; if (/UNKNOWN service|Maximum call stack/.test(msg)) { window.__dsoSkipWorkbenchEditor = true; } } }
      if (!root.__djangoShellEditor) { try { root.__djangoShellEditor = __dsoCreateGlobalMonacoEditor(root, host, overflowWidgetsNode); } catch (eGlobal) { root.__dsoLastEditorError = String(eGlobal && eGlobal.message || eGlobal); } }
      if (!root.__djangoShellEditor) {
        host.textContent = "Editor widget is waiting for VS Code editor services.";
        root.__dsoPendingRetries = (root.__dsoPendingRetries || 0) + 1;
        if (root.__dsoPendingRetries <= 10) {
          try { __dsoStartCapture(); } catch (ePendingCapture) { window.__dsoCaptureStartError = String(ePendingCapture && ePendingCapture.message || ePendingCapture); }
          root.__dsoPendingRetryTimer = window.setTimeout(function () { if (root.isConnected && root.style.display !== "none") { window.__djangoShellOverlayShow(window.__djangoShellOverlayGeometry); } }, 500);
        }
      } else {
        root.__dsoWidgetPortalVersion = "body-constructor-v1";
        root.style.visibility = "visible";
        root.__dsoPendingRetries = 0; try { window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, root.__djangoShellEditor); } catch (ePreludeHidden) {}
        try { window.__dsoConfigureOverlayWidgets && window.__dsoConfigureOverlayWidgets(root, root.__djangoShellEditor); } catch (eWidgetOptions) { root.__dsoLastWidgetError = String(eWidgetOptions && eWidgetOptions.message || eWidgetOptions); }
        try { window.__dsoApplyOverlayDebugLine && window.__dsoApplyOverlayDebugLine(root, root.__djangoShellEditor); } catch (eDebugLineOptions) { root.__dsoLastDebugLineError = String(eDebugLineOptions && eDebugLineOptions.message || eDebugLineOptions); }
        try { root.__dsoResizeObserver && root.__dsoResizeObserver.disconnect && root.__dsoResizeObserver.disconnect(); } catch (eResizeDisconnect) {}
        root.__dsoResizeObserver = new ResizeObserver(function () {
          try { __dsoLayoutOverlayEditor(root); } catch (eLayout) {}
        }); root.__dsoResizeObserver.observe(host);
      }
      return root.__djangoShellEditor;
    }
    /** Reads code from either a workbench CodeEditorWidget or standalone Monaco editor. */
    function __dsoEditorValue(editor) {
      try {
        const model = editor && editor.getModel && editor.getModel();
        return model && model.getValue ? model.getValue() : "";
      } catch (eModelValue) {}
      try { if (editor && editor.getValue) { return editor.getValue(); } } catch (eGetValue) {}
      return "";
    }
    ${overlayFrameRendererSource()}
    /** Returns a finite number or a fallback value. */
    function __dsoFinite(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    /** Returns the tallest visible editor before Monaco should scroll internally. */
    function __dsoMaxEditorHeight(viewportHeight) {
      const height = __dsoFinite(viewportHeight, 520) || 520;
      return Math.max(120, Math.min(Math.max(160, Math.round(height * 0.7)), 720, height));
    }

    /** Returns a finite Monaco layout size bounded to the visible overlay viewport. */
    function __dsoLayoutSize(root, host) {
      const rect = host && host.getBoundingClientRect ? host.getBoundingClientRect() : {};
      const style = root && root.style ? root.style : {};
      const fallbackWidth = __dsoFinite(parseFloat(style.width || ""), 560);
      const fallbackHeight = __dsoFinite(parseFloat(style.height || ""), 280);
      const rawWidth = __dsoFinite(rect.width, fallbackWidth) || fallbackWidth;
      const rawHeight = __dsoFinite(rect.height, fallbackHeight) || fallbackHeight;
      const viewportWidth = __dsoFinite(window.innerWidth, fallbackWidth) || fallbackWidth;
      const viewportHeight = __dsoFinite(window.innerHeight, fallbackHeight) || fallbackHeight;
      const maxWidth = Math.max(240, Math.min(viewportWidth, 8192));
      const maxHeight = Math.max(120, Math.min(__dsoMaxEditorHeight(viewportHeight), 8192));
      return { height: Math.round(Math.max(80, Math.min(rawHeight, maxHeight))), width: Math.round(Math.max(100, Math.min(rawWidth, maxWidth))) };
    }

    /** Resolves a webview-local cell rectangle into workbench-window coordinates. */
    function __dsoResolvedGeometry(root, geometry) {
      const attach = __dsoAttachRoot(root);
      if (!attach) { return null; }
      const frameRect = attach.frame.getBoundingClientRect();
      const hostRect = attach.host.getBoundingClientRect();
      const hasGeometry = geometry && __dsoFinite(geometry.width, 0) > 40 && __dsoFinite(geometry.height, 0) > 40;
      const viewportWidth = Math.max(240, Math.min(__dsoFinite(window.innerWidth, 4096), 8192));
      const viewportHeight = Math.max(120, Math.min(__dsoFinite(window.innerHeight, 4096), 8192));
      const boundaryLeft = Math.max(0, frameRect.left - hostRect.left);
      const boundaryTop = Math.max(0, frameRect.top - hostRect.top);
      const boundaryRight = Math.max(boundaryLeft, Math.min(viewportWidth, frameRect.right - hostRect.left));
      const boundaryBottom = Math.max(boundaryTop, Math.min(viewportHeight, frameRect.bottom - hostRect.top));
      const boundaryWidth = Math.max(1, boundaryRight - boundaryLeft);
      const boundaryHeight = Math.max(1, boundaryBottom - boundaryTop);
      const rawLeft = boundaryLeft + (hasGeometry ? __dsoFinite(geometry.left, 0) : 64);
      const rawTop = boundaryTop + (hasGeometry ? __dsoFinite(geometry.top, 0) : Math.min(220, frameRect.height * 0.35));
      const rawWidth = hasGeometry ? __dsoFinite(geometry.width, 560) : Math.max(320, frameRect.width - 96);
      const rawHeight = hasGeometry ? __dsoFinite(geometry.height, 280) : 280;
      const minLeftWidth = Math.min(120, boundaryWidth);
      const minTopHeight = Math.min(80, boundaryHeight);
      const left = Math.max(boundaryLeft, Math.min(rawLeft, boundaryRight - minLeftWidth));
      const top = Math.max(boundaryTop, Math.min(rawTop, boundaryBottom - minTopHeight));
      const availableHeight = Math.max(1, Math.min(boundaryBottom - top, viewportHeight));
      return {
        height: Math.max(1, Math.min(rawHeight, availableHeight, __dsoMaxEditorHeight(viewportHeight))),
        left: left,
        top: top,
        width: Math.max(1, Math.min(rawWidth, boundaryRight - left, viewportWidth))
      };
    }

    /** Lays out the captured editor after the overlay rectangle changes. */
    function __dsoLayoutOverlayEditor(root) {
      const host = root.querySelector(".django-shell-overlay-editor");
      const editor = root.__djangoShellEditor;
      if (!host || !editor || !editor.layout) { return; }
      const layout = __dsoLayoutSize(root, host);
      const layoutKey = layout.width + ":" + layout.height;
      if (root.__dsoLastEditorLayoutKey === layoutKey) { return; }
      root.__dsoLastEditorLayoutKey = layoutKey;
      try { editor.layout(layout); } catch (eLayoutOverlay) {}
      try { window.__dsoScheduleWidgetClamp && window.__dsoScheduleWidgetClamp(root); } catch (eClampLayout) {}
    }

    /** Applies the latest webview cell rectangle to the workbench overlay host. */
    function __dsoApplyGeometry(root, geometry) {
      window.__djangoShellOverlayGeometry = geometry || window.__djangoShellOverlayGeometry || null;
      const rect = __dsoResolvedGeometry(root, window.__djangoShellOverlayGeometry);
      if (!rect) { return false; }
      const left = Math.round(rect.left), top = Math.round(rect.top), width = Math.round(rect.width), height = Math.round(rect.height);
      const sizeKey = width + ":" + height;
      const key = left + ":" + top + ":" + sizeKey;
      if (root.__dsoLastRectKey === key) { return true; }
      const sizeChanged = root.__dsoLastSizeKey !== sizeKey;
      root.__dsoLastRectKey = key; root.__dsoLastSizeKey = sizeKey;
      root.style.left = "0px"; root.style.top = "0px"; root.style.transform = "translate3d(" + left + "px," + top + "px,0)";
      root.style.width = width + "px"; root.style.height = height + "px";
      root.style.right = ""; root.style.bottom = "";
      try { window.__dsoSyncOverlayWidgetLayer && window.__dsoSyncOverlayWidgetLayer(root); } catch (eWidgetLayerGeometry) {}
      if (sizeChanged) { __dsoLayoutOverlayEditor(root); }
      return true;
    }
    /** Schedules one renderer-local geometry refresh for parent workbench scroll and resize. */
    function __dsoScheduleGeometrySync(root) {
      if (!root || root.__dsoGeometrySyncFrame) { return; }
      root.__dsoGeometrySyncFrame = window.requestAnimationFrame(function () {
        root.__dsoGeometrySyncFrame = 0;
        if (!root.isConnected || root.style.display === "none") { return; }
        try { __dsoApplyGeometry(root, window.__djangoShellOverlayGeometry); } catch (eGeometrySync) {}
      });
    }
    /** Installs renderer-local scroll listeners so iframe movement is not delayed by host geometry messages. */
    function __dsoInstallGeometrySync(root) {
      if (!root || root.__dsoGeometrySyncInstalled) { return; }
      const schedule = function () { __dsoScheduleGeometrySync(root); };
      window.addEventListener("resize", schedule, true);
      document.addEventListener("scroll", schedule, true);
      root.__dsoGeometrySyncInstalled = true;
      root.__dsoGeometrySyncCleanup = function () {
        window.removeEventListener("resize", schedule, true);
        document.removeEventListener("scroll", schedule, true);
        root.__dsoGeometrySyncInstalled = false;
      };
    }
    /** Installs the overlay CSS once per workbench window. */
    function __dsoEnsureStyle() {
      let style = document.getElementById("django-shell-overlay-style");
      if (!style) { style = document.createElement("style"); style.id = "django-shell-overlay-style"; document.head.appendChild(style); }
      style.textContent = ".django-shell-overlay{position:absolute;left:0;top:0;width:1px;height:1px;z-index:2147483646;box-sizing:border-box;overflow:visible;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:0;font-family:var(--vscode-font-family);will-change:transform}.django-shell-overlay-head{display:none}.django-shell-overlay-title{font-size:12px;color:var(--vscode-descriptionForeground)}.django-shell-overlay-spacer{flex:1}.django-shell-overlay button{border:0;border-radius:3px;padding:2px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.django-shell-overlay-editor{width:100%;height:100%;min-height:80px;box-sizing:border-box;overflow:visible;contain:layout style}.django-shell-overlay .monaco-editor{overflow:visible!important}.django-shell-overlay .overflowingContentWidgets{overflow:visible!important;z-index:35}.django-shell-overlay .margin-view-overlays .line-numbers{color:var(--vscode-editorLineNumber-foreground,var(--vscode-descriptionForeground,var(--vscode-foreground)))!important;min-width:0!important;overflow:visible!important;padding-right:1ch!important}.django-shell-overlay .dso-exec-range{background:var(--vscode-editor-selectionHighlightBackground,rgba(90,150,255,.18));box-shadow:inset 3px 0 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-start{box-shadow:inset 0 1px 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-end{box-shadow:inset 0 -1px 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-rail{background:var(--vscode-focusBorder,rgba(90,150,255,.9));width:3px!important;margin-left:3px}.django-shell-overlay .dso-debug-line{background:color-mix(in srgb,var(--vscode-editor-stackFrameHighlightBackground,#ffff0033) 70%,transparent);box-shadow:inset 3px 0 0 var(--vscode-editorStackFrameHighlight.border,var(--vscode-charts-yellow,#cca700))}.django-shell-overlay .dso-debug-indicator{background:var(--vscode-charts-yellow,#cca700);border-radius:2px;height:100%!important;margin-left:5px;width:3px!important}.django-shell-overlay-output,.django-shell-overlay-output.error{display:none}.monaco-workbench .tab[aria-label='analysis.py'],.monaco-workbench .tab[aria-label='console-cell.py'],.monaco-workbench .tab[aria-label*='.django-shell'][aria-label*='analysis.py'],.monaco-workbench .tab[title*='/.django-shell/analysis.py'],.monaco-workbench .tab[aria-label*='.django-shell'][aria-label*='console-cell.py'],.monaco-workbench .tab[title*='/.django-shell/console-cell.py']{display:none!important}";
    }

    /** Builds overlay DOM without Trusted Types HTML string assignment. */
    function __dsoBuildOverlay(root) {
      const head = document.createElement("div");
      head.className = "django-shell-overlay-head";
      const title = document.createElement("span");
      title.className = "django-shell-overlay-title";
      title.textContent = "Python";
      const spacer = document.createElement("span");
      spacer.className = "django-shell-overlay-spacer";
      const run = document.createElement("button");
      run.setAttribute("data-run", "");
      run.textContent = "Run";
      head.appendChild(title);
      head.appendChild(spacer);
      head.appendChild(run);
      const editor = document.createElement("div");
      editor.className = "django-shell-overlay-editor";
      const output = document.createElement("pre");
      output.className = "django-shell-overlay-output";
      root.appendChild(head);
      root.appendChild(editor);
      root.appendChild(output);
    }

    ${overlayWidgetRendererSource()}
    ${overlaySyncRendererSource()}
    ${overlayCleanupRendererSource()}
    window.__djangoShellOverlayShow = function (geometry) {
      __dsoEnsureStyle();
      let root = document.getElementById("django-shell-overlay");
      if (root && root.__dsoOwnerToken && root.__dsoOwnerToken !== window.__djangoShellOverlayOwnerToken) {
        try { window.__dsoDisposeOverlay ? window.__dsoDisposeOverlay(root, true) : root.remove(); } catch (eStaleOwner) {}
        root = null;
      }
      const wasShown = !!(root && root.style.display !== "none" && root.style.visibility !== "hidden" && root.__djangoShellEditor);
      if (!root) {
        root = document.createElement("section");
        root.id = "django-shell-overlay";
        root.className = "django-shell-overlay";
        __dsoBuildOverlay(root);
        root.querySelector("[data-run]").addEventListener("click", function () {
          if (root.__dsoRunCurrentInput) { root.__dsoRunCurrentInput(); return; } __dsoPost({ type: "run", code: __dsoUserText(__dsoEditorValue(root.__djangoShellEditor), root) });
        });
      }
      root.__dsoOwnerToken = window.__djangoShellOverlayOwnerToken;
      try { root.dataset.djangoShellOverlayOwner = String(window.__djangoShellOverlayOwnerToken || ""); } catch (eOwnerDataset) {}
      try { __dsoSyncWidgetTheme && __dsoSyncWidgetTheme(root, true); } catch (eRootTheme) {}
      __dsoInstallGeometrySync(root);
      root.__dsoUseVisiblePrelude = !!window.__djangoShellOverlayUseVisiblePrelude;
      root.style.display = "block";
      if (!root.__dsoGeometryTimer) { root.__dsoGeometryTimer = window.setInterval(function () { if (root.style.display !== "none" && !__dsoApplyGeometry(root, window.__djangoShellOverlayGeometry) && root.__dsoHadConsoleFrame && window.__dsoDisposeOverlay) { window.__dsoDisposeOverlay(root); } }, 250); }
      if (!__dsoApplyGeometry(root, geometry)) { return "django-shell-overlay-shown:pending:no-webview-host:" + __dsoStatus(); }
      const editor = __dsoEnsureEditor(root);
      __dsoApplyGeometry(root, geometry);
      if (editor && window.__dsoInstallModelSync) { window.__dsoInstallModelSync(root, editor, __dsoEditorValue, __dsoPost); }
      if (editor && window.__dsoInstallEnterRunner) { window.__dsoInstallEnterRunner(root, editor, __dsoPost); }
      if (editor && window.__dsoSetOverlayVisibleText && (window.__dsoPendingOverlayVisibleText !== undefined || !root.__dsoHasAppliedInitialText)) {
        window.__dsoSetOverlayVisibleText(window.__dsoPendingOverlayVisibleText !== undefined ? window.__dsoPendingOverlayVisibleText : window.__djangoShellOverlayInitialText);
      }
      root.style.visibility = editor ? "visible" : "hidden";
      if (editor && editor.focus && !wasShown) { editor.focus(); }
      return editor ? "django-shell-overlay-shown:editor:" + __dsoStatus() : "django-shell-overlay-shown:pending:" + __dsoStatus();
    };
    window.__djangoShellOverlaySetGeometry = function (geometry) {
      const root = document.getElementById("django-shell-overlay");
      window.__djangoShellOverlayGeometry = geometry || null;
      if (!root) { return "no-overlay"; }
      if (root.__dsoOwnerToken && root.__dsoOwnerToken !== window.__djangoShellOverlayOwnerToken) { return "owner-mismatch"; }
      __dsoApplyGeometry(root, geometry);
      return "ok";
    };
    window.__djangoShellOverlaySetOutput = function (text, ok) {
      const root = document.getElementById("django-shell-overlay");
      if (!root) { return "no-overlay"; }
      if (root.__dsoOwnerToken && root.__dsoOwnerToken !== window.__djangoShellOverlayOwnerToken) { return "owner-mismatch"; }
      const output = root.querySelector(".django-shell-overlay-output");
      output.className = ok ? "django-shell-overlay-output" : "django-shell-overlay-output error";
      output.textContent = String(text || "");
      return "ok";
    };
    window.__djangoShellOverlayHide = function () {
      const root = document.getElementById("django-shell-overlay");
      return window.__dsoDisposeOverlay ? window.__dsoDisposeOverlay(root) : (root ? (root.style.display = "none", "ok") : "no-overlay");
    };
  `;
}
