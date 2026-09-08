// Reaps owned assistant processes and their child groups after cancellation or failure.
import { spawn, type ChildProcess } from "child_process";

export const ASSISTANT_EXIT_GRACE_MS = 500;

/** Terminates only the process or isolated process group created for this assistant invocation. */
export function terminateAssistantProcess(child: ChildProcess, grouped: boolean): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const pid = child.pid;

  if (process.platform === "win32" && pid && child.exitCode == null && child.signalCode == null) {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false, timeout: 2000 });
    killer.on("error", () => { signal("SIGKILL"); cleanup(); });
    killer.on("close", () => { signal("SIGKILL"); cleanup(); });
    killer.unref();
    return;
  }

  /** Releases pipes and the reaper callback after the owned process has stopped. */
  function cleanup(): void {
    if (finished) { return; }
    finished = true;
    clearTimeout(timer);
    child.removeListener("close", closed);
    child.stdin?.destroy?.(); child.stdout?.destroy?.(); child.stderr?.destroy?.();
  }

  /** Checks whether a POSIX group still contains descendants after the direct child exits. */
  function groupAlive(): boolean {
    if (!grouped || !pid) { return false; }
    try { process.kill(-pid, 0); return true; } catch { return false; }
  }

  /** Stops waiting once neither the child nor its owned group needs reaping. */
  function closed(): void { if (!groupAlive()) { cleanup(); } }

  /** Delivers a termination signal to the complete owned group where the platform supports it. */
  function signal(kind: NodeJS.Signals): void {
    if (grouped && pid) {
      try { process.kill(-pid, kind); return; } catch { /* Fall back to the direct child after a spawn failure. */ }
    }
    try { child.kill(kind); } catch { /* A child may have exited between cancellation and signaling. */ }
  }

  if ((child.exitCode != null || child.signalCode != null) && !groupAlive()) { cleanup(); return; }
  child.once("close", closed);
  signal("SIGTERM");
  if (finished) { return; }
  timer = setTimeout(() => {
    signal("SIGKILL");
    cleanup();
  }, ASSISTANT_EXIT_GRACE_MS);
  timer.unref?.();
}
