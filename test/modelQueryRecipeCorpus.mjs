// Provides stable Recipe v2 fixtures shared by compiler, protocol, and UI acceptance tests.

export const MODEL_QUERY_RECIPE_CORPUS = Object.freeze([
  Object.freeze({
    name: "nested-boolean-filter",
    recipe: Object.freeze({
      computed: [],
      groupBy: [],
      mode: "rows",
      orderBy: [],
      postFilter: { children: [], join: "and", kind: "group", negated: false, nodeId: "post-root" },
      source: { app: "db", model: "Company" },
      version: 2,
      where: {
        children: [
          { kind: "comparison", lhs: { kind: "field", path: "is_demo" }, lookup: "exact", negated: false, nodeId: "demo", rhs: { kind: "literal", value: false } },
          {
            children: [
              { kind: "comparison", lhs: { kind: "field", path: "_base_name" }, lookup: "icontains", negated: false, nodeId: "name-test", rhs: { kind: "literal", value: "테스트" } },
              { kind: "comparison", lhs: { kind: "field", path: "_base_name" }, lookup: "icontains", negated: false, nodeId: "name-demo", rhs: { kind: "literal", value: "demo" } }
            ],
            join: "or",
            negated: false,
            nodeId: "names",
            kind: "group"
          }
        ],
        join: "and",
        negated: false,
        nodeId: "where-root"
      }
    })
  }),
  Object.freeze({
    name: "field-comparison",
    recipe: Object.freeze({
      computed: [],
      groupBy: [],
      mode: "rows",
      orderBy: [],
      postFilter: { children: [], join: "and", kind: "group", negated: false, nodeId: "post-root" },
      source: { app: "db", model: "Company" },
      version: 2,
      where: {
        children: [{ kind: "comparison", lhs: { kind: "field", path: "expires_at" }, lookup: "lt", negated: false, nodeId: "date-compare", rhs: { kind: "field", path: "renewed_until" } }],
        join: "and",
        negated: false,
        nodeId: "where-root"
      }
    })
  })
]);

/** Returns the fixture with a stable name, or undefined when no fixture has that name. */
export function modelQueryRecipeFixture(name) {
  return MODEL_QUERY_RECIPE_CORPUS.find((fixture) => fixture.name === name);
}
