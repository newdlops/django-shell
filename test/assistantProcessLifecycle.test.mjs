// Exercises real local assistant child cleanup without invoking providers or transmitting prompts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { runQueryAssistantCommand } from "../out/modelQueryAssistantCli.js";

for (const reason of ["timeout", "cancelled"]) {
  test(`reaps a SIGTERM-ignoring assistant process after ${reason}`, async () => {
    let child, expire;
    const controller = new AbortController();
    const script = "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('ready'); setInterval(() => {}, 1000);";
    const outcome = runQueryAssistantCommand({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), provider: "codex" }, "", 5000, controller.signal, process.env, {
      spawn(command, args, options) { child = spawn(command, args, options); return child; }, setTimer(callback) { expire = callback; return 1; }, clearTimer() {}
    }).then(() => "success", (error) => error.message);
    try {
      await once(child.stdout, "data");
      const closed = once(child, "close");
      if (reason === "timeout") { expire(); } else { controller.abort(); }
      assert.equal(await outcome, reason);
      await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Assistant process was not reaped")), 4000); timer.unref(); })]);
      assert.notEqual(child.signalCode, null);
      assert.equal(child.stdout.destroyed, true);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); } }
  });
}

test("cancellation reaps an ignoring descendant after the direct assistant process exits", { skip: process.platform === "win32" }, async () => {
  let child;
  const controller = new AbortController();
  const descendant = "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);";
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'ignore'] }); setInterval(() => {}, 1000);`;
  const outcome = runQueryAssistantCommand({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), provider: "codex" }, "", 5000, controller.signal, process.env, {
    spawn(command, args, options) { child = spawn(command, args, options); return child; }
  }).then(() => "success", (error) => error.message);
  try {
    const [chunk] = await once(child.stdout, "data");
    assert.match(chunk.toString(), /^\d+$/);
    const exited = once(child, "exit"), closed = once(child, "close");
    controller.abort();
    assert.equal(await outcome, "cancelled");
    assert.deepEqual(await exited, [null, "SIGTERM"]);
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Assistant descendant retained its output pipe")), 4000); timer.unref(); })]);
    assert.equal(child.stdout.destroyed, true);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* The owned process group has already exited. */ }
  }
});
