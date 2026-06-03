// SQL pretty-printer and syntax highlighter for the model browser query log.

const KEYWORDS = new Set([
  "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "ON",
  "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "JOIN", "GROUP", "BY", "ORDER", "HAVING",
  "LIMIT", "OFFSET", "ASC", "DESC", "UNION", "ALL", "EXISTS", "LIKE", "ILIKE", "BETWEEN",
  "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "RETURNING", "USING", "WITH", "TRUE", "FALSE"
]);

const TOKEN = /('(?:[^']|'')*')|("(?:[^"]|"")*")|(\d+(?:\.\d+)?)|(%\(\w+\)s|%s|\$\d+|\?)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([^\s])/g;
const CLAUSE = /\s+\b(FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|UNION ALL|UNION|INNER JOIN|LEFT OUTER JOIN|LEFT JOIN|RIGHT JOIN|CROSS JOIN|JOIN|RETURNING)\b/gi;

/** Returns the SQL reformatted with each clause and select column on its own line. */
export function formatSqlText(sql) {
  let text = String(sql || "").replace(/\s+/g, " ").trim();
  text = text.replace(CLAUSE, "\n$1");
  const lines = text.split("\n");
  const head = lines[0].match(/^(SELECT(?:\s+DISTINCT)?)\s+([\s\S]*)$/i);
  if (head) {
    lines[0] = `${head[1]}\n  ${head[2].split(/,\s*/).join(",\n  ")}`;
  }
  return lines.join("\n");
}

/** Appends syntax-highlighted, formatted SQL as safe DOM nodes under parent. */
export function highlightSqlInto(parent, sql) {
  const text = formatSqlText(sql);
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match[6]) {
      parent.appendChild(document.createTextNode(match[6]));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = match[0];
    span.className = tokenClass(match);
    parent.appendChild(span);
  }
}

/** Prepends one query-log entry (Django ORM command + highlighted SQL) and caps the log length. */
export function appendLogEntry(logbody, action, sqlList, orm, max) {
  const list = Array.isArray(sqlList) ? sqlList : [];
  const entry = document.createElement("div");
  entry.className = "logentry";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${new Date().toLocaleTimeString()}  ·  ${action}`;
  entry.appendChild(meta);
  if (orm) {
    const command = document.createElement("code");
    command.className = "ormcmd";
    command.textContent = orm;
    entry.appendChild(command);
  }
  if (!list.length) {
    const empty = document.createElement("code");
    empty.className = "sql";
    empty.textContent = "(no SQL)";
    entry.appendChild(empty);
  }
  for (const item of list) {
    const code = document.createElement("code");
    code.className = "sql";
    highlightSqlInto(code, item.sql);
    if (item.time) {
      const time = document.createElement("span");
      time.className = "sql-time";
      time.textContent = `   — ${item.time}s`;
      code.appendChild(time);
    }
    entry.appendChild(code);
  }
  logbody.insertBefore(entry, logbody.firstChild);
  while (logbody.childElementCount > max) {
    logbody.removeChild(logbody.lastChild);
  }
}

/** Returns the highlight class for one matched SQL token. */
function tokenClass(match) {
  if (match[1]) {
    return "sql-str";
  }
  if (match[2]) {
    return "sql-ident";
  }
  if (match[3]) {
    return "sql-num";
  }
  if (match[4]) {
    return "sql-param";
  }
  if (match[5]) {
    return KEYWORDS.has(match[5].toUpperCase()) ? "sql-kw" : "sql-name";
  }
  return "sql-punct";
}
