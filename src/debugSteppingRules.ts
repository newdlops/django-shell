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
    { include: false, path: "**/socketserver.py" },
    { include: false, path: "**/threading.py" },
    { include: false, path: "**/lib/python*/**" },
    { include: false, path: "**/site-packages/**" },
    { include: false, path: "**/dist-packages/**" }
  ];
}
