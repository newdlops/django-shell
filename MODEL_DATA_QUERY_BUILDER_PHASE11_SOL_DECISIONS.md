# Phase 11 Sol Decision Record

## Purpose

This document records the remaining decisions and evidence from live `rtcc-poc-page` Query Builder verification. A Sol-level review must decide any item in this document before further design-affecting implementation is performed. Mechanical build, package, installation, and non-mutating cleanup steps may proceed independently.

## Current mechanical state

- The VSIX was rebuilt and installed as `django-shell-1.1.1000031.vsix` after the latest source changes.
- `npm run check` passed: 637 tests, TypeScript compilation, renderer bundles, and repository guideline checks.
- VS Code must restart before its active extension host and existing Model Data webview can load this installed package.
- The live `db.Company` grid loaded 50 rows through `Link: ORM`; no cell edit or Commit action was performed.

## Live evidence gathered before the latest package

The intended four-stage Recipe was assembled in the visible UI up to validation:

1. Filter Rows: `id >= 1`.
2. Calculated Values: scalar subquery named `latest_valuation_id`, relation label `valuation_history_set`, returned field `id`, inner order `id descending`.
3. Filter Results: calculated alias with `is null`, negated to mean `latest_valuation_id is not null`.
4. Result: `latest_valuation_id descending`, then `id ascending`.

The old installed bundle reported three errors:

1. `SUBQUERY_RELATION_INVALID`: the UI picked the grid relation accessor `valuation_history_set`, while the Recipe compiler resolves the filter-query relation identity supplied by `filterFields` metadata.
2. `SUBQUERY_CORRELATION_REQUIRED`: this followed from the unresolved relation and should disappear when the relation source resolves.
3. `RHS_TYPE_MISMATCH`: changing lookup to `is null` left the prior `null` literal instead of the required boolean null-state value.

## Changes already made before this record request

These narrowly scoped corrections were implemented and passed automated checks before the instruction to defer judgement calls:

- `media/gridSubqueryBuilder.js`
  - stores `BackendModelRelation.queryName` when available, while continuing to display the human-facing accessor label such as `valuation_history_set`;
  - accepts either identity when resolving the target for the field picker.
- `media/gridPredicateBuilder.js`
  - changing a predicate lookup to `isnull` now sets RHS to `{ kind: "literal", value: false }`, the valid default for “has value”; negating it produces “is not null”.
- Focused tests cover both contracts.

## Decision 1 — relation identity contract

### Question for Sol

Should the Query Builder persist Django filter-query identity (`queryName`) while showing reverse relation accessor labels, or should the metadata protocol gain an explicit accessor-to-query-name mapping that is persisted separately in Recipe V2?

### Recommended decision

Keep the current implementation: persist `queryName`; show accessor labels. It aligns with the existing Recipe compiler and backend metadata resolver, avoids a Recipe schema change, preserves the visible `valuation_history_set` discovery text, and is compatible with forward relations where both names are equal.

### Required post-restart acceptance check

After VS Code restart, select the displayed `valuation_history_set` option and confirm the Recipe preview has no `SUBQUERY_RELATION_INVALID` or `SUBQUERY_CORRELATION_REQUIRED` issue.

## Decision 2 — automatic scalar output type

### Question for Sol

After Decision 1 is verified, should `outputType: "auto"` infer the exact selected scalar field type for later filter compatibility, or should the UI require the user to choose an explicit output type before a calculated alias is used in Filter Results?

### Evidence

The pre-fix validation included an is-null RHS error caused by stale RHS shape, not necessarily by `outputType: "auto"`. This must be rechecked before changing inference semantics.

### Do not implement until checked

No inference or Recipe schema changes should be made unless the restarted build still rejects `latest_valuation_id is not null` after the relation and boolean-RHS fixes.

## Decision 3 — remaining Phase 11 execution boundary

### Pre-authorized mechanical verification after restart

The fixed implementation plan already specifies these non-mutating checks:

- recreate the four-stage Recipe above;
- wait for latest validation and inspect Meaning, Problems, and Django ORM;
- Apply the read-only query and confirm matching grid refresh without a blank interim grid;
- reset the draft or restore a clean applied state after observation;
- verify keyboard history, resize, Focus Builder, and close/reopen behavior;
- record actual observations.

### Escalate to Sol before acting if

- validation still reports a new or semantically different issue after the installed build is restarted;
- the recipe would require relaxing backend safety limits or changing Recipe V2 semantics;
- Apply attempts a data mutation or presents an unexpected confirmation;
- a theme/zoom failure requires a visual redesign rather than a clearly localized defect fix.

## Current Phase 11 status

Implementation checks are green. Live exit-gate verification is pending the VS Code restart that activates the newest installed package, then the mechanical re-run described above.
