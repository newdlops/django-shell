// Unit tests for runtime-only overlay Python feature context detection.

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { overlayRuntimeCompletionContext, overlayRuntimeFeatureContext, runtimePreludeSymbols } = require("../out/overlayRuntimeContext.js");

const PRELUDE = [
  "from typing import Any as _DjsAny",
  "from shop.models import Company, Employee as Staff",
  "import django.db.models as models",
  "current_user: User",
  ""
].join("\n");

test("parses public runtime imports, aliases, modules, and declarations", () => {
  assert.deepEqual(runtimePreludeSymbols(PRELUDE).map((symbol) => [symbol.name, symbol.kind]), [
    ["Company", "class"],
    ["current_user", "variable"],
    ["models", "namespace"],
    ["Staff", "class"]
  ]);
});

test("returns filtered synthetic runtime names without hidden member analysis", () => {
  const context = overlayRuntimeCompletionContext("value = cu", { character: 10, line: 0 }, PRELUDE);

  assert.equal(context?.kind, "names");
  assert.deepEqual(context?.symbols.map((symbol) => symbol.name), ["current_user"]);
  assert.equal(context?.prefix, "cu");
});

test("routes runtime attribute and chained member completion only", () => {
  const direct = overlayRuntimeCompletionContext("Company.ob", { character: 10, line: 0 }, PRELUDE);
  const chained = overlayRuntimeCompletionContext("Company.objects.filter().va", { character: 27, line: 0 }, PRELUDE);
  const nested = overlayRuntimeCompletionContext("Company.objects.annotate(total=Count('id')).va", { character: 46, line: 0 }, PRELUDE);
  const ordinary = overlayRuntimeCompletionContext("local_value.me", { character: 14, line: 0 }, PRELUDE);

  assert.equal(direct?.kind, "member");
  assert.equal(direct?.root.name, "Company");
  assert.equal(direct?.prefix, "ob");
  assert.equal(chained?.kind, "member");
  assert.equal(chained?.root.name, "Company");
  assert.equal(nested?.kind, "member");
  assert.equal(nested?.root.name, "Company");
  assert.equal(ordinary, undefined);
});

test("only bindings inside the active independent execution unit shadow runtime names", () => {
  const upperUnexecuted = "from shop.models import Company\n\n\nCompany.ob";
  const localImport = "from shop.models import Company\nCompany.ob";
  const assigned = "current_user = load_user()\ncurrent_user.na";

  assert.equal(overlayRuntimeCompletionContext(upperUnexecuted, { character: 10, line: 3 }, PRELUDE)?.kind, "member");
  assert.equal(overlayRuntimeFeatureContext(upperUnexecuted, { character: 2, line: 3 }, PRELUDE)?.root.name, "Company");
  assert.equal(overlayRuntimeCompletionContext(localImport, { character: 10, line: 1 }, PRELUDE), undefined);
  assert.equal(overlayRuntimeFeatureContext(localImport, { character: 2, line: 1 }, PRELUDE), undefined);
  assert.equal(overlayRuntimeCompletionContext(assigned, { character: 15, line: 1 }, PRELUDE), undefined);
});

test("recognizes runtime hover, member navigation, and callable signature roots", () => {
  const source = "Company.objects.filter(name=current_user)";
  const company = overlayRuntimeFeatureContext(source, { character: 2, line: 0 }, PRELUDE);
  const objects = overlayRuntimeFeatureContext(source, { character: 10, line: 0 }, PRELUDE);
  const signature = overlayRuntimeFeatureContext("current_user.refresh(", { character: 21, line: 0 }, PRELUDE);

  assert.deepEqual([company?.root.name, company?.member], ["Company", false]);
  assert.deepEqual([objects?.root.name, objects?.member], ["Company", true]);
  assert.deepEqual([signature?.root.name, signature?.member], ["current_user", true]);
});

test("declines comments, strings, and Python import statement completions", () => {
  assert.equal(overlayRuntimeCompletionContext("# Company", { character: 9, line: 0 }, PRELUDE), undefined);
  assert.equal(overlayRuntimeCompletionContext("value = 'Company", { character: 16, line: 0 }, PRELUDE), undefined);
  assert.equal(overlayRuntimeCompletionContext("from shop import Com", { character: 20, line: 0 }, PRELUDE), undefined);
});

test("finds a runtime receiver inside a post-import nested call", () => {
  const text = "import os; from django.apps import apps; print('runtime', Company.";
  const context = overlayRuntimeCompletionContext(text, { character: text.length, line: 0 }, PRELUDE);
  assert.equal(context?.kind, "member");
  assert.equal(context?.root.name, "Company");
});

test("keeps CRLF binding offsets accurate before a lower runtime request", () => {
  const source = "ordinary = 1\r\n\r\n\r\ncurrent_user.na";
  const context = overlayRuntimeCompletionContext(source, { character: 15, line: 3 }, PRELUDE);

  assert.equal(context?.kind, "member");
  assert.equal(context?.root.name, "current_user");
});
