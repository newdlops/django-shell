// Verifies E2E cleanup preserves shared resources and other runs while removing successful and failed run artifacts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { withE2eArtifacts } from "./e2e/artifacts.mjs";

/** Creates a tiny extension fixture without copying the application's compiled output. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-artifact-test-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", extensionDependencies: ["fixture.python"] }));
  for (const name of ["out", "media", "node_modules", "python", "syntaxes", "temporary"]) { fs.mkdirSync(path.join(root, name)); }
  fs.writeFileSync(path.join(root, "out", "fixture.js"), "// Benign extension fixture.\nexports.fixture = true;\n");
  fs.writeFileSync(path.join(root, "python", "keep.txt"), "shared resource");
  return root;
}

for (const fail of [false, true]) {
  test(`E2E ${fail ? "failure" : "success"} removes owned artifacts and preserves symlink targets`, async () => {
    const root = fixture(); let artifacts;
    try {
      const pending = withE2eArtifacts(root, async (created) => {
        artifacts = created;
        assert.equal(JSON.parse(fs.readFileSync(path.join(created.extensionPath, "package.json"))).extensionDependencies, undefined);
        assert.equal(fs.readFileSync(path.join(created.extensionPath, "python", "keep.txt"), "utf8"), "shared resource");
        if (fail) { throw new Error("controlled test failure"); }
        return "passed";
      }, path.join(root, "temporary"));
      if (fail) { await assert.rejects(pending, /controlled test failure/); } else { assert.equal(await pending, "passed"); }
      assert.ok(Object.values(artifacts).every((directory) => !fs.existsSync(directory)));
      assert.equal(fs.readFileSync(path.join(root, "python", "keep.txt"), "utf8"), "shared resource");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("an incomplete extension copy rolls back all artifacts created before setup failed", async () => {
  const root = fixture();
  try {
    fs.rmSync(path.join(root, "out"), { recursive: true, force: true });
    await assert.rejects(withE2eArtifacts(root, async () => assert.fail("setup should fail"), path.join(root, "temporary")), /ENOENT/);
    assert.deepEqual(fs.readdirSync(path.join(root, ".vscode-test")), []);
    assert.deepEqual(fs.readdirSync(path.join(root, "temporary")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cleaning one E2E run preserves another run that is still active", async () => {
  const root = fixture();
  try {
    await withE2eArtifacts(root, async (first) => {
      await withE2eArtifacts(root, async (second) => {
        assert.notEqual(first.extensionPath, second.extensionPath);
        assert.ok(fs.existsSync(first.extensionPath) && fs.existsSync(second.extensionPath));
      }, path.join(root, "temporary"));
      assert.ok(Object.values(first).every((directory) => fs.existsSync(directory)));
    }, path.join(root, "temporary"));
    assert.deepEqual(fs.readdirSync(path.join(root, ".vscode-test")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the test runner's explicit process exit still removes owned artifacts", () => {
  const root = fixture();
  try {
    const moduleUrl = new URL("./e2e/artifacts.mjs", import.meta.url).href;
    const script = `import { withE2eArtifacts } from ${JSON.stringify(moduleUrl)}; await withE2eArtifacts(${JSON.stringify(root)}, async () => process.exit(7), ${JSON.stringify(path.join(root, "temporary"))});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(root, ".vscode-test")), []);
    assert.deepEqual(fs.readdirSync(path.join(root, "temporary")), []);
    assert.equal(fs.readFileSync(path.join(root, "python", "keep.txt"), "utf8"), "shared resource");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
