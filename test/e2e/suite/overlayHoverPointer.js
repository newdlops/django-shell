// Real renderer-pointer E2E checks for detached overlay hover panels.

const assert = require("node:assert/strict");
const vscode = require("vscode");

const HOVER_SELECTOR = ".monaco-resizable-hover,.monaco-hover,.monaco-editor-hover";

/** Verifies a mouse-triggered hover survives the editor-to-body-portal pointer handoff. */
async function assertOverlayHoverPointerHandoff(extension) {
  await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
  await dispatchOverlayMouse([{ x: 6, y: 6 }], "initial mouse reset");
  await delay(650);

  const symbol = await waitForSymbolGeometry(extension, "Company", "company = Company()");
  assert.equal(symbol.targetInsideEditor, true, `symbol coordinate must hit the overlay editor: ${JSON.stringify(symbol)}`);
  const symbolPoint = centerPoint(symbol.symbolRect);
  await dispatchOverlayMouse(pointerPath({ x: Math.max(2, symbolPoint.x - 24), y: symbolPoint.y }, symbolPoint), "symbol hover");

  const shown = await waitForPortalHover(extension);
  assert.equal(shown.portalContainsHover, true, `mouse hover must render in the overlay body portal: ${JSON.stringify(shown)}`);
  assert.ok(shown.entryPoint, `mouse hover must expose a hit-testable panel point: ${JSON.stringify(shown)}`);

  await dispatchOverlayMouse(pointerPath(symbolPoint, shown.entryPoint), "symbol-to-hover handoff");
  await delay(850);
  const after = JSON.parse(await evalInWorkbench(extension, hoverStateExpression(shown.entryPoint)));
  assert.equal(after.visible, true, `hover was dismissed while the pointer entered its panel: before=${JSON.stringify(shown)} after=${JSON.stringify(after)}`);
  assert.equal(after.portalContainsHover, true, `surviving hover left the owner portal: ${JSON.stringify(after)}`);
  assert.equal(after.pointerInsideHover, true, `renderer pointer did not land inside the surviving hover: ${JSON.stringify(after)}`);
  assert.equal(after.keeperHeld, true, `detached hover keeper was not held inside the portal: ${JSON.stringify(after)}`);
  assert.equal(after.keeperPointerInside, true, `detached hover keeper missed the portal pointer: ${JSON.stringify(after)}`);

  const resizeReady = JSON.parse(await evalInWorkbench(extension, hoverStateExpression(shown.entryPoint)));
  assert.ok(resizeReady.resizePoint, `hover must expose a hit-testable enabled resize sash: ${JSON.stringify(resizeReady)}`);
  await dispatchOverlayMouse(pointerPath(shown.entryPoint, resizeReady.resizePoint), "hover resize sash entry");
  await delay(120);
  const resizeBefore = JSON.parse(await evalInWorkbench(extension, hoverStateExpression(resizeReady.resizePoint)));
  assert.equal(resizeBefore.pointerInsideResizeSash, true, `renderer pointer did not land on the enabled resize sash: ${JSON.stringify(resizeBefore)}`);
  const dragPoint = resizeDragPoint(resizeBefore);
  const dragMoves = pointerPath(resizeBefore.resizePoint, dragPoint).slice(1).map((point) => ({ ...point, action: "move" }));
  await dispatchOverlayMouse([{ ...resizeBefore.resizePoint, action: "down" }, ...dragMoves, { ...dragPoint, action: "up" }], "hover resize drag");
  await delay(850);

  const resized = JSON.parse(await evalInWorkbench(extension, hoverStateExpression(dragPoint)));
  assert.equal(resized.visible, true, `hover was dismissed while its sash was being resized: before=${JSON.stringify(resizeBefore)} after=${JSON.stringify(resized)}`);
  assert.equal(resized.hoverToken, resizeBefore.hoverToken, `resize replaced the original hover instead of preserving it: ${JSON.stringify(resized)}`);
  const dimensionDelta = resizeBefore.resizeAxis === "vertical" ? Math.abs(resized.hoverRect.width - resizeBefore.hoverRect.width) : Math.abs(resized.hoverRect.height - resizeBefore.hoverRect.height);
  assert.ok(dimensionDelta >= 12, `native sash drag did not resize the surviving hover: delta=${dimensionDelta} before=${JSON.stringify(resizeBefore)} after=${JSON.stringify(resized)}`);
  assert.equal(resized.resizeActive, false, `resize ownership was not released after mouseup: ${JSON.stringify(resized)}`);

  await dispatchOverlayMouse([{ x: 6, y: 6 }], "hover cleanup");
  await evalInWorkbench(extension, `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const controller=editor&&editor.getContribution&&editor.getContribution("editor.contrib.contentHover");controller&&controller.hideContentHover&&controller.hideContentHover();return "hover-cleaned";})()`);
  await delay(550);
}

/** Waits until the visible overlay editor exposes one rendered symbol rectangle. */
async function waitForSymbolGeometry(extension, symbol, lineFragment) {
  let last = {};
  for (let attempt = 0; attempt < 50; attempt++) {
    last = JSON.parse(await evalInWorkbench(extension, symbolGeometryExpression(symbol, lineFragment)));
    if (last.symbolRect) {
      return last;
    }
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await delay(120);
  }
  throw new Error(`Timed out waiting for overlay symbol geometry: ${JSON.stringify(last)}`);
}

/** Waits for a visible, hit-testable Monaco hover inside the overlay-owned body portal. */
async function waitForPortalHover(extension) {
  let last = {};
  for (let attempt = 0; attempt < 80; attempt++) {
    last = JSON.parse(await evalInWorkbench(extension, hoverStateExpression()));
    if (last.visible && last.portalContainsHover && last.entryPoint) {
      return last;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for mouse-triggered overlay hover: ${JSON.stringify(last)}`);
}

/** Dispatches actual Chromium mouse movement through the test-only workbench input bridge. */
async function dispatchOverlayMouse(points, stage) {
  const normalized = points.map(roundPoint);
  const result = await vscode.commands.executeCommand("djangoShell.e2eDispatchOverlayMouse", { points: normalized });
  assert.equal(result?.ok, true, `${stage} CDP mouse dispatch failed: ${JSON.stringify(result)}`);
  assert.deepEqual(result?.points, normalized, `${stage} CDP mouse path changed: ${JSON.stringify(result)}`);
  return result;
}

/** Builds a short physical pointer path between two workbench viewport points. */
function pointerPath(from, to) {
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    x: from.x + ((to.x - from.x) * ratio),
    y: from.y + ((to.y - from.y) * ratio)
  }));
}

/** Returns an inward resize destination whose perpendicular coordinate leaves the old hover boundary. */
function resizeDragPoint(state) {
  const point = state.resizePoint;
  const rect = state.hoverRect;
  const viewport = state.viewport;
  if (state.resizeAxis === "vertical") {
    const shrink = rect.width >= 230;
    const xDirection = state.resizeSide === "east" ? (shrink ? -1 : 1) : (shrink ? 1 : -1);
    const outsideY = rect.bottom + 28 < viewport.height ? rect.bottom + 28 : rect.top - 28;
    return roundPoint({ x: point.x + (48 * xDirection), y: Math.max(4, Math.min(viewport.height - 4, outsideY)) });
  }
  const shrink = rect.height >= 130;
  const yDirection = state.resizeSide === "south" ? (shrink ? -1 : 1) : (shrink ? 1 : -1);
  const outsideX = rect.right + 28 < viewport.width ? rect.right + 28 : rect.left - 28;
  return roundPoint({ x: Math.max(4, Math.min(viewport.width - 4, outsideX)), y: point.y + (40 * yDirection) });
}

/** Returns the center of one viewport rectangle. */
function centerPoint(rect) {
  return roundPoint({ x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) });
}

/** Rounds one renderer point to stable subpixel coordinates. */
function roundPoint(point) {
  const rounded = { x: Math.round(Number(point.x) * 100) / 100, y: Math.round(Number(point.y) * 100) / 100 };
  if (point.action === "down" || point.action === "move" || point.action === "up") { rounded.action = point.action; }
  return rounded;
}

/** Evaluates one expression in the workbench renderer that owns the overlay. */
async function evalInWorkbench(extension, expression) {
  assert.ok(extension?.isActive, "Django Shell extension must be active before renderer evaluation.");
  return vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", expression);
}

/** Builds renderer JavaScript that reveals and measures one overlay symbol. */
function symbolGeometryExpression(symbol, lineFragment) {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}let lineNumber=0,column=0,lineText="";for(let line=1;line<=model.getLineCount();line++){const text=String(model.getLineContent(line)||"");if(text.includes(${JSON.stringify(lineFragment)})){const index=text.indexOf(${JSON.stringify(symbol)},Math.max(0,text.indexOf(${JSON.stringify(lineFragment)})));if(index>=0){lineNumber=line;column=index+1;lineText=text;break;}}}if(!lineNumber){return JSON.stringify({reason:"missing-symbol",text:String(model.getValue&&model.getValue()||"").slice(0,500)});}editor.revealPositionInCenterIfOutsideViewport&&editor.revealPositionInCenterIfOutsideViewport({lineNumber,column});editor.setPosition&&editor.setPosition({lineNumber,column});editor.focus&&editor.focus();await delay(180);const start=editor.getScrolledVisiblePosition&&editor.getScrolledVisiblePosition({lineNumber,column});const end=editor.getScrolledVisiblePosition&&editor.getScrolledVisiblePosition({lineNumber,column:column+${JSON.stringify(symbol.length)}});const editorRect=node.getBoundingClientRect();if(!start){return JSON.stringify({reason:"symbol-not-visible",editorRect:{left:editorRect.left,top:editorRect.top,width:editorRect.width,height:editorRect.height},lineNumber,column});}const width=Math.max(4,end&&Number.isFinite(end.left)?Math.abs(end.left-start.left):${JSON.stringify(symbol.length * 8)});const height=Math.max(8,Number(start.height)||18);const symbolRect={left:editorRect.left+start.left,top:editorRect.top+start.top,right:editorRect.left+start.left+width,bottom:editorRect.top+start.top+height,width,height};const center={x:symbolRect.left+(width/2),y:symbolRect.top+(height/2)};const target=document.elementFromPoint(center.x,center.y);return JSON.stringify({lineNumber,column,lineText,symbolRect,targetClassName:String(target&&target.className||""),targetInsideEditor:!!(target&&node.contains(target))});})()`;
}

/** Builds renderer JavaScript that reports the live owner-portal hover and pointer hit target. */
function hoverStateExpression(pointer) {
  return `(function(){const root=document.getElementById("django-shell-overlay");const portal=root&&root.__dsoWidgetRoot;const visible=(node)=>{if(!node||!node.isConnected){return false;}const style=window.getComputedStyle(node),rect=node.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&style.opacity!=="0"&&rect.width>0&&rect.height>0;};const hovers=portal?Array.from(portal.querySelectorAll(${JSON.stringify(HOVER_SELECTOR)})).filter(visible):[];const hover=hovers.find((node)=>node.classList&&node.classList.contains("monaco-resizable-hover"))||hovers.find((node)=>String(node.textContent||"").trim())||hovers[0]||null;if(hover&&!hover.__dsoE2eHoverToken){window.__dsoE2eHoverToken=(Number(window.__dsoE2eHoverToken)||0)+1;hover.__dsoE2eHoverToken=String(window.__dsoE2eHoverToken);}const rect=hover&&hover.getBoundingClientRect();const candidates=rect?[{x:rect.left+Math.min(18,rect.width/3),y:rect.top+Math.min(18,rect.height/3)},{x:rect.left+(rect.width/2),y:rect.top+(rect.height/2)},{x:rect.right-Math.min(18,rect.width/3),y:rect.bottom-Math.min(18,rect.height/3)}]:[];let entryPoint=null;for(const candidate of candidates){const target=document.elementFromPoint(candidate.x,candidate.y);if(target&&hover.contains(target)){entryPoint={x:Math.round(candidate.x*100)/100,y:Math.round(candidate.y*100)/100};break;}}let resizePoint=null,resizeAxis=null,resizeSide=null,resizeSash=null;const sashes=hover?Array.from(hover.querySelectorAll(".monaco-sash:not(.disabled)")):[];for(const sash of sashes){const sashRect=sash.getBoundingClientRect(),vertical=sash.classList.contains("vertical");const ratios=[0.2,0.5,0.8];for(const ratio of ratios){const candidate=vertical?{x:sashRect.left+(sashRect.width*ratio),y:sashRect.top+(sashRect.height/2)}:{x:sashRect.left+(sashRect.width/2),y:sashRect.top+(sashRect.height*ratio)};const target=document.elementFromPoint(candidate.x,candidate.y);if(target&&(target===sash||sash.contains(target))){resizePoint={x:Math.round(candidate.x*100)/100,y:Math.round(candidate.y*100)/100};resizeAxis=vertical?"vertical":"horizontal";resizeSide=vertical?(candidate.x<rect.left+(rect.width/2)?"west":"east"):(candidate.y<rect.top+(rect.height/2)?"north":"south");resizeSash=sash;break;}}if(resizePoint){break;}}const pointer=${JSON.stringify(pointer || null)};const pointerTarget=pointer&&document.elementFromPoint(pointer.x,pointer.y);return JSON.stringify({visible:!!hover,hoverCount:hovers.length,hoverRect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,hoverToken:hover&&hover.__dsoE2eHoverToken||null,entryPoint,resizePoint,resizeAxis,resizeSide,portalContainsHover:!!(portal&&hover&&portal.contains(hover)),pointerInsideHover:!!(hover&&pointerTarget&&hover.contains(pointerTarget)),pointerInsideResizeSash:!!(resizeSash&&pointerTarget&&(pointerTarget===resizeSash||resizeSash.contains(pointerTarget))),pointerTargetClassName:String(pointerTarget&&pointerTarget.className||""),text:String(hover&&hover.textContent||"").replace(/\\s+/g," ").trim().slice(0,240),keeperHeld:!!(root&&root.__dsoDetachedHoverHeld),keeperPointerInside:!!(root&&root.__dsoDetachedHoverPointerInside),resizeActive:!!(root&&root.__dsoDetachedHoverResizeActive),viewport:{width:window.innerWidth,height:window.innerHeight}});})()`;
}

/** Waits for a short renderer or extension-host interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertOverlayHoverPointerHandoff };
