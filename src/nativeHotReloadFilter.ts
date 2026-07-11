// Pure path filter shared by Django Shell's built-in hot-reload watcher and tests.

const EXCLUDED_SEGMENTS = [
  "/.django-shell/",
  "/.venv/",
  "/__pycache__/",
  "/dist-packages/",
  "/migrations/",
  "/node_modules/",
  "/site-packages/",
  "/venv/"
] as const;

/** Returns whether a changed path is generated, third-party, or otherwise unsafe to reload. */
export function shouldIgnoreNativeHotReload(filePath: string): boolean {
  const normalized = `/${String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()}`;
  return !normalized.endsWith(".py") || EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment));
}

export const NATIVE_HOT_RELOAD_EXCLUDED_SEGMENTS = EXCLUDED_SEGMENTS;
