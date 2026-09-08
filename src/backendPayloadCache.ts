// Builds a bounded, hash-checked remote cache probe that runs before the backend exists.
import { createHash } from "crypto";
import { renderPythonTemplate } from "./pythonTemplate";

/** Identifies the exact base64 payload bytes, independently of Python or zlib versions on the server. */
export function backendPayloadDigest(data: string): string {
  return createHash("sha256").update(data, "ascii").digest("hex");
}

/** Builds a fail-open cache probe; only the payload shipped by this extension can reach compile/exec. */
export function backendCacheProbePython(data: string, load: string, needsInlinePrefix: string): string {
  return renderPythonTemplate("cache_probe.py.tmpl", {
    DIGEST: JSON.stringify(backendPayloadDigest(data)),
    LOAD: load,
    NEEDS_INLINE_PREFIX: JSON.stringify(needsInlinePrefix),
    READ_SIZE: String(data.length + 1)
  });
}
