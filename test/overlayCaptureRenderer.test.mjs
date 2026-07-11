// Unit tests for bounded workbench Monaco service capture during warmup.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { overlayCaptureRendererSource } = require("../out/workbenchOverlayCaptureRenderer.js");

/** Creates an isolated renderer realm with controllable capture timers. */
function captureHarness() {
  const timers = [];
  let timerId = 0;
  const sandbox = {
    clearTimeout(id) { const timer = timers.find((item) => item.id === id); if (timer) { timer.cleared = true; } },
    setTimeout(callback, delay) { const timer = { callback, cleared: false, delay, id: ++timerId }; timers.push(timer); return timer.id; }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    window = globalThis;
    window.__dsoCaptures = { widgets: [], insts: [], modelSvcs: [], ctors: [] };
    window.__dsoBadModelSvcs = []; window.__dsoGoodModelSvcs = [];
    function __dsoHasMembers(value, names) {
      if (!value) { return false; }
      const found = Object.create(null);
      let cursor = value;
      for (let depth = 0; cursor && depth < 12; depth++) {
        let keys = [];
        try { keys = Object.getOwnPropertyNames(cursor); } catch (error) { return false; }
        for (let index = 0; index < names.length; index++) { if (keys.indexOf(names[index]) >= 0) { found[names[index]] = true; } }
        try { cursor = Object.getPrototypeOf(cursor); } catch (error) { break; }
      }
      return names.every(function (name) { return !!found[name]; });
    }
    function __dsoIsWidget(value) { return __dsoHasMembers(value, ["layout", "getModel", "getDomNode"]); }
    function __dsoIsLiveWidget(value) {
      if (!__dsoIsWidget(value)) { return false; }
      try {
        const node = value.getDomNode();
        return !!(node && typeof node.then !== "function" && (node.nodeType === 1 || typeof node.tagName === "string"));
      } catch (error) { return false; }
    }
    function __dsoIsInst(value) { return __dsoHasMembers(value, ["createInstance", "invokeFunction"]) && !__dsoHasMembers(value, ["createModel", "getModel"]); }
    function __dsoIsModelSvc(value) { return __dsoHasMembers(value, ["createModel", "getModel", "getModels"]) && (__dsoHasMembers(value, ["onModelAdded"]) || __dsoHasMembers(value, ["onModelRemoved"]) || __dsoHasMembers(value, ["destroyModel"])); }
    function __dsoValidateInst(value) {
      if (!__dsoIsInst(value)) { return "missing-inst"; }
      try { value.invokeFunction(function () { return true; }); return ""; } catch (error) { return "bad-inst"; }
    }
    function __dsoValidateModelSvc(value) {
      if (!__dsoIsModelSvc(value) || window.__dsoBadModelSvcs.indexOf(value) >= 0) { return "missing-modelSvc"; }
      try {
        const models = value.getModels();
        if (!Array.isArray(models)) { window.__dsoBadModelSvcs.push(value); return "bad-modelSvc"; }
        if (window.__dsoGoodModelSvcs.indexOf(value) < 0) { window.__dsoGoodModelSvcs.push(value); }
        return "";
      } catch (error) { window.__dsoBadModelSvcs.push(value); return "bad-modelSvc"; }
    }
    function __dsoRemember(list, value, limit) { if (value && list.indexOf(value) < 0 && list.length < limit) { list[list.length] = value; } }
    function __dsoRealCtor(widget) { return widget && widget.constructor; }
    function __dsoScanDom() {}
    const __dsoOriginalGetOwnPropertyNames = Object.getOwnPropertyNames;
    window.__dsoOwnPropertyReads = 0;
    Object.getOwnPropertyNames = function (value) { window.__dsoOwnPropertyReads += 1; return __dsoOriginalGetOwnPropertyNames(value); };
    ${overlayCaptureRendererSource()}
    window.__captureApi = {
      originals: { arrayPush: Array.prototype.push, mapGet: Map.prototype.get, mapSet: Map.prototype.set, reflectConstruct: Reflect.construct, setAdd: Set.prototype.add, weakMapSet: WeakMap.prototype.set },
      ready: __dsoCaptureReady,
      rearmServiceLookup: __dsoStartServiceLookup,
      start: __dsoStartCapture,
      stop: __dsoStopCapture
    };
  `, context);
  return {
    context,
    evaluate(expression) { return vm.runInContext(expression, context); },
    runTimer(timer) { if (!timer.cleared) { timer.cleared = true; timer.callback(); } },
    timers
  };
}

/** Returns the latest active timer with the requested delay. */
function activeTimer(harness, delay) {
  return [...harness.timers].reverse().find((timer) => !timer.cleared && timer.delay === delay);
}

test("temporary capture hooks restore at their hard deadline and ignore stale generations", () => {
  const harness = captureHarness();
  harness.evaluate("__captureApi.start()");
  assert.equal(harness.evaluate("Array.prototype.push === __captureApi.originals.arrayPush"), true, "exact lookup leaves high-volume hooks dormant");
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), false);
  const generationOne = harness.evaluate("window.__dsoCaptureGeneration");
  const firstWrapper = harness.evaluate("Map.prototype.get");
  const firstDeadline = activeTimer(harness, 1500);
  assert.ok(firstDeadline);

  harness.evaluate("__captureApi.start()");
  assert.equal(harness.evaluate("window.__dsoCaptureGeneration"), generationOne, "an active start is idempotent");
  assert.equal(harness.evaluate("Map.prototype.get"), firstWrapper);
  harness.runTimer(firstDeadline);
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), true);
  assert.equal(harness.evaluate("window.__dsoCaptureScanActive"), false);

  harness.evaluate("__captureApi.start()");
  assert.equal(harness.evaluate("window.__dsoCaptureGeneration"), generationOne + 1);
  firstDeadline.callback();
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), false, "an old deadline cannot stop the new generation");
  harness.runTimer(activeTimer(harness, 1500));
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), true);
});

test("targeted service lookup can be briefly rearmed for the fallback generation", () => {
  const harness = captureHarness();
  harness.evaluate("__captureApi.start(true)");
  const generation = harness.evaluate("window.__dsoCaptureGeneration");
  harness.runTimer(activeTimer(harness, 600));
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), true);
  assert.equal(harness.evaluate(`__captureApi.rearmServiceLookup(${generation})`), true);
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), false);
  assert.equal(harness.evaluate(`__captureApi.rearmServiceLookup(${generation - 1})`), false);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
});

test("trusted constructor capture records exact live services without invoking dynamic proxy methods", () => {
  const harness = captureHarness();
  harness.evaluate(`
    function Widget(inst) { this._instantiationService = inst; }
    Widget.prototype.layout = function () {};
    Widget.prototype.getModel = function () { return { uri: new URI("file:///warmup.py") }; };
    Widget.prototype.getDomNode = function () { return { nodeType: 1 }; };
    function URI(value) { this.value = value; }
    URI.parse = function (value) { return new URI(value); };
    window.__inst = { createInstance: function () {}, invokeFunction: function () {} };
    window.__modelSvc = { createModel: function () {}, getModel: function () {}, getModels: function () { return [{ uri: new URI("file:///source.py") }]; }, onModelAdded: function () {} };
    window.__widget = new Widget(); window.__widget._instantiationService = window.__inst;
  `);
  harness.evaluate("__captureApi.start(); window.__dsoOwnPropertyReads = 0");
  const result = harness.evaluate(`
    const values = [];
    const pushResult = values.push(window.__inst, window.__modelSvc, window.__widget, { opaque: true });
    const createdWidget = Reflect.construct(Widget, [window.__inst, window.__modelSvc]);
    const constructed = Reflect.construct(function Example(value) { this.value = value; }, [7]);
    window.__createdWidget = createdWidget;
    ({ constructed: constructed.value, length: values.length, pushResult: pushResult });
  `);
  assert.deepEqual({ ...result }, { constructed: 7, length: 4, pushResult: 4 });
  assert.equal(harness.evaluate("window.__dsoCaptures.widgets.includes(window.__createdWidget)"), true);
  assert.equal(harness.evaluate("window.__dsoCaptures.insts.includes(window.__inst)"), true);
  assert.equal(harness.evaluate("window.__dsoCaptures.modelSvcs.includes(window.__modelSvc)"), true);
  assert.ok(harness.evaluate("window.__dsoCaptures.ctors.length") >= 1);
  assert.equal(harness.evaluate("__captureApi.ready()"), true, "constructor provenance promotes the complete exact capture");
  harness.runTimer(activeTimer(harness, 0));
  assert.equal(harness.evaluate("Array.prototype.push === __captureApi.originals.arrayPush"), true, "exact readiness stops on its first deferred tick");
});

test("legacy raw candidate counts cannot terminate capture without exact provenance", () => {
  const harness = captureHarness();
  harness.evaluate(`
    window.__dsoCaptures.widgets[0] = { stale: "widget" };
    window.__dsoCaptures.insts[0] = { stale: "inst" };
    window.__dsoCaptures.modelSvcs[0] = { stale: "model" };
    window.__dsoCaptures.ctors[0] = function StaleCtor() {};
    __captureApi.start();
  `);
  assert.equal(harness.evaluate("__captureApi.ready()"), false);
  harness.runTimer(activeTimer(harness, 0));
  assert.equal(harness.evaluate("window.__dsoCaptureScanActive"), true, "raw counts cannot stop the capture tick");
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), false);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
});

test("non-widget Reflect construction cannot promote nested raw candidates to exact provenance", () => {
  const harness = captureHarness();
  harness.evaluate(`
    function Widget() {}
    Widget.prototype.layout = function () {};
    Widget.prototype.getModel = function () { return null; };
    Widget.prototype.getDomNode = function () { return { nodeType: 1 }; };
    window.__rawInst = { createInstance: function () {}, invokeFunction: function (callback) { return callback({}); } };
    window.__rawModelSvc = { createModel: function () {}, getModel: function () {}, getModels: function () { return []; }, onModelAdded: function () {} };
    window.__rawWidget = new Widget();
    function UnrelatedContainer() { this.editor = window.__rawWidget; this.instantiationService = window.__rawInst; this.modelService = window.__rawModelSvc; }
    __captureApi.start();
    Reflect.construct(UnrelatedContainer, []);
  `);
  for (let attempt = 0; attempt < 20; attempt++) {
    const timer = activeTimer(harness, attempt === 0 ? 0 : 16) || activeTimer(harness, 16);
    if (!timer) { break; }
    harness.runTimer(timer);
  }
  assert.equal(harness.evaluate("__captureApi.ready()"), false);
  assert.equal(harness.evaluate("Object.keys(window.__dsoExactCapture || {}).length"), 0);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
});

test("generic and exact service capture reject dynamic RPC and lazy-service proxies", () => {
  const harness = captureHarness();
  harness.evaluate(`
    window.__rpcAccesses = [];
    window.__rpcProxy = new Proxy({}, {
      get: function (target, key) { window.__rpcAccesses.push(String(key)); return key === "nodeType" || key === "instance" ? undefined : function () { window.__rpcAccesses.push(String(key) + ":invoke"); }; }
    });
    window.__lazyInvocations = 0;
    window.__asyncResultHandled = false;
    window.__lazyCodeEditors = new Proxy({}, {
      get: function (target, key) {
        if (key === "instance") { return undefined; }
        if (key === "listCodeEditors") { return function () { window.__lazyInvocations += 1; return []; }; }
        return undefined;
      }
    });
    window.__asyncCodeEditors = { listCodeEditors: function () { return { then: function () {}, catch: function () { window.__asyncResultHandled = true; return this; } }; } };
    function serviceId(name) { const key = function () {}; Object.defineProperty(key, "toString", { value: function () { return name; } }); return key; }
    window.__editorGroupsId = serviceId("editorGroupsService");
    window.__codeEditorsId = serviceId("codeEditorService");
    window.__asyncCodeEditorsId = serviceId("codeEditorService");
    window.__serviceMap = new Map([[window.__editorGroupsId, {}], [window.__codeEditorsId, window.__lazyCodeEditors], [window.__asyncCodeEditorsId, window.__asyncCodeEditors]]);
    __captureApi.start();
    const values = []; values.push(window.__rpcProxy);
    window.__serviceMap.get(window.__editorGroupsId);
  `);
  harness.runTimer(activeTimer(harness, 0));
  assert.equal(harness.evaluate("window.__dsoCaptures.widgets.length"), 0);
  assert.equal(harness.evaluate("window.__dsoCaptures.modelSvcs.length"), 0);
  assert.equal(harness.evaluate("window.__rpcAccesses.includes('getModel:invoke') || window.__rpcAccesses.includes('getDomNode:invoke')"), false);
  assert.equal(harness.evaluate("window.__lazyInvocations"), 0, "an exact service id still cannot make a synthetic proxy callable");
  assert.equal(harness.evaluate("window.__asyncResultHandled"), true, "promise-like editor-service results have their rejection consumed");
  assert.equal(harness.evaluate("__captureApi.ready()"), false);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
  assert.equal(harness.evaluate("Map.prototype.get === __captureApi.originals.mapGet"), true);
});

test("ordinary maps with service-like string keys cannot consume exact-map capacity", () => {
  const harness = captureHarness();
  harness.evaluate(`
    __captureApi.start();
    for (let index = 0; index < 20; index++) { new Map([["editorGroupsService", index]]).get("editorGroupsService"); }
  `);
  assert.equal(harness.evaluate("window.__dsoCaptureServiceMaps.length"), 0);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
});

test("exact service-map lookup recovers an existing editor without Reflect construction and restores every hook", () => {
  const harness = captureHarness();
  harness.evaluate(`
    function URI(value) { this.value = value; }
    URI.parse = function (value) { return new URI(value); };
    function Widget(inst) { this._instantiationService = inst; }
    Widget.prototype.layout = function () {};
    Widget.prototype.getModel = function () { return { uri: new URI("file:///existing.py") }; };
    Widget.prototype.getDomNode = function () { return { nodeType: 1 }; };
    window.__rootInst = { createInstance: function () {}, invokeFunction: function (callback) { return callback({}); } };
    window.__widgetInst = { createInstance: function () {}, invokeFunction: function (callback) { return callback({}); } };
    window.__modelSvc = { createModel: function () {}, getModel: function () {}, getModels: function () { return [{ uri: new URI("file:///existing.py") }]; }, onModelAdded: function () {} };
    window.__existingWidget = new Widget(window.__widgetInst);
    window.__codeEditorSvc = { listCodeEditors: function () { return [window.__existingWidget]; } };
    function serviceId(name) { const key = function () {}; Object.defineProperty(key, "toString", { value: function () { return name; } }); return key; }
    window.__editorGroupsId = serviceId("editorGroupsService");
    window.__instId = serviceId("instantiationService");
    window.__modelId = serviceId("modelService");
    window.__codeEditorsId = serviceId("codeEditorService");
    const entries = [[window.__editorGroupsId, {}]];
    for (let index = 0; index < 100; index++) { entries.push(["noise-" + index, { index: index }]); }
    entries.push([window.__instId, window.__rootInst], [window.__modelId, window.__modelSvc], [window.__codeEditorsId, window.__codeEditorSvc]);
    window.__serviceMap = new Map(entries);
    __captureApi.start();
    window.__serviceMap.get(window.__editorGroupsId);
  `);
  assert.equal(harness.evaluate("window.__dsoCaptureStats && window.__dsoCaptureStats.construct"), undefined, "the existing widget path needs no constructor event");
  harness.runTimer(activeTimer(harness, 0));
  assert.equal(harness.evaluate("window.__dsoExactCapture.widget === window.__existingWidget"), true);
  assert.equal(harness.evaluate("window.__dsoExactCapture.inst === window.__widgetInst"), true, "the widget-scoped instantiation service overrides the registry root");
  assert.equal(harness.evaluate("window.__dsoExactCapture.modelSvc === window.__modelSvc"), true);
  assert.equal(harness.evaluate("__captureApi.ready()"), true);
  for (const comparison of [
    "Array.prototype.push === __captureApi.originals.arrayPush",
    "Map.prototype.get === __captureApi.originals.mapGet",
    "Map.prototype.set === __captureApi.originals.mapSet",
    "WeakMap.prototype.set === __captureApi.originals.weakMapSet",
    "Set.prototype.add === __captureApi.originals.setAdd",
    "Reflect.construct === __captureApi.originals.reflectConstruct"
  ]) {
    assert.equal(harness.evaluate(comparison), true, `${comparison} should be restored`);
  }
});

test("high-volume hooks stay dormant until widget construction and expire after one burst", () => {
  const harness = captureHarness();
  harness.evaluate(`
    function Widget() {}
    Widget.prototype.layout = function () {};
    Widget.prototype.getModel = function () { return null; };
    Widget.prototype.getDomNode = function () { return null; };
    window.__Widget = Widget;
  `);
  harness.evaluate("__captureApi.start()");
  const reflectWrapper = harness.evaluate("Reflect.construct");
  assert.equal(activeTimer(harness, 420), undefined);
  assert.equal(harness.evaluate("Array.prototype.push === __captureApi.originals.arrayPush"), true, "normal capture does not patch hot collections");
  assert.equal(harness.evaluate("Reflect.construct"), reflectWrapper, "the low-volume constructor hook stays armed");

  harness.evaluate("Reflect.construct(window.__Widget, [])");
  assert.equal(harness.evaluate("Array.prototype.push === __captureApi.originals.arrayPush"), false, "widget construction starts a fresh broad burst");
  harness.runTimer(activeTimer(harness, 420));
  assert.equal(harness.evaluate("Array.prototype.push === __captureApi.originals.arrayPush"), true);
  harness.evaluate("__captureApi.stop(window.__dsoCaptureGeneration)");
  assert.equal(harness.evaluate("Reflect.construct === __captureApi.originals.reflectConstruct"), true);
});

test("capture restoration preserves newer wrappers and original constructor exceptions", () => {
  const harness = captureHarness();
  harness.evaluate("__captureApi.start()");
  assert.equal(harness.evaluate(`
    window.__marker = new Error("constructor-marker");
    try { Reflect.construct(function Broken() { throw window.__marker; }, []); false; }
    catch (error) { error === window.__marker; }
  `), true);
  harness.evaluate(`
    window.__delegatedPush = Array.prototype.push;
    window.__foreignPush = function () { return window.__delegatedPush.apply(this, arguments); };
    Array.prototype.push = window.__foreignPush;
    __captureApi.stop(window.__dsoCaptureGeneration);
  `);
  assert.equal(harness.evaluate("Array.prototype.push === window.__foreignPush"), true, "stop never overwrites a newer owner");
  assert.equal(harness.evaluate("window.__dsoCaptureQueueWrite"), 0);
  assert.equal(harness.evaluate("const values = []; values.push({ afterStop: true }); values.length"), 1);
  assert.equal(harness.evaluate("window.__dsoCaptureQueueWrite"), 0, "a chained stale wrapper becomes a transparent pass-through");
  assert.equal(harness.evaluate("Reflect.construct === __captureApi.originals.reflectConstruct"), true);
});

test("forced warmup capture drops stale candidates and uses its longer acknowledgment lease", () => {
  const harness = captureHarness();
  harness.evaluate(`
    window.__dsoCaptures.ctors[0] = function StaleWidget() {};
    window.__dsoCaptures.insts[0] = { createInstance: function () {}, invokeFunction: function () {} };
    window.__dsoCaptures.modelSvcs[0] = { createModel: function () {}, getModel: function () {}, getModels: function () {} };
    window.__dsoBadInsts = [{}]; window.__dsoGoodInsts = [{}]; window.__dsoBadModelSvcs = [{}]; window.__dsoGoodModelSvcs = [{}];
    __captureApi.start(true);
  `);
  assert.equal(harness.evaluate("window.__dsoCaptures.ctors.length"), 0);
  assert.equal(harness.evaluate("window.__dsoCaptures.insts.length"), 0);
  assert.equal(harness.evaluate("window.__dsoCaptures.modelSvcs.length"), 0);
  assert.equal(harness.evaluate("window.__dsoBadInsts.length + window.__dsoGoodInsts.length + window.__dsoBadModelSvcs.length + window.__dsoGoodModelSvcs.length"), 0);
  assert.ok(activeTimer(harness, 600), "targeted service lookup uses a short lease and can be explicitly rearmed for fallback");
  assert.ok(activeTimer(harness, 3000));
  harness.runTimer(activeTimer(harness, 3000));
  assert.equal(harness.evaluate("Reflect.construct === __captureApi.originals.reflectConstruct"), true);
});
