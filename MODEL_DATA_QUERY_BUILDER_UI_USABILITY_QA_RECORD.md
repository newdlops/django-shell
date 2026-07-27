# Model Data Query Builder UI QA Record

## Scope

This record captures the verification performed against the packaged extension installed in the live `rtcc-poc-page` VS Code workspace.

## Automated verification

- `npm run check` completed successfully after the Query Builder changes. It includes the repository guideline checks, TypeScript compilation, renderer bundles, and JavaScript test suite.
- The automated Recipe-store suite now explicitly covers adding a source condition and then selecting `id`; it verifies that the selected `lhs` remains in the draft while the applied recipe remains unchanged.
- The final automated pass also covers the extracted Recipe reducer, workspace lifecycle, issue routing, stable `groupBy` renderer keys, typed scalar parsing, and explicitly loaded workspace/control/popover CSS assets.
- A dedicated visual-contract test now verifies 959px/639px responsive boundaries, Focus Builder layout, popover viewport bounds, forced-colors, reduced motion, theme-token-only colors, and the absence of `transition: all`.
- The render coordinator now coalesces all controller-owned store, metadata, preview, Apply, and result transitions. Its automated suite verifies request coalescing, latest-model rendering, unchanged-region skipping, focus restoration after a region failure, and safe destruction with a queued flush.
- Validation transitions update only mounted predicate/computed issue regions. This preserves active editor controls and their caret/selection while still showing new host/local errors.
- Dedicated reducer, scalar-editor, issue-target, and roving-tab tests now cover immutable Recipe actions, typed native input handling, four-stage error routing, and keyboard-only tab navigation.
- The portal-popover test now exercises real scheduling semantics with a deterministic document fixture: resize/scroll bursts produce one animation-frame reposition even when the browser returns frame id `0`, and destruction releases all document/window listeners.
- Workspace lifecycle and inspector-copy tests use minimal deterministic DOM/clipboard fixtures to verify one active inert-safe stage/review panel and ORM-only clipboard output without operating VS Code.
- Validation now marks the precise `data-query-control-key` (or a safe node fallback) as invalid and appends a stable issue-region description without removing existing control help; the unit test verifies the annotation is removed cleanly after recovery.
- Inline predicate and computed issue text is now deliberately quiet (`note` semantics with no per-item live alert). The persistent drawer status remains the single concise validation announcement channel, avoiding repeated speech while typing.
- An earlier `npm run test:e2e` completed successfully. This isolated extension-host suite verifies extension startup only; it does not claim Model Data Query Builder interaction coverage.
- The latest isolated E2E re-run dynamically avoided the occupied inspector port and reached the extension host, then failed in the unrelated Python golden-definition assertion for `Company` (`definitions=[]`). This is not Query Builder coverage and is not counted as a current E2E pass; it was not retried to avoid unnecessary resource use.
- `npm run build:model-browser` completed successfully.
- The packaged `django-shell-1.1.1000031.vsix` was inspected for the Result-mode confirmation strings before the earlier live check.
- The current `django-shell-1.1.1000031.vsix` was rebuilt after the final automated accessibility work. Its bundled `modelBrowserHtml.js` contains the modular Query Builder stylesheets, inspector `aria-controls` links, and inert inactive review panels.
- The current package was rebuilt again after render-coordinator and inline-validation work. Its bundled Model Data renderer contains the coordinator render versions and validation-only issue refresh path.
- The current package was rebuilt after the final accessibility, popover scheduling, and test-harness changes. The packaged `gridQueryValidationView.js` and `gridQueryPopover.js` were inspected for the invalid-state annotations and zero-safe animation-frame guard.
- After a live recovery check exposed a stale persistent scalar-subquery editor, the controller was changed so explicit Reset Draft, Clear Draft, header Undo/Redo, and Cmd/Ctrl+Z history recovery refresh the persistent predicate/computed editor regions only when the draft revision changes. This preserves normal typing/caret behavior while preventing a clean Recipe summary from being paired with stale editor controls.
- The focused controller and render-coordinator tests passed, and the final `npm run check` pass completed after that recovery fix. The package was rebuilt as `django-shell-1.1.1000031.vsix` after the same change.
- The rebuilt `django-shell-1.1.1000031.vsix` was installed with the VS Code CLI without changing the active window. VS Code must still restart before the running extension host and open Model Data webviews use this replacement.
- Sol max reviewed the pending relation identity, automatic-correlation, Boolean null-state, and scalar output-type questions. Its final decision is recorded in `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_MAX_REVIEW.md`; the earlier Sol high review is superseded.
- The Sol max-authorized correction persists a newly selected relation source as its filter `queryName`, while retaining the reverse accessor as the visible label. TypeScript validation now accepts an empty correlation array only for a relation with complete trusted `filterField`/`outerField` metadata, and the ORM compiler emits that metadata-backed `OuterRef` filter. Incomplete relation metadata fails closed with `SUBQUERY_CORRELATION_INVALID`.
- The visible `is null` comparison now initializes its Boolean null state to `true`. Selecting `has value` produces `false` with `Not` unchecked, and changing away from `is null` resets the literal to incomplete `null`. Explanation and compact-summary tests cover all four Boolean/Not truth-table states.
- Focused Sol-decision tests passed 22/22. The required full `npm run check` pass then completed with 640 tests passed, 0 failed.
- The corrected `django-shell-1.1.1000031.vsix` was rebuilt and installed after those tests. The active VS Code window still requires a normal restart before live verification can use this newest package.
- A subsequent live draft exposed a trusted reverse-relation metadata mismatch: Django's valid raw correlation was `company_id = OuterRef("pk")`, but the exposed `company_id` path reported its declared `ForeignKey` type rather than the referenced scalar type. Sol max's bounded decision is recorded in `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_MAX_LIVE_METADATA_DECISION.md`.
- The authorized backend correction keeps raw relation-path names and relation metadata unchanged, while publishing a concrete FK/O2O column's actual `target_field` scalar type for compatibility validation. Dedicated real-Django tests cover UUID primary-key FK/O2O projection and a reverse scalar subquery using stored query identity with empty automatic correlations; the TypeScript validator still rejects an artificially raw `ForeignKey` type.
- The focused metadata, validation, ORM, and parity suite passed 22/22. The final `npm run check` pass completed after this correction (guidelines, compilation, renderer bundles, and 640 tests with 0 failures).
- The corrected `django-shell-1.1.1000031.vsix` was rebuilt and installed with the VS Code CLI. The currently running extension host still needs one normal VS Code restart before the live relation-metadata check can use this package.
- The changed Query Builder source modules are each below the 1,000-line repository limit; the largest is `media/gridQueryController.js` at 507 lines.
- `git diff --check` produced no whitespace errors.

## Live `rtcc-poc-page` check

Environment preparation used the required network and shell workflow: `pm 5`, then `./zz django shell`. The Model Data view reported the Django runtime ready.

| Check | Observation | Result |
| --- | --- | --- |
| Model data baseline | Opened `db.Company`; the grid showed company values and the footer reported `50 rows loaded · more available`. | Pass |
| Drawer shell | Opened Query Builder and used the 220px drawer height. The stage controls and footer remained visible without covering the grid. | Pass |
| Summary-to-Rows protection | Selected Summary, added `ID — id` as a group field, selected Rows, and received `Switching to Rows removes the selected summary group fields.`. Choosing Cancel retained Summary and the group field. | Pass |
| Scalar subquery guidance | In Calculated Values, changed a computed column to Scalar subquery. The live accessibility tree exposed all six ordered assembly sections: Source, Connection, Target filter, Returned value, Row choice, and Output. | Pass |
| Keyboard Undo/Redo | Added a computed column without applying, used `Cmd+Z` to remove it, then `Cmd+Shift+Z` to restore it. The grid stayed on the applied query throughout. | Pass |
| Picker Escape | Opened the Aggregate field picker and pressed Escape. Its option list closed without changing the draft. | Pass |
| Local error recovery | Added an incomplete source condition. The live shell showed `1 error`, explained that the error must be fixed before Apply, and disabled Apply. Resetting the draft restored the applied query. | Pass |
| Focus Builder | Enabled Focus Builder and confirmed the control changed to `Exit Focus Builder`; disabling it restored the normal builder while preserving the clean applied query. | Pass |
| Draft isolation and cleanup | No draft was applied. `Reset draft to applied query` restored `All rows · no computed columns · Rows ordered by primary key ascending`, `Draft matches applied query`, and a disabled Apply button. | Pass |
| Non-disruptive final visual check | In the visible `Company — data — rtcc-poc-page` VS Code window, a read-only accessibility-tree and screenshot inspection confirmed the loaded `db.Company` grid (50 rows), a 220px Query Builder, four stage controls, skip links, Undo/Redo, one disabled clean-state Apply control, pinned-column controls, populated values, and an unobscured footer. No focus, click, input, scroll, or data mutation was performed. | Pass |
| Live metadata deployment boundary | In the previously loaded VS Code extension, selecting `valuation_history_set → db.ValuationHistory` removed the relation-source error but correctly retained `Complete this subquery connection`: live raw path metadata described `company_id` as `ForeignKey`, which is incompatible with `pk` under the intentionally strict validator. Sol max authorized only target-scalar metadata projection; the correction and automated tests are complete, and a freshly rebuilt package/restart is required before rechecking this exact path. No data was changed. | Pending deployment |

## Remaining verification matrix

The plan's full Phase 11 matrix has not been claimed complete in this record. The active VS Code window must first restart so the installed Sol max-corrected package is loaded. The following required observations still need dedicated, non-disruptive sessions before the implementation plan can be declared fully complete:

- a complete four-stage Recipe through validation, ORM preview, Apply, and grid refresh;
- error recovery and Undo/Redo;
- keyboard-only walkthrough;
- wide, medium, narrow, Focus Builder, Problems, high-contrast, and 200% zoom screenshots;
- light/dark/high-contrast theme matrix.

No database changes were made during the recorded check.
