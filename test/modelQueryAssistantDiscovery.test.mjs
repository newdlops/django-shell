// Direct tests for bounded Query Builder local model discovery projections.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const discovery = require("../out/modelQueryAssistantDiscovery.js");

test("projects Claude help aliases and only advertised reasoning efforts", () => {
  const result = discovery.parseClaudeModelHelp("Usage: claude --model sonnet | opus\n--effort low, medium, high, max\n");
  assert.equal(result.source, "help"); assert.deepEqual(result.models.map((model) => model.model), ["opus", "sonnet"]); assert.deepEqual(result.providerReasoningEfforts, ["low", "medium", "high", "max"]);
});
test("projects wrapped Claude model and effort option descriptions without consuming the next option", () => {
  const result = discovery.parseClaudeModelHelp(`  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Example value 'not-a-model'`);
  assert.equal(result.source, "help"); assert.deepEqual(result.models.map((model) => model.model), ["claude-fable-5", "fable", "opus", "sonnet"]); assert.deepEqual(result.providerReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
});
test("treats empty or malformed Claude help as unavailable metadata", () => {
  for (const help of ["", "Usage: claude\n--effort low\n", "--model <model>"]) {
    const result = discovery.parseClaudeModelHelp(help); assert.equal(result.source, "unavailable"); assert.deepEqual(result.models, []);
  }
});
test("projects bounded Codex GPT ids and advertised reasoning from help fallback", () => {
  const result = discovery.parseCodexModelHelp("Usage: codex --model gpt-5.2 | gpt-5-mini\nmodel_reasoning_effort: low, medium, high\n");
  assert.equal(result.provider, "codex"); assert.equal(result.source, "help"); assert.deepEqual(result.models.map((model) => model.model), ["gpt-5-mini", "gpt-5.2"]); assert.deepEqual(result.providerReasoningEfforts, ["low", "medium", "high"]);
});
test("projects noisy Codex catalog visibility, replacement, priority, and effort metadata", () => {
  const result = discovery.parseCodexModelCatalog('warning\\n{"models":[{"slug":"retired","visibility":"hide","upgrade":"gpt-5","priority":9},{"slug":"gpt-5","display_name":"GPT Five","priority":2,"default_reasoning_level":"high","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"gpt-4","priority":1,"description":"x"}]}\\nwarning');
  assert.deepEqual(result.models.map((model) => model.model), ["gpt-4", "gpt-5"]); assert.equal(result.retiredModels[0].replacement, "gpt-5"); assert.equal(result.retiredModels[0].retired, true); assert.deepEqual(result.models[1].supportedReasoningEfforts, ["low", "high"]);
});
test("fails closed for malformed or no-visible Codex metadata", () => {
  assert.equal(discovery.parseCodexModelCatalog("not json"), undefined);
  assert.equal(discovery.parseCodexModelCatalog('{"models":[{"slug":"hidden","visibility":"hide"}]}'), undefined);
});
test("near-limit malformed delimiters complete with bounded single-pass scanning", () => {
  const malformed = "[".repeat(1_048_576);
  const started = Date.now(); assert.equal(discovery.parseCodexModelCatalog(malformed), undefined); assert.ok(Date.now() - started < 1500);
});
