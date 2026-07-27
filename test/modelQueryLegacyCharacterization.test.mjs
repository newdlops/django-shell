// Characterizes intentionally retained legacy model-query behavior before Recipe v2 replaces it.

import assert from "node:assert/strict";
import test from "node:test";

import { buildRowsOrm } from "./modelBrowserHelpers.mjs";

const COLUMNS = [
  { attname: "id", pk: true, type: "AutoField" },
  { attname: "name", type: "CharField" },
  { attname: "amount", type: "IntegerField" }
];
const RELATIONS = [{ kind: "m2m", name: "members", queryName: "members", single: false, target: "db.Member" }];

test("legacy flat filters are ANDed and a negated term is emitted as exclude", () => {
  const orm = buildRowsOrm({
    app: "db",
    columns: COLUMNS,
    filters: [
      { field: "name", lookup: "icontains", value: "acme" },
      { field: "amount", lookup: "gt", negate: true, value: 10 }
    ],
    limit: 50,
    model: "Company"
  });

  assert.equal(orm, 'Company._base_manager.filter(**{"name__icontains": "acme"}).exclude(**{"amount__gt": "10"}).order_by(\'pk\')[0:51]');
});

test("legacy annotation aliases become post-annotation filters", () => {
  const orm = buildRowsOrm({
    annotations: [{ alias: "name_copy", expression: 'models.F("name")', kind: "annotate" }],
    app: "db",
    columns: COLUMNS,
    filters: [{ field: "name_copy", lookup: "icontains", value: "acme" }],
    limit: 50,
    model: "Company"
  });

  assert.match(orm, /\.annotate\(name_copy=models\.F\("name"\)\)\.filter\(\*\*\{"name_copy__icontains": "acme"\}\)/);
});

test("legacy window aliases are silently dropped from filters", () => {
  const orm = buildRowsOrm({
    annotations: [{ alias: "row_number", field: undefined, func: "row_number", kind: "window", orderBy: [{ field: "id" }], partitionBy: [] }],
    app: "db",
    columns: COLUMNS,
    filters: [{ field: "row_number", lookup: "lte", value: 3 }],
    limit: 50,
    model: "Company"
  });

  assert.match(orm, /\.annotate\(row_number=models\.Window/);
  assert.doesNotMatch(orm, /row_number__lte/);
});

test("legacy Count across a to-many relation uses distinct", () => {
  const orm = buildRowsOrm({
    annotations: [{ alias: "member_count", distinct: true, field: "members", func: "count", kind: "aggregate" }],
    app: "db",
    columns: COLUMNS,
    limit: 50,
    model: "Company",
    relations: RELATIONS
  });

  assert.match(orm, /member_count=models\.Count\("members", distinct=True\)/);
});

test("legacy subquery correlation stays outside an OR condition group", () => {
  const orm = buildRowsOrm({
    annotations: [{
      alias: "matching_member",
      conditions: {
        join: "any",
        terms: [
          { field: "name", lookup: "startswith", rhs: { kind: "value", value: "a" } },
          { field: "name", lookup: "exact", rhs: { field: "name", kind: "outer" } }
        ]
      },
      field: "name",
      filterField: "name",
      kind: "subquery",
      outerField: "name",
      target: "db.Member"
    }],
    app: "db",
    columns: COLUMNS,
    limit: 50,
    model: "Company",
    relations: RELATIONS
  });

  assert.ok(orm.indexOf('.filter(**{"name": models.OuterRef("name")})') < orm.indexOf('.filter((models.Q(**{"name__startswith": "a"}) | models.Q(**{"name__exact": models.OuterRef("name")})))'));
});

test("malformed legacy annotations are dropped rather than reported", () => {
  const orm = buildRowsOrm({
    annotations: [
      { alias: "bad", conditions: { join: "all", terms: [] }, field: "members", func: "count", kind: "aggregate" },
      { alias: "valid", expression: 'models.F("name")', kind: "annotate" }
    ],
    app: "db",
    columns: COLUMNS,
    limit: 50,
    model: "Company",
    relations: RELATIONS
  });

  assert.match(orm, /valid=models\.F\("name"\)/);
  assert.doesNotMatch(orm, /bad/);
});
