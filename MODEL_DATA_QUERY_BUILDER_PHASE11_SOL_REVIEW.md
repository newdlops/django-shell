# Phase 11 Sol Review Addendum

## Review scope and authority

This addendum is the Sol-level decision for the two implementation choices recorded in `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_DECISIONS.md`. It reviews semantics only. It does not authorize a Recipe V2 schema expansion, backend safety-limit relaxation, data mutation, or visual redesign.

Reviewed evidence:

- Phase 11 requirements in `MODEL_DATA_QUERY_BUILDER_UI_USABILITY_IMPLEMENTATION_PLAN.md`;
- the live finding and current state in `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_DECISIONS.md`;
- `BackendModelRelation` and `BackendFilterRelation` contracts;
- the TypeScript metadata resolver, validator, and ORM compiler;
- the Python metadata and Recipe predicate builders;
- the current Subquery and predicate editors and their focused tests.

Focused automated verification was run without UI or packaging:

```text
node --test \
  test/modelQuerySubqueryBuilder.test.mjs \
  test/modelQueryPredicateBuilder.test.mjs \
  test/modelQueryRecipeOrm.test.mjs \
  test/modelQueryRecipeValidation.test.mjs

20 passed, 0 failed
```

The passing tests prove the current encoded contracts; they do not, by themselves, prove that those contracts express the intended null semantics or complete legacy migration behavior.

## Decision 1 — relation identity

### Verdict: approve the canonical identity; approve compatibility only with conditions

Recipe V2 relation sources must persist the Django query identity from `BackendModelRelation.queryName` when it is available. The reverse accessor remains a presentation and related-row expansion identity. A new Recipe schema field is not approved.

The rationale is structural rather than model-specific:

- Django lookup traversal and Recipe compilation require the filter/query name.
- The filter metadata tree already identifies relations by that query name.
- Reverse accessors such as a default `_set` name may differ from `related_query_name()`.
- Persisting the accessor would make a visually valid choice fail deterministic validation before the backend can use its broader relation resolver.
- Forward relations naturally retain the same value because `queryName` and `name` normally coincide.

The UI must continue to display the human-recognizable accessor label and target model. Selection must write `queryName || name` to `source.relation`. Field-picker source resolution may accept either identity so an existing in-memory editor can still render its target fields.

### Compatibility boundary

The current dual-name lookup in `sourceTarget()` is editor-hydration compatibility only. It is not sufficient evidence that an older accessor-valued Recipe can pass validation and compile, because `ModelQueryMetadataIndex.resolveRelation()` resolves the filter-tree query identity, not the grid accessor.

Therefore the phrase “with backward compatibility” is approved only under one of these explicit conditions:

1. evidence establishes that accessor-valued Recipe V2 documents were never durably persisted or shipped, so no cross-version Recipe migration promise exists; or
2. the Recipe ingress/editor normalization path maps a known accessor to its `queryName` before validation, and a focused test proves that the normalized Recipe validates and compiles; or
3. a metadata-backed resolver accepts the accessor without guessing and canonicalizes it to the query name, with tests for distinct accessor/query names and ambiguous-name rejection.

Option 1 is sufficient for the Phase 11 live exit gate because Phase 11 creates a fresh Recipe in the installed build. Options 2 or 3 are required before making a general backward-compatibility claim. A Recipe V2 schema change is unnecessary for all three options.

### Acceptance conditions

Decision 1 is accepted for Phase 11 when all of the following are observed in the restarted installed build:

- the relation option visibly identifies `valuation_history_set` and `db.ValuationHistory`;
- the newly stored source relation is the metadata query identity;
- selecting the relation enables target field selection for `id`;
- latest validation reports neither `SUBQUERY_RELATION_INVALID` nor the derivative `SUBQUERY_CORRELATION_REQUIRED`;
- the generated ORM uses a correct automatically correlated subquery rather than a custom-model correlation;
- no arbitrary relation substitution or hard-coded model exception is used.

## Decision 2 — RHS created when switching to `isnull`

### Verdict: change required

Switching to `isnull` must materialize a JSON boolean RHS. That part of the implementation is approved because both TypeScript and Python validators correctly reject `null` and non-boolean values.

The unconditional default value `false` is not approved for a lookup control whose visible selected label is `is null`.

The reason is exact Django semantics:

```text
isnull=true,  negated=false  => is null
isnull=false, negated=false  => is not null / has value
isnull=true,  negated=true   => is not null / has value
isnull=false, negated=true   => is null
```

The current decision record states that a `false` RHS followed by negation produces “is not null.” That statement is incorrect. It produces “is null.” Replaying the recorded live steps with `rhs.value=false` and `negated=true` can therefore pass validation while returning the opposite row set.

The fixed behavior must satisfy one of these two coherent UI contracts:

1. Recommended current-UI contract: selecting the visible `is null` lookup initializes `rhs` to `{ kind: "literal", value: true }`; the existing `Not` control can then produce “is not null.”
2. Alternative explicit-state contract: selecting the lookup may initialize `false` only if the same operation visibly selects and announces `has value`, and the Phase 11 Recipe leaves `negated=false`.

Because the current comparison option is labeled `is null`, contract 1 is approved as the minimal and least surprising correction. Do not combine `rhs.value=false` with `negated=true` for the Phase 11 target.

### Required tests

Before the latest package is treated as Phase 11-ready, automated coverage must prove:

- changing from a non-null-aware lookup to the visible `is null` lookup creates a boolean RHS;
- the initial RHS matches the visible lookup contract selected above;
- ORM generation for the Phase 11 post-filter is semantically `latest_valuation_id__isnull=False`, either directly or through the logically equivalent negated-`true` form;
- the Meaning/summary text does not claim the inverse operation;
- changing away from `isnull` does not silently retain an incompatible boolean as though it were a user-entered scalar for another lookup.

The last item is a validation/recovery requirement. It does not authorize guessing a replacement value for arbitrary field types; an incomplete value that the user must repair is acceptable.

## Decision 3 — automatic scalar output type

### Verdict: no semantic change; not a Phase 11 blocker

No automatic output-type redesign or Recipe schema change is approved.

For the Phase 11 predicate, `isnull` validation depends on a boolean RHS and does not require numeric comparison compatibility. A scalar subquery with a null `onEmpty` value is allowed to retain `outputType: "auto"`. The previously observed `RHS_TYPE_MISMATCH` is explained by the stale non-boolean RHS and is not evidence of failed scalar type inference.

Reconsider output inference only if the restarted corrected build still produces an output-type-specific validation or execution issue. Record the exact issue code, Recipe fragment, ORM, and selected field metadata before requesting another decision.

## Authorization for remaining work

Mechanical verification may proceed after Decision 2 is corrected and its focused semantic tests pass. No further design decision is needed for the intended four-stage Recipe.

The operator is authorized to:

- rebuild, package, reinstall, and restart the extension through the already approved workflow;
- recreate the fixed Phase 11 Recipe using real metadata;
- inspect latest Meaning, Problems, and Django ORM output;
- apply only the read-only queryset Recipe;
- verify grid refresh, error recovery, history, focus, resize, keyboard, theme, and zoom behavior;
- reset or close the uncommitted draft after observation;
- record screenshots and observations.

Stop and request another Sol decision before changing code if:

- a relation selected by query identity still cannot validate or auto-correlate;
- the generated ORM does not express the intended `is not null` predicate;
- `outputType: "auto"` causes a new concrete validation or execution issue;
- passing the scenario would require a Recipe schema change, safety relaxation, metadata guess, data mutation, or redesign.

## Phase 11 exit criteria

Phase 11 is complete only when all implementation-plan gates are evidenced, plus the semantic conditions below.

### Environment and safety

- the `rtcc-poc-page` integrated terminal used exact `pm 5`, followed separately by exact `./zz django shell`;
- `db.Company` Model Data is opened through `Link: ORM` and rows load;
- no grid edit, Commit, destructive queryset action, or production-data mutation occurs.

### Four-stage Recipe correctness

- Filter Rows is `id >= 1`;
- the calculated `latest_valuation_id` scalar subquery uses the visible `valuation_history_set` relation, returns `id`, and orders inner rows by `id` descending;
- Filter Results is semantically `latest_valuation_id is not null`;
- Result ordering is `latest_valuation_id` descending, then `id` ascending;
- validation has no errors and no unexplained warnings;
- the latest ORM visibly encodes the intended correlation, scalar selection, post-filter null semantics, and two-term order;
- Apply runs a read-only query, preserves prior rows until replacement rows arrive, refreshes the grid, and returns the draft to clean/applied state.

### Recovery and interaction

- removing and restoring Returned Value demonstrates issue targeting and recovery without stealing focus;
- Undo/Redo covers coalesced alias typing, duplicate, and Clear Draft recovery;
- drawer resize, Focus Builder, Show Grid, close/reopen, and grid state restoration pass;
- the required keyboard-only path passes without lost or unpredictable focus;
- Dark+, Light+, High Contrast, and 200% zoom checks record the required states without overlap, clipping, unreadable focus, or hidden disabled/error state.

### Evidence and final status

- actual screenshots and observations are added to the QA record;
- automated checks, package identity, installed/restarted state, and any warnings are recorded;
- Decision 1 compatibility is described within the proven boundary and is not overstated;
- the final record explicitly confirms that the applied ORM predicate is logically `latest_valuation_id__isnull=False`.

Until these criteria are recorded, implementation may be code-complete but the Phase 11 goal is not complete.
