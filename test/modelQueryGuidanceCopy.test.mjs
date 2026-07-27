// Focused contract tests for immutable Query Builder guidance copy.

import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_QUERY_LOOKUPS } from "../media/gridQueryRecipeLimits.js";
import { QUERY_COMPUTED_KIND_GUIDANCE, QUERY_LOOKUP_GUIDANCE, guidanceForComputedKind, guidanceForLookup } from "../media/gridQueryGuidanceCopy.js";

/** Verifies every backend lookup has a stable visible label and helper. */
test("guidance copy covers every supported lookup", () => {
  for (const lookup of MODEL_QUERY_LOOKUPS) {
    assert.equal(typeof QUERY_LOOKUP_GUIDANCE[lookup]?.label, "string", lookup);
    assert.equal(typeof QUERY_LOOKUP_GUIDANCE[lookup]?.description, "string", lookup);
  }
});

/** Keeps future protocol keys understandable without weakening the allowlist. */
test("guidance copy has safe unknown-key fallbacks", () => {
  assert.deepEqual(guidanceForLookup("future_option"), { label: "Future option", description: "This option is supported by the current query contract." });
  assert.deepEqual(guidanceForComputedKind("futureKind"), { label: "FutureKind", description: "This option is supported by the current query contract." });
  assert.ok(Object.isFrozen(QUERY_COMPUTED_KIND_GUIDANCE));
});
