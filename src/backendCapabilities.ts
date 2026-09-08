// Composes small runtime capabilities from a verified index of the existing Python backend source.
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { deflateSync } from "zlib";

export type BackendCapability = "base" | "grid" | "schema" | "inspection" | "query" | "models" | "commit" | "execution" | "extras";
export interface BackendCapabilityPayload { data: string; digest: string; feature: BackendCapability; requires: BackendCapability[] }
interface CapabilityIndex { version: number; sourceDigest: string; requires: Record<BackendCapability, BackendCapability[]>; units: { start: number; end: number; feature: BackendCapability }[] }

/** Reads the generated index only when it exactly matches the source bundled with this extension. */
export function backendCapabilityPayload(runtimePath: string, source: string, feature: BackendCapability): BackendCapabilityPayload | undefined {
  const indexPath = path.join(path.dirname(runtimePath), "django_shell_backend.runtime.json");
  if (!fs.existsSync(indexPath)) { return undefined; }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as CapabilityIndex;
  if (index.version !== 1 || index.sourceDigest !== createHash("sha256").update(source).digest("hex")) {
    throw new Error("Backend capability index is stale. Rebuild the extension before connecting.");
  }
  const lines = source.split("\n");
  const selected = index.units.filter((unit) => unit.feature === feature).map((unit) => lines.slice(unit.start, unit.end).join("\n"));
  if (feature === "base") { selected.push('_STATE["capabilities"] = {"base"}'); }
  const data = deflateSync(Buffer.from(selected.join("\n\n")), { level: 9 }).toString("base64");
  return { data, digest: createHash("sha256").update(data, "ascii").digest("hex"), feature, requires: index.requires[feature] };
}
