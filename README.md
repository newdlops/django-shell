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
   │  ┌─ TCP socket  (127.0.0.1:<random>, default)
   └──┤
      └─ PTY/terminal fallback (marker lines, for remote setups)
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
5. Type Python in the input editor and run it with **Enter** (or `Ctrl/Cmd+Enter`).

Code runs in the **same live namespace** as the attached shell. From there you can also open the **Models** view (activity bar) to browse tables, or run **`Django Shell: Run ORM Query`** to tabulate a custom query.

---

## Features

### Custom console (REPL)

- Opens an embedded **setup terminal** in the workspace root and detects when it enters an interactive Python/Django prompt (`python`, `ipython`, `shell_plus`).
- Optionally prepends a workspace `.venv`/`venv` to the terminal environment (`djangoShell.autoActivateWorkspaceVenv`).
- After the backend attaches, provides a Python input editor and runs code in the live shell namespace, capturing **stdout, stderr, the repr of the last expression, and tracebacks**.
- Multi-line input: leading statements execute, and the final expression's value is shown (and bound to `_`), mirroring an interactive REPL.
- **Restart Kernel** clears stale editor input, generated preludes, and runtime caches.

### Workbench overlay editor

- A workbench-hosted Python editor overlay provides a full editing surface (not just a single-line input) backed by an in-memory document, with its own renderers for prelude views, diagnostics, semantic highlighting, and completion widgets.
- Enter runs the current logical input when no completion/parameter widget is active; Shift+Enter inserts a newline; Ctrl/Cmd+Enter always runs.

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

- **No N+1.** Rows are read with a single `SELECT` via `_base_manager.values(*concrete_fields)`; foreign keys stay as raw `*_id` columns (no JOIN). Properties / `GeneratedField` / annotations are excluded by default.
- **Pagination.** Keyset (pk cursor) by default for stability on large tables, with an OFFSET fallback for non-pk sorts. A **rows-per-page selector** (50 / 100 / 500 / 1000 / 5000 / 10000 / all) lets you trade speed for completeness; `all` is unbounded (not recommended) and is automatically reduced over the slower terminal transport.
- **Counts on demand.** `count()` is computed only when requested (it is expensive), consistent with the active filter set.
- **Structured filters.** Field + lookup + value + negate chips compile to ORM `Q` objects. Field names and lookups are **allowlisted**, so filters cannot be injected; `BooleanField` values are coerced from strings.
- **Sorting.** Click headers to cycle asc/desc/none.
- **Relations, lazily.** Foreign keys show the id with an expander that fetches the related row in one bounded query; reverse FK / M2M relations appear as columns whose chips expand into a bounded related-row table on click. Nothing relational loads automatically.
- **SQL / ORM log.** Each `rows`/`related`/`count`/`commit` captures the real executed SQL (via `CaptureQueriesContext`, regardless of `DEBUG`) and a reconstructed Django ORM expression. A toggleable log panel shows time · action · statement, switchable between **SQL** and **Django ORM** views, with clause-aware formatting and syntax highlighting.
- **Column pinning.** Freeze concrete columns to the left while scrolling horizontally.
- **Transport switch.** A `Link: Auto / Socket / Terminal` selector controls how the grid reaches the shell, so the browser also works in remote setups where only the terminal is reachable.

### Inline editing

Editing is **staged in the webview and never touches the database until you commit** — nothing is sent to the server while you edit.

- Double-click an editable cell to edit it; dirty cells are highlighted. Multiple cells/rows can be edited, then committed together with **Commit (N)**.
- A commit sends one `commit` request: the backend validates **every** change with `full_clean()` first (all-or-nothing), then saves inside `transaction.atomic()` with `save(update_fields=...)`. On any failure the whole batch rolls back and **per-field errors** are returned. PK / auto / non-editable fields are rejected. Django signals fire normally.
- **Type-aware editors** (instead of plain text inputs):
  - **Choices (enum)** → dropdown of `[value, label]` (plus a `(null)` option when nullable); the committed cell shows the human label, not the raw key.
  - **BooleanField** → `true`/`false` dropdown (plus `(null)` for nullable booleans).
  - **Date / DateTime / Time** → native date/time pickers, with stored ISO values normalized to the input's expected shape.
- **Foreign-key searchable picker.** Editing an FK cell opens a live search box: typing queries the target model (text fields via `icontains`, plus exact pk when numeric) in a single bounded `SELECT` and lists `#<pk> · <text fields>` candidates; choosing one stages its pk. By default **every text field is shown** — add substrings to `djangoShell.modelBrowser.lookupExcludeFields` to hide sensitive fields (e.g. `password`, `token`) from the picker's search and labels.

> Edits are made with the **shell user's database privileges** and do not enforce Django auth/permissions — the grid edits the DB directly.

### Custom ORM query console

Opens a **separate panel** that renders the result of **your own ORM code** in the same grid — ideal for custom joins, aggregates, and `.values()` projections. Launch it from the **Models** view title bar (the ▶ button) or `Django Shell: Run ORM Query`. **Each launch opens its own tab**, so you can keep several different queries open at once.

- **Multi-line code** is allowed; the **last expression's value** is tabulated (same semantics as the console). It is evaluated in the **live shell namespace**, so your variables/imports/models are available, and assignments persist (just like the shell).
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
| `Django Shell: Browse Model Data` | Open the model data browser grid (prompts for a model). |
| `Django Shell: Run ORM Query` | Open the custom ORM query console panel. |
| `Django Shell: Refresh Model Catalog` | Refresh the Models catalog view. |
| `Django Shell: Refresh Runtime Inspector` | Refresh the runtime tree view. |
| `Django Shell: Show Process Environment` | Show the attached process environment details. |
| `Django Shell: Open Notebook Console (Deprecated)` | Open the legacy `.djshell` notebook console. |

## Keybindings

In the overlay editor:

| Key | Action |
| --- | --- |
| Enter | Run the current Python input when completion/parameter widgets are not active. |
| Shift+Enter | Insert a newline. |
| Ctrl+Enter / Cmd+Enter | Run the current Python input. |

In the ORM query console: **Ctrl/Cmd+Enter** runs the query.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `djangoShell.autoActivateWorkspaceVenv` | `true` | Prepend a workspace `.venv`/`venv` to the setup terminal environment when present. |
| `djangoShell.enableCodeActions` | `false` | Forward code actions through generated Python shadow documents. Expensive in large projects. |
| `djangoShell.enableModelPreludeImports` | `false` | Scan workspace model files and import discovered model classes into editor preludes. Expensive in large projects. |
| `djangoShell.enableRuntimeCompletion` | `false` | Enable deprecated notebook-cell runtime variable completions. |
| `djangoShell.diagnosticLogging` | `false` | Write runtime, source-analysis, and editor-bridge diagnostics to the `Django Shell` output channel. |
| `djangoShell.modelBrowser.lookupExcludeFields` | `[]` | Field-name substrings (case-insensitive) to hide from the FK picker's search and labels. Empty = show all fields. |

---

## Internals

### Backend bootstrap

When the shell prompt is detected, the extension injects a **one-line `exec(...)`** command (`src/backendBootstrap.ts`). It `zlib`-deflates and base64-encodes the embedded `python/django_shell_backend.py`, decompresses and `exec`s it into the shell's `globals()`, then calls `start(globals(), token)`. Because the source is embedded, no extra Python file needs to exist on the target machine (a legacy path-based bootstrap is used only if embedding fails). The backend prints a `__DJANGO_SHELL_BACKEND_READY__` marker carrying `{host, port, token}` (or a `__..._FAILED__` marker with a traceback).

### Transports

`start()` launches a `ThreadingTCPServer` bound to `127.0.0.1:<random port>` on a daemon thread, storing the live namespace + token. The extension (`src/backendClient.ts`) then talks to it two ways:

- **TCP socket** (default) — one JSON request line in, one JSON response line out; token-authenticated; connect timeout 1.5 s, response timeout 30 s.
- **PTY / terminal fallback** — for remote setups (e.g. local VS Code over an SSH terminal) where the socket is unreachable, requests/responses ride the terminal as `__DJANGO_SHELL_BACKEND_RESPONSE__` marker lines. Each request is a short `_djs_rpc('…','id')` call (the bulky JSON/truncation logic lives in the bootstrap-defined backend helper), and the helper **scrubs its own line from the interactive shell history**: your executed ORM (console/query) stays as a tidy history entry, while grid/inspect/keepalive plumbing is removed from history and the `In[N]` counter — so the server-side shell reads like only your real Django queries ran.

Transport modes are **Auto** (socket first, fall back to terminal), **Socket** (force TCP), and **Terminal** (force PTY). Expensive runtime-tree inspection requires the socket bridge; model-browser / query / lookup requests are PTY-capable (with a reduced page size) so the grid still works over the terminal.

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
| `rows` | One bounded page of rows (`.values()`, no JOIN), with filters/order/cursor/offset. |
| `related` | One bounded page of related rows for an explicit FK/reverse/M2M expansion. |
| `count` | Row count for the current filter set (computed on demand). |
| `commit` | Validate (`full_clean`, all-or-nothing) and save staged edits in one transaction. |
| `lookup` | FK picker search of a target model (single SELECT; optional field exclusions). |
| `query` | Evaluate user ORM code and tabulate the final expression's value. |

### Safety model

- **Bounded everything.** Grid and query reads always use `LIMIT n+1` (for "has more"); generators/iterables are consumed with `itertools.islice`.
- **Whitelist serialization.** Cells are encoded by a single helper (`Decimal→str`, datetimes→ISO, `UUID→str`, `bytes→base64+len`, collections→truncated repr, model→`{pk}`); the grid **never calls `__str__`/`repr`** on a row object, so rendering causes no extra queries or side effects.
- **No implicit eval in the grid.** Filters are built from allowlisted field + lookup names as ORM parameters (injection-proof). `eval` happens only for code you explicitly type (`execute`, `query`).
- **Edits are transactional.** `full_clean()` validates the whole batch before any write; saves run in `transaction.atomic()` with `save(update_fields=...)`, so signals fire and a failure rolls everything back.
- **Loopback + token.** The TCP server binds to `127.0.0.1` and validates a per-session token on every request.

### Generated files

`.django-shell/analysis.py` and `.django-shell/console-cell.py` are overwritten as implementation details (see [IntelliSense model](#intellisense-model)). They are excluded from packaging and should not be committed.

### Source layout

- **Extension host (`src/`, TypeScript → `out/`):** `extension.ts` (activation, lazy runtime source), `customConsole.ts` + `customConsoleHtml.ts` (console panel), `workbenchOverlay*.ts` (overlay editor + renderers), `pythonShadow.ts` / `pythonFeatureBridge.ts` / `overlayPythonFeatureBridge.ts` (IntelliSense bridge), `runtimeInspector.ts` (tree view), `backendBootstrap.ts` + `backendClient.ts` (attach + transport), `modelBackend.ts` (wire types/parsers), `modelBrowser.ts` + `modelBrowserHtml.ts` (grid panel), `modelQueryConsole.ts` (query panel), `modelCatalog.ts` + `modelCatalogHtml.ts` (Models view), `djangoProject.ts` / `shellLaunch.ts` / `terminalState.ts` (project + terminal detection), `notebook*.ts` (deprecated notebook).
- **Webview frontends (`media/`, bundled by esbuild into `media/dist/`):** `terminalRendererSource.js`, `customConsoleSource.js`, `modelCatalogSource.js`, and `modelBrowserSource.js` — the last importing `gridEdit.js` (staged editing + type-aware editors), `gridFkPicker.js` (FK search), `gridQuery.js` (query mode), `gridPin.js` (column pinning), and `sqlHighlight.js` (log formatting).
- **Backend (`python/django_shell_backend.py`):** the single in-process module covering every request kind above; embedded into the bootstrap and not imported separately.
- Repository code follows a ≤500-line-per-file, JSDoc-on-declarations guideline (`scripts/check-code-guidelines.mjs`).

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
- **Model browser / query empty over a remote terminal** — switch the `Link:` selector to `Terminal` (page size is reduced for the slower transport).
- **Terminal fails to start after installing a VSIX** — rebuild/package on the target platform; the extension uses the native `node-pty` dependency.

---

## License

This extension is proprietary software. See [LICENSE](LICENSE).
