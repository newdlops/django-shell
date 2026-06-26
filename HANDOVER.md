# Django Shell — Handover

## 2026-06-26 Debug Overlay Handover

### Current Goal

Python cell overlay debugging must behave like a real editor debugger:

- overlay gutter breakpoints must be visible and clickable;
- inline breakpoints must be available through the overlay context menu;
- breakpoints must bind to the generated `.django-shell/console-cell.py` source used by debugpy;
- paused lines and step-over state should stay visible in the overlay;
- step-over should remain in overlay code, while step-into may navigate into external source.

The user is Korean-speaking. Reply in Korean unless explicitly asked otherwise.

### Latest User-Visible Problem

The user showed an overlay screenshot with:

```python
a=1
b=2
c=3
d=4
e=5
f=6
```

Clicking near the `>>>` / `...` prompt gutter did not show a breakpoint, and no diagnostic log was emitted.

Initial diagnosis was that the overlay breakpoint hit-test was too narrow. That was true, but the first fix did not appear in the UI because the workbench renderer patch version was not bumped, so the old injected renderer code remained active in the already-open VS Code window.

### Latest Fix

- `src/workbenchOverlayBreakpointRenderer.ts`
  - Replaced the fixed `clientX <= 24` breakpoint-lane hit-test.
  - The overlay now uses Monaco `editor.getLayoutInfo().contentLeft` as the gutter width.
  - This makes clicks in the `>>>` / `...` prompt area count as breakpoint gutter clicks.
  - Breakpoint dots now render through an overlay-owned prompt-gutter layer instead of depending on Monaco's line decoration lane.
  - The overlay-owned prompt-gutter layer is display-only (`pointer-events: none`) so it cannot break editor UI hit targets.
  - The prompt-gutter layer now renders above Monaco (`z-index: 80`) so red dots are not hidden by editor internals.
  - Breakpoint clicks now optimistically update renderer-local markers before the extension-host round trip completes.
  - Monaco breakpoint `linesDecorationsClassName` rails were removed so the UI does not show duplicate red dots.
  - Document-level capture handles prompt-gutter clicks even when Monaco or another overlay element owns the actual target.
  - Breakpoint listeners reinstall when the renderer patch is reapplied to the same Monaco editor instance.
  - Breakpoint controls keep `lineDecorationsWidth: 0` and `lineNumbersMinChars: 1`; line-number CSS keeps exactly one prompt gap before user code.
  - Added near-gutter skip diagnostics:
    - `overlay.cell.breakpoint.click.skip`
  - Successful toggles already log through:
    - `overlay.cell.breakpoint.toggle`
    - `overlay.bridge.toggleBreakpoint`

- `src/workbenchOverlay.ts`
  - Bumped `RENDERER_PATCH_VERSION` to `57`.
  - This is load-bearing. Without this bump, an open VS Code renderer sees the old patch as current and does not inject the new hit-test code.
  - Renderer injection now also checks the live bridge port, not only the patch version, so a stale `127.0.0.1:<port>` bridge gets refreshed instead of leaving the renderer to hit `ECONNREFUSED`.

- `src/workbenchOverlayRenderer.ts`
  - Records the failed bridge port in `window.__djangoShellOverlayBridgeFailedPort` when renderer-to-host `fetch` fails.
  - Forces Monaco prompt line-number padding to one character with `.margin-view-overlays .line-numbers{min-width:0!important;overflow:visible!important;padding-right:1ch!important}` so `>>> a=1` keeps one readable gap without reintroducing the old wide gutter.

- `test/overlaySyncRenderer.test.mjs`
  - Added coverage for prompt-gutter-width breakpoint clicks.
  - Added coverage for optimistic local breakpoint marker updates.
  - Added coverage for document-level prompt-gutter breakpoint clicks with a display-only marker layer.
  - Added coverage for near-gutter clicks that cannot resolve a model line and should log `breakpoint.click.skip`.
  - Existing inline breakpoint context-menu coverage remains.

### Verification

Last run:

```bash
npm run check
```

Result: 119 tests passed.

Also ran:

```bash
git diff --check
```

Result: exit code 0. It prints the recurring `fsmonitor_ipc__send_query` warning, but no whitespace errors.

### Important Runtime Note

Source changes in this repo do not affect the installed extension until the extension host or installed build is refreshed.

For this latest fix specifically, the user should reopen the overlay or restart/reload the extension host so patch version `57` is injected. If the UI still behaves the same, first check whether the renderer actually reports patch version `57`.

### If It Still Fails

Check logs in this order:

1. `overlay.show`
   - Confirm a fresh renderer patch was injected.
   - Confirm patch version is `57`.

2. `overlay.cell.breakpoint.toggle`
   - Renderer saw a click and converted it to a source location.

3. `overlay.bridge.toggleBreakpoint`
   - Extension host received the toggle and called VS Code breakpoint APIs.

4. `overlay.cell.breakpoint.click.skip`
   - Renderer saw a near-gutter click but could not resolve a Monaco line.
   - Important fields: `x`, `laneLimit`, `inputStartLine`, `reason`.

If none of these logs appear, the DOM capture listener is probably not installed or the click is landing outside `editor.getDomNode()`.

If toggle logs appear but no marker is visible, inspect `window.__dsoSetOverlayBreakpoints` and `window.__dsoApplyOverlayBreakpoints`.

If markers appear but debugpy does not stop, inspect:

- `src/debugBreakpoints.ts`
- DAP `setBreakpoints` request/response logs
- `.django-shell/console-cell.py` contents
- overlay source text vs generated backing file text
- line offset between visible input and generated source

### Files Most Relevant To Current Debug Work

- `src/workbenchOverlay.ts`
- `src/workbenchOverlayBreakpointRenderer.ts`
- `src/workbenchOverlaySyncRenderer.ts`
- `src/workbenchOverlayRenderer.ts`
- `src/customConsole.ts`
- `src/debugBreakpoints.ts`
- `src/overlayPrelude.ts`
- `test/overlaySyncRenderer.test.mjs`
- `test/workbenchOverlayLifecycle.test.mjs`

### Project Constraints

- Keep code files at or below 1000 lines.
- First line of every code file must be a purpose comment.
- Every class/function/method in source code needs a JSDoc/docstring-style summary.
- Run `npm run check` after code changes.
- `src/customConsole.ts` is currently close to the line limit, around 998 lines. Do not add meaningful code there; create or extend smaller modules instead.
- The worktree has many ongoing modified files. Do not revert unrelated changes.

---

Date: 2026-06-06. Covers the model-data-browser / ORM-mode work on branch
`model-browser-orm-enhancements` (commit `09ab10c`, not merged, not pushed).

---

## 0. TL;DR / read this first

- **You test the INSTALLED extension, not this repo.** The shell loads
  `~/.vscode/extensions/newdlops.django-shell-<version>/…`, **not**
  `/Users/lky/project/django-shell`. Source changes only take effect after **F5**
  (Extension Development Host) or **repackage + reinstall + reload window**.
  Most "still broken after the fix" reports were the stale installed build.
- The extension runs in three layers that must stay in sync:
  1. **TS extension host** — `src/` → compiled to `out/` (gitignored) by `tsc`.
  2. **Webview UIs** — `media/*Source.js` → bundled to `media/dist/*.js` (tracked) by esbuild.
  3. **Python backend** — `python/django_shell_backend.py`, injected as source into the live Django shell.
- Build/verify / package:
  - `npx tsc -p ./ --noEmit` — fast typecheck loop.
  - `node --test test/*.test.mjs` — unit tests.
  - `npm run check` (= guidelines + `tsc` + `build:renderer` + tests). Current: **36 pass /
    5 skip / 0 fail**. The 5 skips + the e2e "overlay-guard" are **pre-red on clean HEAD** —
    not regressions.
  - `npx --yes @vscode/vsce package` — build the `.vsix` **directly**. (`npm run package` runs
    `check` first, which can be red on pre-existing issues; package directly to avoid that.)
  - **No-Django Python check trick:** import `python/django_shell_backend.py` under system
    `python3`, inject a fake `django.apps` into `sys.modules`, and call the target function — used
    to unit-test backend logic without a real Django project. (Node's `--input-type=module -e`
    importing `out/*.js` is the analogous trick for the TS cell builders — used throughout this
    session to print/verify generated ORM cells.)
- Guidelines (`scripts/check-code-guidelines.mjs`): every function needs a **single-line**
  `/** … */` JSDoc immediately above it; **max 1000 lines/file**. First line of every code file is
  a purpose comment.

### Working agreement (if you're the next AI/Claude session)
- The user is **Korean-speaking — reply in Korean.**
- **Commit/push/publish only when explicitly asked** (the user's convention: a release commit on
  `main` titled like `v.0.0.9 -release-`; PR/commit trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).
- **Concurrent edits happen** (the user / a linter touch files between turns) — **re-read a file
  right before editing it.**
- Per-project **auto-memory loads** from `~/.claude/projects/-Users-lky-project-django-shell/memory/`
  (`MEMORY.md` index) — read those mechanism notes, don't re-derive (see §11).
- You **cannot verify runtime behavior headlessly** (§9) — say so, and build a VSIX so the user
  can test, rather than claiming it works.

---

## 1. What the extension is

A VS Code extension that attaches to an interactive Django shell and adds:
- a **model data browser** (webview grid: rows, inline edit, FK pickers, relation
  expansion, pinned/resizable columns, query log),
- a **runtime variable inspector** (tree view),
- a CDP-injected **Monaco "python cell" overlay** in the workbench,
- a custom **console** webview.

The shell is whatever Python REPL the user reaches — **local** (`python manage.py shell`)
or **remote** (SSH, `kubectl exec` into a pod). The backend is injected by typing a
bootstrap `exec("…")` into that shell.

---

## 2. Transports & ORM mode (the central model)

`BackendTransportMode = "auto" | "tcp" | "pty" | "orm"` (`src/backendClient.ts`).

- **auto** — prefer the loopback socket, fall back to PTY.
- **tcp / Socket** — socket-first, falls back to PTY unless no fallback exists.
- **pty / Terminal** — force the interactive shell; reads reconstructed as ORM cells.
- **orm** — model-browser reads run as the user's **literal ORM cells** typed into the
  shell, so a server-side `pre_run_cell` audit logs real Django ORM, not RPC plumbing.

`reconstructsViaOrmCell = (mode === "orm" || mode === "pty")`.

**The default transport is now `orm`** (changed this session). Set in `package.json`
(`djangoShell.modelBrowser.transport` default `"orm"`), `BackendClient` initial `mode`,
and `customConsole`. Also fixed a latent gap: the configured value is now actually
**applied at startup** (`customConsole` ~L259 seeds `setTransportMode(this.selectedTransport
?? this.modelTransportSetting())`; previously the config was ignored on a fresh start).

**Hard contract (user requirement):** in ORM mode `raw_cell` audit must show clean Django ORM or
user Python only: **no `_djs_rpc`, `_djs_backend_module`, `apps.get_model`, or `json.dumps`
support-layer cells**. Reconstructed cells are injection-proof (`pyStr`/`safeName`/identifier
allowlists in `src/modelOrm.ts`). Model catalog and top-level inspection stay functional in
remote PTY via pure probe cells (`len(apps.get_models())`, `len(globals())`); the capture hook
attaches the metadata to the response marker.

**Remote ⇒ PTY.** The backend's `127.0.0.1:<port>` socket lives in the remote pod, so a
local connect gets `ECONNREFUSED`. `backendClient` falls back to PTY; `markSocketUnavailable()`
pre-marks the socket dead on a remote attach (detected via the inline-bootstrap retry).

### Physical limits you must respect
- **PTY response marker ≤ 1 MB** (`_PTY_MARKER_LIMIT`). Oversized backend responses are split into
  chunk markers (`chunk.index/count/data`) and reassembled in `notebookPtySession`; do not restore the
  old `ptyRequestBuffer.slice(-1_250_000)` tail-drop or large inspection responses can lose chunks.
- **tty canonical input line ≈ 1 KB on macOS** (≈4 KB on Linux). A typed cell longer than
  that is silently truncated → the shell hangs at a `…:` continuation prompt. This bit the
  inspect/children cells and the bootstrap; keep typed cells short.

---

## 3. Backend bootstrap & the capture hook

### Bootstrap delivery (`src/backendBootstrap.ts`, `src/notebookPtySession.ts`)
The backend source reaches the shell three ways:
1. **env payload** `DJANGO_SHELL_BACKEND_B64` (deflate+base64 on `pty.spawn` env) — local only;
   does **not** cross SSH/kubectl.
2. **local file** `open(runtimePath)` — only on the host running the extension.
3. **inline** — source embedded in the typed `exec("…")` — the only channel that crosses to a
   remote shell.

Flow: type the **env-mode** bootstrap first. On a remote shell neither env nor local file is
available → it now **prints a clean `__DJANGO_SHELL_BACKEND_NEEDS_INLINE__` marker** (guarded by
`os.path.exists`), **instead of raising `FileNotFoundError`** in the server audit (this session's
fix). `inspectMarkers` arms the inline retry on that marker **or** a traceback; the inline
bootstrap is typed only once `detectPrimaryPythonPrompt` matches (typing the ~24 KB blob before
the prompt returns corrupts it).

The bootstrap was shrunk **1018 → 749 B** by moving the `_djs_rpc` lambda + `_djs_backend_initial_names`
wiring out of **both** typed commands into `start(namespace, token)` (`backendLoadStatements`
shared tail; the history scrub stays the **last** statement so IPython doesn't re-record it).
This keeps it well under the tty line limit for long extension paths and removes `_djs_rpc` from
the audit line. **The bootstrap is still required even in ORM mode** — the capture hook +
`_pty_tabulate_result` produce the response markers the extension reads.

### Capture hook (`_pty_install_ipython_capture` in `python/django_shell_backend.py`)
Registers `pre_run_cell`/`post_run_cell`. For each cell `_post` reads `result.result`, runs
`_pty_tabulate_result(value)` (→ `grid`), optionally computes `inspect` children, captures
SQL, and prints `__DJANGO_SHELL_BACKEND_RESPONSE__` marker(s) (`_pty_emit_cell` →
`_pty_cell_marker` → `_pty_fit_response` or chunk markers when oversized). Responses are
FIFO-correlated by a per-cell counter id `_djs_cell-N`.

Gotchas baked in (don't regress):
- **FIFO-desync guard:** `_post` returns early when `state["save"]` is None — the bootstrap cell
  that *installs* the hook mid-execution never ran `_pre`; emitting a marker there would desync
  the queue so the first real read consumes it.
- **History scrub:** legacy `_djs_backend_module._pty_orm_` helper cells are scrubbed if they ever
  appear, but current ORM-mode code avoids typing them because they still appear in `pre_run_cell`
  audit once.
- **`_pty_fit_response`** truncates `stdout`/`stderr`/`traceback` (40 KB), caps `sql` to 50 and
  **truncates each query's text** (2 KB), caps `inspect.children`, and keeps as many grid rows as
  fit (`truncated`/`hasMore`) rather than dropping the grid.

---

## 4. Model data browser (`src/modelBrowser.ts`, `media/modelBrowserSource.js`, `src/modelOrm.ts`, `src/modelBackend.ts`)

In ORM/PTY mode there is **no schema RPC** — the grid head is synthesized from the first rows
page. Reads are built in `src/modelOrm.ts` (`build*Orm`) and parsed by `parseOrm*Response`.

### Grid virtualization — `media/gridVirtual.js` (NEW)
`createVirtualRows({scroller, getBody, columnSpan, buildRow, onRender})` windows the `<tbody>`:
renders only the viewport ±12 overscan plus top/bottom **spacer `<tr class=vspacer>`** that hold
the scrollbar. Tables ≤ **80 rows** render whole (identical to the old path, zero risk). Row
height is measured from the first paint. Re-renders on scroll past the overscan **and** on a
`ResizeObserver` (the log/table drag handle, window/panel resize). `onRows` calls
`virtual.setRows(rows, append)`.
- **Staged edits survive re-render** via `editor.applyStaged(tr)` (`media/gridEdit.js`) — edits
  live in the editor's `pending` Map keyed by pk; re-render reapplies the dirty value.
- **Pins survive** — `media/gridPin.js` `repaintPins` skips rows without `dataset.pk` (covers
  spacers + detail rows) and offsets pinned columns past the row-number gutter.
- Scroll re-render is **skipped while a cell editor input is focused** (no lost edit).
- `content-visibility:auto` was rejected — it's a no-op on `<tr>` (table internals can't take
  size containment), hence manual windowing.

### Row-number gutter
A frozen left `<th class=rownum>`/`<td class=rownum>` ("#") showing the **absolute** row index.
`repaintPins` accounts for it (lead offset). CSS in `src/modelBrowserHtml.ts`.

### Log/table resize handle
`<div class=logresize>` on the top edge of the log panel drags `--log-h` (CSS var on the grid),
persisted via `vscode.getState/setState`. The `1fr` grid track (the table) absorbs the change;
the virtualizer's ResizeObserver re-renders.

### Relation column headers
`buildHead` shows kind + model: `relationKindLabel(kind)` (m2m → m2m, o2o → o2o, reverse-fk →
reverseFK, fk → FK) + `relationModelName(target)` (strips the app prefix). Hidden reverse
relations (`related_name='+'`, accessor ends in `+`) are excluded — `_browse_relation_name`
filters them, and `_pty_orm_children`'s field list does too. **Do NOT use
`ForeignObjectRel.is_hidden()`** — it's missing in some Django versions; check the accessor
name `.endswith("+")` instead.

### "all" page size / SQL-heavy results
`ALL_PAGE_SIZE = 1e9` once made the rows ORM cell over-run the marker and `_pty_fit_response`
*dropped* the grid → "could not tabulate". Fixed: `backendClient.modelRows` caps the ORM-mode
limit at `ORM_PTY_ROW_CAP = 2000` (+ "Load more"); `_pty_fit_response` keeps as many rows as fit
and truncates SQL query text; `parseOrmGridResponse` honors `grid.truncated`. Use **Socket/Auto**
to fetch larger pages (no marker cap).

---

## 5. Computed `@property` columns (read-only, lazy)

`_browse_computed_columns(model)` lists a model's `@property`/`@cached_property` names (via
`_pty_is_computed_field`, sorted `dir()`, skips dunder + concrete/relation names + `pk`, cap 40),
flagged `{computed: true, editable: false, type: "property", annotated: <bool>}`. They appear in
the schema/columns so headers render, but are **NOT computed by default** (rows stay
concrete-only — fast, no N+1).

### Lazy per-column load
Each computed header has a `▷/▼` toggle (`act:loadComputed`); cells show a muted `·` until
activated. Activating posts `loadComputed {field}` → `modelBrowser.loadComputed` →
`source.modelComputed({app, model, field, filters, order, limit: loadedRowCount, columns})` →
posts `computed {field, values:{pk:cell}}`. The frontend stores values in `state.computed[field]`
(keyed by `String(pk)`); `paintComputedCell` reads the store so values **survive virtualization**.
Load-more re-requests active fields; reload/`onSchema` clears the store.

### Why N+1 is inherent (decided with the user)
A `@property` is arbitrary Python evaluated per instance; one that hits the DB is **inherently
N+1** (1 base SELECT + per-row property queries). History of attempts and the user's final calls:
1. eager-load all relations (`select_related`/`prefetch_related`) — **rejected**: properties join
   many models → huge JOINs for every base row, worse than N+1. (All eager code was removed.)
2. **annotation-backed single query** — the model may declare `djshell_annotations` (a dict OR
   classmethod → `{field: <Django expression>}`); `buildComputedOrm` then emits
   `…annotate(__djs=<expr>)…values("pk","__djs")` (one query). The header shows
   "@property · 1 query". The user **declined to add this to their models / config / a side-file**.
3. **final state:** keep lazy per-row, **bound by page size** (smaller page = fewer queries).
   `_browse_computed` (socket) returns `queryCount`/`rowCount` to make the cost visible.

### ORM-mode cell is readable ORM (not `_djs_backend_module` / JSON wrappers)
`buildComputedOrm` emits (per-row case)
`[{"pk": __o.pk, "value": __o.<field>} for __o in Company._base_manager…]`
— the audit shows the real query + per-row property access (which makes the N+1 self-evident).
Annotated case wraps it in a `lambda __m:` so the bare model name appears once, keeping the cell
under the tty limit and returns `.values("pk", "__djs")` rows directly. `parseOrmComputedResponse`
reads the capture hook's grid rows, not stdout JSON; a raising property errors the cell so the
**real traceback surfaces** (the old generic
"Computed field failed in ORM mode." hid it — and was caused by capturing the property's huge SQL
into the response, blowing the marker; `_browse_computed` no longer captures SQL text).

### Filtering computed columns
A property still can't resolve to a DB field, so computed columns remain **non-sortable**. Filtering
is now split:
- annotation-backed properties use `.annotate(...).filter(...)` and stay DB-side;
- ordinary properties need **no model-code changes** and are filtered Python-side, after DB filters
  and before pagination (`_browse_python_filter_iter` / `pythonFilterCell`). This is exact but can
  scan many rows and can run property N+1 work; the UI labels these fields as `@property · Python`.
Relation filters are existence-only (`rel:name isnull true/false`) and M2M/reverse-FK filters add
`.distinct()`.

---

## 6. Runtime inspector (`src/runtimeInspector.ts`, backend `_inspect_*` / `_pty_orm_*`)

Tree of namespace variables → drill into children. Paths are `BackendRuntimePathSegment[]` with
ops `name | attr | index | all_index | dict` (`dict` is **positional** into `items()`, not key
lookup; `all_index` means index into `obj.all()` for Django managers/querysets).

### Inspection pure probes
Inspection must keep `raw_cell` audit clean while staying fast. In ORM/terminal mode,
`backendClient.inspect()` types `len(globals())`; child drill-down types pure Python probes such as
`dir(obj)` for objects and `len(items)` for collections. The capture hook recognizes those probes,
suppresses the probe's display/grid payload, and attaches `runtime` / `inspect` metadata to the cell
marker. Do **not** type `_djs_backend_module` helper calls for inspection.
Probe execution is only the audit facade: `_pty_inspect_probe_target` resolves the probe target with
the structured helper path rules instead of trusting/parsing `dir()` output. If the raw `dir(...)`
cell raises while a placeholder attribute/property is being opened, the marker can still be `ok`
with helper-built children (often a `value` child carrying the inspection error) rather than an empty
tree. Reverse manager rows should type as `dir(list((obj.related_set).all())[0])`, not
`dir(list((obj.related_set))[0])`.
Do **not** cap the namespace or child list: the user explicitly prefers complete inspection metadata
even when the namespace is very large.
- Oversized inspection responses must be chunked, not truncated. `_pty_cell_marker` emits chunk markers
  and `parseBackendResponseMarkers` / `assemblePtyResponseChunk` rebuild the full response.
- Object child listing is lazy for descriptors: all `@property` / `cached_property` names should appear,
  but their getters are not evaluated until the property path itself is opened.
- `_resolve_child` (op `attr`) falls back to `_pty_safe_getattr` when the name isn't in
  `_attribute_mapping`, so Django reverse-relation/M2M-manager drill-downs resolve (they're listed
  via `_meta` but absent from the vars/dataclass/property mapping).

---

## 7. Overlay backing-file dirty prompt (fixed)

`src/overlayMemoryDocument.ts` opens `.django-shell/analysis.py` (and the query console's
`query-analysis.py`) as real `TextDocument`s for Pylance and edits them via `applyEdit` (→ dirty).
`syncAnalysis()` (called on every keystroke-driven language request) edited without saving, so the
hidden doc sat dirty at rest → VS Code prompted "Save analysis.py?" on reload/exit (the exit
prompt fires before `deactivate` cleanup can run). Fix: a **debounced clean-save** (300 ms,
`scheduleAnalysisCleanSave`) flushes the doc clean once typing pauses. `save()` only clears the
dirty flag (content unchanged), so IntelliSense is unaffected.

---

## 8. Other load-bearing facts (don't relearn the hard way)

- **ORM model auto-import:** startup always binds model classes already present in Django's app
  registry (`apps.get_models()`) before the initial-name snapshot, so bare-name browse doesn't
  `NameError`. The slower module scan remains gated by `DJANGO_SHELL_AUTOIMPORT_MODELS` (default on).
  The IPython capture hook also re-binds registry models just before `._base_manager` / `._meta`
  cells execute, covering remote shells where the env flag did not cross or Django became ready
  after bootstrap.
- **`modelRef(app, model)`** now emits the bare class name (`Company._base_manager…`), not
  `apps.get_model(...)`, so the audited cell stays actual ORM. Binding happens silently in the
  backend namespace; do not put `apps.get_model(...)` back into the visible cell.
- **CDP overlay** (Monaco python cell) is injected into the workbench; it prefers the "Django
  Shell" tab's editor group. **Unverifiable headlessly.**
- **execution_count / history.sqlite:** never roll back `execution_count` without DELETEing the
  matching `history.sqlite` row, or IPython history logging corrupts.

---

## 9. What can't be verified here (needs a real environment)

The webview UIs (grid, virtualization, row gutter, resize handle, lazy columns), the CDP overlay,
the inspector tree, and anything touching a live Django shell are **not headlessly verifiable**.
`npm run check` only covers TS types, node unit tests, and guidelines. **Everything in §4–§7 needs
manual testing in real VS Code against a Django project** (the user's is `…/project/captain`,
app `db`, model `Company` with a SQL-heavy `has_paid_subscription` `@property`).

---

## 10. Git / deploy state

- Branch **`model-browser-orm-enhancements`** @ `09ab10c` (18 files, +1005/−165), based on `main`.
  **Not merged, not pushed.** The user's convention is committing releases directly to `main`.
- To run the new code: **F5** (Extension Development Host) or `npx vsce package` →
  `code --install-extension django-shell-*.vsix` → reload window. Consider a **version bump**
  (currently `0.0.901`) so the installed version visibly changes.
- Open follow-ups / decisions left to the user:
  - merge the branch to `main` (and/or push); release commit convention `v.0.0.X -release-`;
  - the lazy-computed N+1 stays per-row by choice (annotation opt-in declined);
  - optional: client-side filtering of *loaded* computed values (a future feature, not built).
- **Paused from earlier sessions (lower priority than reported bugs):** the *query-console*
  CDP-Monaco overlay (key parameterization, anchor+geometry+wiring, prelude/ownership/validation)
  — `src/modelQueryConsole.ts` exists; the overlay piece was deferred.
- `.vscodeignore` excludes `Trace-*.json`, `.claude/**`, `.django-shell/**`, planning `.md`s
  (VSIX-bloat guard) — keep it that way.

> Note: this file replaced an earlier `HANDOVER.md` (2026-06-04) aimed at the next AI session;
> its still-relevant content (working agreement, build/package commands, no-Django test trick,
> paused query-console task) was merged above. The rest of it described the then-uncommitted
> pre-`v0.0.8`+ state and is superseded by §10.

---

## 11. Where the detailed rationale lives

Claude's per-project session memory (`~/.claude/projects/-Users-lky-project-django-shell/memory/`)
has blow-by-blow notes for a future Claude session: `orm-mode-transport-contract.md` (master),
`remote-bootstrap-delivery.md`, `overlay-backing-file-dirty-prompt.md`, `orm-cell-fifo-desync.md`,
`orm-model-autoimport.md`, `overlay-multitab-targeting.md`, `main-checks-already-red.md`. This
`handover.md` is the self-contained summary for a human picking up the work.
