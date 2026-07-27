// Query Builder Meaning and Django ORM review-panel rendering helpers.

import { explainImplicitBehavior, explainPredicateGroup, explainResult, queryExplanationTokens } from "./gridQueryExplanation.js";

/** Renders safe semantic Meaning and implicit-behavior content for the active Recipe. */
export function renderQueryInspector({ element, elements, recipe, root, scope, validation }) {
  const paragraphs = [explainPredicateGroup(recipe.where, { root: true }).text];
  const enabled = (recipe.computed || []).filter((item) => item?.enabled);
  if (enabled.length) { paragraphs.push(`Add ${enabled.map((item) => `\`${item.alias || item.kind}\``).join(", ")}.`); }
  const post = explainPredicateGroup(recipe.postFilter, { postFilter: true, root: true });
  if (recipe.postFilter?.children?.length) { paragraphs.push(post.text); }
  paragraphs.push(explainResult(recipe, { fields: Object.fromEntries(scope.columns.map((field) => [field.attname || field.name, field])) }).text);
  elements.queryPlainMeaning.replaceChildren(...paragraphs.map((text) => explanationParagraph(element, text)));
  const transport = root.getElementById("transport")?.value || "auto";
  const implicit = explainImplicitBehavior(recipe, validation, { transport: transport === "orm" ? "the ORM link" : transport === "tcp" ? "the socket link" : "the active link" });
  elements.queryImplicitBehavior.replaceChildren();
  if (implicit.length) { elements.queryImplicitBehavior.append(element("h3", {}, "The builder will also"), element("ul", { className: "query-implicit-behavior" }, ...implicit.map((text) => element("li", {}, text)))); }
}

/** Renders one explanation paragraph with code tokens as semantic code elements. */
function explanationParagraph(element, text) {
  const paragraph = element("p");
  for (const token of queryExplanationTokens(text)) { paragraph.appendChild(element(token.kind === "code" ? "code" : "span", {}, token.value)); }
  return paragraph;
}

/** Copies only the host-generated ORM preview, leaving selectable text as the safe fallback. */
export async function copyQueryOrmPreview(root = document) {
  const text = root.getElementById("queryOrmPreview")?.textContent || "";
  const orm = text.includes("Django ORM\n") ? text.split("Django ORM\n").slice(1).join("Django ORM\n") : "";
  if (!orm || !navigator.clipboard?.writeText) { return false; }
  try {
    await navigator.clipboard.writeText(orm);
    return true;
  } catch {
    return false;
  }
}
