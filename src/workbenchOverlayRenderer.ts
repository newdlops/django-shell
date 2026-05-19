// Renderer-side workbench overlay source for the Django shell Python cell.
import { overlaySyncRendererSource } from "./workbenchOverlaySyncRenderer";
import { overlayWidgetRendererSource } from "./workbenchOverlayWidgetRenderer";
import { overlayCleanupRendererSource } from "./workbenchOverlayCleanupRenderer";
/** Builds the JavaScript injected into the focused VS Code workbench window. */
export function overlayRendererSource(modelUri: string): string {
  return `
    window.__djangoShellOverlayModelUri = window.__djangoShellOverlayModelUri || ${JSON.stringify(modelUri)};
    window.__dsoCaptures = window.__dsoCaptures || { widgets: [], insts: [], modelSvcs: [], ctors: [] };

    /** Posts one renderer event to the extension-host bridge. */
    function __dsoPost(payload) {
      const bridge = window.__djangoShellOverlayBridge || {};
      return fetch("http://127.0.0.1:" + bridge.port + "/django-shell-overlay", {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json", "x-django-shell-token": bridge.token },
        method: "POST"
      }).catch(function () {});
    }

    /** Returns whether a value looks like VS Code's CodeEditorWidget. */
    function __dsoIsWidget(value) {
      return !!(value && typeof value.layout === "function" && typeof value.getModel === "function" && typeof value.getDomNode === "function");
    }

    /** Returns whether a value looks like VS Code's instantiation service. */
    function __dsoIsInst(value) {
      return !!(value && typeof value.createInstance === "function" && typeof value.invokeFunction === "function");
    }

    /** Returns whether a value looks like VS Code's model service. */
    function __dsoIsModelSvc(value) {
      return !!(value && typeof value.createModel === "function" && typeof value.getModel === "function" && typeof value.getModels === "function");
    }

    /** Stores one captured object in a bounded unique list. */
    function __dsoRemember(list, value, limit) {
      if (!value || list.indexOf(value) >= 0 || list.length >= limit) { return; }
      list[list.length] = value;
    }

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
      try {
        modelSvc.getModels();
        return "";
      } catch (e) {
        return "bad-modelSvc:" + String(e && e.message || e).slice(0, 120);
      }
    }

    /** Scans one object for editor widget, instantiation service, and model service references. */
    function __dsoSniff(value) {
      const caps = window.__dsoCaptures;
      if (!value || typeof value !== "object") { return; }
      if (__dsoIsWidget(value)) {
        __dsoRemember(caps.widgets, value, 40);
        __dsoRemember(caps.ctors, __dsoRealCtor(value), 8);
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
        if (__dsoIsWidget(value)) { return value; }
        try {
          if (__dsoIsWidget(value && value.editor)) { return value.editor; }
          if (__dsoIsWidget(value && value._editor)) { return value._editor; }
        } catch (eNested) {}
      }
      try {
        const symbols = Object.getOwnPropertySymbols(element);
        for (let i = 0; i < symbols.length; i++) {
          let value;
          try { value = element[symbols[i]]; } catch (eSymbolRead) { continue; }
          if (__dsoIsWidget(value)) { return value; }
        }
      } catch (eSymbols) {}
      return null;
    }

    /** Searches an editor DOM subtree and nearby ancestors for an editor widget reference. */
    function __dsoFindWidget(start) {
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
        if (widget) { return widget; }
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
      return caps.ctors[0] && inst && (modelSvc || model)
        ? { ctor: caps.ctors[0], inst: inst, model: model, modelSvc: modelSvc }
        : null;
    }

    /** Returns a lightweight capture state summary. */
    function __dsoStatus() {
      try {
        const caps = window.__dsoCaptures || {};
        const factory = __dsoFactory();
        const root = document.getElementById("django-shell-overlay");
        return "widgets=" + ((caps.widgets || []).length) +
          " insts=" + ((caps.insts || []).length) +
          " modelSvcs=" + ((caps.modelSvcs || []).length) +
          " ctors=" + ((caps.ctors || []).length) +
          " factory=" + !!factory +
          " editorError=" + String(root && root.__dsoLastEditorError || "").slice(0, 120) +
          " widgetError=" + String(root && root.__dsoLastWidgetError || "").slice(0, 120) +
          " captureError=" + String(window.__dsoCaptureStartError || "");
      } catch (e) {
        return "status-err:" + String(e && e.message || e);
      }
    }

    /** Builds a Monaco URI with the captured model service's URI class. */
    function __dsoUri(modelSvc) {
      try {
        const models = modelSvc.getModels();
        for (let i = 0; i < models.length; i++) {
          const URI = models[i] && models[i].uri && models[i].uri.constructor;
          if (URI && typeof URI.parse === "function") { return URI.parse(window.__djangoShellOverlayModelUri); }
        }
      } catch (eUri) {}
      return null;
    }

    /** Creates a real workbench CodeEditorWidget using captured VS Code services. */
    function __dsoCreateWorkbenchEditor(host) {
      const factory = __dsoFactory();
      if (!factory) { return null; }
      const options = { acceptSuggestionOnEnter: "on", automaticLayout: true, fixedOverflowWidgets: false, folding: true, formatOnPaste: false, formatOnType: false, glyphMargin: false, hover: { enabled: true }, lineNumbers: "on", lineNumbersMinChars: 3, minimap: { enabled: false }, parameterHints: { enabled: true }, quickSuggestions: true, scrollBeyondLastLine: false, suggestOnTriggerCharacters: true };
      const widgetOptions = { isSimpleWidget: false };
      const editor = factory.inst.createInstance(factory.ctor, host, options, widgetOptions);
      const uri = __dsoUri(factory.modelSvc);
      let model = factory.model || null;
      try { model = model || (uri && factory.modelSvc && factory.modelSvc.getModel(uri)); } catch (eGetModel) {}
      if (!model && factory.modelSvc) {
        model = uri ? factory.modelSvc.createModel(window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", "python", uri, false) : factory.modelSvc.createModel(window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", "python");
      }
      try { if (model && model.setLanguage) { model.setLanguage("python"); } } catch (eSetLanguage) {}
      try { if (globalThis.monaco && globalThis.monaco.editor && globalThis.monaco.editor.setModelLanguage) { globalThis.monaco.editor.setModelLanguage(model, "python"); } } catch (eSetModelLanguage) {}
      if (editor && editor.setModel) { editor.setModel(model); }
      const rect = host.getBoundingClientRect();
      if (editor && editor.layout) { editor.layout({ width: Math.max(100, rect.width), height: Math.max(80, rect.height) }); }
      return editor;
    }

    /** Creates a standalone Monaco editor only when the workbench exposes the public API. */
    function __dsoCreateGlobalMonacoEditor(host) {
      const monacoApi = (globalThis.monaco && globalThis.monaco.editor) ? globalThis.monaco : ((window.monaco && window.monaco.editor) ? window.monaco : null);
      if (!monacoApi) { return null; }
      const uri = monacoApi.Uri.parse(window.__djangoShellOverlayModelUri);
      const model = monacoApi.editor.getModel(uri) || monacoApi.editor.createModel(window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", "python", uri);
      return monacoApi.editor.create(host, { acceptSuggestionOnEnter: "on", automaticLayout: true, fixedOverflowWidgets: false, folding: true, formatOnPaste: false, formatOnType: false, glyphMargin: false, hover: { enabled: true }, isSimpleWidget: false, lineNumbers: "on", lineNumbersMinChars: 3, minimap: { enabled: false }, model: model, parameterHints: { enabled: true }, quickSuggestions: true, scrollBeyondLastLine: false, suggestOnTriggerCharacters: true });
    }

    /** Creates or focuses the overlay editor widget. */
    function __dsoEnsureEditor(root) {
      if (root.__djangoShellEditor) { return root.__djangoShellEditor; }
      const host = root.querySelector(".django-shell-overlay-editor");
      host.textContent = "";
      try { root.__djangoShellEditor = __dsoCreateWorkbenchEditor(host); } catch (eWorkbench) { root.__dsoLastEditorError = String(eWorkbench && eWorkbench.message || eWorkbench); }
      if (!root.__djangoShellEditor) {
        try { root.__djangoShellEditor = __dsoCreateGlobalMonacoEditor(host); } catch (eGlobal) { root.__dsoLastEditorError = String(eGlobal && eGlobal.message || eGlobal); }
      }
      if (!root.__djangoShellEditor) {
        host.textContent = "Editor widget is waiting for VS Code editor services.";
        root.__dsoPendingRetries = (root.__dsoPendingRetries || 0) + 1;
        if (root.__dsoPendingRetries <= 10) {
          try { __dsoStartCapture(); } catch (ePendingCapture) { window.__dsoCaptureStartError = String(ePendingCapture && ePendingCapture.message || ePendingCapture); }
          root.__dsoPendingRetryTimer = window.setTimeout(function () { if (root.isConnected && root.style.display !== "none") { window.__djangoShellOverlayShow(window.__djangoShellOverlayGeometry); } }, 500);
        }
      } else {
        root.style.visibility = "visible";
        root.__dsoPendingRetries = 0; try { window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, root.__djangoShellEditor); } catch (ePreludeHidden) {}
        try { window.__dsoConfigureOverlayWidgets && window.__dsoConfigureOverlayWidgets(root, root.__djangoShellEditor); } catch (eWidgetOptions) { root.__dsoLastWidgetError = String(eWidgetOptions && eWidgetOptions.message || eWidgetOptions); }
        try { root.__dsoResizeObserver && root.__dsoResizeObserver.disconnect && root.__dsoResizeObserver.disconnect(); } catch (eResizeDisconnect) {}
        root.__dsoResizeObserver = new ResizeObserver(function () {
          const rect = host.getBoundingClientRect();
          try { root.__djangoShellEditor.layout && root.__djangoShellEditor.layout({ width: Math.max(100, rect.width), height: Math.max(80, rect.height) }); } catch (eLayout) {}
        }); root.__dsoResizeObserver.observe(host);
      }
      return root.__djangoShellEditor;
    }
    /** Reads code from either a workbench CodeEditorWidget or standalone Monaco editor. */
    function __dsoEditorValue(editor) {
      try { if (editor && editor.getValue) { return editor.getValue(); } } catch (eGetValue) {}
      try {
        const model = editor && editor.getModel && editor.getModel();
        return model && model.getValue ? model.getValue() : "";
      } catch (eModelValue) {}
      return "";
    }
    /** Finds the visible VS Code webview frame that contains the custom console tab. */
    function __dsoFindWebviewFrame() {
      const frames = document.querySelectorAll("iframe.webview,.webview iframe,iframe[src^='vscode-webview'],iframe[id*='webview'],webview");
      let best = null;
      let bestArea = 0;
      for (let i = 0; i < frames.length; i++) {
        const style = window.getComputedStyle(frames[i]);
        const rect = frames[i].getBoundingClientRect();
        const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        const area = style.display === "none" || style.visibility === "hidden" ? 0 : width * height;
        if (area > bestArea) {
          best = frames[i];
          bestArea = area;
        }
      }
      return bestArea > 4000 ? best : null;
    }
    /** Finds the workbench DOM host that owns the custom console webview frame. */
    function __dsoFindWebviewHost(frame) {
      if (!frame) { return null; }
      const closest = frame.closest(".webview");
      return closest && closest !== frame ? closest : frame.parentElement;
    }

    /** Ensures the overlay root is a child of the custom console webview host. */
    function __dsoAttachRoot(root) {
      const frame = __dsoFindWebviewFrame();
      const host = __dsoFindWebviewHost(frame);
      if (!frame || !host) { return null; }
      if (window.getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }
      if (root.parentElement !== host) {
        host.appendChild(root);
      }
      return { frame: frame, host: host };
    }
    /** Returns a finite number or a fallback value. */
    function __dsoFinite(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    /** Resolves a webview-local cell rectangle into workbench-window coordinates. */
    function __dsoResolvedGeometry(root, geometry) {
      const attach = __dsoAttachRoot(root);
      if (!attach) { return null; }
      const frameRect = attach.frame.getBoundingClientRect();
      const hostRect = attach.host.getBoundingClientRect();
      const hasGeometry = geometry && __dsoFinite(geometry.width, 0) > 40 && __dsoFinite(geometry.height, 0) > 40;
      const rawLeft = frameRect.left - hostRect.left + (hasGeometry ? __dsoFinite(geometry.left, 0) : 64);
      const rawTop = frameRect.top - hostRect.top + (hasGeometry ? __dsoFinite(geometry.top, 0) : Math.min(220, frameRect.height * 0.35));
      const rawWidth = hasGeometry ? __dsoFinite(geometry.width, 560) : Math.max(320, frameRect.width - 96);
      const rawHeight = hasGeometry ? __dsoFinite(geometry.height, 280) : 280;
      const left = Math.max(0, Math.min(rawLeft, hostRect.width - 120));
      const top = Math.max(0, Math.min(rawTop, hostRect.height - 120));
      return {
        height: Math.max(120, Math.min(rawHeight, hostRect.height - top)),
        left: left,
        top: top,
        width: Math.max(240, Math.min(rawWidth, hostRect.width - left))
      };
    }

    /** Lays out the captured editor after the overlay rectangle changes. */
    function __dsoLayoutOverlayEditor(root) {
      const host = root.querySelector(".django-shell-overlay-editor");
      const editor = root.__djangoShellEditor;
      if (!host || !editor || !editor.layout) { return; }
      const rect = host.getBoundingClientRect();
      try { editor.layout({ width: Math.max(100, rect.width), height: Math.max(80, rect.height) }); } catch (eLayoutOverlay) {}
      try { window.__dsoScheduleWidgetClamp && window.__dsoScheduleWidgetClamp(root); } catch (eClampLayout) {}
    }

    /** Applies the latest webview cell rectangle to the workbench overlay host. */
    function __dsoApplyGeometry(root, geometry) {
      window.__djangoShellOverlayGeometry = geometry || window.__djangoShellOverlayGeometry || null;
      const rect = __dsoResolvedGeometry(root, window.__djangoShellOverlayGeometry);
      if (!rect) { return false; }
      root.style.left = rect.left + "px";
      root.style.top = rect.top + "px";
      root.style.width = rect.width + "px";
      root.style.height = rect.height + "px";
      root.style.right = "";
      root.style.bottom = "";
      __dsoLayoutOverlayEditor(root);
      return true;
    }
    /** Installs the overlay CSS once per workbench window. */
    function __dsoEnsureStyle() {
      if (document.getElementById("django-shell-overlay-style")) { return; }
      const style = document.createElement("style");
      style.id = "django-shell-overlay-style";
      style.textContent = ".django-shell-overlay{position:absolute;left:0;top:0;width:1px;height:1px;z-index:10;box-sizing:border-box;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:0;font-family:var(--vscode-font-family)}.django-shell-overlay-head{display:none}.django-shell-overlay-title{font-size:12px;color:var(--vscode-descriptionForeground)}.django-shell-overlay-spacer{flex:1}.django-shell-overlay button{border:0;border-radius:3px;padding:2px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.django-shell-overlay-editor{height:100%;min-height:80px}.django-shell-overlay-output,.django-shell-overlay-output.error{display:none}";
      document.head.appendChild(style);
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
    try { __dsoStartCapture(); } catch (eStartCapture) { window.__dsoCaptureStartError = String(eStartCapture && eStartCapture.message || eStartCapture); }
    window.__djangoShellOverlayShow = function (geometry) {
      __dsoEnsureStyle();
      let root = document.getElementById("django-shell-overlay");
      if (!root) {
        root = document.createElement("section");
        root.id = "django-shell-overlay";
        root.className = "django-shell-overlay";
        __dsoBuildOverlay(root);
        root.querySelector("[data-run]").addEventListener("click", function () {
          __dsoPost({ type: "run", code: __dsoEditorValue(root.__djangoShellEditor) });
        });
      }
      root.__dsoUseVisiblePrelude = !!window.__djangoShellOverlayUseVisiblePrelude;
      root.style.display = "block";
      if (!root.__dsoGeometryTimer) { root.__dsoGeometryTimer = window.setInterval(function () { if (root.style.display !== "none") { __dsoApplyGeometry(root, window.__djangoShellOverlayGeometry); } }, 250); }
      if (!__dsoApplyGeometry(root, geometry)) { return "django-shell-overlay-shown:pending:no-webview-host:" + __dsoStatus(); }
      const editor = __dsoEnsureEditor(root);
      __dsoApplyGeometry(root, geometry);
      if (editor && window.__dsoInstallModelSync) { window.__dsoInstallModelSync(root, editor, __dsoEditorValue, __dsoPost); }
      if (editor && window.__dsoInstallEnterRunner) { window.__dsoInstallEnterRunner(root, editor, __dsoPost); }
      root.style.visibility = editor ? "visible" : "hidden";
      if (editor && editor.focus) { editor.focus(); }
      return editor ? "django-shell-overlay-shown:editor:" + __dsoStatus() : "django-shell-overlay-shown:pending:" + __dsoStatus();
    };
    window.__djangoShellOverlaySetGeometry = function (geometry) {
      const root = document.getElementById("django-shell-overlay");
      window.__djangoShellOverlayGeometry = geometry || null;
      if (!root) { return "no-overlay"; }
      __dsoApplyGeometry(root, geometry);
      return "ok";
    };
    window.__djangoShellOverlaySetOutput = function (text, ok) {
      const root = document.getElementById("django-shell-overlay");
      if (!root) { return "no-overlay"; }
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
