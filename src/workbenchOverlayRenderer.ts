// Renderer-side workbench overlay source for the Django shell Python cell.
import { overlaySyncRendererSource } from "./workbenchOverlaySyncRenderer";
import { overlayWidgetRendererSource } from "./workbenchOverlayWidgetRenderer";
import { overlayCleanupRendererSource } from "./workbenchOverlayCleanupRenderer";
import { overlayFrameRendererSource } from "./workbenchOverlayFrameRenderer";
import { overlayCaptureRendererSource } from "./workbenchOverlayCaptureRenderer";

export interface OverlayRendererOptions {
  executionMode?: "shell" | "submit";
  panelTitle?: string;
}

/** Builds the JavaScript injected into the focused VS Code workbench window. */
export function overlayRendererSource(modelUri: string, options: OverlayRendererOptions = {}): string {
  const executionMode = options.executionMode ?? "shell";
  const panelTitle = options.panelTitle ?? "Django Shell";
  return `
    const __dsoOverlayModelUri = ${JSON.stringify(modelUri)};
    const __dsoOverlayBridge = Object.assign({}, window.__djangoShellOverlayBridge || {});
    window.__djangoShellOverlayModelUri = __dsoOverlayModelUri;
    window.__dsoCaptures = window.__dsoCaptures || { widgets: [], insts: [], modelSvcs: [], ctors: [] };
    window.__dsoBadInsts = []; window.__dsoGoodInsts = [];
    window.__dsoBadModelSvcs = []; window.__dsoGoodModelSvcs = [];
    window.__dsoLastFactoryError = ""; window.__dsoLastModelError = "";
    window.__dsoWidgetCache = window.__dsoWidgetCache || (typeof WeakMap !== "undefined" ? new WeakMap() : null);
    window.__dsoRejectedWidgets = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    window.__dsoSniffedWidgets = window.__dsoSniffedWidgets || (typeof WeakSet !== "undefined" ? new WeakSet() : null);
    window.__dsoDomCaptureFallbackAfter = 0;
    /** Posts one renderer event to the extension-host bridge. */
    function __dsoPost(payload) {
      const bridge = __dsoOverlayBridge;
      const url = "http://127.0.0.1:" + bridge.port + "/django-shell-overlay?token=" + encodeURIComponent(bridge.token || "");
      const body = JSON.stringify(payload);
      const request = function (mode) { return fetch(url, { body: body, headers: { "content-type": "text/plain" }, method: "POST", mode: mode }); };
      const fallback = function (error) { window.__dsoLastPostError = String(error && error.message || error); window.__dsoLastPostType = payload && payload.type; window.__djangoShellOverlayBridgeFailedAt = Date.now(); window.__djangoShellOverlayBridgeFailedPort = bridge.port; return request("no-cors"); };
      return payload && payload.type === "run" ? request("cors").catch(fallback) : request("cors").catch(function (error) { return fallback(error).catch(function () { return undefined; }); });
    }
    /** Returns whether named members exist as real own or prototype properties without duck-typing a dynamic proxy. */
    function __dsoHasMembers(value, names) {
      if (!value) { return false; }
      const found = Object.create(null);
      let cursor = value;
      for (let depth = 0; cursor && depth < 12; depth++) {
        let keys = [];
        try { keys = Object.getOwnPropertyNames(cursor); } catch (eMemberKeys) { return false; }
        for (let index = 0; index < names.length; index++) { if (keys.indexOf(names[index]) >= 0) { found[names[index]] = true; } }
        try { cursor = Object.getPrototypeOf(cursor); } catch (eMemberPrototype) { break; }
      }
      for (let index = 0; index < names.length; index++) { if (!found[names[index]]) { return false; } }
      return true;
    }
    /** Detects a promise-like RPC result and consumes its rejection before callers discard it. */
    function __dsoIsAsyncResult(value) {
      let asyncResult = false;
      try { asyncResult = !!(value && typeof value.then === "function"); } catch (eAsyncProbe) { return true; }
      if (!asyncResult) { return false; }
      try {
        if (typeof value.catch === "function") { void value.catch(function () { return undefined; }); }
        else { void Promise.resolve(value).catch(function () { return undefined; }); }
      } catch (eAsyncCatch) {}
      return true;
    }
    /** Returns whether a value has the structural members of VS Code's CodeEditorWidget. */
    function __dsoIsWidget(value) {
      return __dsoHasMembers(value, ["layout", "getModel", "getDomNode"]);
    }
    /** Returns whether a widget is a local live editor rather than an RPC proxy with synthetic methods. */
    function __dsoIsLiveWidget(value) {
      if (!__dsoIsWidget(value)) { return false; }
      const rejected = window.__dsoRejectedWidgets;
      try { if (rejected && rejected.has(value)) { return false; } } catch (eRejectedWidgetRead) {}
      try { if (/^bound(?: |$)/.test(String(value.constructor && value.constructor.name || ""))) { return false; } } catch (eWidgetCtor) { return false; }
      try {
        const node = value.getDomNode();
        if (__dsoIsAsyncResult(node)) { try { rejected && rejected.add(value); } catch (eRejectedWidgetAsync) {} return false; }
        const live = !!(node && (node.nodeType === 1 || typeof node.tagName === "string"));
        return live;
      } catch (eLiveWidget) { try { rejected && rejected.add(value); } catch (eRejectedWidgetError) {} return false; }
    }
    /** Returns whether a value looks like VS Code's instantiation service. */
    function __dsoIsInst(value) {
      return __dsoHasMembers(value, ["createInstance", "invokeFunction"]) && !__dsoHasMembers(value, ["createModel", "getModel"]);
    }
    /** Returns whether a value looks like VS Code's model service. */
    function __dsoIsModelSvc(value) {
      return __dsoHasMembers(value, ["createModel", "getModel", "getModels"]) && (__dsoHasMembers(value, ["onModelAdded"]) || __dsoHasMembers(value, ["onModelRemoved"]) || __dsoHasMembers(value, ["destroyModel"]));
    }
    /** Returns whether a value looks like VS Code's text model. */
    function __dsoIsTextModel(value) { return !!(value && value.uri && typeof value.getLanguageId === "function" && typeof value.getValue === "function" && typeof value.onDidChangeContent === "function"); }
    /** Reads a local widget model synchronously while rejecting RPC-like results. */
    function __dsoReadWidgetModel(widget, source) {
      if (!__dsoIsLiveWidget(widget)) { return null; }
      try {
        const model = widget.getModel();
        if (__dsoIsAsyncResult(model)) {
          window.__dsoLastModelError = String(source || "widget-model") + ":async";
          try { window.__dsoRejectedWidgets && window.__dsoRejectedWidgets.add(widget); } catch (eRejectAsyncModelWidget) {}
          return null;
        }
        return model || null;
      } catch (error) {
        window.__dsoLastModelError = String(source || "widget-model") + ":" + String(error && error.message || error).slice(0, 120);
        try { window.__dsoRejectedWidgets && window.__dsoRejectedWidgets.add(widget); } catch (eRejectModelWidget) {}
        return null;
      }
    }
    /** Stores one captured object in a bounded unique list. */
    function __dsoRemember(list, value, limit) {
      if (!value || list.indexOf(value) >= 0 || list.length >= limit) { return; }
      list[list.length] = value;
    }
    /** Returns whether an instantiation service already failed a synchronous local probe. */ function __dsoBadInst(value) { return window.__dsoBadInsts && window.__dsoBadInsts.indexOf(value) >= 0; }
    /** Marks an instantiation service so later factory passes avoid repeated RPC probes. */ function __dsoRememberBadInst(value) { if (value && !__dsoBadInst(value)) { window.__dsoBadInsts[window.__dsoBadInsts.length] = value; } }
    /** Returns whether an instantiation service already passed a synchronous local probe. */ function __dsoGoodInst(value) { return window.__dsoGoodInsts && window.__dsoGoodInsts.indexOf(value) >= 0; }
    /** Marks an instantiation service as locally usable. */ function __dsoRememberGoodInst(value) { if (value && !__dsoGoodInst(value)) { window.__dsoGoodInsts[window.__dsoGoodInsts.length] = value; } }
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
      if (__dsoBadInst(inst)) { return "bad-inst:cached"; }
      if (__dsoGoodInst(inst)) { return ""; }
      try {
        const result = inst.invokeFunction(function () { return true; });
        if (__dsoIsAsyncResult(result)) { __dsoRememberBadInst(inst); return "bad-inst:async"; }
        if (result !== true) { __dsoRememberBadInst(inst); return "bad-inst:result"; }
        __dsoRememberGoodInst(inst);
        return "";
      } catch (e) {
        __dsoRememberBadInst(inst);
        return "bad-inst:" + String(e && e.message || e).slice(0, 120);
      }
    }
    /** Returns an error string when a model service is not usable. */
    function __dsoValidateModelSvc(modelSvc) {
      if (!__dsoIsModelSvc(modelSvc)) { return "missing-modelSvc"; }
      if (__dsoBadModelSvc(modelSvc)) { return "bad-modelSvc:cached"; }
      if (__dsoGoodModelSvc(modelSvc)) { return ""; }
      try {
        const models = modelSvc.getModels();
        if (__dsoIsAsyncResult(models)) { __dsoRememberBadModelSvc(modelSvc); return "bad-modelSvc:async"; }
        if (!Array.isArray(models)) { __dsoRememberBadModelSvc(modelSvc); return "bad-modelSvc:models"; }
        __dsoRememberGoodModelSvc(modelSvc);
        return "";
      } catch (eModelSvcProbe) {
        __dsoRememberBadModelSvc(modelSvc);
        return "bad-modelSvc:" + String(eModelSvcProbe && eModelSvcProbe.message || eModelSvcProbe).slice(0, 120);
      }
    }
    /** Scans one object for editor widget, instantiation service, and model service references. */
    function __dsoSniff(value) {
      const caps = window.__dsoCaptures;
      if (!value || typeof value !== "object") { return; }
      if (__dsoIsLiveWidget(value)) {
        __dsoRemember(caps.widgets, value, 40);
        __dsoRemember(caps.ctors, __dsoRealCtor(value), 8);
        try { const model = __dsoReadWidgetModel(value, "sniff-widget"); const URI = model && model.uri && model.uri.constructor; if (URI && typeof URI.parse === "function") { window.__dsoUriCtor = URI; } } catch (eWidgetUri) {}
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
      try { const cached = cache && cache.get(element); if (__dsoIsLiveWidget(cached)) { return cached; } } catch (eWidgetCacheRead) {}
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
        if (__dsoIsLiveWidget(value)) { try { cache && cache.set(element, value); } catch (eWidgetCacheWidget) {} return value; }
        try {
          if (__dsoIsLiveWidget(value && value.editor)) { try { cache && cache.set(element, value.editor); } catch (eWidgetCacheEditor) {} return value.editor; }
          if (__dsoIsLiveWidget(value && value._editor)) { try { cache && cache.set(element, value._editor); } catch (eWidgetCacheUnderscore) {} return value._editor; }
        } catch (eNested) {}
      }
      try {
        const symbols = Object.getOwnPropertySymbols(element);
        for (let i = 0; i < symbols.length; i++) {
          let value;
          try { value = element[symbols[i]]; } catch (eSymbolRead) { continue; }
          if (__dsoIsLiveWidget(value)) { try { cache && cache.set(element, value); } catch (eWidgetCacheSymbol) {} return value; }
        }
      } catch (eSymbols) {}
      return null;
    }

    /** Searches an editor DOM subtree and nearby ancestors for an editor widget reference. */
    function __dsoFindWidget(start) {
      const cache = window.__dsoWidgetCache;
      try { const cached = cache && start && cache.get(start); if (__dsoIsLiveWidget(cached)) { return cached; } } catch (eFindWidgetCacheRead) {}
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
      const now = Date.now();
      if (window.__dsoLastDomCaptureScanAt && now - window.__dsoLastDomCaptureScanAt < 1200) { return; }
      window.__dsoLastDomCaptureScanAt = now;
      const editors = document.querySelectorAll(".editor-group-container .monaco-editor, .monaco-editor");
      for (let i = 0; i < editors.length; i++) {
        const root = editors[i];
        if (root.closest && root.closest("#django-shell-overlay")) { continue; }
        const widget = __dsoFindWidget(root);
        if (widget) { __dsoSniff(widget); }
      }
    }
    ${overlayCaptureRendererSource()}

    /** Restarts capture immediately before the host opens its temporary warmup editor. */
    window.__dsoArmOverlayCapture = function (ownerToken) {
      if (ownerToken && ownerToken !== String(__dsoOverlayBridge.token || "")) { return "owner-mismatch"; }
      const root = document.getElementById("django-shell-overlay");
      if (root && root.__djangoShellEditor) { return "capture-ready:" + Number(window.__dsoCaptureGeneration || 0); }
      __dsoStartCapture(true);
      window.__dsoDomCaptureFallbackAfter = Date.now() + 700;
      return "capture-armed:" + Number(window.__dsoCaptureGeneration || 0);
    };

    /** Rearms the short exact-service lookup lease for a matching fallback transaction. */
    window.__dsoRearmOverlayServiceLookup = function (ownerToken, generation) {
      if (ownerToken && ownerToken !== String(__dsoOverlayBridge.token || "")) { return "owner-mismatch"; }
      const current = Number(window.__dsoCaptureGeneration || 0);
      if (Number(generation) !== current) { return "capture-stale:" + current; }
      return __dsoStartServiceLookup(current) ? "service-lookup-armed:" + current : "service-lookup-inactive:" + current;
    };

    /** Stops temporary capture hooks owned by this overlay renderer. */
    window.__dsoStopOverlayCapture = function (ownerToken, generation) {
      if (ownerToken && ownerToken !== String(__dsoOverlayBridge.token || "")) { return "owner-mismatch"; }
      const current = Number(window.__dsoCaptureGeneration || 0);
      if (generation !== undefined && generation !== null && Number(generation) !== current) { return "capture-stale:" + current; }
      __dsoStopCapture(current);
      return "capture-stopped:" + current;
    };

    /** Returns a captured editor factory when enough workbench internals are available. */
    function __dsoFactory() {
      window.__dsoLastFactoryError = "";
      if (window.__dsoDomCaptureFallbackAfter && Date.now() >= window.__dsoDomCaptureFallbackAfter) { __dsoScanDom(); }
      const caps = window.__dsoCaptures;
      const exact = window.__dsoExactCapture || (window.__dsoExactCapture = {});
      let instError = "missing-inst", modelSvcError = "missing-modelSvc", registryError = "";
      if (exact.widget && !__dsoIsLiveWidget(exact.widget)) { exact.widget = null; exact.ctor = null; }
      if (exact.inst) {
        instError = __dsoValidateInst(exact.inst);
        if (instError) { if (window.__dsoPreferredInst === exact.inst) { window.__dsoPreferredInst = null; } exact.inst = null; }
      }
      if (exact.modelSvc) {
        modelSvcError = __dsoValidateModelSvc(exact.modelSvc);
        if (modelSvcError) { if (window.__dsoPreferredModelSvc === exact.modelSvc) { window.__dsoPreferredModelSvc = null; } exact.modelSvc = null; }
      }
      try { __dsoScanCapturedServiceMaps(); } catch (eRegistryFactory) { registryError = "registry:" + String(eRegistryFactory && eRegistryFactory.message || eRegistryFactory).slice(0, 120); }
      for (let i = 0; i < caps.widgets.length; i++) {
        const widget = caps.widgets[i];
        if (!__dsoIsLiveWidget(widget)) { continue; }
        __dsoRemember(caps.ctors, __dsoRealCtor(widget), 8);
        const sniffed = window.__dsoSniffedWidgets;
        let alreadySniffed = false;
        try { alreadySniffed = !!(sniffed && sniffed.has(widget)); } catch (eSniffedRead) {}
        if (!alreadySniffed) { __dsoSniff(widget); try { sniffed && sniffed.add(widget); } catch (eSniffedWrite) {} }
      }
      let inst = null;
      let modelSvc = null;
      const exactInst = exact.inst, exactModelSvc = exact.modelSvc;
      const preferredInst = window.__dsoPreferredInst, preferredModelSvc = window.__dsoPreferredModelSvc;
      if (exactInst) { instError = __dsoValidateInst(exactInst); if (!instError) { inst = exactInst; } }
      if (!inst && preferredInst && preferredInst !== exactInst) {
        instError = __dsoValidateInst(preferredInst);
        if (!instError) { inst = preferredInst; }
        else if (window.__dsoPreferredInst === preferredInst) { window.__dsoPreferredInst = null; }
      }
      if (exactModelSvc) { modelSvcError = __dsoValidateModelSvc(exactModelSvc); if (!modelSvcError) { modelSvc = exactModelSvc; } }
      if (!modelSvc && preferredModelSvc && preferredModelSvc !== exactModelSvc) {
        modelSvcError = __dsoValidateModelSvc(preferredModelSvc);
        if (!modelSvcError) { modelSvc = preferredModelSvc; }
        else if (window.__dsoPreferredModelSvc === preferredModelSvc) { window.__dsoPreferredModelSvc = null; }
      }
      for (let i = 0; i < caps.insts.length; i++) {
        if (inst) { break; }
        const error = __dsoValidateInst(caps.insts[i]);
        if (!error) { inst = caps.insts[i]; break; }
        if (error !== "bad-inst:cached") { instError = error; }
      }
      for (let i = 0; i < caps.modelSvcs.length; i++) {
        if (modelSvc) { break; }
        const error = __dsoValidateModelSvc(caps.modelSvcs[i]);
        if (!error) { modelSvc = caps.modelSvcs[i]; break; }
        if (error !== "bad-modelSvc:cached") { modelSvcError = error; }
      }
      let model = null;
      if (!modelSvc) {
        for (let i = 0; i < caps.widgets.length; i++) {
          const candidate = __dsoReadWidgetModel(caps.widgets[i], "factory-widget");
          try { if (candidate && String(candidate.uri) === __dsoOverlayModelUri) { model = candidate; break; } } catch (eFactoryModelUri) { window.__dsoLastModelError = "factory-widget-uri:" + String(eFactoryModelUri && eFactoryModelUri.message || eFactoryModelUri).slice(0, 120); }
        }
      }
      let ctor = exact.ctor || window.__dsoPreferredCtor || null;
      if (typeof ctor !== "function") { ctor = null; }
      for (let i = 0; !ctor && i < caps.ctors.length; i++) { if (typeof caps.ctors[i] === "function") { ctor = caps.ctors[i]; } }
      if (ctor && inst && (modelSvc || model)) { window.__dsoLastFactoryError = ""; return { ctor: ctor, inst: inst, model: model, modelSvc: modelSvc }; }
      const missing = [];
      if (!ctor) { missing[missing.length] = "ctor"; }
      if (!inst) { missing[missing.length] = "inst(" + instError + ")"; }
      if (!modelSvc && !model) { missing[missing.length] = "model(" + modelSvcError + ")"; }
      window.__dsoLastFactoryError = (registryError ? registryError + ";" : "") + "missing:" + missing.join(",");
      return null;
    }

    /** Returns a lightweight capture state summary. */
    function __dsoStatus() {
      try {
        const caps = window.__dsoCaptures || {};
        const root = document.getElementById("django-shell-overlay");
        const consoleRects = __dsoConsoleGroups();
        const boundFrame = root && root.__dsoFrame;
        const candidatesReady = !!((caps.ctors || []).length && (caps.insts || []).length && (caps.modelSvcs || []).length);
        let uriCtorReady = false;
        try { uriCtorReady = !!(window.__dsoUriCtor && typeof window.__dsoUriCtor.parse === "function"); } catch (eStatusUriCtor) {}
        return "widgets=" + ((caps.widgets || []).length) +
          " insts=" + ((caps.insts || []).length) +
          " modelSvcs=" + ((caps.modelSvcs || []).length) +
          " ctors=" + ((caps.ctors || []).length) +
          " candidatesReady=" + candidatesReady +
          " exactReady=" + __dsoCaptureReady() +
          " uriCtor=" + uriCtorReady +
          " badModelSvcs=" + ((window.__dsoBadModelSvcs || []).length) +
          " factory=" + !!(root && root.__djangoShellEditor) +
          " consoleGroups=" + consoleRects.length +
          " consoleFrame=" + (boundFrame && consoleRects.length && __dsoFrameIsConsole(boundFrame, consoleRects) ? 1 : 0) +
          " factoryError=" + String(window.__dsoLastFactoryError || "").slice(0, 160) +
          " modelError=" + String(window.__dsoLastModelError || "").slice(0, 160) +
          " editorError=" + String(root && root.__dsoLastEditorError || "").slice(0, 120) +
          " widgetError=" + String(root && root.__dsoLastWidgetError || "").slice(0, 120) +
          " captureError=" + String(window.__dsoCaptureStartError || "");
      } catch (e) {
        return "status-err:" + String(e && e.message || e);
      }
    }
    /** Builds a Monaco URI from an already captured editor model or global Monaco. */
    function __dsoUri() {
      try {
        if (window.__dsoUriCtor && typeof window.__dsoUriCtor.parse === "function") {
          const cachedCtor = window.__dsoUriCtor;
          const cachedUri = cachedCtor.parse(__dsoOverlayModelUri);
          if (!__dsoIsAsyncResult(cachedUri) && cachedUri) { return cachedUri; }
          if (window.__dsoUriCtor === cachedCtor) { window.__dsoUriCtor = null; }
          window.__dsoLastModelError = "cached-uri:async";
        }
      } catch (eCachedUri) { window.__dsoUriCtor = null; window.__dsoLastModelError = "cached-uri:" + String(eCachedUri && eCachedUri.message || eCachedUri).slice(0, 120); }
      try {
        const exact = window.__dsoExactCapture || {};
        const exactModel = __dsoReadWidgetModel(exact.widget, "uri-exact-widget");
        const exactURI = exactModel && exactModel.uri && exactModel.uri.constructor;
        if (exactURI && typeof exactURI.parse === "function") {
          const exactUri = exactURI.parse(__dsoOverlayModelUri);
          if (!__dsoIsAsyncResult(exactUri) && exactUri) { window.__dsoUriCtor = exactURI; return exactUri; }
        }
        const widgets = (window.__dsoCaptures && window.__dsoCaptures.widgets) || [];
        for (let i = 0; i < widgets.length; i++) {
          if (widgets[i] === exact.widget) { continue; }
          const model = __dsoReadWidgetModel(widgets[i], "uri-widget");
          const URI = model && model.uri && model.uri.constructor;
          if (URI && typeof URI.parse === "function") {
            const uri = URI.parse(__dsoOverlayModelUri);
            if (!__dsoIsAsyncResult(uri) && uri) { window.__dsoUriCtor = URI; return uri; }
          }
        }
      } catch (eUri) { window.__dsoLastModelError = "widget-uri:" + String(eUri && eUri.message || eUri).slice(0, 120); }
      try {
        const URI = globalThis.monaco && globalThis.monaco.Uri || window.monaco && window.monaco.Uri;
        if (URI && typeof URI.parse === "function") {
          const uri = URI.parse(__dsoOverlayModelUri);
          if (!__dsoIsAsyncResult(uri) && uri) { window.__dsoUriCtor = URI; return uri; }
        }
      } catch (eGlobalUri) { window.__dsoLastModelError = "global-uri:" + String(eGlobalUri && eGlobalUri.message || eGlobalUri).slice(0, 120); }
      if (!window.__dsoLastModelError) { window.__dsoLastModelError = "missing-uri-constructor"; }
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
    /** Disposes partially-created editor resources after a failed construction transaction. */
    function __dsoRollbackWorkbenchResources(editor, ownedModel) {
      if (editor && !__dsoIsAsyncResult(editor)) {
        try { if (__dsoHasMembers(editor, ["dispose"])) { const disposed = editor.dispose(); __dsoIsAsyncResult(disposed); } } catch (eRollbackEditor) {}
      }
      if (ownedModel && !__dsoIsAsyncResult(ownedModel)) {
        try { if (__dsoHasMembers(ownedModel, ["dispose"])) { const disposed = ownedModel.dispose(); __dsoIsAsyncResult(disposed); } } catch (eRollbackModel) {}
      }
    }
    /** Creates a real workbench CodeEditorWidget using captured VS Code services. */
    function __dsoCreateWorkbenchEditor(root, host, overflowWidgetsNode) {
      const factory = __dsoFactory();
      if (!factory) { return null; }
      window.__dsoLastModelError = "";
      const uri = __dsoUri();
      let model = factory.model || null;
      let ownedModel = null;
      let serviceAttempted = false, serviceUnsafe = false, serviceError = "";
      if (model && __dsoIsAsyncResult(model)) { model = null; window.__dsoLastModelError = "factory-model:async"; }
      if (model) {
        try { if (!model.uri) { model = null; window.__dsoLastModelError = "factory-model:missing-uri"; } }
        catch (eFactoryModel) { model = null; window.__dsoLastModelError = "factory-model:" + String(eFactoryModel && eFactoryModel.message || eFactoryModel).slice(0, 120); }
      }
      if (!model && factory.modelSvc && !uri) {
        window.__dsoLastModelError = window.__dsoLastModelError || "missing-uri-constructor";
        return null;
      }
      if (!model && factory.modelSvc && uri) {
        const text = window.__dsoInitialModelText ? window.__dsoInitialModelText() : "", language = __dsoPythonLanguage();
        serviceAttempted = true;
        try {
          model = factory.modelSvc.createModel(text, language, uri, false);
          if (__dsoIsAsyncResult(model)) { model = null; serviceUnsafe = true; serviceError = "create-model:async"; }
          else if (model) { ownedModel = model; }
        } catch (eCreateModel) { serviceError = "create-model:" + String(eCreateModel && eCreateModel.message || eCreateModel).slice(0, 120); }
        if (!model && !serviceUnsafe) {
          try {
            model = factory.modelSvc.getModel(uri);
            if (__dsoIsAsyncResult(model)) { model = null; serviceUnsafe = true; serviceError = "get-model:async"; }
          } catch (eGetModel) { serviceError += (serviceError ? ";" : "") + "get-model:" + String(eGetModel && eGetModel.message || eGetModel).slice(0, 120); }
        }
      }
      if (model) {
        try {
          if (model.isDisposed) { const disposed = model.isDisposed(); if (__dsoIsAsyncResult(disposed) || disposed) { model = null; serviceUnsafe = true; serviceError = serviceError || "model-disposed"; } }
          if (model && model.getValue) { const value = model.getValue(); if (__dsoIsAsyncResult(value)) { model = null; serviceUnsafe = true; serviceError = serviceError || "model-value:async"; } }
        } catch (eModelProbe) { model = null; serviceError = serviceError || "model-probe:" + String(eModelProbe && eModelProbe.message || eModelProbe).slice(0, 120); }
      }
      let modelUri = null;
      try { modelUri = model && model.uri; } catch (eModelUri) { serviceError = serviceError || "model-uri:" + String(eModelUri && eModelUri.message || eModelUri).slice(0, 120); }
      if (!model || !modelUri) {
        if (serviceAttempted) { __dsoRememberBadModelSvc(factory.modelSvc); }
        window.__dsoLastModelError = serviceError || (serviceUnsafe ? "unsafe-model-service" : "missing-model");
        __dsoRollbackWorkbenchResources(null, ownedModel);
        return null;
      }
      try { if (model && model.setLanguage) { model.setLanguage(__dsoPythonLanguage()); } } catch (eSetLanguage) {}
      try { if (globalThis.monaco && globalThis.monaco.editor && globalThis.monaco.editor.setModelLanguage) { globalThis.monaco.editor.setModelLanguage(model, "python"); } } catch (eSetModelLanguage) {}
      const options = { acceptSuggestionOnEnter: "on", automaticLayout: false, fixedOverflowWidgets: false, folding: true, formatOnPaste: false, formatOnType: false, glyphMargin: true, hover: { enabled: true }, lineDecorationsWidth: 0, lineNumbers: "on", lineNumbersMinChars: 1, minimap: { enabled: false }, overflowWidgetsDomNode: overflowWidgetsNode, parameterHints: { enabled: true }, quickSuggestions: true, scrollBeyondLastLine: false, suggestOnTriggerCharacters: true };
      const widgetOptions = { isSimpleWidget: false };
      let editor = null;
      try { editor = factory.inst.createInstance(factory.ctor, host, options, widgetOptions); }
      catch (eCreateEditor) { __dsoRememberBadInst(factory.inst); __dsoRollbackWorkbenchResources(null, ownedModel); window.__dsoLastFactoryError = "create-editor:" + String(eCreateEditor && eCreateEditor.message || eCreateEditor).slice(0, 120); throw eCreateEditor; }
      if (__dsoIsAsyncResult(editor)) { __dsoRememberBadInst(factory.inst); __dsoRollbackWorkbenchResources(null, ownedModel); window.__dsoLastFactoryError = "create-editor:async"; return null; }
      let localWidgetShape = __dsoIsWidget(editor);
      try { if (/^bound(?: |$)/.test(String(editor && editor.constructor && editor.constructor.name || ""))) { localWidgetShape = false; } } catch (eCreatedWidgetCtor) { localWidgetShape = false; }
      if (!localWidgetShape) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "create-editor:not-local-widget"; return null; }
      if (!__dsoHasMembers(editor, ["setModel"])) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "set-model:missing"; return null; }
      try { const setResult = editor.setModel(model); if (__dsoIsAsyncResult(setResult)) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "set-model:async"; return null; } }
      catch (eSetEditorModel) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "set-model:" + String(eSetEditorModel && eSetEditorModel.message || eSetEditorModel).slice(0, 120); throw eSetEditorModel; }
      if (!__dsoIsLiveWidget(editor)) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "set-model:not-live-widget"; return null; }
      try { if (editor.layout) { const layoutResult = editor.layout(__dsoLayoutSize(root, host)); if (__dsoIsAsyncResult(layoutResult)) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "layout:async"; return null; } } }
      catch (eEditorLayout) { __dsoRollbackWorkbenchResources(editor, ownedModel); window.__dsoLastFactoryError = "layout:" + String(eEditorLayout && eEditorLayout.message || eEditorLayout).slice(0, 120); throw eEditorLayout; }
      const exact = window.__dsoExactCapture || (window.__dsoExactCapture = {}), caps = window.__dsoCaptures || { widgets: [] };
      exact.widget = editor; exact.ctor = __dsoRealCtor(editor); if (caps.widgets) { caps.widgets.length = 0; __dsoRemember(caps.widgets, editor, 40); }
      window.__dsoLastFactoryError = ""; window.__dsoLastModelError = "";
      return editor;
    }
    /** Creates a standalone Monaco editor only when the workbench exposes the public API. */
    function __dsoCreateGlobalMonacoEditor(root, host, overflowWidgetsNode) {
      const monacoApi = (globalThis.monaco && globalThis.monaco.editor) ? globalThis.monaco : ((window.monaco && window.monaco.editor) ? window.monaco : null);
      if (!monacoApi) { return null; }
      const uri = monacoApi.Uri.parse(__dsoOverlayModelUri);
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
      if (!root.__djangoShellEditor) { try { root.__djangoShellEditor = __dsoCreateWorkbenchEditor(root, host, overflowWidgetsNode); } catch (eWorkbench) { root.__dsoLastEditorError = String(eWorkbench && eWorkbench.message || eWorkbench); } }
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
    ${overlayFrameRendererSource(panelTitle)}
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
      if (root.__dsoHasActiveConsoleGroup === false) {
        __dsoHandleGeometryMiss(root);
      } else {
        root.__dsoGeometryMissingSince = 0;
        const restoreRoot = !!root.__dsoGeometryParked;
        const restoreWidgets = restoreRoot || !!root.__dsoGeometryWidgetParked;
        root.__dsoGeometryParked = false;
        root.__dsoGeometryWidgetParked = false;
        if (root.__djangoShellEditor && !root.__dsoExplicitlyParked && root.style.display !== "none") {
          if (restoreWidgets) { root.style.visibility = "visible"; }
          try { if (restoreWidgets && window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, true, false); } } catch (eRestoreWidgets) {}
        }
      }
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
    /** Parks a live editor only after the owning frame is absent long enough to rule out a transient tab transition. */
    function __dsoHandleGeometryMiss(root) {
      if (!root) { return; }
      const now = Date.now();
      if (!root.__dsoGeometryMissingSince) {
        root.__dsoGeometryMissingSince = now;
        root.__dsoGeometryWidgetParked = true;
        try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, false, true); } } catch (eParkTransientWidgets) {}
        return;
      }
      if (now - root.__dsoGeometryMissingSince < 700) { return; }
      root.__dsoGeometryParked = true;
      root.style.visibility = "hidden";
      try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, false, true); } } catch (eParkWidgets) {}
    }
    /** Installs the overlay CSS once per workbench window. */
    function __dsoEnsureStyle() {
      let style = document.getElementById("django-shell-overlay-style");
      const version = String(window.__djangoShellOverlayPatchVersion || "");
      if (style && style.__dsoPatchVersion === version) { return; }
      if (!style) { style = document.createElement("style"); style.id = "django-shell-overlay-style"; document.head.appendChild(style); }
      style.textContent = ".django-shell-overlay{position:absolute;left:0;top:0;width:1px;height:1px;z-index:2147483646;box-sizing:border-box;overflow:visible;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:0;font-family:var(--vscode-font-family);will-change:transform}.django-shell-overlay-head{display:none}.django-shell-overlay-title{font-size:12px;color:var(--vscode-descriptionForeground)}.django-shell-overlay-spacer{flex:1}.django-shell-overlay button{border:0;border-radius:3px;padding:2px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.django-shell-overlay-editor{width:100%;height:100%;min-height:80px;box-sizing:border-box;overflow:visible;contain:layout style}.django-shell-overlay .monaco-editor{overflow:visible!important}.django-shell-overlay .overflowingContentWidgets{overflow:visible!important;z-index:35}.django-shell-overlay .margin-view-overlays .line-numbers{color:var(--vscode-editorLineNumber-foreground,var(--vscode-descriptionForeground,var(--vscode-foreground)))!important;min-width:0!important;overflow:visible!important;padding-right:1ch!important}.django-shell-overlay .dso-exec-range{background:var(--vscode-editor-selectionHighlightBackground,rgba(90,150,255,.18));box-shadow:inset 3px 0 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-start{box-shadow:inset 0 1px 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-end{box-shadow:inset 0 -1px 0 var(--vscode-focusBorder,rgba(90,150,255,.9))}.django-shell-overlay .dso-exec-range-rail{background:var(--vscode-focusBorder,rgba(90,150,255,.9));width:3px!important;margin-left:3px}.django-shell-overlay .dso-debug-line{background:color-mix(in srgb,var(--vscode-charts-yellow,#cca700) 22%,var(--vscode-editor-stackFrameHighlightBackground,#ffff0033));box-shadow:inset 4px 0 0 var(--vscode-debugIcon-breakpointCurrentStackframeForeground,var(--vscode-charts-yellow,#cca700)),inset 0 1px 0 color-mix(in srgb,var(--vscode-charts-yellow,#cca700) 45%,transparent),inset 0 -1px 0 color-mix(in srgb,var(--vscode-charts-yellow,#cca700) 45%,transparent)}.django-shell-overlay .dso-debug-inline-value{background:var(--vscode-editor-inlineValuesBackground,var(--vscode-editorInlayHint-background,transparent));border-radius:3px;color:var(--vscode-editor-inlineValuesForeground,var(--vscode-editorInlayHint-foreground,var(--vscode-descriptionForeground)));font-style:italic;opacity:.92;padding:0 3px}.django-shell-overlay .dso-debug-indicator{align-items:center;background:transparent;display:flex;justify-content:center;margin-left:0;width:14px!important}.django-shell-overlay .dso-debug-indicator::before{border-bottom:5px solid transparent;border-left:9px solid var(--vscode-debugIcon-breakpointCurrentStackframeForeground,var(--vscode-charts-yellow,#cca700));border-top:5px solid transparent;content:'';filter:drop-shadow(0 0 1px rgba(0,0,0,.5))}.django-shell-overlay .dso-breakpoint-line{box-shadow:inset 3px 0 0 var(--vscode-debugIcon-breakpointForeground,#e51400);background:color-mix(in srgb,var(--vscode-debugIcon-breakpointForeground,#e51400) 7%,transparent)}.django-shell-overlay-output,.django-shell-overlay-output.error{display:none}.monaco-workbench .tab[aria-label='analysis.py'],.monaco-workbench .tab[aria-label='console-cell.py'],.monaco-workbench .tab[aria-label*='.django-shell'][aria-label*='analysis.py'],.monaco-workbench .tab[title*='/.django-shell/analysis.py'],.monaco-workbench .tab[aria-label*='.django-shell'][aria-label*='console-cell.py'],.monaco-workbench .tab[title*='/.django-shell/console-cell.py']{display:none!important}";
      style.textContent += ".monaco-workbench .tab[aria-label='query-analysis.py'],.monaco-workbench .tab[aria-label='query-cell.py'],.monaco-workbench .tab[title*='/.django-shell/query-analysis.py'],.monaco-workbench .tab[title*='/.django-shell/query-cell.py']{display:none!important}";
      style.__dsoPatchVersion = version;
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
    window.__djangoShellOverlayShow = function (geometry, ownerToken) {
      __dsoEnsureStyle();
      if (ownerToken && ownerToken !== String(__dsoOverlayBridge.token || "")) { return "owner-mismatch"; }
      const requestedOwner = String(ownerToken || window.__djangoShellOverlayOwnerToken || "");
      let root = document.getElementById("django-shell-overlay");
      if (root && root.__dsoOwnerToken !== requestedOwner) {
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
      root.__dsoOwnerToken = requestedOwner;
      root.__dsoExecutionMode = ${JSON.stringify(executionMode)};
      root.__dsoExplicitlyParked = false;
      try { root.dataset.djangoShellOverlayOwner = requestedOwner; } catch (eOwnerDataset) {}
      try { if (__dsoSyncWidgetTheme) { __dsoSyncWidgetTheme(root, true); } } catch (eRootTheme) {}
      __dsoInstallGeometrySync(root);
      root.__dsoUseVisiblePrelude = !!window.__djangoShellOverlayUseVisiblePrelude;
      root.style.removeProperty("display"); root.style.display = "block";
      if (!wasShown) { root.style.removeProperty("visibility"); root.style.visibility = "hidden"; try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, false, false); } } catch (eHoldWidgets) {} }
      if (!root.__dsoGeometryTimer) { root.__dsoGeometryTimer = window.setInterval(function () { if (root.style.display !== "none" && !__dsoApplyGeometry(root, window.__djangoShellOverlayGeometry) && root.__dsoHadConsoleFrame) { __dsoHandleGeometryMiss(root); } }, 250); }
      if (!__dsoApplyGeometry(root, geometry)) {
        root.__dsoGeometryWidgetParked = true;
        try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, false, true); } } catch (ePendingWidgets) {}
        return "django-shell-overlay-shown:pending:no-webview-host:" + __dsoStatus();
      }
      const previousEditor = root.__djangoShellEditor;
      const editor = __dsoEnsureEditor(root);
      if (editor && editor !== previousEditor) { __dsoApplyGeometry(root, geometry); }
      if (editor && window.__dsoInstallModelSync) { window.__dsoInstallModelSync(root, editor, __dsoEditorValue, __dsoPost); }
      if (editor && window.__dsoInstallEnterRunner) { window.__dsoInstallEnterRunner(root, editor, __dsoPost); }
      const pendingOwnerMatches = !window.__dsoPendingOverlayOwnerToken || window.__dsoPendingOverlayOwnerToken === requestedOwner;
      if (editor && window.__dsoSetOverlayVisibleText && ((window.__dsoPendingOverlayVisibleText !== undefined && pendingOwnerMatches) || !root.__dsoHasAppliedInitialText)) {
        window.__dsoSetOverlayVisibleText(window.__dsoPendingOverlayVisibleText !== undefined && pendingOwnerMatches ? window.__dsoPendingOverlayVisibleText : window.__djangoShellOverlayInitialText, requestedOwner);
      }
      const editorVisible = !!editor && !root.__dsoGeometryParked;
      root.style.visibility = editorVisible ? "visible" : "hidden";
      try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, editorVisible && root.__dsoHasActiveConsoleGroup !== false, false); } } catch (eShowWidgets) {}
      if (editorVisible && editor.focus && !wasShown) { editor.focus(); }
      return editor ? "django-shell-overlay-shown:editor:" + __dsoStatus() : "django-shell-overlay-shown:pending:" + __dsoStatus();
    };
    window.__djangoShellOverlaySetGeometry = function (geometry, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      window.__djangoShellOverlayGeometry = geometry || null;
      if (!root) { return "no-overlay"; }
      __dsoApplyGeometry(root, geometry);
      return "ok";
    };
    window.__djangoShellOverlaySetOutput = function (text, ok, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (!root) { return "no-overlay"; }
      if (ownerToken && root.__dsoOwnerToken !== ownerToken) { return "owner-mismatch"; }
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
