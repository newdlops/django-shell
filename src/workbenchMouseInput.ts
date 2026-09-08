// Test-only native Electron input for the owning VS Code workbench window.

/** Identifies one renderer-space mouse point in CSS pixels. */
export interface WorkbenchMousePoint { action?: "down" | "move" | "up"; x: number; y: number; }

/** Builds a bounded main-process expression that sends native pointer events without renderer debugger acknowledgements. */
export function mainProcessMouseInputExpression(windowId: number, rawPoints: WorkbenchMousePoint[]): string {
  const points = rawPoints.slice(0, 32).map((point) => ({
    ...(point?.action === "down" || point?.action === "move" || point?.action === "up" ? { action: point.action } : {}),
    x: Number.isFinite(Number(point?.x)) ? Math.round(Math.max(0, Math.min(100_000, Number(point.x)))) : 0,
    y: Number.isFinite(Number(point?.y)) ? Math.round(Math.max(0, Math.min(100_000, Number(point.y)))) : 0
  }));
  return `
    (async function () {
      const req = typeof require === "function" ? require : (process && process.mainModule && typeof process.mainModule.require === "function" ? process.mainModule.require.bind(process.mainModule) : undefined);
      if (!req) { return { ok: false, reason: "no-main-require" }; }
      const win = req("electron").BrowserWindow.fromId(${JSON.stringify(windowId)});
      if (!win || win.isDestroyed && win.isDestroyed() || !win.webContents || win.webContents.isDestroyed && win.webContents.isDestroyed()) { return { ok: false, reason: "missing-workbench-window" }; }
      const points = ${JSON.stringify(points)};
      if (!points.length) { return { ok: false, reason: "missing-mouse-points" }; }
      let pressed = false;
      let lastPoint = points[0];
      try {
        if (!win.isFocused || !win.isFocused()) {
          req("electron").app.focus({ steal: true });
          win.show(); win.focus(); win.webContents.focus();
          await new Promise(function (resolve) { setTimeout(resolve, 120); });
        }
        for (let index = 0; index < points.length; index++) {
          const point = points[index];
          lastPoint = point;
          if (point.action === "down") {
            pressed = true;
            win.webContents.sendInputEvent({ button: "left", modifiers: ["leftbuttondown"], clickCount: 1, type: "mouseDown", x: point.x, y: point.y });
          } else if (point.action === "up") {
            win.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseUp", x: point.x, y: point.y });
            pressed = false;
          } else {
            win.webContents.sendInputEvent({ ...(pressed ? { button: "left", modifiers: ["leftbuttondown"] } : {}), type: "mouseMove", x: point.x, y: point.y });
          }
          if (index + 1 < points.length) { await new Promise(function (resolve) { setTimeout(resolve, 18); }); }
        }
        return { ok: true, points: points };
      } catch (error) {
        return { ok: false, reason: "mouse-dispatch-failed", error: String(error && error.message || error), points: points };
      } finally {
        if (pressed && lastPoint) { try { win.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseUp", x: lastPoint.x, y: lastPoint.y }); } catch (eReleaseMouse) {} }
      }
    })()
  `.trim();
}
