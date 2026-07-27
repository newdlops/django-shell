# Phase 11 Sol Max Live Relation-Metadata Decision

## Authority and scope

This is the Sol max decision for the new live Phase 11 reverse-relation correlation failure observed after restarting the installed build.

The observed draft used:

- outer model `db.Company`;
- displayed relation `valuation_history_set → db.ValuationHistory`;
- persisted relation query identity `valuation_history`;
- relation-source scalar subquery with `correlations: []`.

No Apply occurred and no data changed. This review changes no source code, package, installed extension, or UI state. It authorizes only the narrow metadata correction and tests stated below.

## Evidence reviewed

- `MODEL_DATA_QUERY_BUILDER_PHASE11_SOL_MAX_REVIEW.md`.
- The live model definition at `rtcc-poc-page/zuzu/db/models/valuation_history.py`.
- `python/backend_parts/50_model_core.pyfrag`, especially `_browse_columns()`, `_browse_relations()`, `_browse_relation_query_name()`, `_browse_relation_subquery_meta()`, and `_browse_filter_field_tree()`.
- `src/modelBackend.ts`, `src/modelQueryRecipeMetadata.ts`, `src/modelQueryRecipeValidation.ts`, and `src/modelQueryPredicateOrm.ts`.
- `python/backend_parts/90_model_query_recipe_predicate.pyfrag` and `python/backend_parts/91_model_query_recipe_computed.pyfrag`.
- Focused metadata, validation, ORM, backend, and parity tests.

Read-only focused tests were run:

```text
node --test \
  test/modelQueryRecipeValidation.test.mjs \
  test/modelQueryRecipeOrm.test.mjs \
  test/modelQueryRecipeBackend.test.mjs \
  test/modelQueryRecipeParity.test.mjs

20 passed, 0 failed
```

That green baseline does not cover the live contract mismatch. The TypeScript tests currently hand-author the target raw FK field as `AutoField` or `IntegerField`; they do not prove that the Python metadata backend emits that scalar type.

## Exact verdict

**CHANGE REQUIRED — keep the selected relationship and correct the generic raw-relation-column type metadata.**

The reverse relation is the correct Phase 11 relationship. Its accessor/query-name split is working as approved:

```text
display/accessor: valuation_history_set
stored/query name: valuation_history
target: db.ValuationHistory
```

The blocking `SUBQUERY_CORRELATION_INVALID` is not evidence that the relationship is unsuitable. It is caused by an internal metadata contradiction:

```text
automatic target path: company_id
automatic outer path:  pk

target path metadata: attname=company_id, name=company, type=ForeignKey
outer path metadata:  attname=id,         name=id,      type=AutoField
```

`company_id` denotes the raw scalar database value, but the field tree labels it with the declared relation-object class `ForeignKey`. TypeScript therefore compares `ForeignKey` with `AutoField` and correctly fails closed.

For this live model, Django's actual storage-side equality is valid:

```python
ValuationHistory._base_manager.filter(company_id=models.OuterRef("pk"))
```

`ValuationHistory.company` targets the default `Company` primary key. The raw `company_id` column therefore has the scalar type of the foreign key's target field, which is the same `AutoField` family as `Company.pk`.

## Root-cause trace

1. The live model declares `ValuationHistory.company` as a `ForeignKey` to `Company`, with `related_name="valuation_history_set"` and `related_query_name="valuation_history"`.
2. `_browse_relation_subquery_meta()` correctly derives the reverse correlation paths as the forward field attname and the outer primary-key alias:

   ```text
   filterField = forward.attname = company_id
   outerField = pk
   ```

3. `_browse_filter_field_tree(ValuationHistory)` builds its leaves from `_browse_columns(ValuationHistory)`.
4. `_browse_columns()` exposes the raw identifier `field.attname`, but sets `type` to `type(field).__name__`.
5. For a foreign key this creates a mixed contract: scalar identifier/value `company_id`, relation-object type `ForeignKey`.
6. `ModelQueryMetadataIndex.resolvePath()` resolves both paths successfully.
7. `compatibleTypes()` classifies `AutoField` as numeric but cannot classify `ForeignKey`, so it emits the exact live message, “This relation does not provide compatible automatic connection fields.”

This is a type projection error attached to an attname. It is not a missing path, query-name error, scalar output-type error, or invalid Django correlation.

## Approved implementation

### 1. Correct the backend's raw concrete-column type projection

In `python/backend_parts/50_model_core.pyfrag`, add one small, documented helper (name is implementation-local) that returns the Recipe/UI-facing scalar type for a concrete column:

- for a non-relation concrete field, preserve the current field class name;
- for a concrete FK or O2O exposed through its raw `attname`, use the class name of its Django target/storage field;
- fail conservatively to the current field class if Django does not expose a usable target field;
- do not infer from identifier suffixes, model names, database values, or a numeric-only allowlist.

Use that helper for `_browse_columns()`'s `type` value. Keep all of these unchanged:

- `attname`;
- declared field `name`;
- `relation` target metadata;
- choices, labels, help text, nullability, editability, and primary-key flags;
- relation accessor and `queryName`;
- `filterField` and `outerField`.

This is the generic correction because the UI reads and filters the raw `*_id` value. It also handles non-integer relation targets by projecting the actual Django target field type instead of pretending every foreign key is numeric.

### 2. Keep TypeScript safety checks and compiler behavior

No widening of `compatibleTypes()` is approved.

In particular, do not:

- classify every `ForeignKey` as numeric;
- accept any relation-shaped metadata without resolving both paths;
- bypass type compatibility for relation sources;
- guess a target type from `_id`;
- hard-code `Company`, `ValuationHistory`, `company_id`, or `pk`.

After corrected metadata is loaded, the existing automatic-correlation validator should resolve compatible scalar types and the existing compiler should emit the metadata-backed filter.

The fail-closed compiler fallback for incomplete relation metadata must remain.

### 3. Keep the Python Recipe relation compiler unchanged

No Python Recipe validation/compiler semantic change is authorized for this live finding.

The Python relation-source path already:

- requires client correlations to be exactly empty;
- resolves the live Django relation;
- derives this live reverse FK filter from the forward field attname;
- emits `company_id = OuterRef("pk")` for this relationship.

The backend metadata correction aligns the TypeScript preflight view with that live Django compiler contract. It does not require a Recipe schema change.

### 4. Do not choose a different relationship

Phase 11 must continue to use the displayed `valuation_history_set → db.ValuationHistory` relation and persist `valuation_history`.

Selecting a different relation would hide the metadata bug and would no longer verify the intended reverse FK/accessor-versus-query-name contract.

## Not authorized by this decision

- Recipe V2 changes or migration.
- UI redesign or copy changes.
- A `ForeignKey` compatibility shortcut in TypeScript.
- Model- or field-specific exceptions.
- M2M correlation changes.
- Custom `to_field` correlation redesign.
- Safety-limit changes.
- Data mutation.

Stop for another Sol max decision if the narrow metadata correction does not remove the correlation issue or if completion requires any item above.

## Required tests before packaging

### Python metadata contract

Add a real-Django backend test, not only a hand-authored metadata object, proving that:

1. a concrete FK remains exposed under its raw attname;
2. its `name` remains the declared relation name;
3. its relation target metadata remains present;
4. its exposed `type` equals the scalar Django target-field type rather than `ForeignKey`;
5. a reverse FK relation's `filterField` resolves to that target-tree leaf;
6. the outer primary-key leaf and target raw-FK leaf are compatible.

Add a non-integer target-field case, such as UUID or text, to prove the implementation follows Django target metadata and does not apply a numeric FK heuristic.

### TypeScript validation and ORM compilation

Use a backend-shaped reverse relation with distinct accessor and query identity. Prove that:

1. `correlations: []` validates with the corrected scalar target-field metadata;
2. no `SUBQUERY_CORRELATION_REQUIRED` or `SUBQUERY_CORRELATION_INVALID` is produced;
3. the compiled inner queryset contains `filterField = OuterRef(outerField)`;
4. the target queryset cannot compile uncorrelated;
5. missing `filterField` or `outerField` still fails closed;
6. manual correlations on a relation source remain rejected;
7. deliberately malformed metadata that still labels the raw target attname as `ForeignKey` is not made valid by a TypeScript heuristic.

### Python Recipe integration

Add or extend a read-only real-Django backend test for a reverse FK relation source. It must prove that:

1. the relation query identity resolves;
2. empty manual correlations are accepted;
3. the scalar subquery returns only rows related to each outer row;
4. generated ORM contains the exact metadata/live-Django correlation;
5. an explicit inner order removes `SUBQUERY_IMPLICIT_ORDER`.

### Full verification

After implementation:

```text
npm run check
```

must pass before rebuild, package, installation, restart, or live UI verification.

## Interpretation of the other two live Problems

The other messages do not justify code changes:

- `Choose an available field` is expected while the returned scalar field is still unset.
- `The subquery uses its default order` is expected while inner ordering is still empty.

They must disappear through completing the Phase 11 editor state:

```text
returned field: id
inner order: id descending
```

The automatic-correlation error is different: it must disappear immediately after choosing the relation, before a returned field or explicit order is selected.

## Revised live UI verification

Run these checks only after the corrected build is packaged, installed, and VS Code is restarted.

1. Start from a fresh `db.Company` Link: ORM grid and a fresh Recipe draft so the metadata trees are reloaded.
2. Add `Filter Rows: id >= 1`.
3. Add scalar subquery alias `latest_valuation_id`.
4. Choose the displayed relation `valuation_history_set → db.ValuationHistory`.
5. Immediately inspect Problems before choosing a returned field:
   - `SUBQUERY_RELATION_INVALID` must be absent;
   - `SUBQUERY_CORRELATION_REQUIRED` must be absent;
   - `SUBQUERY_CORRELATION_INVALID` must be absent;
   - the incomplete returned-field error and implicit-order warning are allowed at this intermediate point.
6. Choose returned field `id`.
   - the returned-field error must disappear;
   - only the implicit-order warning may remain.
7. Add inner order `id descending`.
   - the implicit-order warning must disappear;
   - validation must now have no error and no unexplained warning.
8. Keep `outputType: auto`.
9. Add `Filter Results: latest_valuation_id`, null state `has value`, with `Not` unchecked.
10. Add final order `latest_valuation_id descending`, then `id ascending`.
11. Inspect the read-only ORM preview before Apply. For this live relationship it must contain the semantic equivalent of:

    ```python
    ValuationHistory._base_manager.filter(
        company_id=models.OuterRef("pk")
    ).order_by("-id").values("id")[:1]
    ```

    It must also contain direct `latest_valuation_id__isnull=False` filtering and final `-latest_valuation_id, id` ordering.
12. Apply only after all checks above pass. Confirm grid replacement and clean/applied state without edit or Commit.

## Completion status

The Phase 11 goal remains **not complete** at this decision point.

It may proceed after the narrow backend metadata correction, required automated tests, `npm run check`, rebuild/reinstall/restart, and revised read-only live verification all pass. No relationship substitution is approved.
