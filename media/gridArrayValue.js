// Reads array shape from cell metadata and memoizes only legacy item counts, leaving full parsing to editing.
import { parseEditableArray } from "./gridArrayEdit.js";

const cells = new WeakMap();
const texts = new Map();
const TEXT_CACHE_BYTES = 1024 * 1024;
let retainedBytes = 0;

/** Returns a list's length without repeatedly materializing the full value while painting cells. */
export function editableArrayLength(column, cell) {
  if (!column || !["ArrayField", "JSONField"].includes(column.type)) { return undefined; }
  if (cell && typeof cell === "object") {
    if (cell.kind) { return cell.kind === "array" && Number.isSafeInteger(cell.len) && cell.len >= 0 ? cell.len : undefined; }
    if (cells.has(cell)) { return cells.get(cell); }
    const count = legacyLength(column, String(cell.edit ?? cell.v ?? ""));
    cells.set(cell, count);
    return count;
  }
  const text = String(cell ?? "");
  if (!text.trim() && column.type === "ArrayField") { return 0; }
  if (texts.has(text)) { return texts.get(text); }
  const count = legacyLength(column, text);
  const bytes = text.length * 2;
  if (bytes <= TEXT_CACHE_BYTES) {
    while (texts.size && (texts.size >= 32 || retainedBytes + bytes > TEXT_CACHE_BYTES)) {
      const oldest = texts.keys().next().value;
      retainedBytes -= oldest.length * 2; texts.delete(oldest);
    }
    texts.set(text, count); retainedBytes += bytes;
  }
  return count;
}

/** Handles older cell payloads once while avoiding JSON parsing for obvious scalar and object values. */
function legacyLength(column, text) {
  if (!text.trim() && column.type === "ArrayField") { return 0; }
  return text.trimStart().startsWith("[") ? parseEditableArray(column, text)?.items.length : undefined;
}
