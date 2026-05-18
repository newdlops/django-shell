// Deprecated notebook-cell language bridge retained for compatibility.

import * as vscode from "vscode";
import { SerializedAsyncQueue } from "./asyncQueue";
import { cloneCompletionResult, CompletionResult, completionRequestShape, completionResultCount } from "./completionRequestCache";
import { DiagnosticLogger } from "./diagnostics";
import { withLatencyBudget } from "./latencyBudget";
import { PythonShadowDocuments } from "./pythonShadow";

const PYTHON_CELL_SELECTOR: vscode.DocumentSelector = [{ language: "python", scheme: "vscode-notebook-cell" }];
const COMPLETION_CACHE_TTL_MS = 3000;
const FEATURE_BUDGET_MS = 20;
const COMPLETION_BUDGET_MS = 2000;

/** Provides bridged IntelliSense features for Python notebook cell documents. */
export class PythonFeatureBridge implements
  vscode.CodeActionProvider,
  vscode.CompletionItemProvider,
  vscode.DefinitionProvider,
  vscode.Disposable,
  vscode.DocumentHighlightProvider,
  vscode.HoverProvider,
  vscode.ReferenceProvider,
  vscode.SignatureHelpProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly completionCache = new Map<string, { expiresAt: number; result: CompletionResult }>();
  private readonly completionInFlight = new Map<string, Promise<CompletionResult>>();
  private readonly featureQueue = new SerializedAsyncQueue();

  /** Stores the shadow document synchronizer used as the file-scheme bridge target. */
  constructor(private readonly shadows: PythonShadowDocuments, private readonly logger?: DiagnosticLogger) {}

  /** Registers bridged Python language features for Django shell input cells. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(PYTHON_CELL_SELECTOR, this, ".", "'", "\""),
      vscode.languages.registerHoverProvider(PYTHON_CELL_SELECTOR, this),
      vscode.languages.registerDefinitionProvider(PYTHON_CELL_SELECTOR, this),
      vscode.languages.registerReferenceProvider(PYTHON_CELL_SELECTOR, this),
      vscode.languages.registerDocumentHighlightProvider(PYTHON_CELL_SELECTOR, this),
      vscode.languages.registerSignatureHelpProvider(PYTHON_CELL_SELECTOR, this, "(", ","),
      vscode.languages.registerCodeActionsProvider(PYTHON_CELL_SELECTOR, this)
    );
    context.subscriptions.push(this);
  }

  /** Releases bridge provider registrations. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Forwards completion requests to Python providers through a shadow document. */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionList | vscode.CompletionItem[]> {
    const started = Date.now();
    const shape = completionRequestShape(document, position);
    const cached = this.cachedCompletion(shape.key);
    if (cached) {
      this.logFeature("completion", started, undefined, undefined, undefined, completionResultCount(cached), context.triggerCharacter);
      return cloneCompletionResult(cached, shape.replacementRange);
    }
    const existing = this.completionInFlight.get(shape.key);
    if (existing) {
      const ready = await withLatencyBudget(existing, COMPLETION_BUDGET_MS);
      this.logFeature("completion", started, undefined, undefined, undefined, ready.value ? completionResultCount(ready.value) : 0, context.triggerCharacter);
      return ready.completed && ready.value ? cloneCompletionResult(ready.value, shape.replacementRange) : [];
    }
    const promise = this.loadCompletionItems(document, position, token, context);
    const cachedPromise = promise.then((result) => {
      if (completionResultCount(result) > 0) {
        this.completionCache.set(shape.key, { expiresAt: Date.now() + COMPLETION_CACHE_TTL_MS, result });
      }
      return result;
    });
    this.completionInFlight.set(shape.key, cachedPromise);
    cachedPromise.finally(() => {
      if (this.completionInFlight.get(shape.key) === cachedPromise) {
        this.completionInFlight.delete(shape.key);
      }
    }).catch(() => undefined);
    const ready = await withLatencyBudget(cachedPromise, COMPLETION_BUDGET_MS);
    this.logFeature("completion", started, undefined, undefined, undefined, ready.value ? completionResultCount(ready.value) : 0, context.triggerCharacter);
    return ready.completed && ready.value ? cloneCompletionResult(ready.value, shape.replacementRange) : [];
  }

  /** Forwards one uncached completion request through a shadow document. */
  private async loadCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<CompletionResult> {
    return this.featureQueue.run(document.uri.toString(), async () => {
      const shadow = await this.shadows.shadowDocument(document, token, false);
      if (!shadow) {
        return [];
      }
      const providerStarted = Date.now();
      const result = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>(
        "vscode.executeCompletionItemProvider",
        shadow.document.uri,
        toShadowPosition(position, shadow.lineOffset),
        context.triggerCharacter
      );
      this.logger?.log("editor.provider", {
        feature: "completion",
        items: completionResultCount(result ?? []),
        lineOffset: shadow.lineOffset,
        providerMs: Date.now() - providerStarted,
        shadowLines: shadow.document.lineCount,
        shadow: shadow.document.uri.toString(),
        shadowScheme: shadow.document.uri.scheme,
        trigger: context.triggerCharacter
      });
      return mapCompletionResult(result, shadow.lineOffset);
    });
  }

  /** Returns a still-valid completion cache entry for a stable request key. */
  private cachedCompletion(key: string): CompletionResult | undefined {
    const cached = this.completionCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.completionCache.delete(key);
      return undefined;
    }
    return cached.result;
  }

  /** Forwards hover requests through a shadow document. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const started = Date.now();
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("hover", started, shadowStarted);
      return undefined;
    }
    const providerStarted = Date.now();
    const hoversReady = await withLatencyBudget(vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      shadow.document.uri,
      toShadowPosition(position, shadow.lineOffset)
    ), remainingBudget(started));
    if (!hoversReady.completed || !hoversReady.value) {
      this.logFeature("hover", started, shadowStarted, providerStarted, shadow, 0);
      return undefined;
    }
    const hovers = hoversReady.value;
    const hover = mergeHovers(hovers ?? [], shadow.lineOffset);
    this.logFeature("hover", started, shadowStarted, providerStarted, shadow, hovers?.length ?? 0);
    return hover;
  }

  /** Forwards definition requests and maps shadow-file self locations back to the cell. */
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    const started = Date.now();
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("definition", started, shadowStarted);
      return undefined;
    }
    const providerStarted = Date.now();
    const ready = await withLatencyBudget(vscode.commands.executeCommand<Array<vscode.Location | vscode.DefinitionLink>>(
      "vscode.executeDefinitionProvider",
      shadow.document.uri,
      toShadowPosition(position, shadow.lineOffset)
    ), remainingBudget(started));
    const mapped = mapDefinitionLocations(ready.value ?? [], shadow.document.uri, document.uri, shadow.lineOffset);
    this.logFeature("definition", started, shadowStarted, providerStarted, shadow, mapped.length);
    return mapped;
  }

  /** Forwards reference requests and maps shadow-file self locations back to the cell. */
  async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
    const started = Date.now();
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("references", started, shadowStarted);
      return [];
    }
    const providerStarted = Date.now();
    const ready = await withLatencyBudget(vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      shadow.document.uri,
      toShadowPosition(position, shadow.lineOffset),
      context
    ), remainingBudget(started));
    const mapped = mapLocations(ready.value ?? [], shadow.document.uri, document.uri, shadow.lineOffset);
    this.logFeature("references", started, shadowStarted, providerStarted, shadow, mapped.length);
    return mapped;
  }

  /** Forwards document highlight requests through a shadow document. */
  async provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.DocumentHighlight[]> {
    const started = Date.now();
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("highlights", started, shadowStarted);
      return [];
    }
    const providerStarted = Date.now();
    const ready = await withLatencyBudget(vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
      "vscode.executeDocumentHighlights",
      shadow.document.uri,
      toShadowPosition(position, shadow.lineOffset)
    ), remainingBudget(started));
    const mapped = mapDocumentHighlights(ready.value ?? [], shadow.lineOffset);
    this.logFeature("highlights", started, shadowStarted, providerStarted, shadow, mapped.length);
    return mapped;
  }

  /** Forwards signature help requests through a shadow document. */
  async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): Promise<vscode.SignatureHelp | undefined> {
    const started = Date.now();
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("signature", started, shadowStarted);
      return undefined;
    }
    const providerStarted = Date.now();
    const ready = await withLatencyBudget(vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      shadow.document.uri,
      toShadowPosition(position, shadow.lineOffset),
      context.triggerCharacter
    ), remainingBudget(started));
    const result = ready.value;
    this.logFeature("signature", started, shadowStarted, providerStarted, shadow, result?.signatures.length ?? 0, context.triggerCharacter);
    return result;
  }

  /** Forwards code action requests and maps shadow-file edits back to the cell. */
  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<Array<vscode.CodeAction | vscode.Command>> {
    const started = Date.now();
    if (!codeActionsEnabled()) {
      return [];
    }
    const shadowStarted = Date.now();
    const shadowReady = await withLatencyBudget(this.featureQueue.run(document.uri.toString(), () => this.shadows.shadowDocument(document, token, false)), remainingBudget(started));
    const shadow = shadowReady.value;
    if (!shadowReady.completed || !shadow) {
      this.logFeature("codeActions", started, shadowStarted);
      return [];
    }
    const providerStarted = Date.now();
    const ready = await withLatencyBudget(vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
      "vscode.executeCodeActionProvider",
      shadow.document.uri,
      toShadowRange(range, shadow.lineOffset),
      context.only
    ), remainingBudget(started));
    const mapped = (ready.value ?? []).map((action) => mapCodeAction(action, shadow.document.uri, document.uri, shadow.lineOffset));
    this.logFeature("codeActions", started, shadowStarted, providerStarted, shadow, mapped.length, context.only?.value);
    return mapped;
  }

  /** Writes one editor feature bridge timing diagnostic. */
  private logFeature(
    feature: string,
    started: number,
    shadowStarted: number | undefined,
    providerStarted?: number,
    shadow?: { document: vscode.TextDocument; lineOffset: number },
    items?: number,
    trigger?: string
  ): void {
    const shadowMs = shadowStarted === undefined
      ? undefined
      : providerStarted !== undefined
        ? providerStarted - shadowStarted
        : Date.now() - shadowStarted;
    this.logger?.log("editor.feature", {
      feature,
      items,
      lineOffset: shadow?.lineOffset,
      ms: Date.now() - started,
      providerMs: providerStarted !== undefined ? Date.now() - providerStarted : undefined,
      shadow: shadow?.document.uri.toString(),
      shadowMs,
      trigger
    });
  }
}

/** Combines multiple hover provider results into one hover response. */
function mergeHovers(hovers: vscode.Hover[], lineOffset: number): vscode.Hover | undefined {
  const contents = hovers.flatMap((hover) => hover.contents);
  if (!contents.length) {
    return undefined;
  }
  const range = mapRange(hovers.find((hover) => hover.range)?.range, lineOffset);
  return new vscode.Hover(contents, range);
}

/** Maps one notebook-cell position into the shadow document. */
function toShadowPosition(position: vscode.Position, lineOffset: number): vscode.Position {
  return new vscode.Position(position.line + lineOffset, position.character);
}

/** Maps one notebook-cell range into the shadow document. */
function toShadowRange(range: vscode.Range, lineOffset: number): vscode.Range {
  return new vscode.Range(toShadowPosition(range.start, lineOffset), toShadowPosition(range.end, lineOffset));
}

/** Maps completion results from shadow-file coordinates back to notebook-cell coordinates. */
function mapCompletionResult(
  result: vscode.CompletionList | vscode.CompletionItem[] | undefined,
  lineOffset: number
): vscode.CompletionList | vscode.CompletionItem[] {
  if (!result) {
    return [];
  }
  if (Array.isArray(result)) {
    return result.map((item) => mapCompletionItem(item, lineOffset));
  }
  result.items = result.items.map((item) => mapCompletionItem(item, lineOffset));
  return result;
}

/** Maps one completion item range and edits back to notebook-cell coordinates. */
function mapCompletionItem(item: vscode.CompletionItem, lineOffset: number): vscode.CompletionItem {
  item.range = mapCompletionRange(item.range, lineOffset);
  item.textEdit = mapTextEdit(item.textEdit, lineOffset);
  item.additionalTextEdits = item.additionalTextEdits?.map((edit) => mapImportOrCellTextEdit(edit, lineOffset));
  return item;
}

/** Maps a completion range union back to notebook-cell coordinates. */
function mapCompletionRange(
  range: vscode.CompletionItem["range"],
  lineOffset: number
): vscode.CompletionItem["range"] {
  if (!range) {
    return undefined;
  }
  if ("inserting" in range) {
    return {
      inserting: mapRange(range.inserting, lineOffset) ?? new vscode.Range(0, 0, 0, 0),
      replacing: mapRange(range.replacing, lineOffset) ?? new vscode.Range(0, 0, 0, 0)
    };
  }
  return mapRange(range, lineOffset);
}

/** Maps definition results that point at a shadow document back to concrete locations. */
function mapDefinitionLocations(
  locations: Array<vscode.Location | vscode.DefinitionLink>,
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.Location[] {
  return compact(locations.map((location) => {
    if ("targetUri" in location) {
      return locationFromLink(location, shadowUriValue, documentUri, lineOffset);
    }
    return mapLocation(location, shadowUriValue, documentUri, lineOffset);
  }));
}

/** Maps concrete locations from the shadow document to the notebook cell. */
function mapLocations(
  locations: vscode.Location[],
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.Location[] {
  return compact(locations.map((location) => mapLocation(location, shadowUriValue, documentUri, lineOffset)));
}

/** Maps one concrete location from the shadow document to the notebook cell. */
function mapLocation(
  location: vscode.Location,
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.Location | undefined {
  if (location.uri.toString() !== shadowUriValue.toString()) {
    return location;
  }
  const range = mapRange(location.range, lineOffset);
  return range ? new vscode.Location(documentUri, range) : undefined;
}

/** Converts one location link into a location while remapping shadow-file targets. */
function locationFromLink(
  link: vscode.DefinitionLink,
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.Location | undefined {
  const uri = link.targetUri.toString() === shadowUriValue.toString() ? documentUri : link.targetUri;
  const range = uri.toString() === documentUri.toString()
    ? mapRange(link.targetSelectionRange ?? link.targetRange, lineOffset)
    : link.targetSelectionRange ?? link.targetRange;
  return range ? new vscode.Location(uri, range) : undefined;
}

/** Maps document highlights from shadow-file coordinates back to notebook-cell coordinates. */
function mapDocumentHighlights(highlights: vscode.DocumentHighlight[], lineOffset: number): vscode.DocumentHighlight[] {
  return compact(highlights.map((highlight) => {
    const range = mapRange(highlight.range, lineOffset);
    return range ? new vscode.DocumentHighlight(range, highlight.kind) : undefined;
  }));
}

/** Maps code action workspace edits from the shadow file to the notebook cell. */
function mapCodeAction(
  action: vscode.CodeAction | vscode.Command,
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.CodeAction | vscode.Command {
  if (!("edit" in action) || !action.edit) {
    return action;
  }
  action.edit = mapWorkspaceEdit(action.edit, shadowUriValue, documentUri, lineOffset);
  return action;
}

/** Maps all shadow-file text edits in a workspace edit to the notebook cell document. */
function mapWorkspaceEdit(
  edit: vscode.WorkspaceEdit,
  shadowUriValue: vscode.Uri,
  documentUri: vscode.Uri,
  lineOffset: number
): vscode.WorkspaceEdit {
  const mapped = new vscode.WorkspaceEdit();
  for (const [uri, textEdits] of edit.entries()) {
    if (uri.toString() !== shadowUriValue.toString()) {
      mapped.set(uri, textEdits);
      continue;
    }
    const cellEdits = compact(textEdits.map((editItem) => mapTextEdit(editItem, lineOffset)));
    if (cellEdits.length) {
      mapped.set(documentUri, cellEdits);
    }
  }
  return mapped;
}

/** Maps a shadow-file text edit back to notebook-cell coordinates. */
function mapTextEdit(edit: vscode.TextEdit | undefined, lineOffset: number): vscode.TextEdit | undefined {
  if (!edit) {
    return undefined;
  }
  const range = mapRange(edit.range, lineOffset);
  return range ? new vscode.TextEdit(range, edit.newText) : undefined;
}

/** Maps import insertions to the cell top and normal edits to adjusted cell coordinates. */
function mapImportOrCellTextEdit(edit: vscode.TextEdit, lineOffset: number): vscode.TextEdit {
  const range = mapRange(edit.range, lineOffset);
  if (range) {
    return new vscode.TextEdit(range, edit.newText);
  }
  return new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), edit.newText);
}

/** Maps one shadow-file range back to notebook-cell coordinates. */
function mapRange(range: vscode.Range | undefined, lineOffset: number): vscode.Range | undefined {
  if (!range || range.end.line < lineOffset) {
    return undefined;
  }
  return new vscode.Range(
    Math.max(0, range.start.line - lineOffset),
    range.start.line < lineOffset ? 0 : range.start.character,
    range.end.line - lineOffset,
    range.end.character
  );
}

/** Removes undefined values while preserving item types. */
function compact<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => item !== undefined);
}

/** Returns whether expensive bridged code actions should run for notebook Python cells. */
function codeActionsEnabled(): boolean {
  return vscode.workspace.getConfiguration("djangoShell").get<boolean>("enableCodeActions", false);
}

/** Returns the remaining latency budget for one editor feature request. */
function remainingBudget(started: number): number { return Math.max(1, FEATURE_BUDGET_MS - (Date.now() - started)); }
