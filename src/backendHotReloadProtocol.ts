// Typed parser for the Django Shell backend's built-in hot-reload response.

export interface BackendHotReloadFileResult {
  message: string;
  module?: string;
  patched: string[];
  path: string;
  status: "ok" | "partial" | "error" | "skipped";
}

export interface BackendHotReloadResult {
  engine: "experimental";
  error?: string;
  ok: boolean;
  results: BackendHotReloadFileResult[];
}

/** Parses built-in hot-reload results while discarding malformed per-file rows. */
export function parseHotReloadResponse(buffer: string): BackendHotReloadResult {
  const value: unknown = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}");
  if (!isRecord(value) || value.engine !== "experimental") { throw new Error("Invalid built-in hot-reload response engine."); }
  const parsed = value as Partial<BackendHotReloadResult>;
  const results = Array.isArray(parsed.results) ? parsed.results.flatMap((raw) => {
    if (!isRecord(raw)) { return []; }
    const row = raw as Partial<BackendHotReloadFileResult>;
    if (typeof row.path !== "string" || typeof row.message !== "string" || !["ok", "partial", "error", "skipped"].includes(row.status ?? "")) { return []; }
    return [{ message: row.message, module: typeof row.module === "string" ? row.module : undefined, patched: Array.isArray(row.patched) ? row.patched.filter((name): name is string => typeof name === "string") : [], path: row.path, status: row.status as BackendHotReloadFileResult["status"] }];
  }) : [];
  return { engine: "experimental", error: typeof parsed.error === "string" ? parsed.error : undefined, ok: Boolean(parsed.ok), results };
}

/** Narrows untrusted JSON objects before reading protocol fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the stable result shape for a socket-only transport failure. */
export function hotReloadTransportError(error: string): BackendHotReloadResult {
  return { engine: "experimental", error, ok: false, results: [] };
}
