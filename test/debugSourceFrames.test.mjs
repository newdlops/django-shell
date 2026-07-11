// Unit tests for debug stack-frame source selection.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { choosePreferredDebugSourceFrame, isOverlayDebugSourcePath, isPseudoDebugSourcePath, isUserDebugSourcePath } = require("../out/debugSourceFrames.js");

test("prefers workspace source frames over site-packages during step-in", () => {
  const frames = [
    frame("/workspace/.venv/lib/python3.12/site-packages/django/db/models/query.py", 30),
    frame("/workspace/app/services.py", 12),
    frame("/workspace/.django-shell/console-cell.py", 5)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferUserSource: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/workspace/app/services.py");
});

test("classifies Django related descriptors in a venv as library code", () => {
  const frames = [
    frame("/workspace/.venv/lib/python3.11/site-packages/django/db/models/fields/related_descriptors.py", 310),
    frame("/workspace/app/models.py", 42)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferUserSource: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/workspace/app/models.py");
});

test("keeps overlay preference for ordinary overlay pauses", () => {
  const frames = [
    frame("/workspace/.django-shell/console-cell.py", 5),
    frame("/workspace/app/services.py", 12)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferOverlay: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/workspace/.django-shell/console-cell.py");
});

test("keeps current user source while stepping inside a function called from overlay", () => {
  const frames = [
    frame("/workspace/app/services.py", 142),
    frame("/workspace/.django-shell/console-cell.py", 14)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferOverlay: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/workspace/app/services.py");
});

test("recovers overlay source when overlay preference lands on traceback cleanup", () => {
  const frames = [
    frame("/Users/lky/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/lib/python3.11/traceback.py", 184),
    frame("/workspace/app/services.py", 198),
    frame("/workspace/.django-shell/console-cell.py", 14)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferOverlay: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/workspace/.django-shell/console-cell.py");
});

test("falls back to non-library source when workspace roots do not match remote paths", () => {
  const frames = [
    frame("/usr/lib/python3.12/threading.py", 100),
    frame("/app/services.py", 9)
  ];

  const selected = choosePreferredDebugSourceFrame(frames, { preferUserSource: true, workspaceRoots: ["/workspace"] });

  assert.equal(selected.source.path, "/app/services.py");
});

test("detects generated overlay frame paths and file URIs", () => {
  assert.equal(isOverlayDebugSourcePath("/workspace/.django-shell/console-cell.py"), true);
  assert.equal(isOverlayDebugSourcePath("file:///workspace/.django-shell/console-cell.py"), true);
  assert.equal(isOverlayDebugSourcePath("/workspace/app/services.py"), false);
});

test("treats the manage.py shell entry script as plumbing rather than user source", () => {
  assert.equal(isUserDebugSourcePath("/workspace/manage.py"), false);
  assert.equal(isUserDebugSourcePath("C:\\work\\proj\\manage.py"), false);
  assert.equal(isUserDebugSourcePath("/workspace/app/manage_utils.py"), true);

  const frames = [
    frame("/workspace/manage.py", 22),
    frame("/workspace/app/services.py", 9)
  ];
  const selected = choosePreferredDebugSourceFrame(frames, { preferUserSource: true, workspaceRoots: ["/workspace"] });
  assert.equal(selected.source.path, "/workspace/app/services.py");
});

test("rejects realpath-expanded Python pseudo sources as workspace files", () => {
  assert.equal(isPseudoDebugSourcePath("<django-shell-backend>"), true);
  assert.equal(isPseudoDebugSourcePath("/workspace/<django-shell-backend>"), true);
  assert.equal(isPseudoDebugSourcePath("file:///workspace/%3Cdjango-shell-backend%3E"), true);
  assert.equal(isPseudoDebugSourcePath("C:\\workspace\\<frozen importlib._bootstrap>"), true);
  assert.equal(isPseudoDebugSourcePath("/workspace/app/services.py"), false);
  assert.equal(isUserDebugSourcePath("/workspace/<django-shell-backend>"), false);

  const frames = [
    { ...frame("/workspace/<django-shell-backend>", 1700), source: { name: "<django-shell-backend>", path: "/workspace/<django-shell-backend>" } },
    frame("/workspace/.django-shell/console-cell.py", 6)
  ];
  const selected = choosePreferredDebugSourceFrame(frames, { preferOverlay: true, workspaceRoots: ["/workspace"] });
  assert.equal(selected.source.path, "/workspace/.django-shell/console-cell.py");
});

function frame(path, line) {
  return { id: line, line, name: path.split("/").at(-1), source: { path } };
}
