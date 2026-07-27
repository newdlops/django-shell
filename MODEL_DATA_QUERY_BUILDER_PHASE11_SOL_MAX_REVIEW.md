# Phase 11 Sol Max Final Review

## Authority and supersession

This is the final Sol max decision for the Phase 11 relation-identity, null-predicate, and scalar-output-type questions. It supersedes `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_REVIEW.md` (the earlier Sol high review) and any conflicting recommendation in `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_DECISIONS.md`.

This review changed no source code, package, installed extension, or live UI state.

## Evidence reviewed

- Phase 11 in `MODEL_DATA_QUERY_BUILDER_UI_USABILITY_IMPLEMENTATION_PLAN.md`.
- Both earlier Phase 11 decision/review documents.
- `media/gridSubqueryBuilder.js`, `media/gridPredicateBuilder.js`, `media/gridPredicateValue.js`, `media/gridQueryExplanation.js`, and `media/gridQuerySummary.js`.
- `BackendModelRelation` / `BackendFilterRelation`, the TypeScript metadata index, validator, predicate/compiler path, and the Python Recipe validation/compiler path.
- Focused Subquery, predicate, validation, ORM, explanation, and backend tests.

Read-only focused tests were run:

```text
node --test \
  test/modelQuerySubqueryBuilder.test.mjs \
  test/modelQueryPredicateBuilder.test.mjs \
  test/modelQueryRecipeOrm.test.mjs \
  test/modelQueryRecipeValidation.test.mjs \
  test/modelQueryExplanation.test.mjs

25 passed, 0 failed
```

These tests establish the current baseline only. They do not approve the current semantics: one test explicitly expects the incorrect `isnull=false` default, and there is no TypeScript end-to-end test for an automatically correlated relation-source scalar subquery.

## Final verdict summary

| Decision | Verdict | Consequence |
| --- | --- | --- |
| Persist `queryName`; display the accessor | **APPROVE** | Keep the picker contract and do not expand Recipe V2. |
| Treat the current relation-source implementation as Phase 11-ready | **CHANGE REQUIRED** | The TypeScript validator and ORM compiler must implement the already-promised metadata-driven automatic relation correlation. |
| Initialize visible `is null` with `rhs=false` | **CHANGE REQUIRED** | Initialize it with Boolean `true`; use an explicit non-negated `false` state for the Phase 11 `is not null` predicate. |
| Change scalar `outputType: "auto"` | **APPROVE NO CHANGE** | `auto` is valid for the Phase 11 null check and is not the cause of the recorded type error. |

## Decision 1 — relation identity and automatic correlation

### 1A. Canonical stored identity: APPROVE

For a newly selected relation source, Recipe V2 must store:

```text
source.relation = BackendModelRelation.queryName || BackendModelRelation.name
```

The option must continue to display the accessor-oriented label and target model, for example:

```text
valuation_history_set → db.ValuationHistory
```

The current `relationValue()` choice in `media/gridSubqueryBuilder.js` is approved. `sourceTarget()` may accept either the canonical query name or accessor while hydrating the editor. No additional Recipe field and no Recipe V2 schema change are authorized.

The reason is deterministic: Django filter traversal, `BackendFilterRelation.name`, `ModelQueryMetadataIndex.resolveRelation()`, and the Recipe compiler all use the query identity. The reverse related-row accessor is a UI/row-expansion identity and may be different.

### 1B. Exact backward-compatibility boundary

The approved compatibility claim is limited to these cases:

1. A fresh selection in the corrected build stores `queryName || name`.
2. Forward relations for which accessor and query identity are equal continue to work unchanged.
3. An accessor-valued in-memory draft can still resolve its target fields in `sourceTarget()`.

It is **not** approved to claim that an accessor-valued Recipe saved by an older build validates or compiles. `sourceTarget()` is editor hydration only; `ModelQueryMetadataIndex.resolveRelation()` still accepts the filter-tree query identity, not an arbitrary accessor.

No legacy migration is required for the Phase 11 exit gate because Phase 11 creates a fresh Recipe. Before a general cross-version compatibility claim is made, a separate change must either prove that accessor-valued Recipes were never durably persisted or normalize a known accessor to its unique metadata-backed query name at Recipe ingress. Guessing, accepting ambiguous matches, or adding an extra Recipe schema field is not authorized here.

### 1C. Automatic relation correlation: CHANGE REQUIRED

The picker fix alone cannot pass Phase 11. The TypeScript path currently contradicts both the UI and Python contracts:

- the UI says a relation source supplies correlation automatically and leaves `correlations: []`;
- the Python validator accepts exactly an empty correlation list for relation sources and derives the correlation from relation metadata;
- the TypeScript validator unconditionally requires one or more explicit correlations;
- the TypeScript ORM compiler emits no relation-derived filter when `correlations` is empty, which would be an uncorrelated scalar subquery if validation were merely relaxed.

Therefore it is not sufficient to remove `SUBQUERY_CORRELATION_REQUIRED`. Validation and compilation must be corrected together.

The following narrowly scoped code action is authorized and required:

1. In `src/modelQueryRecipeValidation.ts`, make correlation validation source-aware.
   - A `model` source keeps the existing requirement for one to four complete explicit correlations.
   - A `relation` source requires `correlations` to be exactly `[]`.
   - A relation source is valid for ORM compilation only when its resolved `BackendFilterRelation` supplies a complete, metadata-backed automatic correlation contract. For the Phase 11 reverse relation, this is `filterField` on the target and `outerField` on the current model.
   - Missing or invalid automatic-correlation metadata must produce a blocking `SUBQUERY_CORRELATION_INVALID`; it must never fall through to an uncorrelated query.
2. In `src/modelQueryPredicateOrm.ts`, make `compileModelQueryInnerQuery()` source-aware.
   - For a `model` source, preserve the existing explicit `targetPath = OuterRef(outerPath)` filters.
   - For a supported `relation` source, resolve the same relation from metadata and emit `relation.filterField = OuterRef(relation.outerField)` before the inner predicate.
   - Never emit a relation-source inner queryset without a correlation filter.
3. Do not hard-code `db.Company`, `valuation_history_set`, `valuation_history`, or any project field name. Use the resolved metadata values.
4. Do not redesign or guess the M2M correlation contract in this Phase 11 correction. A relation without the required exact metadata must fail closed and be recorded for a separate Sol decision.
5. Keep the Python relation-source contract unchanged unless a parity test exposes a concrete mismatch for this Phase 11 reverse relation.

Required tests:

- a reverse relation with distinct accessor `valuation_history_set` and query identity `valuation_history` stores the query identity but displays/resolves the accessor;
- a relation-source scalar subquery with `correlations: []` validates when its resolved metadata has `filterField` and `outerField`;
- the same Recipe compiles a target filter containing `models.OuterRef(...)` and never an uncorrelated target queryset;
- a relation source with manual correlations is rejected;
- a relation missing automatic-correlation metadata is rejected;
- a custom-model source with no explicit correlation remains rejected;
- the full Phase 11 Recipe validates and compiles with no relation or correlation issue.

## Decision 2 — visible `is null`, Boolean RHS, and exact Phase 11 ORM

### Verdict: CHANGE REQUIRED

`isnull` must carry a JSON Boolean RHS. The current default Boolean is wrong for the visible control label.

The truth table is:

```text
rhs=true,  negated=false  -> is null
rhs=false, negated=false  -> is not null / has value
rhs=true,  negated=true   -> is not null / has value
rhs=false, negated=true   -> is null
```

Because the selected comparison is visibly labeled `is null`, selecting it must initialize:

```json
{ "lookup": "isnull", "rhs": { "kind": "literal", "value": true } }
```

The current `rhs=false` default is rejected. It silently selects “has value” while the comparison control says “is null,” and combining that state with `Not=true` returns null rows—the opposite of the recorded Phase 11 intent.

The exact Phase 11 UI state for `latest_valuation_id is not null` is:

```text
Comparison: is null
Null state: has value
Not: unchecked
```

The exact required ORM predicate is:

```python
models.Q(**{"latest_valuation_id__isnull": False})
```

`~models.Q(**{"latest_valuation_id__isnull": True})` is logically equivalent, but it is not the canonical Phase 11 evidence state. The final UI/QA record must use the direct, non-negated `False` form so the controls, Meaning text, and ORM all describe one state without double inversion.

The following exact changes are authorized and required:

1. In `media/gridPredicateBuilder.js`, change `lookupChanges(..., "isnull")` to create `rhs.value: true`.
2. When changing away from `isnull`, replace the null-state Boolean with an incomplete RHS appropriate for ordinary value entry instead of silently reusing it as a scalar field value. `{ kind: "literal", value: null }` is the approved safe reset; validation may require the user to complete it.
3. Keep the existing `Null state` options `has value=false` and `is null=true`; do not add a second Recipe lookup or change Recipe V2.
4. In `media/gridQueryExplanation.js` and the compact summary path, special-case `isnull` so Boolean and negation are expressed as the effective phrase `is null` or `has a value`/`is not null`. Do not render or announce an inverted statement such as “is null false.”

Required tests:

- selecting visible `is null` creates a Boolean `true` RHS;
- selecting `has value` creates Boolean `false` and leaves `Not` unchecked for the Phase 11 target;
- leaving `isnull` resets the null-state Boolean to an incomplete ordinary literal;
- all four truth-table rows produce correct Meaning/summary semantics;
- the full Phase 11 Recipe compiler output contains exactly `"latest_valuation_id__isnull": False` and does not wrap that predicate in `~(...)`;
- TypeScript and Python validation accept the same Boolean form.

## Decision 3 — scalar output type

### Verdict: APPROVE NO CHANGE

Keep `latest_valuation_id.outputType` as `"auto"`.

An `isnull` comparison validates the RHS as a Boolean null-state selector; it does not require numeric comparison compatibility with the selected `id` scalar. With `onEmpty.value === null`, neither the TypeScript nor Python contract requires a concrete output type. Django can infer the scalar subquery field from the selected `id` expression.

Do not add output inference, force an explicit output type, change Recipe V2, or cast the annotation for Phase 11. Reopen this decision only if the corrected relation correlation and Boolean predicate produce a new, output-type-specific issue. That report must include the exact issue code, metadata for the returned field, Recipe fragment, and generated ORM.

## Minimal authorized implementation checklist

Only the following implementation work is authorized without another Sol decision:

- [ ] Keep relation picker persistence as `queryName || name` and accessor-oriented display.
- [ ] Correct TypeScript relation-source validation to accept empty manual correlations only when exact automatic-correlation metadata is present.
- [ ] Correct TypeScript relation-source ORM compilation to emit the metadata-backed `filterField = OuterRef(outerField)` filter and fail closed otherwise.
- [ ] Change the visible `is null` initialization from Boolean `false` to Boolean `true`.
- [ ] Reset the null-state Boolean when leaving `isnull`.
- [ ] Correct `isnull` Meaning/summary wording for Boolean plus negation.
- [ ] Add the focused validation, ORM, UI-helper, explanation, and full Phase 11 Recipe tests listed above.
- [ ] Run `npm run check`; only after it passes, rebuild/reinstall and restart the extension through the existing approved workflow.
- [ ] Perform the non-mutating Phase 11 UI exit checks below and update the QA record.

Stop for another Sol decision instead of changing code if completion would require M2M correlation design, a Recipe schema change, guessed metadata, safety-limit relaxation, data mutation, or visual redesign.

## Exact final Phase 11 UI exit conditions

Phase 11 is complete only when all of these are recorded against the restarted package:

1. The `rtcc-poc-page` terminal used exact separate commands `pm 5` and `./zz django shell`; `db.Company` opened through `Link: ORM`, and rows loaded without edit or Commit.
2. The four-stage Recipe is exactly:
   - Filter Rows: `id >= 1`;
   - Calculated Values: `latest_valuation_id`, scalar subquery, displayed relation `valuation_history_set → db.ValuationHistory`, returned `id`, inner order `id descending`, `outputType: auto`;
   - Filter Results: `latest_valuation_id`, null state `has value`, `Not` unchecked;
   - Result: `latest_valuation_id descending`, then `id ascending`.
3. Validation has no errors and no unexplained warnings. In particular, there is no `SUBQUERY_RELATION_INVALID`, `SUBQUERY_CORRELATION_REQUIRED`, `SUBQUERY_CORRELATION_INVALID`, or `RHS_TYPE_MISMATCH`.
4. The latest ORM visibly contains all of the following semantic pieces:
   - a target-model scalar subquery correlated with the current row through metadata-backed `OuterRef`;
   - inner `id` descending ordering and one-row `values("id")[:1]` selection;
   - annotation as `latest_valuation_id`;
   - direct post-filter `models.Q(**{"latest_valuation_id__isnull": False})`;
   - final ordering by `-latest_valuation_id`, then `id`.
5. Apply executes only the read-only queryset, keeps prior rows visible until replacement rows arrive, refreshes the grid, and returns the draft to clean/applied state.
6. The Phase 11 plan's recovery, Undo/Redo, resize/Focus Builder, close/reopen, keyboard-only, Dark+, Light+, High Contrast, and 200% zoom checks are recorded with the required screenshots; no test edits data or uses Commit.

Until these conditions and the corrected automated tests are recorded, the implementation may be partially corrected but the Phase 11 goal is **not complete**.
