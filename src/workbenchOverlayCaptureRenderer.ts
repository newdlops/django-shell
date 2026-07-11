// Renderer-side bounded service capture used to construct a workbench-native Monaco editor.

/** Builds low-overhead temporary capture hooks for Monaco editor services created during warmup. */
export function overlayCaptureRendererSource(): string {
  return `
    const __dsoCaptureQueueLimit = 384;
    const __dsoCaptureDeadlineMs = 1500;
    const __dsoForcedCaptureDeadlineMs = 3000;
    const __dsoBroadCaptureMs = 420;
    const __dsoServiceLookupMs = 600;
    const __dsoServiceMapLimit = 8;
    const __dsoServiceEntryLimit = 768;
    const __dsoServiceScanIntervalMs = 80;

    /** Returns whether exact-provenance capture has every value required to construct a workbench editor. */
    function __dsoCaptureReady() {
      const exact = window.__dsoExactCapture || {};
      return !!(exact.widget && exact.ctor && exact.inst && exact.modelSvc);
    }

    /** Records a direct widget or service candidate without enumerating arbitrary object properties. */
    function __dsoCaptureDirect(value, source) {
      const kind = typeof value;
      if (!value || (kind !== "object" && kind !== "function")) { return false; }
      const caps = window.__dsoCaptures;
      const trusted = /^(?:constructor|construct|constructArg|registryWidget|registryWidgetInst|registryInst|registryModelSvc)$/.test(String(source || ""));
      const exact = window.__dsoExactCapture || (window.__dsoExactCapture = {});
      let captured = false;
      if (kind === "function") {
        try { if (value.prototype && __dsoIsWidget(value.prototype)) { __dsoRemember(caps.ctors, value, 8); if (trusted) { window.__dsoPreferredCtor = value; exact.ctor = value; } captured = true; } } catch (eCaptureCtor) {}
        return captured;
      }
      if (__dsoIsLiveWidget(value)) {
        const fresh = caps.widgets.indexOf(value) < 0;
        __dsoRemember(caps.widgets, value, 40);
        __dsoRemember(caps.ctors, __dsoRealCtor(value), 8);
        if (trusted) { window.__dsoPreferredCtor = __dsoRealCtor(value); exact.ctor = window.__dsoPreferredCtor; exact.widget = value; }
        try {
          const widgetInst = value._instantiationService;
          if (__dsoIsInst(widgetInst)) {
            __dsoRemember(caps.insts, widgetInst, 24); __dsoRememberInstantiationMaps(widgetInst, trusted);
            if (trusted && !__dsoValidateInst(widgetInst)) { window.__dsoPreferredInst = widgetInst; exact.inst = widgetInst; }
          }
        } catch (eCaptureWidgetInst) {}
        if (fresh) { try { const model = value.getModel && value.getModel(); const URI = model && model.uri && model.uri.constructor; if (URI && typeof URI.parse === "function") { window.__dsoUriCtor = URI; } } catch (eCaptureWidgetUri) {} }
        captured = true;
      }
      if (__dsoIsInst(value)) {
        __dsoRemember(caps.insts, value, 24); __dsoRememberInstantiationMaps(value);
        if (trusted && !__dsoValidateInst(value)) { window.__dsoPreferredInst = value; exact.inst = value; }
        captured = true;
      }
      if (__dsoIsModelSvc(value)) {
        __dsoRemember(caps.modelSvcs, value, 24);
        if (trusted && !__dsoValidateModelSvc(value)) { window.__dsoPreferredModelSvc = value; exact.modelSvc = value; }
        captured = true;
      }
      if (captured) {
        const stats = window.__dsoCaptureStats || (window.__dsoCaptureStats = {});
        stats[source] = (stats[source] || 0) + 1;
      }
      return captured;
    }

    /** Enqueues one raw value without shape checks so collection hooks remain nearly transparent. */
    function __dsoEnqueueCaptureCandidate(value, source, priorityCandidate) {
      const kind = typeof value;
      if (!value || (kind !== "object" && kind !== "function")) { return; }
      if (priorityCandidate) {
        const priority = window.__dsoCapturePriorityValues || (window.__dsoCapturePriorityValues = []);
        if (priority.indexOf(value) < 0 && priority.length < 64) { priority[priority.length] = value; }
      }
      const values = window.__dsoCaptureQueueValues || (window.__dsoCaptureQueueValues = new Array(__dsoCaptureQueueLimit));
      const sources = window.__dsoCaptureQueueSources || (window.__dsoCaptureQueueSources = new Array(__dsoCaptureQueueLimit));
      const write = Number(window.__dsoCaptureQueueWrite || 0);
      const read = Number(window.__dsoCaptureQueueRead || 0);
      if (write - read >= __dsoCaptureQueueLimit) { window.__dsoCaptureQueueDropped = Number(window.__dsoCaptureQueueDropped || 0) + 1; return; }
      const slot = write % __dsoCaptureQueueLimit;
      values[slot] = value; sources[slot] = source;
      window.__dsoCaptureQueueWrite = write + 1;
    }

    /** Queues one candidate after a direct bounded shape check outside collection hot paths. */
    function __dsoQueueCaptureCandidate(value, source) {
      const captured = __dsoCaptureDirect(value, source);
      try { if (value && value.nodeType) { return; } } catch (eCaptureNode) {}
      __dsoEnqueueCaptureCandidate(value, source, captured);
    }

    /** Offers one directly useful hook value without allowing patched collections to recurse. */
    function __dsoCaptureFromHook(value, source) {
      if (window.__dsoCaptureHookDepth) { return; }
      window.__dsoCaptureHookDepth = 1;
      try { __dsoQueueCaptureCandidate(value, source); } finally { window.__dsoCaptureHookDepth = 0; }
    }

    /** Enqueues one noisy collection value without inspecting its shape synchronously. */
    function __dsoCaptureRawFromHook(value, source) {
      if (!window.__dsoCaptureScanActive || window.__dsoCaptureHookDepth) { return; }
      if (Number(window.__dsoCaptureQueueWrite || 0) - Number(window.__dsoCaptureQueueRead || 0) >= __dsoCaptureQueueLimit) { return; }
      window.__dsoCaptureHookDepth = 1;
      try { __dsoEnqueueCaptureCandidate(value, source, false); } finally { window.__dsoCaptureHookDepth = 0; }
    }

    /** Returns an allowlisted DI service identifier without invoking arbitrary proxy keys. */
    function __dsoCapturedServiceId(key) {
      if (typeof key !== "function") { return ""; }
      try { if (!Object.prototype.hasOwnProperty.call(key, "toString")) { return ""; } } catch (eServiceKey) { return ""; }
      let name = "";
      try { name = String(key); } catch (eServiceName) { return ""; }
      return /^(?:editorGroupsService|instantiationService|modelService|codeEditorService|editorService)$/.test(name) ? name : "";
    }

    /** Remembers one ServiceCollection Map, optionally prioritizing a captured widget's own scope. */
    function __dsoRememberServiceMap(map, priority) {
      if (!(map instanceof Map)) { return; }
      const maps = window.__dsoCaptureServiceMaps || (window.__dsoCaptureServiceMaps = []);
      const existing = maps.indexOf(map);
      if (existing >= 0) {
        if (priority && existing > 0) { maps.splice(existing, 1); maps.unshift(map); }
        return;
      }
      if (priority) { maps.unshift(map); if (maps.length > __dsoServiceMapLimit) { maps.pop(); } }
      else if (maps.length < __dsoServiceMapLimit) { maps[maps.length] = map; }
    }

    /** Remembers ServiceCollection entry maps from an instantiation-service parent chain. */
    function __dsoRememberInstantiationMaps(inst, priority) {
      let cursor = inst;
      for (let depth = 0; cursor && depth < 8; depth++) {
        try { __dsoRememberServiceMap(cursor._services && cursor._services._entries, priority); } catch (eInstantiationMap) {}
        try { cursor = cursor._parent; } catch (eInstantiationParent) { break; }
      }
    }

    /** Removes one service from a rejection list after an exact local probe succeeds. */
    function __dsoForgetRejectedService(list, value) {
      if (!list || !value) { return; }
      for (let index = list.length - 1; index >= 0; index--) { if (list[index] === value) { list.splice(index, 1); } }
    }

    /** Records URI support from existing local text models without constructing or disposing a model. */
    function __dsoCaptureModelUris(modelSvc) {
      try {
        const models = modelSvc.getModels();
        if (__dsoCaptureAsyncResult(models)) { return false; }
        if (!Array.isArray(models)) { return false; }
        for (let index = 0; index < Math.min(models.length, 40); index++) {
          const URI = models[index] && models[index].uri && models[index].uri.constructor;
          if (URI && typeof URI.parse === "function") { window.__dsoUriCtor = URI; break; }
        }
        return true;
      } catch (eRegistryModels) { return false; }
    }

    /** Detects and consumes a promise-like service result before it can reject unhandled. */
    function __dsoCaptureAsyncResult(value) {
      let asyncResult = false;
      try { asyncResult = !!(value && typeof value.then === "function"); } catch (eCaptureAsyncProbe) { return true; }
      if (!asyncResult) { return false; }
      try {
        if (typeof value.catch === "function") { void value.catch(function () { return undefined; }); }
        else { void Promise.resolve(value).catch(function () { return undefined; }); }
      } catch (eCaptureAsyncCatch) {}
      return true;
    }

    /** Records actual local CodeEditorWidgets returned by the exact code editor service. */
    function __dsoCaptureEditorList(editors) {
      if (__dsoCaptureAsyncResult(editors)) { return; }
      if (!Array.isArray(editors)) { return; }
      for (let index = 0; index < Math.min(editors.length, 40); index++) { __dsoCaptureDirect(editors[index], "registryWidget"); }
    }

    /** Unwraps only a plain value descriptor and never invokes a service proxy getter. */
    function __dsoCapturedServiceValue(value) {
      if (!value || (typeof value !== "object" && typeof value !== "function")) { return value; }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, "instance");
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") && descriptor.value ? descriptor.value : value;
      } catch (eServiceValue) { return value; }
    }

    /** Captures one allowlisted service value with exact ServiceCollection provenance. */
    function __dsoCaptureExactService(name, value) {
      const exact = window.__dsoExactCapture || (window.__dsoExactCapture = {});
      if (name === "instantiationService" && !__dsoValidateInst(value)) {
        __dsoCaptureDirect(value, "registryInst");
      } else if (name === "modelService") {
        __dsoForgetRejectedService(window.__dsoBadModelSvcs, value);
        if (!__dsoValidateModelSvc(value) && __dsoCaptureModelUris(value)) { __dsoCaptureDirect(value, "registryModelSvc"); }
      } else if (name === "codeEditorService" && __dsoHasMembers(value, ["listCodeEditors"])) {
        try { __dsoCaptureEditorList(value && value.listCodeEditors && value.listCodeEditors()); } catch (eRegistryCodeEditors) {}
      } else if (name === "editorService" && (__dsoHasMembers(value, ["visibleTextEditorControls"]) || __dsoHasMembers(value, ["activeTextEditorControl"]))) {
        try { __dsoCaptureEditorList(value && value.visibleTextEditorControls); } catch (eRegistryVisibleEditors) {}
        try { const active = value && value.activeTextEditorControl; if (!__dsoCaptureAsyncResult(active)) { __dsoCaptureEditorList(active ? [active] : []); } } catch (eRegistryActiveEditor) {}
      }
      if (exact.widget) { try { __dsoCaptureDirect(exact.widget._instantiationService, "registryWidgetInst"); } catch (eRegistryWidgetInst) {} }
    }

    /** Traverses captured service maps with an entry cap and resolves only exact allowlisted identifiers. */
    function __dsoScanCapturedServiceMaps() {
      const maps = window.__dsoCaptureServiceMaps || [];
      if (!maps.length) { return; }
      const now = Date.now();
      if (window.__dsoLastServiceMapScanAt && now - window.__dsoLastServiceMapScanAt < __dsoServiceScanIntervalMs) { return; }
      window.__dsoLastServiceMapScanAt = now;
      for (let mapIndex = 0; mapIndex < maps.length && !__dsoCaptureReady(); mapIndex++) {
        let inspected = 0;
        try {
          maps[mapIndex].forEach(function (value, key) {
            if (inspected++ >= __dsoServiceEntryLimit) { return; }
            const name = __dsoCapturedServiceId(key);
            const exact = window.__dsoExactCapture || {};
            if (name && !((name === "instantiationService" && exact.inst) || (name === "modelService" && exact.modelSvc) || ((name === "codeEditorService" || name === "editorService") && exact.widget))) { __dsoCaptureExactService(name, __dsoCapturedServiceValue(value)); }
          });
        } catch (eRegistryMap) {}
      }
    }

    /** Inspects a deferred candidate with a strict property and collection-entry budget. */
    function __dsoInspectCaptureCandidate(value, source) {
      if (!value) { return; }
      __dsoCaptureDirect(value, source);
      try { if (value.nodeType) { return; } } catch (eInspectCaptureNode) {}
      let collectionCount = 0;
      try {
        if (value instanceof Map || value instanceof Set) {
          value.forEach(function (item) { if (collectionCount++ < 48) { __dsoQueueCaptureCandidate(item, source + ":collection"); } });
        } else if (Array.isArray(value)) {
          for (let index = 0; index < Math.min(32, value.length); index++) { __dsoQueueCaptureCandidate(value[index], source + ":array"); }
        }
      } catch (eCaptureCollection) {}
      let keys = [];
      try { keys = Object.getOwnPropertyNames(value); } catch (eCaptureKeys) { return; }
      let inspected = 0;
      /** Reads one candidate property while respecting the per-object inspection budget. */
      const inspectKey = function (key) {
        if (inspected >= 48) { return; }
        inspected += 1;
        try { __dsoQueueCaptureCandidate(value[key], source + ":property"); } catch (eCaptureProperty) {}
      };
      for (let index = 0; index < keys.length && inspected < 48; index++) { if (/instanti|model|editor|service|collection|entries/i.test(keys[index])) { inspectKey(keys[index]); } }
      for (let index = 0; index < keys.length && inspected < 48; index++) { if (!/instanti|model|editor|service|collection|entries/i.test(keys[index])) { inspectKey(keys[index]); } }
    }

    /** Drains a small capture batch outside patched collection operations. */
    function __dsoDrainCaptureQueue() {
      const values = window.__dsoCaptureQueueValues || [];
      const sources = window.__dsoCaptureQueueSources || [];
      let read = Number(window.__dsoCaptureQueueRead || 0);
      const write = Number(window.__dsoCaptureQueueWrite || 0);
      let drained = 0;
      while (read < write && drained < 5 && !__dsoCaptureReady()) {
        const slot = read % __dsoCaptureQueueLimit;
        const value = values[slot], source = sources[slot] || "queue";
        values[slot] = undefined; sources[slot] = undefined;
        read += 1; drained += 1;
        window.__dsoCaptureQueueRead = read;
        __dsoInspectCaptureCandidate(value, source);
      }
      window.__dsoCaptureQueueRead = read;
      const priority = window.__dsoCapturePriorityValues || [];
      let priorityRead = Number(window.__dsoCapturePriorityRead || 0);
      while (priorityRead < priority.length && drained < 10 && !__dsoCaptureReady()) {
        const value = priority[priorityRead]; priority[priorityRead] = undefined; priorityRead += 1; drained += 1;
        __dsoInspectCaptureCandidate(value, "priority");
      }
      window.__dsoCapturePriorityRead = priorityRead;
    }

    /** Restores the high-volume collection hooks for one matching broad-capture generation. */
    function __dsoStopBroadCapture(generation, broadGeneration) {
      if (generation !== window.__dsoCaptureGeneration) { return; }
      if (broadGeneration && broadGeneration !== window.__dsoCaptureBroadGeneration) { return; }
      const originals = window.__dsoCaptureOriginals;
      const wrappers = window.__dsoCaptureWrappers;
      if (originals && wrappers) {
        try { if (Map.prototype.set === wrappers.mapSet) { Map.prototype.set = originals.mapSet; } } catch (eRestoreMap) {}
        try { if (WeakMap.prototype.set === wrappers.weakMapSet) { WeakMap.prototype.set = originals.weakMapSet; } } catch (eRestoreWeakMap) {}
        try { if (Set.prototype.add === wrappers.setAdd) { Set.prototype.add = originals.setAdd; } } catch (eRestoreSet) {}
        try { if (Array.prototype.push === wrappers.arrayPush) { Array.prototype.push = originals.arrayPush; } } catch (eRestoreArray) {}
      }
      try { if (window.__dsoCaptureBroadTimer) { window.clearTimeout(window.__dsoCaptureBroadTimer); } } catch (eClearCaptureBroad) {}
      window.__dsoCaptureBroadTimer = 0; window.__dsoCaptureBroadActive = false;
    }

    /** Installs a short collection-capture burst without replacing a newer third-party wrapper. */
    function __dsoStartBroadCapture(generation) {
      if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return; }
      const originals = window.__dsoCaptureOriginals;
      const wrappers = window.__dsoCaptureWrappers;
      if (!originals || !wrappers) { return; }
      const broadGeneration = Number(window.__dsoCaptureBroadGeneration || 0) + 1;
      window.__dsoCaptureBroadGeneration = broadGeneration; window.__dsoCaptureBroadActive = true;
      try { if (window.__dsoCaptureBroadTimer) { window.clearTimeout(window.__dsoCaptureBroadTimer); } } catch (eRestartCaptureBroad) {}
      try { if (Map.prototype.set === originals.mapSet || Map.prototype.set === wrappers.mapSet) { Map.prototype.set = wrappers.mapSet; } } catch (eInstallMap) {}
      try { if (WeakMap.prototype.set === originals.weakMapSet || WeakMap.prototype.set === wrappers.weakMapSet) { WeakMap.prototype.set = wrappers.weakMapSet; } } catch (eInstallWeakMap) {}
      try { if (Set.prototype.add === originals.setAdd || Set.prototype.add === wrappers.setAdd) { Set.prototype.add = wrappers.setAdd; } } catch (eInstallSet) {}
      try { if (Array.prototype.push === originals.arrayPush || Array.prototype.push === wrappers.arrayPush) { Array.prototype.push = wrappers.arrayPush; } } catch (eInstallArray) {}
      window.__dsoCaptureBroadTimer = window.setTimeout(function () { __dsoStopBroadCapture(generation, broadGeneration); }, __dsoBroadCaptureMs);
    }

    /** Restores the targeted Map.get service-lookup hook for one capture generation. */
    function __dsoStopServiceLookup(generation) {
      if (generation !== window.__dsoCaptureGeneration) { return; }
      const originals = window.__dsoCaptureOriginals;
      const wrappers = window.__dsoCaptureWrappers;
      try { if (originals && wrappers && Map.prototype.get === wrappers.mapGet) { Map.prototype.get = originals.mapGet; } } catch (eRestoreMapGet) {}
      try { if (window.__dsoServiceLookupTimer) { window.clearTimeout(window.__dsoServiceLookupTimer); } } catch (eClearServiceLookup) {}
      window.__dsoServiceLookupTimer = 0;
    }

    /** Rearms only the targeted DI Map lookup hook for one active capture generation. */
    function __dsoStartServiceLookup(generation) {
      if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return false; }
      const originals = window.__dsoCaptureOriginals, wrappers = window.__dsoCaptureWrappers;
      if (!originals || !wrappers) { return false; }
      try { if (window.__dsoServiceLookupTimer) { window.clearTimeout(window.__dsoServiceLookupTimer); } } catch (eRestartServiceLookup) {}
      try { if (Map.prototype.get === originals.mapGet || Map.prototype.get === wrappers.mapGet) { Map.prototype.get = wrappers.mapGet; } } catch (eInstallMapGet) { return false; }
      window.__dsoServiceLookupTimer = window.setTimeout(function () { __dsoStopServiceLookup(generation); }, __dsoServiceLookupMs);
      return Map.prototype.get === wrappers.mapGet;
    }

    /** Restores all temporary built-ins for one matching capture generation. */
    function __dsoStopCapture(generation) {
      if (generation && generation !== window.__dsoCaptureGeneration) { return; }
      const activeGeneration = Number(window.__dsoCaptureGeneration || 0);
      __dsoStopBroadCapture(activeGeneration);
      __dsoStopServiceLookup(activeGeneration);
      const originals = window.__dsoCaptureOriginals;
      const wrappers = window.__dsoCaptureWrappers;
      if (originals && wrappers) {
        try { if (Reflect.construct === wrappers.reflectConstruct) { Reflect.construct = originals.reflectConstruct; } } catch (eRestoreReflect) {}
      }
      try { if (window.__dsoCaptureTickTimer) { window.clearTimeout(window.__dsoCaptureTickTimer); } } catch (eClearCaptureTick) {}
      try { if (window.__dsoCaptureDeadlineTimer) { window.clearTimeout(window.__dsoCaptureDeadlineTimer); } } catch (eClearCaptureDeadline) {}
      window.__dsoCaptureTickTimer = 0; window.__dsoCaptureDeadlineTimer = 0;
      window.__dsoCaptureOriginals = null; window.__dsoCaptureWrappers = null; window.__dsoCaptureScanActive = false;
      window.__dsoCaptureForced = false;
      window.__dsoCaptureQueueValues = []; window.__dsoCaptureQueueSources = []; window.__dsoCaptureQueueRead = 0; window.__dsoCaptureQueueWrite = 0;
      window.__dsoCapturePriorityValues = []; window.__dsoCapturePriorityRead = 0;
      window.__dsoCaptureServiceMaps = [];
    }

    /** Runs one deferred capture tick and stops immediately when the factory is complete. */
    function __dsoCaptureTick(generation) {
      if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return; }
      const tick = Number(window.__dsoCaptureTickCount || 0) + 1;
      window.__dsoCaptureTickCount = tick;
      __dsoScanCapturedServiceMaps();
      __dsoDrainCaptureQueue();
      if (__dsoCaptureReady()) { __dsoStopCapture(generation); return; }
      window.__dsoCaptureTickTimer = window.setTimeout(function () { __dsoCaptureTick(generation); }, 16);
    }

    /** Installs short-lived low-cost hooks only while the warmup editor is being constructed. */
    function __dsoStartCapture(force) {
      if (!force && __dsoCaptureReady()) { return; }
      if (window.__dsoCaptureScanActive) {
        if (!force) { return; }
        __dsoStopCapture(window.__dsoCaptureGeneration);
      }
      if (force) {
        const caps = window.__dsoCaptures || {};
        if (caps.widgets) { caps.widgets.length = 0; } if (caps.insts) { caps.insts.length = 0; }
        if (caps.modelSvcs) { caps.modelSvcs.length = 0; } if (caps.ctors) { caps.ctors.length = 0; }
        window.__dsoPreferredCtor = null; window.__dsoPreferredInst = null; window.__dsoPreferredModelSvc = null;
        if (window.__dsoBadInsts) { window.__dsoBadInsts.length = 0; } if (window.__dsoGoodInsts) { window.__dsoGoodInsts.length = 0; }
        if (window.__dsoBadModelSvcs) { window.__dsoBadModelSvcs.length = 0; } if (window.__dsoGoodModelSvcs) { window.__dsoGoodModelSvcs.length = 0; }
        window.__dsoExactCapture = {}; window.__dsoSniffedWidgets = typeof WeakSet !== "undefined" ? new WeakSet() : null;
        window.__dsoWidgetCache = typeof WeakMap !== "undefined" ? new WeakMap() : null; window.__dsoLastDomCaptureScanAt = 0; window.__dsoLastServiceMapScanAt = 0;
        window.__dsoSkipWorkbenchEditor = false;
      }
      const generation = Number(window.__dsoCaptureGeneration || 0) + 1;
      window.__dsoCaptureGeneration = generation; window.__dsoCaptureScanActive = true; window.__dsoCaptureForced = !!force; window.__dsoCaptureTickCount = 0;
      window.__dsoCaptureQueueValues = new Array(__dsoCaptureQueueLimit); window.__dsoCaptureQueueSources = new Array(__dsoCaptureQueueLimit); window.__dsoCaptureQueueRead = 0; window.__dsoCaptureQueueWrite = 0; window.__dsoCaptureQueueDropped = 0;
      window.__dsoCapturePriorityValues = []; window.__dsoCapturePriorityRead = 0;
      window.__dsoCaptureServiceMaps = [];
      const originals = { arrayPush: Array.prototype.push, mapGet: Map.prototype.get, mapSet: Map.prototype.set, reflectConstruct: Reflect.construct, setAdd: Set.prototype.add, weakMapSet: WeakMap.prototype.set };
      const wrappers = {};
      wrappers.mapGet = function (key) { const result = originals.mapGet.call(this, key); if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return result; } try { if (__dsoCapturedServiceId(key)) { __dsoRememberServiceMap(this); } } catch (eCaptureMapGet) {} return result; };
      wrappers.mapSet = function (key, value) { const result = originals.mapSet.call(this, key, value); if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return result; } try { __dsoCaptureFromHook(value, "map"); } catch (eCaptureMap) {} return result; };
      wrappers.weakMapSet = function (key, value) { const result = originals.weakMapSet.call(this, key, value); if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return result; } try { __dsoCaptureRawFromHook(value, "weakMap"); } catch (eCaptureWeakMap) {} return result; };
      wrappers.setAdd = function (value) { const result = originals.setAdd.call(this, value); if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return result; } try { __dsoCaptureRawFromHook(value, "set"); } catch (eCaptureSet) {} return result; };
      wrappers.arrayPush = function () { const result = originals.arrayPush.apply(this, arguments); if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return result; } try { for (let index = 0; index < arguments.length; index++) { __dsoCaptureRawFromHook(arguments[index], "array"); } } catch (eCaptureArray) {} return result; };
      wrappers.reflectConstruct = function () {
        if (generation !== window.__dsoCaptureGeneration || !window.__dsoCaptureScanActive) { return originals.reflectConstruct.apply(Reflect, arguments); }
        const target = arguments[0], args = arguments[1];
        let widgetConstructor = false;
        try {
          widgetConstructor = !!(target && target.prototype && __dsoIsWidget(target.prototype));
          if (widgetConstructor) { __dsoCaptureFromHook(target, "constructor"); __dsoStartBroadCapture(generation); }
        } catch (eCaptureBeforeConstruct) {}
        const result = originals.reflectConstruct.apply(Reflect, arguments);
        try {
          if (widgetConstructor) {
            __dsoCaptureFromHook(result, "construct");
            const count = Math.min(48, args && Number(args.length) || 0);
            for (let index = 0; index < count; index++) { __dsoCaptureFromHook(args[index], "constructArg"); }
          }
        } catch (eCaptureConstruct) {}
        return result;
      };
      window.__dsoCaptureOriginals = originals; window.__dsoCaptureWrappers = wrappers;
      try { if (Reflect.construct === originals.reflectConstruct) { Reflect.construct = wrappers.reflectConstruct; } if (Map.prototype.get === originals.mapGet) { Map.prototype.get = wrappers.mapGet; } } catch (error) { window.__dsoCaptureStartError = String(error && error.message || error); }
      __dsoStartServiceLookup(generation);
      window.__dsoCaptureDeadlineTimer = window.setTimeout(function () { __dsoStopCapture(generation); }, force ? __dsoForcedCaptureDeadlineMs : __dsoCaptureDeadlineMs);
      window.__dsoCaptureTickTimer = window.setTimeout(function () { __dsoCaptureTick(generation); }, 0);
    }
  `;
}
