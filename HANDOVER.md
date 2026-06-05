# Handover for the next AI session — Django Shell extension (v0.0.9 WIP)

_Updated 2026-06-04. Audience: the next Claude Code session in this repo._

## Read first (orientation)

- You are continuing a long bug-fixing session on this VS Code extension. The user is **Korean-speaking** (reply in Korean). Commit/push/publish **only when explicitly asked**; nothing has been committed this session.
- Your **auto-memory auto-loads** from `~/.claude/projects/-Users-lky-project-django-shell/memory/` (`MEMORY.md` index). It already holds the deep mechanism notes — **read them, don't re-derive**: `orm-mode-transport-contract`, `overlay-multitab-targeting`, `orm-model-autoimport`, `model-data-browser-feature`, `main-checks-already-red`. This file is the *session-state + working-agreement* layer on top of those.
- **Concurrent edits happen** (the user / a linter edit files between your turns). **Re-read a file right before editing it** — don't trust a stale view.
- **Headless cannot verify** CDP / IPython / plain REPL / Monaco / PTY timing / a live Django shell. `tsc` + `node:test` + ad-hoc Python are your only automated signals. **Do not claim runtime behavior is verified** — say "needs VS Code + a live shell_plus" and (per the established workflow) build a VSIX so the user can test.

## Repo state right now

- **Everything is UNCOMMITTED.** `HEAD` = `v.0.0.8` (`2304c2f`). Working tree: **31 modified (+2428/−616) + 7 new files**; `package.json` already at `0.0.9`. Staged deletions: `log.txt`, `other_extension_log.txt`.
- New files: `src/modelOrm.ts`, `src/modelQueryConsole.ts`, `src/shellTranscript.ts`, `media/gridRelated.js`, `media/gridResize.js`, `media/gridFkPicker.js`, `media/gridQuery.js`.
- **Green:** `npx tsc -p ./ --noEmit` → 0; `node --test test/*.test.mjs` → 32 pass / 5 skipped / 0 fail.
- **Red, but PRE-EXISTING (not yours, don't "fix" by cramming):** `check:guidelines` flags `src/customConsole.ts` (555) and `src/workbenchOverlaySyncRenderer.ts` (531) over the 500-line cap. See memory `main-checks-already-red`.
- Latest artifact: `django-shell-0.0.9.vsix` (~2.93 MB), rebuilt with all current fixes.

## Commands

```
npx tsc -p ./ --noEmit          # typecheck (fast loop)
node --test test/*.test.mjs     # unit tests
npm run check                   # guidelines + tests — RED on the 2 pre-existing files above
npx --yes @vscode/vsce package  # build .vsix DIRECTLY (npm run package fails: it runs check first)
```
Ad-hoc Python check pattern (no Django needed): import `python/django_shell_backend.py` under system `python3`, inject a fake `django.apps` into `sys.modules`, call the target function. Used this session to prove auto-import.

## Hard constraints the checker enforces (these have burned time before)

- **≤500 lines per code file** (`.py` exempt; `.md` exempt). When an edit pushes a `.ts`/`.js` over, compact (one-line `if`s, combined assigns) or extract a module — do **not** add to the two already-over files.
- **Single-line JSDoc only** — multi-line `/** ... */` is rejected. First line of every code file is a purpose comment; every class/fn/method gets a one-line doc.
- **Injection-proofing** for anything typed into the shell: `IDENTIFIER` regex, `pyStr` (JSON.stringify), `pyScalar`. ORM builders in `src/modelOrm.ts` must never interpolate raw user strings.

## Where things live (symbols are durable; line #s approximate)

- **Backend** `python/django_shell_backend.py` (~1200+ lines, exempt): `start()` 45 → `_autoimport_django_namespace` 73 / `_autoimport_bind_models` 101 (run **before** the `_djs_initial_names` snapshot at `_pty_install_capture` 719/728 and `server.initial_names` 53). Capture hook: `_pty_emit_cell` 656, `_pty_tabulate_result` 687, `_pty_sql_begin` 661, `_pty_install_capture` 719. History fix `_pty_forget_ipython_db` 933. Cell value `_browse_cell` 1210.
- **Transport routing** `src/backendClient.ts`: `models()`/rows/related/etc. branch on `this.mode==="orm"` → `ormCell()` (~211); `ORM_NO_PTY` set (~402) suppresses environment/prelude/schema in ORM mode; `supportsRuntimeInspection()` (~151).
- **ORM builders** `src/modelOrm.ts`: `buildRowsOrm`/`buildRelatedOrm`/`buildCountOrm`/`buildCommitOrm`/`buildModelsOrm`/`buildInspectOrm`/`buildChildrenOrm`/`buildLookupOrm`; `pyValueSummary` for inspector; `__test` exports all.
- **Catalog refresh** `src/modelCatalog.ts`: `load(token, attempt)` — token-guarded retry on `!ok` (this turn's fix B).
- **Readiness → UI** `src/customConsole.ts`: `handleSessionSnapshot` (~241–263) fires `runtimeEmitter` on ready; `scheduleRuntimeRefresh` (~424, 750 ms) re-fires after each cell.
- **PTY / ready marker** `src/notebookPtySession.ts`: marker parsed mid-bootstrap (~250); `requestViaPty` (~276) serializes via `ptyQueue`, single `pendingCell` slot, 90 s timeout; `buildPtyExecuteCell` bracketed paste + trailing newline.
- **Overlay (CDP)** `src/workbenchOverlay*.ts`: `__dsoAttachRoot` sticks to first-bound frame; geometry de-dupe in `workbenchOverlayRenderer.ts`.
- **Bootstrap** `src/backendBootstrap.ts`: env-var payload `DJANGO_SHELL_BACKEND_B64`, autoimport flag `DJANGO_SHELL_AUTOIMPORT_MODELS`.

## Gotchas that already cost time

- The CDP overlay **persists until the VS Code window reloads** — a captured trace / observed behavior can reflect the OLD overlay after a VSIX update if the window wasn't reloaded.
- Never roll back IPython `execution_count` without DELETEing the `history.sqlite` row (`_pty_forget_ipython_db`) — that was the `Session/line number was not unique` bug.
- The session reports `ready` **mid-bootstrap** (before a clean prompt), so the first ORM cell can mistype/parse-fail — that's why the catalog retries and ORM cells use bracketed paste + trailing newline.
- **Catalog/inspector stuck on "loading" (fixed 2026-06-04):** the IPython capture hook is registered *during* the bootstrap `exec` cell, so that cell's `post_run_cell` fired with no matching `pre_run_cell` and emitted a spurious `_djs_cell-1` marker with **empty stdout**. Literal ORM cells resolve by FIFO (no id match), so that empty marker was consumed as the *models* response (0 models) and every later ORM request got the previous cell's marker — a permanent off-by-one desync (inspector then parsed the models JSON → 0 variables). Fix in `_pty_install_ipython_capture._post`: `if not state["save"]: return` — `_pre` only sets `save` for cells it set up, so the bootstrap cell now emits nothing and the FIFO stays aligned. The plain-REPL path already had the equivalent guard (`state["first"]`). Verified by ad-hoc IPython-shell simulation (bootstrap → 0 markers; real cell → one `_djs_cell-1` with captured stdout).
- VS Code webviews live in a **shared layer** (`#<guid> > iframe`), not in editor-group DOM — overlay tab/group detection can't map iframe→tab; rely on sticking to the bound frame.
- VSIX bloat: `Trace-*.json` / stray dirs slip in — `.vscodeignore` now excludes `Trace-*.json`, `.claude/**`, `.django-shell/**`, and the planning `.md`s.

## Pending / not done

- **Paused tasks #15–17 (P3–P6):** query-console CDP-Monaco overlay (key parameterization, anchor+geometry+wiring, prelude/ownership/validation). Lower priority than user-reported bugs.
- **Before release:** commit + tag (repo convention: a commit titled like `v.0.0.9 -release-`; PR/commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`). Optionally split the two over-cap files so `check`/`npm run package` go green.

## Manual verification checklist (hand to the user; VS Code + shell_plus/IPython project)

1. ORM mode (default): browsing a model → live audit shows only `Model._base_manager…[:N]`; edit→Commit → `o=…; o.save(update_fields=…)`.
2. Auto-import: bare-name browse of a model `shell_plus` skips (e.g. `VertexAiPredictionRequest`) → **no `NameError`**.
3. Catalog populates **immediately** on shell start, no manual refresh.
4. Inspector: user vs pre-existing split; drill fields/properties/reverse-set; `datetime`/`Decimal` show values.
5. FK expand, reverse relations, pagination, filter, sort, draggable column resize.
6. Overlay: python cell stays responsive after opening a Model Browser tab; no column jump on resize.
7. Transport selector → Socket/Terminal: no regression.

## If you need pre-compaction detail

Full transcript: `~/.claude/projects/-Users-lky-project-django-shell/5aafcd94-e0a7-49c3-a576-c152dd06d77b.jsonl`.
