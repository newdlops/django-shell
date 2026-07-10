# Django Shell

Django Shell is a VS Code extension for working inside a **real, live `manage.py shell` process**. It layers a notebook-like Python console, a workbench-hosted editor overlay, a runtime inspector, and a SQL-client-style **model data browser** (read, filter, sort, edit, and run custom ORM queries) on top of the actual Django ORM running in your shell session.

Unlike tools that spawn their own Python or parse your code statically, every feature here talks to an **in-process backend that runs inside the same namespace as your shell** — so the variables, imports, models, and database connection you see are exactly the ones the shell holds.

---

## Table of Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Features](#features)
  - [Custom console (REPL)](#custom-console-repl)
  - [Workbench overlay editor](#workbench-overlay-editor)
  - [IntelliSense model](#intellisense-model)
  - [Runtime inspector](#runtime-inspector)
  - [Model data browser](#model-data-browser)
  - [Inline editing](#inline-editing)
  - [Custom ORM query console](#custom-orm-query-console)
  - [Deprecated notebook console](#deprecated-notebook-console)
- [Commands](#commands)
- [Keybindings](#keybindings)
- [Settings](#settings)
- [Internals](#internals)
  - [Backend bootstrap](#backend-bootstrap)
  - [Transports](#transports)
  - [Request protocol](#request-protocol)
  - [Safety model](#safety-model)
  - [Generated files](#generated-files)
  - [Source layout](#source-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Architecture at a glance

```
VS Code extension host (TypeScript, out/extension.js)
   │
   ├─ Custom console panel ─┐
   ├─ Overlay editor       ─┤  user code / grid actions
   ├─ Runtime inspector    ─┤
   ├─ Model catalog + grid ─┘
   │
   │  JSON-line requests (token-authed)
   │  ┌─ TCP socket  (127.0.0.1:<random>) — code execution + inspection
   └──┤
      ├─ ORM cells over the terminal — default for model-browser reads
      └─ PTY/terminal fallback (marker lines, for remote SSH/kubectl)
   │
django_shell_backend.py  ── runs INSIDE the live `manage.py shell` process
   • shares the shell's namespace (your vars/imports/models)
   • serves requests under a single execution lock
   • live access to django.apps, ORM, model `_meta`, DB connection
```

The backend is a single Python module that the extension **injects into your running shell** (it is not imported as a separate process). Once attached, the extension drives all features through a small JSON request protocol.

---

## Requirements

- VS Code **1.92** or newer.
- The Microsoft **Python** extension and **Pylance** (for IntelliSense features).
- A Django project that can start an interactive shell (`manage.py shell` / `shell_plus`) from the workspace root.

Open the folder that contains `manage.py`, then run the console command. The native `node-pty` dependency drives the embedded terminal; `ws` backs the renderer transport.

---

## Quick start

1. Open a Django project folder in VS Code.
2. Run **`Django Shell: Open Console`** from the Command Palette.
3. In the setup terminal that opens, start the shell:

   ```sh
   python manage.py shell
   ```

4. Wait until the Python input cell is enabled — the extension has detected the interactive prompt and attached its backend.
5. Type Python in the input editor and run it with **Enter** (or `Ctrl/Cmd+Enter`). Use `Alt+Enter` to skip the highlighted execution unit without running it.

Code runs in the **same live namespace** as the attached shell. From there you can also open the **Models** view (activity bar) to browse tables, or run **`Django Shell: Run ORM Query`** to tabulate a custom query.

---

## Features

### Custom console (REPL)

- Opens an embedded **setup terminal** in the workspace root and detects when it enters an interactive Python/Django prompt (`python`, `ipython`, `shell_plus`).
- Optionally prepends a workspace `.venv`/`venv` to the terminal environment (`djangoShell.autoActivateWorkspaceVenv`).
- On attach, binds your installed model classes plus `django`/`apps`/`settings`/`models` into the live namespace (like `shell_plus`) so bare model names resolve immediately in the console and in ORM-mode grid reads; controlled by `djangoShell.autoImportModels` (see [Settings](#settings)).
- After the backend attaches, provides a Python input editor and runs code in the live shell namespace, capturing **stdout, stderr, the repr of the last expression, and tracebacks**.
- Multi-line input: leading statements execute, and the final expression's value is shown (and bound to `_`), mirroring an interactive REPL.
- **Restart Kernel** clears stale editor input, generated preludes, and runtime caches.

### Workbench overlay editor

- A workbench-hosted Python editor overlay provides a full editing surface (not just a single-line input) backed by an in-memory document, with its own renderers for prelude views, diagnostics, semantic highlighting, and completion widgets.
- Enter runs the current logical input when no completion/parameter widget is active; Shift+Enter inserts a newline; Ctrl/Cmd+Enter always runs; Alt+Enter skips the highlighted execution unit without running it.

### IntelliSense model

The extension creates generated Python files under `.django-shell/` so Pylance/Python language features work against shell input:

- `analysis.py` — provider-only runtime/source preludes plus user input (without the shell-input marker).
- `console-cell.py` — the same prelude plus a protected shell-input marker for editor identity; the visible cell shows only user input.

Runtime and source **preludes are kept separate from visible input**, so generated imports never appear while you type or accept autocomplete. After each execution the runtime imports are refreshed so dynamic variables can participate in analysis. These files are implementation details — **do not edit or commit them**.

Optional, off by default (expensive in large projects): forwarding code actions through the shadow document (`enableCodeActions`) and importing discovered workspace model classes into editor preludes (`enableModelPreludeImports`).

### Runtime inspector

A **Runtime** tree in the Django Shell activity bar exposes the live namespace:

- User variables and importable initial shell values.
- Loaded Python modules.
- Nested collection items and object attributes (from safe mappings).
- Inherited class attributes, dataclass fields (including `slots=True`), and property names/values.

Top-level inspection **never evaluates properties** (a getter can run arbitrary code); property values are only read when you explicitly expand an object. Inspection uses the socket bridge; over terminal-only fallback the view reports that remote inspection is disabled.

### Model data browser

A SQL-client-style grid over your live models, opened from the **Models** activity-bar view (a searchable, collapsible app→model tree) or `Django Shell: Browse Model Data`. **Each open is its own tab** — open as many models (or several views of the same model with different filters) side by side as you like.

- **No N+1.** Rows are read with a single `SELECT` via `_base_manager.values(*concrete_fields)`; foreign keys stay as raw `*_id` columns (no JOIN). Properties / `GeneratedField` / annotations are not auto-computed — they appear as read-only columns you load on demand (see **Computed columns**).
- **Pagination.** Keyset (pk cursor) by default for stability on large tables, with an OFFSET fallback for non-pk sorts. A **rows-per-page selector** (50 / 100 / 500 / 1000 / 5000 / 10000 / all) lets you trade speed for completeness; `all` is unbounded (not recommended) and is automatically reduced over the slower terminal transport.
- **Virtualization.** The grid windows its rows — rendering only those near the viewport plus spacer rows — so large or accumulated (Load-more / `all`) result sets stay responsive; tables of ≤ 80 rows render in full. Staged edits and the active cell editor survive re-windowing. A sticky left **`#` row-number gutter** numbers loaded rows and stays pinned during horizontal scroll.
- **Counts on demand.** `count()` is computed only when requested (it is expensive), consistent with the active filter set.
- **`+ Column` builder.** Build computed columns without writing code: **aggregates** (Count / Sum / Avg / Min / Max over a field or a relation, distinct-forced for Count over a to-many), structured **Subquery**, raw **Annotate**, **window functions** (Rank / DenseRank / RowNumber and running Sum/Avg/Min/Max/Count with partition-by and order-by), and **F-expression** arithmetic. Aggregate / Annotate / Subquery columns can add a type-aware condition group in the UI: combine up to eight field paths with **all / any**, negate individual terms, compare against a literal or another field (`F`), and compare a Subquery term against the current row (`OuterRef`). With no group-by the terms become per-row annotation columns; add group-by fields and the rows **collapse into a read-only per-group summary** (aggregates only). The active filters become the outer `WHERE` clause; a window column forces OFFSET pagination, and a lookup on an aggregate column becomes a `HAVING` filter. All identifiers are allowlisted against the live model graph.
- **Computed columns, on demand.** `@property` / `@cached_property` / `GeneratedField` / annotation columns are read-only and never auto-computed. A **▷** button in the header loads that one column's values for the currently-loaded rows; the header flags the cost (per-row `@property` N+1 vs. a single DB query) and the status line reports the actual query count. A model can opt a property into a single annotated query by declaring its ORM equivalent in a `djshell_annotations` map.
- **Relation-traversal filters.** Each filter term is a chain of searchable dropdowns — field → relation → field → … → lookup → value — that can drill across foreign keys, reverse FKs, one-to-one and M2M relations (e.g. `author ▸ profile ▸ city`); the related model's field tree is fetched lazily. Terms compile to **allowlisted** ORM `Q` objects (field names and lookups are allowlisted, so filters cannot be injected), value editors adapt to the field type (choice/boolean dropdowns, a from/to range pair, an `in` chip list, an is-null toggle), and computed/aggregate columns filter post-aggregation (`HAVING`). Beyond the plain comparisons, text fields also offer **transform operators** — `length` (`=`/`>`/`≥`/`<`/`≤`) and a whitespace-stripped `trim =` (Django `Length`/`Trim`) — and date/time fields offer **extracts** (`year`, `quarter`, `month`, `weekday`, `day`, `hour`, `minute`, `second`). Each applied filter appears as a chip in the bar; click its **✕** to drop just that one filter and re-run.
- **Sorting.** Click any header to cycle asc/desc/none — concrete columns **and `+ Column` aggregate / window / F-expression columns** sort server-side (the sort is pushed into `order_by` after `.annotate()`); read-only `@property` columns are excepted.
- **Field finder.** `Cmd/Ctrl+F` opens a searchable list of the grid's columns and relations; picking one scrolls that header into view and highlights it — handy on wide tables.
- **Relations, lazily.** A foreign key shows the raw id with two actions: **⎘** expands the related row inline in one bounded query, and **↗** opens the target model in a new tab pre-filtered to that row. Reverse-FK / one-to-one / M2M relations appear as columns whose chips expand into a bounded related-row table on click (an editable nested table when the relation is a concrete model). Nothing relational loads automatically.
- **SQL / ORM log.** Each `rows`/`related`/`count`/`aggregate`/`commit` captures the real executed SQL (via `CaptureQueriesContext`, regardless of `DEBUG`) and a reconstructed Django ORM expression. A toggleable, drag-resizable log panel shows time · action · statement, switchable between **SQL** and **Django ORM** views, with clause-aware formatting and syntax highlighting; the chosen height persists.
- **Column pinning.** Freeze concrete columns to the left while scrolling horizontally.
- **Column resize.** Drag a header's right edge to resize a column (the first drag freezes the table to a fixed layout so columns can both grow and shrink); widths persist within the panel.
- **Transport switch.** A per-panel `Link: Auto / Socket / Terminal / ORM` selector controls how the grid reaches the shell. **ORM is the default:** reads run as your own literal Django ORM cells in the shell, so a live `pre_run_cell` audit logs Django ORM rather than RPC plumbing (requires `shell_plus`/IPython). **Terminal** works everywhere — including remote SSH / `kubectl exec` shells where the loopback socket is unreachable. See [Transports](#transports).

### Inline editing

Editing is **staged in the webview and never touches the database until you commit** — nothing is sent to the server while you edit.

- Double-click an editable cell to edit it; dirty cells are highlighted. Multiple cells/rows can be edited, then committed together with **Commit (N)**.
- A commit sends one `commit` request: the backend validates **every** change with `full_clean()` first (all-or-nothing), then saves inside `transaction.atomic()` with `save(update_fields=...)`. On any failure the whole batch rolls back and **per-field errors** are returned. PK / auto / non-editable fields are rejected. Django signals fire normally.
- **Type-aware editors** (instead of plain text inputs):
  - **Choices (enum)** → dropdown of `[value, label]` (plus a `(null)` option when nullable); the committed cell shows the human label, not the raw key.
  - **BooleanField** → `true`/`false` dropdown (plus `(null)` for nullable booleans).
  - **Date / DateTime / Time** → native date/time pickers, with stored ISO values normalized to the input's expected shape.
- **Foreign-key searchable picker.** Editing an FK cell opens a live, debounced search box with arrow-key navigation: typing queries the target model (text fields via `icontains`, plus exact pk when numeric) in a single bounded `SELECT` and lists `#<pk> · <text fields>` candidates; choosing one stages its pk. By default **every text field is shown** — add substrings to `djangoShell.modelBrowser.lookupExcludeFields` to hide sensitive fields (e.g. `password`, `token`) from the picker's search and labels.
- **Editable related tables.** An expanded reverse-FK / M2M set (when it is a concrete model, not a single one-to-one) is itself editable inline, with its own **Commit (N)** button that saves against the related model through the same validated, transactional commit path.

> Edits are made with the **shell user's database privileges** and do not enforce Django auth/permissions — the grid edits the DB directly.

### Custom ORM query console

Opens a **single reusable panel** that renders the result of **your own ORM code** in the same grid — ideal for custom joins, aggregates, and `.values()` projections. Launch it from the **Models** view title bar (the ▶ button) or `Django Shell: Run ORM Query`; launching it again reveals the existing panel, and running new code replaces the result.

- **Multi-line code** is allowed; the **last expression's value** is tabulated (same semantics as the console). It is evaluated in the **live shell namespace**, so your variables/imports/models are available, and assignments persist (just like the shell).
- **Workbench overlay editing** provides the same Python completion, hover, signature, definition, and diagnostics bridge as the main shell editor. Plain Enter inserts a line; **Ctrl/Cmd+Enter** or **Run** submits the complete query document.
- **Result-type aware:** a model-instance `QuerySet` of a single concrete model renders editable rows via one bounded `.values()` SELECT (FK as `*_id`) **with the model's reverse-FK / M2M relations as expandable columns** (same as the model browser); `.values()` / `.values_list()` / joined / plain-list / scalar results render read-only.
- **Editing reuses the same commit path** when the result is editable (single model + pk) — the panel attaches the result's app/model to each commit.
- The result flows through the exact same grid renderer, SQL/ORM log, and pagination as the model browser; works over both socket and terminal transports.

> This is **explicit user `eval`** — distinct from the grid's "no implicit `__str__`/no automatic eval" safety rule. Rendering a result still avoids calling `str(instance)`; the only code executed is what you typed.

### Deprecated notebook console

`.djshell` notebooks and `Django Shell: Open Notebook Console (Deprecated)` are retained for existing users. New work should use the custom console.

---

## Commands

| Command | Purpose |
| --- | --- |
| `Django Shell: Open Console` | Open the primary custom console. |
| `Django Shell: Show Overlay Editor` | Show the workbench-hosted Python overlay editor. |
| `Django Shell: Run Current Python Input` | Run the current logical Python input block from the overlay. |
| `Django Shell: Skip Current Python Input` | Move past the highlighted Python input block without running it. |
| `Django Shell: Browse Model Data` | Open the model data browser grid (prompts for a model). |
| `Django Shell: Run ORM Query` | Open the custom ORM query console panel. |
| `Django Shell: Run Current ORM Query` | Run the complete document in the active ORM query overlay. |
| `Django Shell: Refresh Model Catalog` | Refresh the Models catalog view. |
| `Django Shell: Refresh Runtime Inspector` | Refresh the runtime tree view. |
| `Django Shell: Show Process Environment` | Show the attached process environment details. |
| `Django Shell: Show Diagnostics Log` | Enable diagnostic logging and reveal the `Django Shell` output channel. |
| `Django Shell: Open Notebook Console (Deprecated)` | Open the legacy `.djshell` notebook console. |

## Keybindings

In the overlay editor:

| Key | Action |
| --- | --- |
| Enter | Run the current Python input when completion/parameter widgets are not active. |
| Shift+Enter | Insert a newline. |
| Ctrl+Enter / Cmd+Enter | Run the current Python input. |
| Alt+Enter | Skip the highlighted Python input without running it. |

In the ORM query console: **Ctrl/Cmd+Enter** runs the query.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `djangoShell.modelBrowser.transport` | `"orm"` | Default transport for the model data browser, console, and query console: `orm` (run reads as your own literal Django ORM cells so a live `pre_run_cell` audit logs ORM, not RPC plumbing — needs `shell_plus`/IPython), `pty`/Terminal (compact reconstructed cells, works over remote SSH/`kubectl`), `auto` (socket first, terminal fallback), or `tcp`/Socket. Switchable per-panel via the `Link:` selector. |
| `djangoShell.autoImportModels` | `true` | Bind your workspace's model classes (and `django`/`apps`/`settings`/`models`) into the shell namespace at startup, like `shell_plus`, so names in the editor analysis prelude are importable. Base names and every registered model are bound regardless; this setting only controls the deeper module scan. Set `false` to skip it. |
| `djangoShell.autoActivateWorkspaceVenv` | `true` | Prepend a workspace `.venv`/`venv` to the setup terminal environment when present. |
| `djangoShell.enableCodeActions` | `false` | Forward code actions through generated Python shadow documents. Expensive in large projects. |
| `djangoShell.enableModelPreludeImports` | `false` | Scan workspace model files and import discovered model classes into editor preludes. Expensive in large projects. |
| `djangoShell.enableRuntimeCompletion` | `false` | Enable deprecated notebook-cell runtime variable completions (affects only the legacy `.djshell` console). |
| `djangoShell.diagnosticLogging` | `true` | When on (the default), logs the shell session, backend requests, and overlay activity to the `Django Shell` output channel. Set `false` to disable. |
| `djangoShell.modelBrowser.lookupExcludeFields` | `[]` | Field-name substrings (case-insensitive) to hide from the FK picker's search and labels. Empty = show all fields. |

---

## Internals

### Backend bootstrap

When the shell prompt is detected, the extension injects a short **one-line `exec(...)`** command (`src/backendBootstrap.ts`) that loads the `zlib`+base64 `python/django_shell_backend.py` source from the spawn env payload (`DJANGO_SHELL_BACKEND_B64`), else from the on-disk runtime file, decompresses and `exec`s it into the shell's `globals()`, then calls `start(globals(), token)`. On a remote shell (SSH, `kubectl`/`docker exec`) where neither the env payload nor the local file crosses the boundary, the stub prints a clean `__DJANGO_SHELL_BACKEND_NEEDS_INLINE__` signal instead of raising, and the extension retries with an **inline** bootstrap that embeds the compressed source directly in the typed command (also retried when a traceback precedes the ready marker). The backend prints a `__DJANGO_SHELL_BACKEND_READY__` marker carrying `{host, port, token, …}` (or a `__..._FAILED__` marker with a traceback).

At attach time `start()` also binds `django`/`apps`/`settings`/`models` and every registered model class (straight from `apps.get_models()`, no fresh import) into the shell namespace **before** snapshotting the initial names — so bare model names resolve in the console and in ORM-mode cells. With `djangoShell.autoImportModels` enabled (the default) it additionally module-scans each app for managers/enums; existing names are never overwritten.

### Transports

`start()` launches a `ThreadingTCPServer` bound to `127.0.0.1:<random port>` on a daemon thread, storing the live namespace + token. The extension (`src/backendClient.ts`) then talks to it three ways:

- **TCP socket** — one JSON request line in, one JSON response line out; token-authenticated; connect timeout 1.5 s, response timeout 30 s. Used for `execute`/inspection and, when reachable, grid metadata.
- **PTY / terminal** — for remote setups (e.g. local VS Code over an SSH or `kubectl exec` terminal) where the socket is unreachable, requests/responses ride the terminal as `__DJANGO_SHELL_BACKEND_RESPONSE__` marker lines. Each request is a short `_djs_rpc('…','id')` call (the bulky JSON/truncation logic lives in the bootstrap-defined backend helper), and the helper **scrubs its own line from the interactive shell history**: your executed ORM (console/query) stays as a tidy history entry, while grid/inspect/keepalive plumbing is removed from history and the `In[N]` counter — so the server-side shell reads like only your real Django queries ran.
- **ORM cells** — model-browser/query reads are reconstructed (`src/modelOrm.ts`) as your own literal, injection-proof Django ORM one-liners and typed into the shell as ordinary cells; a per-cell capture hook emits the result as a marker. A server-side `pre_run_cell` audit therefore logs **real Django ORM**, not RPC plumbing. Reconstructed cells are bounded (≤ ~900 chars, ≤ 2000 rows); a read whose cell would exceed the tty input limit falls back to the bounded `_djs_rpc` path, and metadata kinds (`schema`/`filterfields`/`models`/`inspect`/…) are never typed (schema is synthesized from the first row page; the filter tree falls back to flat fields).

Transport modes are **ORM** (default), **Auto**, **Socket**, and **Terminal**. **ORM** runs grid reads as literal ORM cells (above) while `execute` still uses the socket when reachable; it requires `shell_plus`/IPython. **Auto** prefers the loopback socket and falls back to the terminal — nothing is typed into the shell when the socket is reachable. **Socket** prefers the socket but also falls back to the terminal when it is unreachable (e.g. a remote shell). **Terminal** forces the PTY, reconstructing reads as ORM cells scrubbed from history. Expensive runtime-tree inspection requires the socket bridge; model-browser / query / lookup requests are PTY-capable (with a reduced page size) so the grid still works over the terminal.

### Request protocol

All requests carry the auth token and run under a single `_EXECUTION_LOCK` (serialized). Kinds:

| Kind | Purpose |
| --- | --- |
| `execute` | Run Python in the shell namespace; capture stdout/stderr/result/traceback. |
| `complete` | Check whether source is a complete statement (no execution). |
| `environment` | Report the attached process environment (executable, prefix, cwd, paths, Django info). |
| `inspect` | Safe summaries of variables/modules (top level avoids property evaluation). |
| `prelude` | Namespace summaries for hidden editor preludes only. |
| `children` | Lazy child inspection of one object path (reads properties on explicit expand). |
| `models` | Catalog of installed models (`apps.get_models()`, 0 queries). |
| `schema` | Column + relation metadata from `_meta` (0 queries; types/null/editable/choices). |
| `filterfields` | Filterable field/relation tree for one model so the filter UI can drill across relations (0 queries; FKs as `*_id`, choices, traversable relations). |
| `rows` | One bounded page of rows (`.values()`, no JOIN), with filters/order/cursor/offset. |
| `related` | One bounded page of related rows for an explicit FK/reverse/M2M expansion. |
| `count` | Row count for the current filter set (computed on demand). |
| `computed` | Lazily compute one `@property`/`@cached_property` column over the current page (one query if a DB annotation is declared, else per-row); returns `{pk: cell}` with a query count. |
| `aggregate` | Grouped or global aggregate / window / F-expression results for the current filter set (read-only grid). |
| `commit` | Validate (`full_clean`, all-or-nothing) and save staged edits in one transaction. |
| `lookup` | FK picker search of a target model (single SELECT; optional field exclusions). |
| `query` | Evaluate user ORM code and tabulate the final expression's value. |

### Safety model

- **Bounded everything.** Grid and query reads always use `LIMIT n+1` (for "has more"); generators/iterables are consumed with `itertools.islice`.
- **Whitelist serialization.** Cells are encoded by a single helper (`Decimal→str`, datetimes→ISO, `UUID→str`, `bytes→base64+len`, collections→truncated repr, model→`{pk}`); the grid **never calls `__str__`/`repr`** on a row object, so rendering causes no extra queries or side effects.
- **No implicit eval in the grid.** Filters, relation-traversal paths, conditional aggregate / annotate / subquery columns, window/F-expression columns, and group-by keys are all built from names allowlisted against the live model graph and passed as ORM parameters (injection-proof). `eval` happens only for code you explicitly type (`execute`, `query`).
- **Edits are transactional.** `full_clean()` validates the whole batch before any write; saves run in `transaction.atomic()` with `save(update_fields=...)`, so signals fire and a failure rolls everything back.
- **Loopback + token.** The TCP server binds to `127.0.0.1` and validates a per-session token on every request.

### Generated files

`.django-shell/analysis.py` and `.django-shell/console-cell.py` are overwritten as implementation details (see [IntelliSense model](#intellisense-model)). They are excluded from packaging and should not be committed.

### Source layout

- **Extension host (`src/`, TypeScript → `out/`):** `extension.ts` (activation, lazy runtime source), `customConsole.ts` + `customConsoleHtml.ts` (console panel), `workbenchOverlay*.ts` (overlay editor + renderers), `pythonShadow.ts` / `pythonFeatureBridge.ts` / `overlayPythonFeatureBridge.ts` (IntelliSense bridge), `runtimeInspector.ts` (tree view), `backendBootstrap.ts` + `backendClient.ts` (attach + transport), `modelOrm.ts` (reconstructs grid/query reads as literal Django ORM cells for the ORM/Terminal transports), `modelBackend.ts` (wire types/parsers), `modelBrowser.ts` + `modelBrowserHtml.ts` (grid panel), `modelQueryConsole.ts` (query panel), `modelCatalog.ts` + `modelCatalogHtml.ts` (Models view), `djangoProject.ts` / `shellLaunch.ts` / `terminalState.ts` / `shellTranscript.ts` (project, terminal detection + history scrubbing), `notebook*.ts` (deprecated notebook).
- **Webview frontends (`media/`, bundled by esbuild into `media/dist/`):** `terminalRendererSource.js`, `customConsoleSource.js`, `modelCatalogSource.js`, and `modelBrowserSource.js` — the last importing `gridEdit.js` (staged editing + type-aware editors, which imports `gridFkPicker.js` for FK search), `gridFilter.js` (cascading relation-traversal filter bar), `gridAggregate.js` (the `+ Column` builder: annotations / aggregates / subqueries / window / F-expr + group-by), `gridColumnConditions.js` (its shared multi-condition query builder), `gridFieldPath.js` (relation-path pickers), `gridCombobox.js` (searchable comboboxes), `gridRelated.js` (editable nested related tables), `gridVirtual.js` (row windowing), `gridResize.js` (column resizing), `gridPin.js` (column pinning), `gridQuery.js` (query mode), and `sqlHighlight.js` (log formatting).
- **Backend (`python/django_shell_backend.py`):** the single in-process module covering every request kind above; embedded into the bootstrap and not imported separately.
- Repository code follows a ≤1000-line-per-file, purpose-comment-per-file, JSDoc-on-declarations guideline (`scripts/check-code-guidelines.mjs`).

---

## Development

```sh
npm install
npm run check        # guideline checks + unit tests
npm run compile      # tsc + esbuild webview bundles
npm run test:e2e     # extension-host E2E tests
npm run package      # build a VSIX (filtered by .vscodeignore)
```

Backend unit tests (`test/modelBrowser.test.mjs`) spawn Python and run the real Django ORM in an in-memory SQLite database; they skip automatically when Django is not importable. Point them at a specific interpreter with `DJANGO_SHELL_E2E_PYTHON`.

`.vscodeignore` filters the VSIX so sources, tests, logs, generated indexes, source maps, Python caches, native debug symbols, and the raw (pre-bundle) webview modules are excluded.

---

## Troubleshooting

- **Input cell stays disabled** — confirm the setup terminal has reached an interactive Django shell prompt.
- **Stale IntelliSense** — run Restart Kernel from the console header (clears the overlay document, analysis prelude, and runtime cache).
- **Runtime inspector unavailable in a remote setup** — the socket bridge may be unreachable from the extension host. Code execution and the model browser can still work over the terminal fallback, but runtime tree inspection is disabled in that mode.
- **Model browser / query empty over a remote terminal** — switch the `Link:` selector (`Auto / Socket / Terminal / ORM`) to `Terminal`; page size is reduced for the slower transport.
- **ORM-mode reads do nothing or keep falling back** — ORM mode (the default) needs an IPython / `shell_plus` shell. In a plain `python manage.py shell` switch the `Link:` selector to `Socket`, `Auto`, or `Terminal`.
- **Diagnosing attach / transport issues** — run `Django Shell: Show Diagnostics Log` (logging is on by default) to inspect the shell session, backend requests, and transport fallbacks in the `Django Shell` output channel.
- **Terminal fails to start after installing a VSIX** — rebuild/package on the target platform; the extension uses the native `node-pty` dependency.

---

## License

This extension is proprietary software. See [LICENSE](LICENSE).
