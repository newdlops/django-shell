// E2E fixture exposing a native Python completion provider and its invocation history.

const vscode = require("vscode");

const SENTINEL = "NativeProviderSentinel";
const AUTO_IMPORT = "from native_provider_fixture import NativeProviderSentinel\n";

let calls = [];
let provideCount = 0;
let resolveCount = 0;
let origins = new WeakMap();

/** Returns the bare identifier ending at one completion position. */
function identifierPrefix(document, position) {
  const before = document.lineAt(position.line).text.slice(0, position.character);
  return /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? "";
}

/** Returns whether one bare identifier should receive the sentinel completion. */
function matchesSentinel(prefix) {
  return prefix.length > 0 && SENTINEL.startsWith(prefix);
}

/** Records one provider phase with the exact document identity seen by VS Code. */
function recordCall(phase, document, prefix = "") {
  calls.push({ language: document?.languageId ?? "", matched: matchesSentinel(prefix), phase, prefix, uri: document?.uri?.toString() ?? "" });
}

/** Resets fixture counters before an isolated provider probe. */
function resetState() {
  calls = [];
  provideCount = 0;
  resolveCount = 0;
  origins = new WeakMap();
}

/** Returns a serializable snapshot of provider calls and counters. */
function snapshotState() {
  return { calls: calls.map((call) => ({ ...call })), provideCount, resolveCount };
}

/** Activates the native Python completion provider and observation commands. */
function activate(context) {
  const provider = {
    /** Offers one uniquely identifiable completion for a matching bare prefix. */
    provideCompletionItems(document, position) {
      provideCount += 1;
      const prefix = identifierPrefix(document, position);
      recordCall("provide", document, prefix);
      if (!matchesSentinel(prefix)) {
        return undefined;
      }
      const item = new vscode.CompletionItem(SENTINEL, vscode.CompletionItemKind.Class);
      const start = position.translate(0, -prefix.length);
      item.detail = "Django Shell native provider E2E sentinel";
      item.filterText = SENTINEL;
      item.preselect = true;
      item.range = new vscode.Range(start, position);
      item.sortText = `\u0000${SENTINEL}`;
      item.insertText = SENTINEL;
      origins.set(item, { document, prefix });
      return new vscode.CompletionList([item], false);
    },

    /** Resolves the sentinel with a deliberately file-top auto-import edit. */
    resolveCompletionItem(item) {
      resolveCount += 1;
      const origin = origins.get(item);
      recordCall("resolve", origin?.document, origin?.prefix ?? "");
      item.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), AUTO_IMPORT)];
      return item;
    }
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: "python", scheme: "file" }, provider),
    vscode.commands.registerCommand("djangoShellNativeProvider.reset", resetState),
    vscode.commands.registerCommand("djangoShellNativeProvider.snapshot", snapshotState)
  );
}

/** Releases no process-wide resources beyond VS Code-managed subscriptions. */
function deactivate() {}

module.exports = { activate, deactivate };
