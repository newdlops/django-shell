// Shares correlated foreign-key lookup requests between the two grid hosts.

import * as vscode from "vscode";
import type { BackendModelColumn, BackendModelLookup, ModelLookupQuery } from "./modelBackend";

/** Resolves lookup metadata from the active source column and always returns a correlated outcome. */
export async function modelLookupResponse(message: { field?: string; q?: string; requestId?: number | string; target?: string }, columns: BackendModelColumn[], lookup: (query: ModelLookupQuery) => Promise<BackendModelLookup>, database?: string): Promise<{ requestId?: number | string; result: BackendModelLookup; type: "lookup" }> {
  let result: BackendModelLookup;
  try {
    const column = columns.find((item) => item.attname === message.field && item.relation?.target === message.target);
    const relation = column?.relation;
    const split = relation?.target.lastIndexOf(".") ?? -1;
    if (!relation || split < 1) { throw new Error("This relation is no longer available. Reload the table and try again."); }
    const configured = vscode.workspace.getConfiguration("djangoShell").get<string[]>("modelBrowser.lookupExcludeFields", []);
    const exclude = Array.isArray(configured) ? configured.filter((item) => typeof item === "string" && item.trim()) : [];
    result = await lookup({ app: relation.target.slice(0, split), database, exclude, model: relation.target.slice(split + 1), q: typeof message.q === "string" ? message.q : "", valueField: relation.filterField });
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error), hasMore: false, ok: false, rows: [], sql: [] };
  }
  return { requestId: message.requestId, result, type: "lookup" };
}
