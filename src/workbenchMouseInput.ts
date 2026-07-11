// Test-only main-process CDP input for the owning VS Code workbench window.

/** Identifies one renderer-space mouse point in CSS pixels. */
export interface WorkbenchMousePoint { action?: "down" | "move" | "up"; x: number; y: number; }

/** Builds a bounded Electron-main expression that moves the real renderer mouse through CDP. */
export function mainProcessMouseInputExpression(windowId: number, rawPoints: WorkbenchMousePoint[]): string {
  const points = rawPoints.slice(0, 32).map((point) => ({
    ...(point?.action === "down" || point?.action === "move" || point?.action === "up" ? { action: point.action } : {}),
    x: Number.isFinite(Number(point?.x)) ? Math.max(0, Math.min(100_000, Number(point.x))) : 0,
    y: Number.isFinite(Number(point?.y)) ? Math.max(0, Math.min(100_000, Number(point.y))) : 0
  }));
  return `
    (async function () {
      const req = typeof require === "function" ? require : (process && process.mainModule && typeof process.mainModule.require === "function" ? process.mainModule.require.bind(process.mainModule) : undefined);
      if (!req) { return { ok: false, reason: "no-main-require" }; }
      const win = req("electron").BrowserWindow.fromId(${JSON.stringify(windowId)});
      if (!win || win.isDestroyed && win.isDestroyed() || !win.webContents || win.webContents.isDestroyed && win.webContents.isDestroyed()) { return { ok: false, reason: "missing-workbench-window" }; }
      const points = ${JSON.stringify(points)};
      if (!points.length) { return { ok: false, reason: "missing-mouse-points" }; }
      const debug = win.webContents.debugger;
      const alreadyAttached = debug.isAttached();
      let pressed = false;
      let lastPoint = points[0];
      try {
        if (!alreadyAttached) { debug.attach("1.3"); }
        try { win.show(); win.focus(); win.webContents.focus(); } catch (eFocusWindow) {}
        try { await debug.sendCommand("Page.bringToFront"); } catch (eBringToFront) {}
        for (let index = 0; index < points.length; index++) {
          const point = points[index];
          lastPoint = point;
          if (point.action === "down") {
            await debug.sendCommand("Input.dispatchMouseEvent", { button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", type: "mousePressed", x: point.x, y: point.y });
            pressed = true;
          } else if (point.action === "up") {
            await debug.sendCommand("Input.dispatchMouseEvent", { button: "left", buttons: 0, clickCount: 1, pointerType: "mouse", type: "mouseReleased", x: point.x, y: point.y });
            pressed = false;
          } else {
            await debug.sendCommand("Input.dispatchMouseEvent", { button: "none", buttons: pressed ? 1 : 0, pointerType: "mouse", type: "mouseMoved", x: point.x, y: point.y });
          }
          if (index + 1 < points.length) { await new Promise(function (resolve) { setTimeout(resolve, 18); }); }
        }
        return { ok: true, points: points };
      } catch (error) {
        return { ok: false, reason: "mouse-dispatch-failed", error: String(error && error.message || error), points: points };
      } finally {
        if (pressed && lastPoint) { try { await debug.sendCommand("Input.dispatchMouseEvent", { button: "left", buttons: 0, clickCount: 1, pointerType: "mouse", type: "mouseReleased", x: lastPoint.x, y: lastPoint.y }); } catch (eReleaseMouse) {} }
        if (!alreadyAttached) { try { debug.detach(); } catch (eDetachDebugger) {} }
      }
    })()
  `.trim();
}
