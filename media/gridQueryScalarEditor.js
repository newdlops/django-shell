// Field-aware scalar parsing and native-input selection for Query Builder controls.

const NUMERIC_TYPES = /Integer|Float|Decimal|AutoField/;
const EXTRACT_LOOKUPS = new Set(["year", "quarter", "month", "week_day", "day", "hour", "minute", "second"]);

/** Returns a native input type that preserves the selected Django field's scalar shape. */
export function inputTypeForQueryScalar(field, lookup) {
  const type = EXTRACT_LOOKUPS.has(lookup) || lookup?.startsWith("length") ? "IntegerField" : (lookup === "date" ? "DateField" : field?.type);
  if (type === "DateField") { return "date"; }
  if (type === "DateTimeField") { return "datetime-local"; }
  if (type === "TimeField") { return "time"; }
  return NUMERIC_TYPES.test(String(type || "")) ? "number" : "text";
}

/** Parses one native form value into a JSON-safe QueryScalar without implicit coercion. */
export function parseQueryScalar(field, raw) {
  if (raw === "") { return null; }
  if (field?.type === "BooleanField") { return raw === true || raw === "true"; }
  if (NUMERIC_TYPES.test(String(field?.type || "")) && typeof raw === "string") {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  return raw;
}
