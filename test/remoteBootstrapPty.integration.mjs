// Measures cold and cached remote ORM attachment using isolated real IPython processes and PTYs.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { hostHarness } from "./stabilityHostHarness.mjs";
import { PYTHON } from "./modelBrowserHelpers.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty"), harness = hostHarness();
const runtime = path.resolve("python/django_shell_backend.py");
const hasIPython = PYTHON && childProcess.spawnSync(PYTHON, ["-c", "import django, IPython"], { encoding: "utf8" }).status === 0;

/** Waits for a concrete terminal state with bounded diagnostics on failure. */
async function until(check, session, timeout = 20000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) { throw new Error(`Terminal state timed out: ${session.outputTail}`); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Writes an in-memory Django fixture that hides the local extension path as an SSH boundary would. */
function writeFixture(root) {
  const file = path.join(root, "remote_fixture.py");
  fs.writeFileSync(file, ["# Isolated remote ORM bootstrap fixture.", "import os, tempfile", `tempfile.tempdir = ${JSON.stringify(root)}`,
    "from django.conf import settings", "settings.configure(INSTALLED_APPS=['django.contrib.contenttypes'], DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, USE_TZ=True)",
    "import django", "django.setup()", "from django.db import models, connection",
    "class RemoteItem(models.Model):", '    """Provides one real Django row without using a project database."""', "    title = models.CharField(max_length=50)",
    "    class Meta:", '        """Registers the fixture under an installed app."""', "        app_label = 'contenttypes'",
    "with connection.schema_editor() as editor: editor.create_model(RemoteItem)", "RemoteItem.objects.create(title='remote row')",
    "_remote_exists = os.path.exists", "def _remote_path_exists(value):", '    """Models an extension file path that is absent on the server."""',
    `    return False if value == ${JSON.stringify(runtime)} else _remote_exists(value)`, "os.path.exists = _remote_path_exists",
    "import json", "def _fixture_audit(info):", '    """Records real executed cells without altering any application audit hooks."""',
    `    with open(${JSON.stringify(path.join(root, "audit.jsonl"))}, 'a') as stream: stream.write(json.dumps(info.raw_cell) + '\\n')`,
    "get_ipython().events.register('pre_run_cell', _fixture_audit)", ""].join("\n"));
  return file;
}

/** Attaches through the production session state machine, then queries through the real ORM capture hooks. */
async function connect(root, fixture) {
  const session = harness.session(), events = [], writes = [];
  session.client = undefined; session.token = ""; session.mode = "shell";
  session.options.backendRuntimePath = runtime;
  session.options.diagnosticLogger = { enabled: () => true, log: (name, fields) => events.push({ name, ...fields }) };
  const env = { ...process.env, DJANGO_SHELL_BACKEND_B64: "", PYTHONSTARTUP: "", IPYTHONDIR: path.join(root, "ipython"), TMPDIR: root, TERM: "xterm-256color" };
  const started = Date.now();
  const terminal = pty.spawn(PYTHON, ["-m", "IPython", "--simple-prompt", "--no-autoindent", "--no-banner", "--HistoryManager.enabled=False", "-i", fixture], { cols: 120, rows: 30, cwd: root, env });
  session.process = { write: (data) => { writes.push(data); terminal.write(data); }, kill: () => terminal.kill(), resize: (cols, rows) => terminal.resize(cols, rows) };
  terminal.onData((data) => { if (!session.disposed) { session.handleOutput(data); } });
  let exited = false; terminal.onExit(() => { exited = true; });
  try {
    await until(() => Boolean(session.backend), session);
    const readyMs = Date.now() - started;
    assert.equal(session.isRemoteTerminalBackend(), true); assert.equal(session.cellCapture, true);
    assert.deepEqual(session.backend.endpoint.capabilities, ["base"], JSON.stringify(events.filter((event) => event.name === "backend.attach")));
    session.backend.setTransportMode("orm");
    const executed = await session.backend.execute("2 + 3");
    assert.equal(executed.ok, true); assert.equal(executed.result, "5");
    const catalog = await session.backend.models();
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    assert.equal(events.some((event) => event.kind?.startsWith("capability.")), false, "Console and catalog must work before any optional upload");
    const rows = await session.backend.modelRows({ app: "contenttypes", model: "RemoteItem", limit: 5 });
    assert.equal(rows.ok, true, JSON.stringify(rows)); assert.equal(rows.rows.length, 1);
    assert.ok(JSON.stringify(rows.rows).includes("remote row"));
    const metrics = { readyMs, firstRowsMs: Date.now() - started, inputBytes: writes.reduce((total, data) => total + Buffer.byteLength(data), 0),
      bootstrapModes: events.filter((event) => event.name === "backend.attach").map((event) => event.bootstrapMode),
      capabilities: events.filter((event) => event.name === "backend.pty.request" && event.kind?.startsWith("capability.")).map((event) => event.kind),
      noisyLogLines: events.filter((event) => event.name === "shell.out" && /[A-Za-z0-9+/=]{100}/.test(event.line ?? "")).length };
    assert.equal(metrics.noisyLogLines, 0);
    assert.deepEqual(metrics.capabilities, ["capability.grid"]);
    const inspected = await session.backend.inspect();
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const query = await session.backend.modelQuery({ code: "RemoteItem.objects.values('id', 'title')", limit: 5 });
    assert.equal(query.ok, true, JSON.stringify(query)); assert.equal(query.rows.length, 1);
    session.backend.setTransportMode("auto");
    const schema = await session.backend.modelSchema("contenttypes", "RemoteItem");
    assert.equal(schema.ok, true, JSON.stringify(schema));
    const counted = await session.backend.modelCount({ app: "contenttypes", model: "RemoteItem" });
    assert.equal(counted.ok, true, JSON.stringify(counted)); assert.equal(counted.count, 1);
    const committed = await session.backend.modelCommit({ app: "contenttypes", model: "RemoteItem", changes: [{ pk: 1, fields: { title: "saved lazily" } }] });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    session.backend.setTransportMode("orm");
    const saved = await session.backend.modelRows({ app: "contenttypes", model: "RemoteItem", limit: 5 });
    assert.ok(JSON.stringify(saved.rows).includes("saved lazily"));
    const instrumented = await session.backend.execute("sum(item.pk for item in RemoteItem.objects.all())");
    assert.equal(instrumented.ok, true, JSON.stringify(instrumented)); assert.equal(instrumented.result, "1");
    session.backend.useForwardedEndpoint(session.backend.endpoint.host, session.backend.endpoint.port);
    const socketResult = await session.backend.execute("len([2, 3, 4])");
    assert.equal(socketResult.ok, true, JSON.stringify(socketResult)); assert.equal(socketResult.result, "3");
    assert.equal(session.backend.transport, "tcp");
    return metrics;
  } finally {
    session.dispose(); terminal.destroy(); await until(() => exited, session, 5000);
  }
}

test("fresh remote IPython processes reuse bootstrap payloads and still return real ORM rows", { skip: !hasIPython, timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-remote-pty-"));
  try {
    const fixture = writeFixture(root), cold = await connect(root, fixture), cached = await connect(root, fixture);
    assert.deepEqual(cold.bootstrapModes, ["env", "seed"]);
    assert.deepEqual(cached.bootstrapModes, ["env", "seed"]);
    assert.ok(cached.inputBytes < cold.inputBytes * 0.3, JSON.stringify({ cold, cached }));
    const audit = fs.readFileSync(path.join(root, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(audit.some((line) => line === "2 + 3"));
    assert.ok(audit.some((line) => line.includes("_load_capability_from_stdin('grid'") || line.includes('_load_capability_from_stdin("grid"')));
    assert.equal(audit.some((line) => /[A-Za-z0-9+/=]{100}/.test(line)), false, "Encoded payloads must never be executed or audited as Python cells");
    t.diagnostic(JSON.stringify({ cold, cached }));
  } finally { fs.rmSync(root, { force: true, recursive: true }); }
});

test("failed or interrupted framed uploads restore terminal input and echo", { skip: !PYTHON || process.platform === "win32", timeout: 10000 }, () => {
  const result = childProcess.spawnSync(PYTHON, ["test/fixtures/backendUploadFailures.py"], { encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), ["ValueError", "ValueError", "TimeoutError", "KeyboardInterrupt"]);
});
