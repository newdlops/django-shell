// Isolates native hover-test paths from unrelated hardware pointer movement in the owned test window.

/** Installs a scoped capture guard while preserving delivery checks for every requested press, release, and endpoint. */
function installHoverInputGuard() {
  window.__dsoE2eHoverInput?.cleanup();
  let path = null, previous = null, received = new Set(), required = [], ignored = 0;
  const ignoredPoints = [];
  const types = ["pointerover", "pointerout", "pointerenter", "pointerleave", "pointermove", "pointerdown", "pointerup", "mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove", "mousedown", "mouseup"];
  /** Reports the DOM mouse event expected from one native Electron input action. */
  function eventType(point) { return point.action === "down" ? "mousedown" : point.action === "up" ? "mouseup" : "mousemove"; }
  /** Compares native renderer coordinates with the rounded path supplied to Electron. */
  function matches(event, point) { return Math.abs(event.clientX - point.x) <= 1 && Math.abs(event.clientY - point.y) <= 1; }
  /** Stops only off-path events; requested events continue through the production hover handlers. */
  function onPointer(event) {
    if (!path) { return; }
    if (!path.some((point) => matches(event, point)) && !(previous && matches(event, previous))) {
      ignored += 1;
      if (ignoredPoints.length < 12) { ignoredPoints.push({ type: event.type, x: event.clientX, y: event.clientY }); }
      event.stopImmediatePropagation();
      return;
    }
    required.forEach((point, index) => { if (event.type === eventType(point) && matches(event, point)) { received.add(index); } });
  }
  types.forEach((type) => window.addEventListener(type, onPointer, true));
  window.__dsoE2eHoverInput = {
    /** Replaces the allowed path before native dispatch and resets its delivery evidence. */
    setPath(points) {
      if (!Array.isArray(points) || !points.length || points.length > 32 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) { throw new Error("Invalid hover input path."); }
      previous = path?.[path.length - 1] || null;
      path = points;
      required = points.filter((point, index) => point.action === "down" || point.action === "up" || index === points.length - 1);
      received = new Set();
    },
    /** Returns arrival evidence independently of the hover widget's own visibility assertions. */
    snapshot() { return { armed: !!path, pending: required.filter((_point, index) => !received.has(index)), ignored, ignoredPoints }; },
    /** Restores ordinary hardware input after success, failure, or diagnostic cleanup. */
    cleanup() { types.forEach((type) => window.removeEventListener(type, onPointer, true)); path = null; }
  };
  return "hover-input-guard-installed";
}

module.exports = { installHoverInputGuard };
