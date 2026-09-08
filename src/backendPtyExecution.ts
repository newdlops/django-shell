// Shares the decision to execute a literal terminal cell or load the instrumented execution capability.
import type { BackendRequestPayload } from "./backendClient";

/** Reports whether the capture hooks can handle a request without the instrumented RPC executor. */
export function usesLiteralPtyCell(payload: BackendRequestPayload, cellCapture: boolean, ipython: boolean): boolean {
  return (payload.kind === "execute" || payload.kind === "ormcell") && typeof payload.code === "string" && cellCapture
    && (ipython || !payload.code.includes("\n")) && !wantsPtyProgress(payload) && !wantsPtyDebugWrapper(payload);
}

/** Keeps progress-aware execution on the instrumented RPC path. */
function wantsPtyProgress(payload: BackendRequestPayload): boolean {
  return payload.kind === "execute" && /\bfor\b|\btqdm\s*\(|\.iterator\s*\(|\.objects\b|QuerySet\b/.test(payload.code ?? "");
}

/** Preserves backend compile metadata required for debugger breakpoints. */
function wantsPtyDebugWrapper(payload: BackendRequestPayload): boolean {
  return payload.kind === "execute" && Array.isArray(payload.breakpointLines);
}
