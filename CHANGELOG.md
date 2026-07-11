# Changelog

All notable user-facing changes to the **Django Shell** VS Code extension.

This extension uses a `0.0.x` running build number rather than strict semantic
versioning; the `0.0.9xx` series is the current line (it follows `0.0.8`, with no
`0.0.9`/`0.0.90` in between). The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added
- **Built-in experimental debugger engine** — `djangoShell.debug.engine` can start the bundled dependency-free tracer directly inside a live shell while keeping debugpy as the default. No companion extension, package install, or Python runtime Setup step is required. Its workspace watcher also deep-reloads changed loaded modules while retaining live function, decorator, class-method, property, and URL-conf references.
- Conditional breakpoint expressions, hit conditions, and logpoint messages are now preserved when Django Shell mirrors generated-source breakpoints into DAP or file mode.

### Changed
- Debug runs clear adapter-side breakpoints when they finish, and the built-in tracer uses explicit per-cell thread opt-in so a warm experimental session cannot pause an ordinary shell execution or newly-created background thread.

## [0.0.903] — 2026-06-10

### Added
- **Sortable computed columns** — `+ Column` aggregate / window / F-expression
  columns can now be sorted by clicking their header; the sort is applied as
  `order_by` after `.annotate()`, consistently across the ORM, socket, and
  terminal transports (read-only `@property` columns stay unsortable). A lazy
  `@property` column reloaded while sorted by an annotation stays aligned to the
  visible page.
- **Transform & extract filter operators** — char/text fields gain `length`
  (`=`/`>`/`≥`/`<`/`≤`) and a whitespace-stripped `trim =` (Django `Length`/`Trim`,
  registered on `CharField`/`TextField` at attach time); date/time fields gain
  `weekday`, `quarter`, `hour`, `minute`, `second` extracts (Django built-ins).
  All are honored by the row count and every transport, are allowlisted
  (injection-proof), and are dropped rather than raising on an incompatible field.
- **Removable filter chips** — each applied filter shows a chip with an **✕** that
  drops just that filter and re-runs the query, leaving the other filters, the
  sort, and any computed columns intact.

### Fixed
- **`+ Column` aliases are filterable right away** — an open filter term now
  refreshes its field list in place when an annotation/aggregate column is added
  (in both the rows and group-by views), so its alias is immediately searchable
  instead of only appearing in a brand-new term; a duplicate alias entry in ORM
  mode is also gone.

### Changed
- Documentation accuracy pass — the README now matches the shipped behavior: the
  four transport modes with **ORM** as the default, the `+ Column`
  aggregate/window builder, cascading relation-traversal filters, row
  virtualization, column resize, on-demand computed columns, the
  `Show Diagnostics Log` command, and the `modelBrowser.transport` /
  `autoImportModels` settings.
- Added this `CHANGELOG.md`.

## [0.0.902] — 2026-06-10

### Added
- **`+ Column` builder** in the model data browser — add computed columns without
  writing code: **aggregates** (Count / Sum / Avg / Min / Max over a field or a
  relation), **window functions** (Rank / DenseRank / RowNumber and running
  Sum/Avg/Min/Max/Count with partition-by and order-by), and **F-expression**
  arithmetic.
- **Group-by collapse** — add group-by fields and the rows roll up into a
  read-only per-group summary; the active filters become the `WHERE` clause and a
  lookup on an aggregate column becomes a `HAVING` filter.
- **Cascading relation-traversal filters** — filter terms are now chains of
  field/relation dropdowns (e.g. `author ▸ profile ▸ city`) that drill across
  foreign keys, reverse FKs, one-to-one and M2M relations, with value editors that
  adapt to the field type (from/to range pair, `in` chip list, is-null toggle).
- **Searchable comboboxes** for the field, operator, choice, and column-builder
  dropdowns — type to filter; free text is rejected so every value stays within
  the allowlist.

### Changed
- Filter, traversal-path, and computed-column identifiers are allowlisted against
  the live model graph (injection-proof); a path crossing a to-many relation
  auto-applies `.distinct()`.

## [0.0.901] — 2026-06-07

### Added
- **Interactive model data browser** — the read grid from 0.0.8 becomes a full
  SQL-client-style tool: each model opens in its own tab (open several views of
  one model side by side).
- **Structured filters** — field + lookup + value + negate chips that compile to
  allowlisted, injection-proof ORM `Q` objects.
- **Lazy relations** — a foreign key expands the related row on demand (⎘) or
  opens the target model in a new pre-filtered tab (↗); reverse-FK / one-to-one /
  M2M relations appear as expandable columns that load only when clicked, and
  concrete related sets are editable inline.
- **Transactional inline editing** — edits are staged in the grid (dirty cells
  highlighted) and committed all-at-once: the whole batch is validated with
  `full_clean()`, saved in one `transaction.atomic()`, and rolled back with
  per-field errors on any failure.
- **Type-aware cell editors** — dropdowns for choice fields and booleans, native
  date/time pickers, and a live foreign-key search picker (configurable via
  `djangoShell.modelBrowser.lookupExcludeFields`).
- **Run ORM Query console** — write your own ORM code and tabulate the final
  expression in the same grid; editable single-model results commit through the
  same path.
- **Row virtualization** plus a frozen left `#` row-number gutter, and
  **drag-to-resize** columns, so very large result sets scroll smoothly while pins
  and staged edits are preserved.
- **On-demand computed columns** — read-only `@property` / `GeneratedField` /
  annotation columns load one column at a time (no eager N+1), reporting the
  actual SQL query count.
- **ORM transport mode** (now the default) and a per-panel
  **`Link: Auto / Socket / Terminal / ORM`** selector — grid reads run as your own
  literal Django ORM cells so a server-side `pre_run_cell` audit logs real Django
  ORM, and the browser works over remote SSH / `kubectl exec` shells where the
  loopback socket is unreachable.
- **`Show Diagnostics Log`** command, and the **`djangoShell.modelBrowser.transport`**
  and **`djangoShell.autoImportModels`** settings (the latter binds installed
  models into the shell namespace at startup, so bare model names resolve
  immediately).
- A draggable divider to resize the SQL/ORM query log against the table (height
  persisted).

### Fixed
- A spurious "save changes?" prompt that appeared on window reload or exit; the
  overlay analysis backing files are now kept clean.

## [0.0.8] — 2026-06-04

### Added
- **Models activity-bar view** — a searchable, collapsible app→model tree of the
  installed models, with the `Browse Model Data` and `Refresh Model Catalog`
  commands.
- **Read-only model grid** — reads a model's rows with a single no-JOIN `SELECT`
  (foreign keys as raw `*_id` columns) and never calls `__str__` on a row, so
  browsing causes no extra queries.
- Keyset pagination with a rows-per-page selector and on-demand row counts.
- Click-to-sort column headers (asc / desc / none) and left-pinned (frozen)
  columns.
- A toggleable query log showing the real executed SQL (captured regardless of
  `DEBUG`) with syntax highlighting.

## [0.0.7] — 2026-05-31

### Changed
- Steadier overlay-editor rendering of hidden preludes and the current Python
  input block.

## [0.0.6] — 2026-05-26

### Changed
- More reliable console input handling and overlay prelude/input rendering when
  running the current input block.

## [0.0.5] — 2026-05-26

### Added
- Generated import preludes and shell prompts stay hidden from the visible editor,
  so they never appear while you type or accept autocomplete.

### Fixed
- Python diagnostics in the overlay now line up with your actual input rather than
  hidden prelude lines.

## [0.0.4] — 2026-05-22

### Added
- Editor completion-request caching for snappier autocomplete.

### Fixed
- Stale generated overlay Python files are reset on restart so IntelliSense
  reflects the current session.
- Stray editor tabs the workbench opens for generated overlay backing files are
  closed automatically.

## [0.0.3] — 2026-05-22

### Changed
- The `.djshell` notebook console is **deprecated** and now loads only on demand
  via `Open Notebook Console (Deprecated)`; the custom console is the primary
  surface.
- Hardened Python input execution and editor behavior.

## [0.0.2] — 2026-05-19

### Added
- `Run Current Python Input` command for running the current block from the
  overlay editor.
- Expanded embedded console rendering and the workbench overlay editor.

## [0.0.1] — 2026-05-19

### Added
- Initial proof of concept: attaches an in-process backend to a live
  `manage.py shell` and runs Python in the shell's own namespace, capturing
  stdout, stderr, the last expression's value, and tracebacks.
- Embedded custom console, a workbench-hosted overlay Python editor with
  IntelliSense, and the `Open Console` command.
- Runtime inspector tree that browses the live namespace (variables, modules,
  attributes) without evaluating properties at the top level.
- `Show Process Environment` command and the initial (later deprecated)
  `.djshell` notebook console.
- Settings: `autoActivateWorkspaceVenv`, `enableCodeActions`,
  `enableModelPreludeImports`, `enableRuntimeCompletion`, `diagnosticLogging`.
