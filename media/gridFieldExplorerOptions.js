// Resolves searchable relation paths and pasted Django lookups using only live model metadata.
import { rootMetadataOptions } from "./gridQueryMetadata.js";
import { lookupsForField, LOOKUP_LABELS } from "./gridPredicateValue.js";

/** Parses a backend relation target into its explicit model reference. */
function targetFor(relation) {
  const boundary = String(relation.target || "").lastIndexOf(".");
  if (boundary < 1) { throw new Error("The related model is unavailable."); }
  return { app: relation.target.slice(0, boundary), model: relation.target.slice(boundary + 1) };
}

/** Describes scalar fields, traversable relationships, and relationship checks without duplicate identities. */
function optionsFor(tree, prefix, computed) {
  const options = rootMetadataOptions(tree);
  const pathFor = (name) => [...prefix, name].join("__");
  return [
    ...options.relations.map((item) => ({ descriptor: item, group: "Relationships", kind: "relation", label: item.name, path: pathFor(item.name), detail: item.target })),
    ...options.fields.map((item) => ({ descriptor: item, group: "Fields", kind: "field", label: item.name, path: pathFor(item.name), detail: item.type })),
    ...(!prefix.length ? computed.filter((item) => item.enabled !== false && item.alias).map((item) => ({ descriptor: item, group: "Calculated values", kind: "computed", label: item.alias, path: item.alias, detail: item.outputType || "Calculated" })) : []),
    ...options.relations.map((item) => ({ descriptor: item, group: "Relationship checks", kind: "relationTerminal", label: `Check ${item.name}`, path: pathFor(item.name), detail: "Has value / is null" }))
  ];
}

/** Returns one bounded field list or one validated pasted path/lookup, without searching unrelated models. */
export async function resolveFieldExplorer({ source, prefix = [], query = "", computed = [], loadTree }) {
  const text = String(query).trim();
  if (text.length > 240 || prefix.length > 11) { return { prefix, items: [], message: "This path is too long. Choose a closer field." }; }
  const pasted = text.includes("__"), parts = pasted ? text.split("__") : [...prefix, text];
  if (parts.length > 14) { return { prefix, items: [], message: "This path has too many relationships." }; }
  let model = source, tree = await loadTree(model);
  const resolved = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const segment = parts[index], options = rootMetadataOptions(tree);
    const relation = options.relations.find((item) => item.name === segment);
    const lookup = parts.slice(index + 1).join("__");
    if (pasted && relation && lookup === "isnull") {
      const path = [...resolved, segment].join("__");
      return { prefix: resolved, model, items: [{ descriptor: relation, group: "Django lookup", kind: "relationTerminal", label: path, path, lookup, detail: "Has value / is null" }], total: 1 };
    }
    if (relation && resolved.length < 11) {
      resolved.push(segment); model = targetFor(relation); tree = await loadTree(model); continue;
    }
    const field = options.fields.find((item) => item.name === segment);
    if (pasted && field && lookupsForField(field).includes(lookup)) {
      const path = [...resolved, segment].join("__");
      return { prefix: resolved, model, items: [{ descriptor: field, group: "Django lookup", kind: "field", label: path, path, lookup, detail: `${LOOKUP_LABELS[lookup]} · ${field.type}` }], total: 1 };
    }
    return { prefix: resolved, model, items: [], message: field ? `“${lookup}” is not an available comparison for ${segment}. Choose the field first to see its comparisons.` : `No field or relationship named “${segment}” here. Check the path or browse from the model above.` };
  }
  const term = parts.at(-1).toLowerCase();
  const all = optionsFor(tree, resolved, computed).filter((item) => `${item.label} ${item.descriptor.label || ""}`.toLowerCase().includes(term));
  return { prefix: resolved, model, items: all.slice(0, 60), total: all.length, partial: Boolean(tree.partial) };
}
