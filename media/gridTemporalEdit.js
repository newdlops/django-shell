// Preserves stored ISO offsets and precision while editing wall-clock date and time components.

/** Splits an ISO value without interpreting its wall clock in the browser's time zone. */
function parts(raw) {
  const value = String(raw || "").replace(" ", "T");
  const match = value.match(/^(.*?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  return { clock: match?.[1] || "", fraction: match?.[2] || "", offset: match?.[3] || "" };
}

/** Returns second-resolution picker text while retaining precision separately for storage. */
export function temporalEditorValue(type, raw) {
  return type === "DateField" ? String(raw || "").slice(0, 10) : parts(raw).clock;
}

/** Restores the original fixed UTC offset and unedited fractional seconds after a clock edit. */
export function temporalStoredValue(type, original, edited) {
  if (!edited || type === "DateField") { return edited; }
  const before = parts(original), after = parts(edited);
  const clock = /(?:T|^)\d{2}:\d{2}$/.test(after.clock) ? `${after.clock}:00` : after.clock;
  return `${clock}${after.fraction || before.fraction}${before.offset}`;
}

/** Describes the fixed offset used by the picker instead of implying the browser's local time zone. */
export function temporalEditorLabel(type, raw) {
  const offset = parts(raw).offset;
  return type === "DateField" ? "Date" : `${type === "TimeField" ? "Time" : "Date and time"} (${offset === "Z" ? "UTC" : offset ? `UTC${offset}` : "Django local time"})`;
}
