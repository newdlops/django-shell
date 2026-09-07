// Builds correlated save responses for every host of the shared grid editor.
import type { BackendCommitResult, BackendModelColumn, ModelCommitChange, ModelCommitQuery } from "./modelBackend";

/** Captures the editor and exact model/database target at the time a save starts. */
export interface ModelCommitMessage {
  app?: string;
  changes?: ModelCommitChange[];
  commitId?: string;
  database?: string;
  editorId?: string;
  model?: string;
}

/** Converts validation and transport failures into a response that releases only the initiating editor. */
export async function modelCommitResponse(message: ModelCommitMessage, columns: BackendModelColumn[], commit: (query: ModelCommitQuery) => Promise<BackendCommitResult>): Promise<{ commitId?: string; editorId?: string; model: string; result: BackendCommitResult; type: "commit" }> {
  let result: BackendCommitResult;
  try {
    if (!message.app || !message.model || !Array.isArray(message.changes) || !message.changes.length) { throw new Error("No valid changes to commit."); }
    result = await commit({ app: message.app, changes: message.changes, columns, database: message.database, model: message.model });
  } catch (error) {
    result = { error: `Save could not be confirmed. Check the stored values before retrying. ${error instanceof Error ? error.message : String(error)}`, ok: false, orm: "", results: [], saved: 0, sql: [] };
  }
  return { commitId: message.commitId, editorId: message.editorId, model: `${message.app}.${message.model}`, result, type: "commit" };
}
