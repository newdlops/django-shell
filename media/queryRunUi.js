// ORM query lifecycle status controls for the existing model-browser webview.

/** Connects query execution snapshots to the existing Run button, status text, and Interrupt action. */
export function createQueryRunUi(ctx) {
  const run = document.getElementById("runQuery");
  const interrupt = document.getElementById("interruptQuery");
  const openConsole = document.getElementById("openQueryConsole");
  const guarded = ["transport", "reload", "more"].map((id) => document.getElementById(id)).filter(Boolean);
  let snapshot;
  let timer = 0;
  let lastSecond = -1;
  let announcedState = "";

  /** Stops elapsed-time rendering after a terminal query state. */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  /** Returns compact visible status text for the current query execution snapshot. */
  function text() {
    if (!snapshot) {
      return "";
    }
    const seconds = Math.max(0, Math.floor((Date.now() - (snapshot.startedAt || Date.now())) / 1000));
    if (snapshot.state === "idle") { return "Ready to run a Django ORM query."; }
    if (snapshot.state === "running") { return `Running query · ${seconds}s`; }
    if (snapshot.state === "slow") { return `Still running in the live Django shell · ${seconds}s`; }
    if (snapshot.state === "cancelling") { return "Interrupting query…"; }
    if (snapshot.state === "timedOut") { return `Query interrupted after ${Math.round((snapshot.timeoutMs || 0) / 1000)}s.`; }
    if (snapshot.state === "cancelled") { return snapshot.error ? "Interrupt could not be confirmed. Open Django Shell and use Restart Kernel." : "Query interrupted."; }
    return snapshot.error || "";
  }

  /** Renders one host-provided lifecycle snapshot and keeps duplicate submission unavailable. */
  function render(next) {
    snapshot = next;
    const active = ["running", "slow", "cancelling"].includes(next?.state);
    document.querySelector(".app")?.setAttribute("aria-busy", String(active));
    run.disabled = active;
    run.textContent = ["failed", "timedOut"].includes(next?.state) ? "Retry" : "Run query";
    interrupt.hidden = !active;
    interrupt.disabled = next?.state === "cancelling";
    interrupt.setAttribute("aria-hidden", String(!active));
    if (openConsole) {
      const needsRecovery = next?.state === "cancelled" && Boolean(next.error);
      openConsole.hidden = !needsRecovery;
      openConsole.setAttribute("aria-hidden", String(!needsRecovery));
    }
    for (const control of guarded) {
      if (active) {
        control.dataset.queryRunDisabled = control.disabled ? "preserve" : "restore";
        control.disabled = true;
      } else if (control.dataset.queryRunDisabled === "restore") {
        control.disabled = false;
        delete control.dataset.queryRunDisabled;
      }
    }
    if (active) {
      updateStatus();
      if (!timer) {
        timer = setInterval(updateStatus, 250);
      }
    } else {
      stop();
      const message = text();
      if (message) {
        ctx.status.textContent = message;
      }
    }
    if (next?.state && next.state !== announcedState) {
      announcedState = next.state;
      (next.state === "failed" ? ctx.announcer?.announceError : ctx.announcer?.announceStatus)?.(text());
    }
  }

  /** Updates the elapsed status only when its visible whole-second value changes. */
  function updateStatus() {
    const second = Math.max(0, Math.floor((Date.now() - (snapshot?.startedAt || Date.now())) / 1000));
    if (second === lastSecond && ctx.status.textContent) { return; }
    lastSecond = second;
    ctx.status.textContent = text();
  }

  /** Formats the completed query result using the controller's measured elapsed time. */
  function successText(rowCount) {
    const seconds = Math.max(0, Number(snapshot?.elapsedMs) || 0) / 1000;
    return `Loaded ${rowCount} row${rowCount === 1 ? "" : "s"} in ${seconds.toFixed(seconds < 10 ? 1 : 0)}s.`;
  }

  interrupt.addEventListener("click", () => ctx.post({ type: "interruptQuery" }));
  openConsole?.addEventListener("click", () => ctx.post({ type: "openConsole" }));
  return { render, successText };
}
