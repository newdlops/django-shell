// Shared debugpy stepping filters for Django shell debug sessions.

export interface DebugpySteppingRule {
  include: boolean;
  path: string;
}

/** Returns debugpy stepping filters that keep shell debugging on user source. */
export function buildDebugpySteppingRules(): DebugpySteppingRule[] {
  return [
    { include: false, path: "<django-shell-backend>" },
    { include: false, path: "*/django_shell_backend.py" },
    { include: false, path: "*/socketserver.py" },
    { include: false, path: "*/threading.py" },
    { include: false, path: "*/site-packages/*" },
    { include: false, path: "*\\site-packages\\*" },
    { include: false, path: "*/dist-packages/*" },
    { include: false, path: "*\\dist-packages\\*" }
  ];
}
