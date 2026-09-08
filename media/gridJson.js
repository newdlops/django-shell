// Parses and serializes editable JSON while preserving integers outside JavaScript's safe numeric range.

/** Parses JSON with exact integer tokens represented as BigInt only inside the editor. */
export function parseJsonExact(source) {
  const text = String(source);
  let index = 0;
  /** Consumes only whitespace permitted by JSON. */
  function whitespace() { while (/[ \t\r\n]/.test(text[index] || "x")) { index++; } }
  /** Rejects incomplete or malformed JSON instead of silently changing its meaning. */
  function invalid() { throw new SyntaxError(`Invalid JSON at position ${index}.`); }
  /** Reads a quoted JSON string, delegating escape validation to the native parser. */
  function string() {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === "\\") { index++; }
      else if (char === '"') { return JSON.parse(text.slice(start, index)); }
    }
    return invalid();
  }
  /** Reads one JSON value and recursively preserves exact nested integers. */
  function value() {
    whitespace();
    const char = text[index];
    if (char === '"') { return string(); }
    if (char === "[" || char === "{") {
      const array = char === "[", result = array ? [] : {}, end = array ? "]" : "}";
      index++; whitespace();
      if (text[index] === end) { index++; return result; }
      for (;;) {
        whitespace();
        let key;
        if (!array) {
          if (text[index] !== '"') { return invalid(); }
          key = string(); whitespace();
          if (text[index++] !== ":") { return invalid(); }
        }
        const item = value();
        if (array) { result.push(item); }
        else { Object.defineProperty(result, key, { configurable: true, enumerable: true, value: item, writable: true }); }
        whitespace();
        if (text[index] === end) { index++; return result; }
        if (text[index++] !== ",") { return invalid(); }
      }
    }
    for (const [token, literal] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(token, index)) { index += token.length; return literal; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))?.[0];
    if (!token) { return invalid(); }
    index += token.length;
    const number = Number(token);
    return /^-?\d+$/.test(token) && !Number.isSafeInteger(number) ? BigInt(token) : number;
  }
  const result = value();
  whitespace();
  if (index !== text.length) { invalid(); }
  return result;
}

/** Serializes an editor value as JSON text, emitting BigInt values as numeric tokens rather than strings. */
export function stringifyJsonExact(value) {
  if (typeof value === "bigint") { return value.toString(); }
  if (Array.isArray(value)) { return `[${value.map((item) => stringifyJsonExact(item) ?? "null").join(",")}]`; }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${stringifyJsonExact(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
