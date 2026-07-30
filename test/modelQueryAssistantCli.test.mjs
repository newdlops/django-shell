// Direct behavioral tests for shell-free Query Builder assistant process bounds.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const cli = require("../out/modelQueryAssistantCli.js");
/** Builds an evented fake child process without launching any external command. */
function fakeChild() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = (value) => { child.stdinValue = value; }; child.kill = () => { child.killed = true; return true; }; child.killed = false; return child; }
/** Runs a fake child command with injectable timers and returns its observable state. */
function run(child, controller = new AbortController()) { const timers = []; const calls = []; const promise = cli.runQueryAssistantCommand({ args: ["exec"], command: "codex", cwd: "/work", provider: "codex" }, "prompt", 50, controller.signal, { PATH: "/prepared" }, { clearTimer: (timer) => { timer.cleared = true; }, setTimer: (callback) => { const timer = { callback }; timers.push(timer); return timer; }, spawn: (command, args, options) => { calls.push({ args, command, options }); return child; } }); return { calls, promise, timers }; }

test("builds exact fixed argv contracts without shell interpolation", () => {
  assert.deepEqual(cli.buildQueryAssistantCommand("claude", "claude", "/work").args, ["-p", "--output-format", "text", "--no-session-persistence", "--tools", ""]);
  assert.deepEqual(cli.buildQueryAssistantCommand("codex", "codex", "/work").args, ["exec", "--sandbox", "read-only", "--ephemeral", "--color", "never", "-C", "/work", "-"]);
  assert.deepEqual(cli.buildQueryAssistantCommand("claude", "claude", "/work", { autoUpdateModel: false, model: "sonnet", reasoningEffort: "high" }).args, ["-p", "--output-format", "text", "--no-session-persistence", "--tools", "", "--model", "sonnet", "--effort", "high"]);
  assert.deepEqual(cli.buildQueryAssistantCommand("codex", "codex", "/work", { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "xhigh" }).args, ["exec", "--sandbox", "read-only", "--ephemeral", "--color", "never", "-C", "/work", "-c", "model_reasoning_effort=\"xhigh\"", "--model", "gpt-5", "-"]);
});
test("rejects oversized or argv-shaped model and effort settings before spawn", () => {
  const oversized = "m".repeat(161);
  for (const settings of [{ autoUpdateModel: false, model: oversized, reasoningEffort: "" }, { autoUpdateModel: false, model: "--model", reasoningEffort: "" }, { autoUpdateModel: false, model: "gpt-5", reasoningEffort: "high --danger" }]) {
    assert.throws(() => cli.buildQueryAssistantCommand("codex", "codex", "/work", settings), { message: "unsupported-settings" });
  }
});
test("resolves only X_OK candidates through an injected filesystem seam", async () => {
  const calls = []; const resolved = await cli.resolveQueryAssistantExecutable("codex", { PATH: "/first:/second" }, { access: async (candidate) => { calls.push(candidate); if (candidate === "/second/codex") { return; } throw new Error("missing"); } });
  assert.equal(resolved, "/second/codex"); assert.deepEqual(calls, ["/first/codex", "/second/codex"]);
});
test("merges current, fixed login-shell, and common paths deterministically", async () => {
  const environment = await cli.prepareQueryAssistantEnvironment({ PATH: "/existing" }, { loginShellPath: async () => "/login:/existing" });
  assert.ok(environment.PATH.startsWith("/existing:/login:/opt/homebrew/bin")); assert.equal(environment.NO_COLOR, "1"); assert.equal(environment.TERM, "dumb");
});
test("bounded child success sends exact argv, stdin, cwd, and settles once", async () => {
  const child = fakeChild(); const result = run(child); child.stdout.emit("data", Buffer.from("recipe")); child.emit("close", 0); child.emit("error", new Error("late")); assert.equal(await result.promise, "recipe"); assert.deepEqual(result.calls[0], { args: ["exec"], command: "codex", options: { cwd: "/work", env: { PATH: "/prepared" }, shell: false, stdio: ["pipe", "pipe", "pipe"] } }); assert.equal(child.stdinValue, "prompt"); assert.equal(result.timers[0].cleared, true);
});
test("timeout kills once and reports the timeout category", async () => {
  const child = fakeChild(); const result = run(child); result.timers[0].callback(); child.emit("close", 1); await assert.rejects(result.promise, { message: "timeout" }); assert.equal(child.killed, true);
});
test("stdout overflow kills once and reports the oversized category", async () => {
  const child = fakeChild(); const result = run(child); child.stdout.emit("data", Buffer.from("x".repeat(200001))); child.emit("close", 0); await assert.rejects(result.promise, { message: "output-too-large" }); assert.equal(child.killed, true);
});
test("abort after spawn kills once and late close or error cannot double settle", async () => {
  const child = fakeChild(); const controller = new AbortController(); const result = run(child, controller); controller.abort(); child.emit("close", 0); child.emit("error", new Error("late")); await assert.rejects(result.promise, { message: "cancelled" }); assert.equal(child.killed, true);
});
test("metadata capture uses no stdin payload and ignores late output after every settlement", async () => {
  const child = fakeChild(); const timers = []; const calls = []; const promise = cli.runQueryAssistantMetadataCommand({ args: ["--help"], command: "codex", cwd: "/work" }, new AbortController().signal, { PATH: "/prepared" }, { clearTimer: (timer) => { timer.cleared = true; }, setTimer: (callback) => { const timer = { callback }; timers.push(timer); return timer; }, spawn: (command, args, options) => { calls.push({ args, command, options }); return child; } });
  child.stdout.emit("data", Buffer.from("catalog")); child.emit("close", 0); child.stdout.emit("data", Buffer.from("-late")); child.stderr.emit("data", Buffer.from("-late")); child.emit("error", new Error("late"));
  assert.equal(await promise, "catalog"); assert.deepEqual(calls[0], { args: ["--help"], command: "codex", options: { cwd: "/work", env: { PATH: "/prepared" }, shell: false, stdio: ["ignore", "pipe", "pipe"] } }); assert.equal(child.stdinValue, undefined); assert.equal(timers[0].cleared, true);
});
test("overflow rejects before retaining output and EPIPE cannot mask unsupported stderr", async () => {
  const child = fakeChild(); const result = run(child); child.stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })); child.stderr.emit("data", Buffer.from("unknown option --model")); child.emit("close", 1); await assert.rejects(result.promise, { message: "unsupported-settings" });
  const oversized = fakeChild(); const overflow = run(oversized); oversized.stdout.emit("data", Buffer.from("small")); oversized.stdout.emit("data", Buffer.from("x".repeat(200001))); oversized.stdout.emit("data", Buffer.from("late")); oversized.emit("close", 0); await assert.rejects(overflow.promise, { message: "output-too-large" }); assert.equal(oversized.killed, true);
});
test("a single oversized stderr chunk retains its beginning for rejection classification", async () => {
  const child = fakeChild(); const result = run(child); child.stderr.emit("data", Buffer.from(`unknown option --model${"x".repeat(20000)}`)); child.emit("close", 1);
  await assert.rejects(result.promise, { message: "unsupported-settings" });
});
test("a rejection marker after bounded retained stderr still classifies settings", async () => {
  const child = fakeChild(); const result = run(child); child.stderr.emit("data", Buffer.from("x".repeat(20000))); child.stderr.emit("data", Buffer.from("\nunexpected argument '--model' found")); child.emit("close", 1);
  await assert.rejects(result.promise, { message: "unsupported-settings" });
});
test("classifies only explicit settings rejections rather than generic model service failures", async () => {
  const unavailable = fakeChild(); const unavailableResult = run(unavailable); unavailable.stderr.emit("data", Buffer.from("model service temporarily unavailable")); unavailable.emit("close", 1);
  await assert.rejects(unavailableResult.promise, { message: "provider-failed" });
  const invalidResponse = fakeChild(); const invalidResponseResult = run(invalidResponse); invalidResponse.stderr.emit("data", Buffer.from("model returned an invalid response")); invalidResponse.emit("close", 1);
  await assert.rejects(invalidResponseResult.promise, { message: "provider-failed" });
  const unexpectedValue = fakeChild(); const unexpectedValueResult = run(unexpectedValue); unexpectedValue.stderr.emit("data", Buffer.from("unexpected argument 'model' found")); unexpectedValue.emit("close", 1);
  await assert.rejects(unexpectedValueResult.promise, { message: "provider-failed" });
  const rejectedFlag = fakeChild(); const rejectedFlagResult = run(rejectedFlag); rejectedFlag.stderr.emit("data", Buffer.from("unknown option --model")); rejectedFlag.emit("close", 1);
  await assert.rejects(rejectedFlagResult.promise, { message: "unsupported-settings" });
});
test("classifies only explicit authentication failures instead of incidental auth text", async () => {
  const incidental = fakeChild(); const incidentalResult = run(incidental); incidental.stderr.emit("data", Buffer.from("no authoritative response was returned")); incidental.emit("close", 1);
  await assert.rejects(incidentalResult.promise, { message: "provider-failed" });
  const loggedOut = fakeChild(); const loggedOutResult = run(loggedOut); loggedOut.stderr.emit("data", Buffer.from("error: not logged in; please log in")); loggedOut.emit("close", 1);
  await assert.rejects(loggedOutResult.promise, { message: "authentication" });
});
test("retains rolling authentication detection after bounded stderr and prioritizes settings rejection", async () => {
  const delayedLogin = fakeChild(); const delayedLoginResult = run(delayedLogin); delayedLogin.stderr.emit("data", Buffer.from("x".repeat(20000))); delayedLogin.stderr.emit("data", Buffer.from("\nnot logged in")); delayedLogin.emit("close", 1);
  await assert.rejects(delayedLoginResult.promise, { message: "authentication" });
  const settingsFirst = fakeChild(); const settingsFirstResult = run(settingsFirst); settingsFirst.stderr.emit("data", Buffer.from("authentication failed: unknown option --model")); settingsFirst.emit("close", 1);
  await assert.rejects(settingsFirstResult.promise, { message: "unsupported-settings" });
});
