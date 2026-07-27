// Coalesced region renderer for the Model Data Query Builder.

/** Creates a single microtask renderer that always reads the latest complete model. */
export function createQueryRenderCoordinator({ captureFocus = () => undefined, getModel, regions = [], restoreFocus = () => {}, schedule = queueMicrotask } = {}) {
  const signatures = new Map();
  const reasons = new Set();
  let destroyed = false;
  let queued = false;

  /** Runs one coherent rendering transaction using current state rather than caller snapshots. */
  function flush() {
    queued = false;
    if (destroyed) { return; }
    const model = getModel?.();
    const focus = captureFocus?.();
    const requestReasons = [...reasons];
    reasons.clear();
    try {
      for (const region of regions) {
        const signature = region.signature?.(model);
        if (signatures.get(region.id) === signature) { continue; }
        region.update?.(model);
        signatures.set(region.id, signature);
      }
    } finally {
      restoreFocus?.(focus, model, requestReasons);
    }
  }

  return {
    /** Releases every region and prevents further scheduled writes. */
    destroy() { destroyed = true; reasons.clear(); for (const region of regions) { region.destroy?.(); } },
    /** Forces an immediate coherent render for initialization and tests. */
    flush,
    /** Coalesces one rendering reason into the next microtask. */
    request(reason = "unknown") { if (destroyed) { return; } reasons.add(reason); if (!queued) { queued = true; schedule(flush); } }
  };
}
