// Cached live model metadata service for Query Builder field, relation, and model pickers.

/** Returns a canonical metadata cache key for an app/model target. */
function modelKey(target) {
  return `${String(target?.app || "")}.${String(target?.model || "")}`;
}

/** Parses an app-qualified model label without accepting arbitrary object shapes. */
function targetFromLabel(label) {
  const text = String(label || "");
  const boundary = text.lastIndexOf(".");
  return boundary < 1 ? { app: "", model: text } : { app: text.slice(0, boundary), model: text.slice(boundary + 1) };
}

/** Converts a filter-field reply into a safe tree object or undefined on backend failure. */
function treeFromMessage(message) {
  const result = message?.result || message;
  return result?.ok && Array.isArray(result?.fields) && Array.isArray(result?.relations) ? result : undefined;
}

/** Returns direct scalar fields and relation descriptors from one cached field tree. */
export function rootMetadataOptions(tree) {
  if (!tree) { return { fields: [], relations: [] }; }
  return {
    fields: (tree.fields || []).filter((field) => field && typeof field.name === "string").map((field) => ({ ...field, path: field.name, role: "field" })),
    relations: (tree.relations || []).filter((relation) => relation && typeof relation.name === "string").map((relation) => ({ ...relation, path: relation.name, role: "relation" }))
  };
}

/** Creates the request-id-scoped cache used by all Predicate Builder instances in a drawer. */
export function createQueryMetadataService({ post, onChange } = {}) {
  const cache = new Map();
  const pending = new Map();
  let sequence = 0;

  /** Publishes one metadata state change without exposing mutable cache entries. */
  function publish(target) {
    onChange?.(getState(target));
  }

  /** Returns the current pending/ready/error state for one target. */
  function getState(target) {
    const entry = cache.get(modelKey(target));
    return entry ? { error: entry.error, pending: Boolean(entry.pending), target: { ...entry.target }, tree: entry.tree } : { error: undefined, pending: false, target: { ...target }, tree: undefined };
  }

  /** Returns a cached field tree, requesting it once when absent or explicitly retried. */
  function loadTree(target, { retry = false } = {}) {
    const key = modelKey(target);
    const existing = cache.get(key);
    if (existing?.tree && !retry) { return Promise.resolve(existing.tree); }
    if (existing?.promise && !retry) { return existing.promise; }
    const normalized = { app: String(target?.app || ""), model: String(target?.model || "") };
    if (!normalized.app || !normalized.model || typeof post !== "function") {
      const error = "Field metadata is unavailable.";
      cache.set(key, { error, pending: false, target: normalized, tree: undefined });
      publish(normalized);
      return Promise.reject(new Error(error));
    }
    const requestId = `query-meta-${sequence += 1}`;
    let rejectRequest;
    let resolveRequest;
    const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    pending.set(requestId, { key, reject: rejectRequest, resolve: resolveRequest, target: normalized });
    cache.set(key, { error: undefined, pending: true, promise, requestId, target: normalized, tree: undefined });
    post({ app: normalized.app, model: normalized.model, requestId, type: "filterFields" });
    publish(normalized);
    return promise;
  }

  /** Resolves the matching request while ignoring stale or unrelated filter-field messages. */
  function onMessage(message) {
    const requestId = message?.requestId;
    if (typeof requestId !== "string" || !requestId.startsWith("query-meta-")) { return false; }
    const request = pending.get(requestId);
    if (!request) { return true; }
    pending.delete(requestId);
    const tree = treeFromMessage(message);
    if (tree) {
      cache.set(request.key, { error: undefined, pending: false, target: request.target, tree });
      request.resolve(tree);
    } else {
      const error = message?.result?.error || message?.error || "Could not load field metadata.";
      cache.set(request.key, { error: String(error), pending: false, target: request.target, tree: undefined });
      request.reject(new Error(String(error)));
    }
    publish(request.target);
    return true;
  }

  /** Retries one failed tree request explicitly; there is no silent flat-field fallback. */
  function retry(target) {
    return loadTree(target, { retry: true });
  }

  /** Replaces the model catalog used by model-source Exists and Subquery controls. */
  function setCatalog(models) {
    cache.catalog = Array.isArray(models) ? models.filter((model) => model && typeof model.app === "string" && typeof model.model === "string").map((model) => ({ app: model.app, model: model.model })) : [];
  }

  /** Returns the sorted installed-model catalog as pickable app-qualified entries. */
  function getCatalog() {
    return [...(cache.catalog || [])].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
  }

  return { getCatalog, getState, loadTree, onMessage, retry, setCatalog };
}

/** Exposes pure helpers for focused metadata-cache tests without requiring a browser DOM. */
export const __test = { modelKey, rootMetadataOptions, targetFromLabel, treeFromMessage };
