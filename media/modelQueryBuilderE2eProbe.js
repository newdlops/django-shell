// Isolated DOM-only Query Builder E2E probe used by the Extension Host fixture.

/** Waits until a DOM predicate becomes true and returns its value. */
async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now(); let value;
  while (Date.now() - started < timeoutMs) {
    value = predicate(); if (value) { return value; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Finds one visible button by its exact accessible text. */
function button(document, label) { return [...document.querySelectorAll("button")].find((candidate) => !candidate.hidden && candidate.textContent?.trim() === label); }

/** Clicks a named button after confirming that it is available. */
function click(document, label) { const target = button(document, label); if (!target || target.disabled) { throw new Error(`${label} is unavailable.`); } target.click(); return target; }

/** Returns the stable Add-condition action from the active predicate group. */
function conditionAdd(document) { return [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === "Add condition to this group"); }

/** Waits for one rendered Query Builder condition Field control matching a predicate. */
async function waitForE2eField(document, predicate, timeoutMs = 5000) {
  return waitFor(() => { const select = document.querySelector('select[aria-label="Condition field"]'); return select && predicate(select) ? select : undefined; }, "Query Builder Field control", timeoutMs);
}

/** Returns whether the active draft has a locally valid, settled preview. */
function previewIsReady(document) { return !document.getElementById("queryDrawerApply")?.disabled && !document.getElementById("queryDrawerStatus")?.textContent?.includes("Checking latest"); }

/** Returns true when Undo has removed every example artifact and restored the applied draft. */
function examplesRestored(document) {
  const text = [document.getElementById("queryComputedList")?.textContent, document.getElementById("queryPostFilterRoot")?.textContent, document.getElementById("queryOrderBy")?.textContent].join(" ");
  const aliases = ["row_count", "has_memberships", "normalized_username", "username_length", "rank_within_status"];
  return document.querySelectorAll("#queryExamples button").length === 4 && document.getElementById("queryDraftStatus")?.textContent === "Draft matches applied query" && aliases.every((alias) => !text.includes(alias));
}

/** Captures the required compact overflow metrics from the assistant review area. */
function assistantOverflow(document) {
  const metrics = {};
  for (const [name, selector] of Object.entries({ actions: ".query-assistant-actions", form: ".query-assistant-panel", panel: "#queryAssistantPanel", review: "#queryReviewPane" })) {
    const node = document.querySelector(selector); metrics[name] = node ? { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth } : undefined;
  }
  return metrics;
}

/** Returns true only after an authoritative snapshot has restored usable assistant controls. */
function assistantSettingsReady(document, expected) {
  const provider = document.getElementById("queryAssistantProvider"); const model = document.getElementById("queryAssistantModel"); const reasoning = document.getElementById("queryAssistantReasoning"); const refresh = document.getElementById("queryAssistantRefresh");
  return provider?.value === expected.provider && !provider.disabled && model?.value === (expected.automatic ? "" : expected.model) && !model?.disabled && reasoning?.value === expected.reasoning && !reasoning.disabled && !refresh?.disabled;
}

/** Exercises the progressive examples, assistant lifecycle, and existing picker DOM without product state. */
export async function runModelQueryBuilderE2eProbe({ document, postMessage, requestId }) {
  let selectPrototype; let originalShowPicker; let showPickerCalls = 0; let terminal = false; const view = document.defaultView || globalThis.window;
  /** Posts exactly one correlated terminal result even when cleanup fails. */
  const finish = (snapshot) => { if (terminal) { return; } terminal = true; try { postMessage({ requestId, snapshot, type: "e2eQueryBuilderProbeResult" }); } catch { /* The host timeout remains the final fallback. */ } };
  /** Posts one correlated, non-sensitive major probe stage for timeout diagnostics. */
  const progress = (stage) => postMessage({ requestId, stage, type: "e2eQueryBuilderProbeProgress" });
  /** Converts window-level probe failures into one correlated terminal snapshot. */
  const terminalError = (event) => finish({ error: String(event?.reason?.message || event?.error?.message || event?.message || "window error"), showPickerCalls });
  view?.addEventListener?.("error", terminalError); view?.addEventListener?.("unhandledrejection", terminalError);
  try {
    selectPrototype = HTMLSelectElement.prototype; originalShowPicker = Object.getOwnPropertyDescriptor(selectPrototype, "showPicker");
    progress("examples");
    Object.defineProperty(selectPrototype, "showPicker", { configurable: true, value() { showPickerCalls += 1; } });
    const drawer = document.getElementById("queryDrawer"); if (drawer?.hidden) { document.getElementById("queryDrawerToggle")?.click(); }
    const examples = [...document.querySelectorAll("#queryExamples button")];
    if (examples.length !== 4 || !examples[0].getAttribute("aria-label")?.includes("Aggregate summary") || !examples[1].getAttribute("aria-label")?.includes("Correlated Exists") || !examples[2].getAttribute("aria-label")?.includes("Chained Formula") || !examples[3].getAttribute("aria-label")?.includes("Window RowNumber")) { throw new Error("Progressive examples are missing or unordered."); }
    progress("example-aggregate-apply"); examples[0].click(); await waitFor(() => document.getElementById("queryComputedList")?.textContent?.includes("row_count") && document.getElementById("queryPostFilterRoot")?.textContent?.includes("row_count"), "aggregate example controls"); await waitFor(() => previewIsReady(document), "aggregate preview");
    if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None") { throw new Error("Aggregate example changed applied filters."); }
    progress("example-aggregate-undo-click"); click(document, "Undo"); await waitFor(() => examplesRestored(document), "aggregate undo"); progress("example-aggregate-undo-restored");
    progress("example-exists-apply"); click(document, "2 · Related memberships via Exists"); await waitFor(() => document.getElementById("queryComputedList")?.textContent?.includes("has_memberships") && document.getElementById("queryPostFilterRoot")?.textContent?.includes("has_memberships"), "Exists example controls"); await waitFor(() => previewIsReady(document), "Exists preview");
    if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None") { throw new Error("Exists example changed applied filters."); }
    progress("example-exists-undo-click"); click(document, "Undo"); await waitFor(() => examplesRestored(document), "Exists undo"); progress("example-exists-undo-restored");
    progress("example-formula-apply"); click(document, "3 · Normalize Username; Length ≥ 8"); await waitFor(() => document.getElementById("queryComputedList")?.textContent?.includes("normalized_username") && document.getElementById("queryComputedList")?.textContent?.includes("username_length") && document.getElementById("queryPostFilterRoot")?.textContent?.includes("username_length") && document.getElementById("queryOrderBy")?.textContent?.includes("username_length") && document.getElementById("queryOrderBy")?.textContent?.includes("normalized_username"), "Formula example controls"); await waitFor(() => previewIsReady(document), "Formula preview"); if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None") { throw new Error("Formula example changed applied filters."); } progress("example-formula-undo-click"); click(document, "Undo"); await waitFor(() => examplesRestored(document), "Formula undo"); progress("example-formula-undo-restored");
    progress("example-window-apply"); click(document, "4 · Top 3 ID per Status"); await waitFor(() => document.getElementById("queryComputedList")?.textContent?.includes("rank_within_status") && document.getElementById("queryComputedList")?.textContent?.includes("Window: row_number") && document.getElementById("queryPostFilterRoot")?.textContent?.includes("rank_within_status") && document.getElementById("queryOrderBy")?.textContent?.includes("status") && document.getElementById("queryOrderBy")?.textContent?.includes("rank_within_status"), "Window example controls"); await waitFor(() => previewIsReady(document), "Window preview"); if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None") { throw new Error("Window example changed applied filters."); } progress("example-window-undo-click"); click(document, "Undo"); await waitFor(() => examplesRestored(document), "Window undo"); progress("example-window-undo-restored"); await waitFor(() => document.getElementById("queryDrawerStatus")?.textContent === "Applied query is current.", "restored draft preview");
    progress("assistant-settings"); click(document, "AI Assist"); const assistant = await waitFor(() => document.getElementById("queryAssistantPanel")?.hidden === false ? document.getElementById("queryAssistantPanel") : undefined, "AI Assist panel");
    const provider = await waitFor(() => document.getElementById("queryAssistantProvider"), "assistant provider selector"); const instructions = document.getElementById("queryAssistantInstructions"); const model = document.getElementById("queryAssistantModel"); const reasoning = document.getElementById("queryAssistantReasoning");
    if (!instructions || model?.value !== "" || model?.disabled || reasoning?.value !== "" || !assistant.textContent?.includes("Row data is excluded") || provider.options.length !== 2 || !button(document, "Generate suggestion")?.disabled) { throw new Error("AI Assist automatic default state is incomplete."); }
    let modelControl = document.getElementById("queryAssistantModel"); modelControl.value = "sonnet"; modelControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "sonnet", provider: "claude", reasoning: "" }), "Claude direct model save");
    let reasoningControl = document.getElementById("queryAssistantReasoning"); reasoningControl.value = "high"; reasoningControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "sonnet", provider: "claude", reasoning: "high" }), "Claude reasoning save");
    let providerControl = document.getElementById("queryAssistantProvider"); providerControl.value = "codex"; providerControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: true, model: "", provider: "codex", reasoning: "" }), "Codex provider acknowledgement");
    modelControl = document.getElementById("queryAssistantModel"); modelControl.value = "gpt-5"; modelControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "gpt-5", provider: "codex", reasoning: "" }), "Codex model save");
    reasoningControl = document.getElementById("queryAssistantReasoning"); reasoningControl.value = "xhigh"; reasoningControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "gpt-5", provider: "codex", reasoning: "xhigh" }), "Codex supported reasoning save");
    modelControl = document.getElementById("queryAssistantModel"); modelControl.value = "gpt-5-mini"; modelControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistant.textContent?.includes("does not support the selected reasoning level") && document.getElementById("queryAssistantProvider")?.value === "codex" && !document.getElementById("queryAssistantProvider")?.disabled, "known incompatible reasoning");
    reasoningControl = document.getElementById("queryAssistantReasoning"); reasoningControl.value = "medium"; reasoningControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "gpt-5-mini", provider: "codex", reasoning: "medium" }) && !assistant.textContent?.includes("does not support the selected reasoning level"), "compatible reasoning recovery");
    providerControl = document.getElementById("queryAssistantProvider"); providerControl.value = "claude"; providerControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "sonnet", provider: "claude", reasoning: "high" }), "retained Claude settings");
    modelControl = document.getElementById("queryAssistantModel"); modelControl.value = ""; modelControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: true, model: "", provider: "claude", reasoning: "high" }), "automatic mode restoration"); modelControl = document.getElementById("queryAssistantModel"); modelControl.value = "sonnet"; modelControl.dispatchEvent(new Event("change", { bubbles: true })); await waitFor(() => assistantSettingsReady(document, { automatic: false, model: "sonnet", provider: "claude", reasoning: "high" }), "retained manual pin after automatic mode");
    const currentInstructions = await waitFor(() => document.getElementById("queryAssistantInstructions"), "assistant instruction control after provider selection"); currentInstructions.value = "Create a valid query draft"; currentInstructions.dispatchEvent(new Event("input", { bubbles: true })); const refresh = document.getElementById("queryAssistantRefresh"); refresh.focus(); click(document, "Refresh models"); await waitFor(() => document.getElementById("queryAssistantInstructions")?.value === "Create a valid query draft" && assistantSettingsReady(document, { automatic: false, model: "sonnet", provider: "claude", reasoning: "high" }) && document.activeElement?.id === "queryAssistantRefresh", "metadata refresh preservation and focus"); await waitFor(() => button(document, "Generate suggestion") && !button(document, "Generate suggestion")?.disabled, "enabled assistant generation");
    progress("generation-running"); click(document, "Generate suggestion"); await waitFor(() => assistant.textContent?.includes("Generating suggestion with Claude Code") && button(document, "Generate suggestion")?.disabled && button(document, "Cancel"), "assistant running state"); progress("cancel-clicked"); click(document, "Cancel"); await waitFor(() => button(document, "Cancel")?.disabled && assistant.textContent?.includes("Cancelling generation…"), "assistant cancellation pending"); progress("cancel-ack"); await waitFor(() => assistant.textContent?.includes("Generation was cancelled.") && !assistant.textContent?.includes("AI-generated suggestion"), "assistant cancellation");
    await waitFor(() => button(document, "Generate suggestion") && !button(document, "Generate suggestion")?.disabled, "generation after cancellation"); progress("second-generation"); click(document, "Generate suggestion"); progress("suggestion"); await waitFor(() => assistant.textContent?.includes("AI-generated suggestion · Claude Code") || document.getElementById("queryDraftAiAssembly")?.hidden === false, "assistant result or assembled draft"); if (button(document, "Use as draft")) { throw new Error("AI Assist exposed a manual draft action."); }
    if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None") { throw new Error("Suggestion changed applied filters."); }
    await waitFor(() => document.getElementById("queryDraftStatus")?.textContent === "Draft changes are not applied" && document.getElementById("queryDraftAiAssembly")?.hidden === false && document.getElementById("queryWhereRoot")?.textContent?.includes("Status") && document.getElementById("queryWhereRoot")?.textContent?.includes("equals “active”.") && !document.getElementById("queryDrawerApply")?.disabled, "rendered automatic draft-only assistant acceptance");
    if (document.getElementById("queryAppliedFiltersEmpty")?.textContent !== "None" || document.getElementById("queryDrawerStatus")?.textContent?.includes("Applying")) { throw new Error("Assistant acceptance applied the query."); }
    click(document, "Undo"); await waitFor(() => document.getElementById("queryDraftStatus")?.textContent === "Draft matches applied query", "assistant acceptance undo");
    progress("legacy-picker"); click(document, "1. Filter Rows"); const pickerAdd = await waitFor(() => conditionAdd(document), "legacy picker condition control"); pickerAdd.click(); const select = await waitForE2eField(document, (candidate) => !candidate.disabled);
    const optionGroups = [...select.querySelectorAll("optgroup")].map((group) => group.label); const options = [...select.querySelectorAll("option")]; const overflow = assistantOverflow(document);
    finish({ appliedFilters: document.getElementById("queryAppliedFiltersEmpty")?.textContent || "", applyDisabled: document.getElementById("queryDrawerApply")?.disabled === true, assistantOverflow: overflow, conditionCount: document.querySelectorAll('select[aria-label="Condition field"]').length, disabled: select.disabled, drawerOpen: drawer?.hidden === false, enabledOptionCount: options.filter((option) => !option.disabled && option.value).length, exampleCount: examples.length, focused: document.activeElement === select, optionGroups, placeholderDisabled: options[0]?.disabled === true, selectedValue: select.value, showPickerCalls });
  } catch (error) { finish({ error: String(error?.message || error), showPickerCalls }); }
  finally { view?.removeEventListener?.("error", terminalError); view?.removeEventListener?.("unhandledrejection", terminalError); try { if (selectPrototype && originalShowPicker) { Object.defineProperty(selectPrototype, "showPicker", originalShowPicker); } else if (selectPrototype) { delete selectPrototype.showPicker; } } catch { /* Terminal output was already emitted. */ } }
}
