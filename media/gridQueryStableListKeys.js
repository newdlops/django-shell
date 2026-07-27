// Stable renderer-local keys for immutable Recipe lists without node identifiers.

/** Returns one deterministic semantic signature for a nodeId-less Recipe list entry. */
export function stableListEntrySignature(entry = {}) {
  if (entry.kind === "computed" || entry.alias) { return `computed:${String(entry.alias || "")}`; }
  return `field:${String(entry.path || "")}`;
}

/** Creates an LCS-backed reconciler that keeps renderer keys through immutable list updates. */
export function createStableListKeyReconciler(prefix = "entry") {
  let sequence = 0;
  let previous = [];

  /** Returns the longest-common-subsequence match pairs for two signature arrays. */
  function lcsPairs(left, right) {
    const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
      for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
        table[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex] ? table[leftIndex + 1][rightIndex + 1] + 1 : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
      }
    }
    const pairs = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) { pairs.push([leftIndex, rightIndex]); leftIndex += 1; rightIndex += 1; }
      else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) { leftIndex += 1; }
      else { rightIndex += 1; }
    }
    return pairs;
  }

  /** Reconciles immutable entries to persistent keys, including duplicates and edited values. */
  function reconcile(entries = []) {
    const next = entries.map((entry) => ({ entry, signature: stableListEntrySignature(entry) }));
    const keys = Array(next.length);
    const usedPrevious = new Set();
    for (const [beforeIndex, nextIndex] of lcsPairs(previous.map((item) => item.signature), next.map((item) => item.signature))) {
      keys[nextIndex] = previous[beforeIndex].key;
      usedPrevious.add(beforeIndex);
    }
    for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
      if (keys[nextIndex]) { continue; }
      const matchingIndex = previous.findIndex((item, beforeIndex) => !usedPrevious.has(beforeIndex) && item.signature === next[nextIndex].signature);
      if (matchingIndex >= 0) { keys[nextIndex] = previous[matchingIndex].key; usedPrevious.add(matchingIndex); continue; }
      if (previous[nextIndex] && !usedPrevious.has(nextIndex)) { keys[nextIndex] = previous[nextIndex].key; usedPrevious.add(nextIndex); continue; }
      sequence += 1;
      keys[nextIndex] = `${prefix}-${sequence}`;
    }
    previous = next.map((item, index) => ({ key: keys[index], signature: item.signature }));
    return keys;
  }

  return { reconcile };
}
