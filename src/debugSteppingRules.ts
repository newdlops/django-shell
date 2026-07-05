// Shared debugpy stepping filters for Django shell debug sessions.

export interface DebugpySteppingRule {
  include: boolean;
  path: string;
}

/** Returns debugpy stepping filters that keep shell debugging on user source. */
export function buildDebugpySteppingRules(): DebugpySteppingRule[] {
  // pydevd glob semantics: a single `*` never crosses path separators, so every path rule needs `**`. Forward slashes
  // work on Windows too (pydevd converts the altsep before matching).
  return [
    { include: false, path: "<django-shell-backend>" },
    { include: false, path: "**/django_shell_backend.py" },
    // The interactive shell's ancestor frames live in manage.py: stepping past a cell must run on instead of trapping there.
    { include: false, path: "**/manage.py" },
    // With justMyCode:false, stepping (or step-in) over a `from x import y` that first-imports a module would otherwise
    // trap in Python's import machinery. Frozen stdlib modules report `<frozen ...>` filenames; importlib lives on disk.
    { include: false, path: "<frozen *>" },
    { include: false, path: "**/importlib/**" },
    { include: false, path: "**/socketserver.py" },
    { include: false, path: "**/threading.py" },
    { include: false, path: "**/lib/python*/**" },
    { include: false, path: "**/site-packages/**" },
    { include: false, path: "**/dist-packages/**" }
  ];
}
