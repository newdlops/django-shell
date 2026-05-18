// Converts renderer-side overlay diagnostics into extension output logs.

import { DiagnosticFields, DiagnosticLogger } from "./diagnostics";

/** Writes one sanitized renderer diagnostic payload. */
export function logOverlayRendererPayload(logger: DiagnosticLogger | undefined, payload: unknown): void {
  const event = eventName(payload);
  if (!event) {
    return;
  }
  logger?.log(`overlay.cell.${event}`, eventFields(payload));
}

/** Returns a safe renderer event name. */
function eventName(payload: unknown): string | undefined {
  const event = (payload as { event?: unknown })?.event;
  return typeof event === "string" ? event.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) : undefined;
}

/** Returns simple scalar fields from a renderer payload. */
function eventFields(payload: unknown): DiagnosticFields {
  const fields: DiagnosticFields = {};
  const raw = payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (["code", "event", "token", "type"].includes(key)) {
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      fields[key] = typeof value === "string" ? value.slice(0, 240) : value;
    }
  }
  return fields;
}
