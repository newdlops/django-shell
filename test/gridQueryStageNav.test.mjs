// Verifies keyboard roving-tab navigation for Query Builder stage and review tabs.
import assert from "node:assert/strict";
import test from "node:test";

import { installQueryRovingTabs } from "../media/gridQueryStageNav.js";

/** Creates a minimal tab button that records its bound keyboard handler and focus calls. */
function button() {
  const listeners = new Map();
  return {
    addEventListener: (type, listener) => listeners.set(type, listener),
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
    keydown(key) {
      let prevented = false;
      listeners.get("keydown")?.({ key, preventDefault: () => { prevented = true; } });
      return prevented;
    }
  };
}

test("roving tabs wrap arrows and support Home/End without intercepting ordinary keys", () => {
  const buttons = [button(), button(), button()];
  const selected = [];
  installQueryRovingTabs(buttons.map((item, index) => ({ button: item, value: `tab-${index}` })), (value) => selected.push(value));

  assert.equal(buttons[0].keydown("ArrowLeft"), true);
  assert.equal(buttons[1].keydown("ArrowRight"), true);
  assert.equal(buttons[1].keydown("Home"), true);
  assert.equal(buttons[0].keydown("x"), false);
  assert.deepEqual(selected, ["tab-2", "tab-2", "tab-0"]);
  assert.equal(buttons[2].focusCalls, 2);
  assert.equal(buttons[0].focusCalls, 1);
});
