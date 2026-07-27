// Immutable, plain-language copy registry for the Model Query Builder.

/** Freezes one guidance entry so view code cannot accidentally alter shared copy. */
function entry(label, description, extra = {}) { return Object.freeze({ label, description, ...extra }); }

/** Fixed section titles, technical labels, and onboarding text. */
export const QUERY_SECTION_GUIDANCE = Object.freeze({
  where: entry("Filter source rows", "Choose which model rows enter the query. An empty section includes every row.", { technical: "WHERE" }),
  computed: entry("Add calculated values", "Create values for filtering, sorting, or display without changing the database.", { technical: "Computed columns" }),
  postFilter: entry("Filter calculated results", "Filter after calculated values are available. Use this for computed aliases and summary totals.", { technical: "Result filter" }),
  result: entry("Shape and order the result", "Choose row-level data or a summary, then control grouping and order.", { technical: "Result" }),
  preview: entry("Understand and validate", "Review the plain meaning, implicit behavior, and Django ORM before applying the draft.", { technical: "Preview" })
});

/** Supported lookup names expressed as user-facing comparisons. */
export const QUERY_LOOKUP_GUIDANCE = Object.freeze({
  exact: entry("equals", "Matches the same value."), iexact: entry("equals, ignoring case", "Matches the same text regardless of letter case.", { qualifier: " (case-insensitive)" }),
  contains: entry("contains", "Matches text containing the value."), icontains: entry("contains, ignoring case", "Matches text containing the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  startswith: entry("starts with", "Matches text beginning with the value."), istartswith: entry("starts with, ignoring case", "Matches text beginning with the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  endswith: entry("ends with", "Matches text ending with the value."), iendswith: entry("ends with, ignoring case", "Matches text ending with the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  gt: entry("is greater than", "Uses a strict numeric or date comparison."), gte: entry("is at least", "Includes the lower boundary."), lt: entry("is less than", "Uses a strict numeric or date comparison."), lte: entry("is at most", "Includes the upper boundary."),
  in: entry("is in this list", "Any listed value may match."), range: entry("is between", "Includes both boundaries."), isnull: entry("has or lacks a value", "Checks a database null, not empty text."), blank: entry("is blank", "Uses the existing null-or-empty blank semantics."), not_blank: entry("is not blank", "Keeps values that are neither null nor empty."), trim: entry("equals after trimming spaces", "Trims surrounding spaces before comparison."),
  length: entry("has length equal to", "Compares text length."), length__gt: entry("has length greater than", "Compares text length."), length__gte: entry("has length at least", "Compares text length."), length__lt: entry("has length less than", "Compares text length."), length__lte: entry("has length at most", "Compares text length."),
  date: entry("has date equal to", "Compares the date part of a date-time."), year: entry("is in year", "Extracts the year."), quarter: entry("is in quarter", "Uses 1 through 4."), month: entry("is in month", "Uses 1 through 12."), week_day: entry("is on weekday", "Uses Django numbering: Sunday 1 through Saturday 7."), day: entry("is on day of month", "Uses 1 through 31."), hour: entry("is in hour", "Uses 0 through 23."), minute: entry("is in minute", "Uses 0 through 59."), second: entry("is in second", "Uses 0 through 59.")
});

/** Available right-hand comparison sources. */
export const QUERY_RHS_GUIDANCE = Object.freeze({
  literal: entry("A value", "Compare with a fixed value you enter."), field: entry("Another field in this row", "Compare with a field from the same model row (Django F expression)."), outerField: entry("Field from the current outer row", "Use a field from the row that opened this subquery (Django OuterRef)."), relativeTime: entry("Relative date or time", "Build a value relative to now or today when the query runs.")
});

/** Calculated-column choices and their bounded use cases. */
export const QUERY_COMPUTED_KIND_GUIDANCE = Object.freeze({
  aggregate: entry("Count or summarize values", "Create Count, Sum, Average, Minimum, or Maximum.", { limit: "Fan-out safety and distinct rules apply." }),
  scalarSubquery: entry("Bring back one matched value", "Run a bounded subquery for each current row and return one value.", { limit: "A correlation and order are often needed." }),
  exists: entry("Check whether a match exists", "Create a true/false value from a related or custom-model match.", { limit: "It does not select a scalar value." }),
  formula: entry("Combine values", "Build arithmetic, text, function, Case, or Cast expressions.", { limit: "Only earlier calculated aliases are available." }),
  window: entry("Rank or calculate across rows", "Create rank, row number, or running aggregate values.", { limit: "A stable order is required." }),
  codeExpression: entry("Restricted Django expression", "Advanced: enter the allowlisted single-line expression form.", { limit: "Transport support and the 800-character limit apply." })
});

/** Formula-editor concepts for concise contextual helpers. */
export const QUERY_FORMULA_KIND_GUIDANCE = Object.freeze({
  field: entry("Field", "Use a value from the current model row."), computed: entry("Calculated value", "Use an enabled value declared earlier in this list."), literal: entry("Fixed value", "Use a JSON-safe fixed value."), binary: entry("Math", "Combine two numeric values."), function: entry("Function", "Apply one of the supported expression functions."), case: entry("Conditional value", "Choose a value based on conditions."), cast: entry("Convert type", "Declare the result type used by the expression.")
});

/** Rows and summary result modes. */
export const QUERY_RESULT_MODE_GUIDANCE = Object.freeze({
  rows: entry("Rows", "Keep one result row per matching model row. Calculated values appear as extra columns."),
  summary: entry("Summary", "Return grouped or global totals. Summary results are read-only.")
});

/** Lifecycle labels used in the drawer and summary band. */
export const QUERY_STATUS_GUIDANCE = Object.freeze({
  draft: entry("Draft changed", "The grid still shows the applied Recipe revision."), checking: entry("Checking the latest draft…", "The builder is validating this query."), valid: entry("Ready to apply.", "No validation errors were found."), warning: entry("Ready to apply with warnings.", "Review the warnings before applying."), applying: entry("Applying Recipe…", "You can continue editing a newer draft."), rejected: entry("The draft was not applied.", "The previous grid remains visible."), metadataError: entry("Field details are unavailable.", "Retry to continue."), transportUnsupported: entry("This draft cannot run through this link.", "Change the query or select a supported link.")
});

/** Makes a stable key readable when a future server adds an option before the UI copy does. */
export function sentenceCase(value) { return String(value || "Query option").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (character) => character.toUpperCase()); }

/** Returns copy for a lookup without preventing a compatible future backend option. */
export function guidanceForLookup(name) { return QUERY_LOOKUP_GUIDANCE[name] || entry(sentenceCase(name), "This option is supported by the current query contract."); }

/** Returns copy for a computed kind without exposing raw protocol details. */
export function guidanceForComputedKind(kind) { return QUERY_COMPUTED_KIND_GUIDANCE[kind] || entry(sentenceCase(kind), "This option is supported by the current query contract."); }
