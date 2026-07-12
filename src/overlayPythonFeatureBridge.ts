// Python feature bridge for the Django shell overlay editor.

import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { closeGeneratedOverlayTabs } from "./generatedOverlayTabs";
import { withLatencyBudget } from "./latencyBudget";
import { OverlayCompletionRequestCache } from "./overlayCompletionRequestCache";
import { overlayExecutionUnitRange, type OverlayExecutionUnitRange } from "./overlayExecutionUnit";
import { OVERLAY_SHELL_LANGUAGE_ID } from "./overlayLanguage";
import { INPUT_MARKER, OverlayMemoryDocument } from "./overlayMemoryDocument";
import { mapOverlaySemanticTokenData } from "./overlaySemanticTokens";

const SEMANTIC_REGISTRATION_ATTEMPTS = 300;
const SEMANTIC_REGISTRATION_DELAY_MS = 100;
const SEMANTIC_TOKEN_DEBOUNCE_MS = 250;
const SIGNATURE_BUDGET_MS = 200;
const SIGNATURE_DEBOUNCE_MS = 40;
const COMPLETION_QUERY_SNAPSHOT = Symbol("overlayCompletionQuerySnapshot");

/** Captures the provider-only source and cursor used to obtain a fallback item. */
interface CompletionQuerySnapshot {
  position: vscode.Position;
  text: string;
}

/** Extends a completion item with the hidden query snapshot used to obtain it. */
interface CompletionItemWithQuerySnapshot extends vscode.CompletionItem {
  [COMPLETION_QUERY_SNAPSHOT]?: CompletionQuerySnapshot;
}

/** Carries visible source geometry needed to relocate Pylance auto-import edits. */
interface CompletionEditContext { focusCharacter?: number; focusLine: number; text: string }

/** Retains one hidden-provider request so a lazily resolved Pylance item can be mapped later. */
interface CompletionResolveContext extends CompletionEditContext {
  analysisText: string;
  index: number;
  offset: number;
  position: vscode.Position;
  protectedLineCount: number;
  triggerCharacter: string | undefined;
}

/** Describes a one-character-left retry for a completed bare identifier. */
interface CompletionEndFallback {
  identifier: string;
  position: vscode.Position;
  text: string;
}

/** Describes a safe import insertion point and whether it follows future imports. */
interface AutoImportInsertion {
  afterFuture: boolean;
  character: number;
  followingLine: number;
  line: number;
}

/** Forwards overlay language requests to the complete workspace-backed Python analysis document. */
export class OverlayPythonFeatureBridge implements vscode.CompletionItemProvider, vscode.DefinitionProvider, vscode.DocumentHighlightProvider, vscode.Disposable, vscode.DocumentSemanticTokensProvider, vscode.HoverProvider, vscode.ReferenceProvider, vscode.SignatureHelpProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly completionCache: OverlayCompletionRequestCache;
  private readonly completionResolutions = new WeakMap<vscode.CompletionItem, CompletionResolveContext>();
  private readonly semanticTokensChanged = new vscode.EventEmitter<void>();
  private completionSuggestionBusy = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private semanticVersion = 0;
  private signatureVersion = 0;
  readonly onDidChangeSemanticTokens = this.semanticTokensChanged.event;

  /** Stores memory documents used for visible and analysis text. */
  constructor(private readonly documents: OverlayMemoryDocument, private readonly logger?: DiagnosticLogger) { this.completionCache = new OverlayCompletionRequestCache(logger); }

  /** Registers Python providers for this instance's overlay editor file (console-cell.py or query-cell.py). */
  activate(): void {
    this.disposed = false;
    const file = path.basename(this.documents.editorUri.fsPath);
    const pattern = `**/.django-shell/${file}`;
    const language = file === "query-cell.py" ? "python" : OVERLAY_SHELL_LANGUAGE_ID;
    const selector: vscode.DocumentSelector = [{ language, pattern, scheme: "file" }];
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(selector, this, ".", "'", "\""),
      vscode.languages.registerHoverProvider(selector, this),
      vscode.languages.registerDefinitionProvider(selector, this),
      vscode.languages.registerReferenceProvider(selector, this),
      vscode.languages.registerDocumentHighlightProvider(selector, this),
      vscode.languages.registerSignatureHelpProvider(selector, this, "(", ",")
    );
    if (language === OVERLAY_SHELL_LANGUAGE_ID) { void this.registerSemanticTokenProvider(selector); }
  }

  /** Releases provider registrations. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.cleanupTimer);
    this.semanticVersion += 1;
    this.signatureVersion += 1;
    this.completionCache.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.semanticTokensChanged.dispose();
  }

  /** Invalidates completion results and pending work after hidden imports change. */
  invalidateCompletions(): void { this.completionCache.clear(); }

  /** Requests fresh visible semantic tokens after the hidden analysis source is installed. */
  refreshSemanticTokens(): void { this.semanticTokensChanged.fire(); }

  /** Provides completions through the hidden analysis document. */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    if (!this.isEditorDocument(document) || token.isCancellationRequested) {
      return undefined;
    }
    const text = document.getText();
    const prelude = this.preludeSource(text);
    if (!prelude.trim() && document.languageId !== OVERLAY_SHELL_LANGUAGE_ID) {
      return [];
    }
    const result = await this.completionCache.provide(document, position, context.triggerCharacter, (isCurrent) => this.loadCompletionItems(text, position, context, isCurrent), () => token.isCancellationRequested);
    if (token.isCancellationRequested) { return undefined; }
    this.rememberCompletionResolutions(result, text, position, context.triggerCharacter);
    return withDjangoCompletions(result, text, position, prelude);
  }

  /** Resolves Pylance's lazy auto-import edit and remaps it into the selected execution unit. */
  async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
    const context = this.completionResolutions.get(item);
    if (!context || token.isCancellationRequested || item.additionalTextEdits?.length || !completionMayNeedLazyImportResolution(item, context) || !this.completionContextStillCurrent(context)) {
      return item;
    }
    const analysisPosition = context.position.translate(context.offset, 0);
    const result = await this.documents.withTransientAnalysisSnapshot(context.analysisText, context.focusLine, async () => {
      return token.isCancellationRequested
        ? []
        : await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>(
        "vscode.executeCompletionItemProvider",
        this.documents.analysisUri,
        analysisPosition,
        context.triggerCharacter,
        context.index + 1
        );
    });
    this.cleanupGeneratedTabs();
    if (token.isCancellationRequested) {
      return item;
    }
    const resolved = matchingCompletionItem(completionItems(result), item, context.index);
    if (!resolved) {
      return item;
    }
    const inferred = completionImportText(resolved, context);
    item.additionalTextEdits = mapAdditionalTextEdits(
      resolved.additionalTextEdits ?? [],
      context.offset,
      context.protectedLineCount,
      context,
      inferred ? [inferred] : []
    );
    return item;
  }

  /** Loads uncached completions through the hidden analysis document. */
  private async loadCompletionItems(text: string, position: vscode.Position, context: vscode.CompletionContext, isCurrent: () => boolean): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    const started = Date.now();
    const offset = analysisOffsetForText(text, this.documents.inputStartLine(), this.documents.lineOffset());
    const protectedLineCount = protectedLineCountForText(text, offset);
    const analysisPosition = this.analysisPosition(position, offset);
    this.completionSuggestionBusy = true;
    try {
      let result = await this.documents.withCancellableAnalysisSnapshot(text, position.line, () => !isCurrent(), () => vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>("vscode.executeCompletionItemProvider", this.documents.analysisUri, analysisPosition, context.triggerCharacter));
      const fallback = completionEndFallback(text, position, context.triggerCharacter, result);
      let querySnapshot: CompletionQuerySnapshot = { position, text };
      let usedEndFallback = false;
      if (fallback && isCurrent()) {
        const fallbackAnalysisPosition = this.analysisPosition(fallback.position, offset);
        const fallbackResult = await this.documents.withTransientAnalysisSnapshot(fallback.text, position.line, async () => {
          return isCurrent()
            ? await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>("vscode.executeCompletionItemProvider", this.documents.analysisUri, fallbackAnalysisPosition, context.triggerCharacter)
            : [];
        });
        if (fallbackResult && completionItems(fallbackResult).some((item) => completionLabel(item) === fallback.identifier)) {
          result = fallbackResult;
          querySnapshot = fallback;
          usedEndFallback = true;
        }
      }
      if (result) { result = rememberCompletionQuerySnapshot(result, querySnapshot); }
      this.cleanupGeneratedTabs();
      const current = isCurrent();
      this.logger?.log("overlay.feature", { current, feature: "completion", items: completionCount(result), ms: Date.now() - started, offset, trigger: context.triggerCharacter, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1, endFallback: usedEndFallback });
      return mapCompletionResult(result, offset, protectedLineCount, { focusCharacter: position.character, focusLine: position.line, text });
    } finally {
      this.completionSuggestionBusy = false;
      if (!this.disposed) { this.semanticTokensChanged.fire(); }
    }
  }

  /** Provides hover through the hidden analysis document. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const started = Date.now();
    const offset = this.analysisOffset(document);
    const analysisPosition = this.analysisPosition(position, offset);
    const hovers = await this.enqueueAnalysisRequest(document.getText(), position.line, () => vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", this.documents.analysisUri, analysisPosition));
    this.cleanupGeneratedTabs();
    this.logger?.log("overlay.feature", { feature: "hover", items: hovers?.length ?? 0, ms: Date.now() - started, offset, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
    const hover = hovers?.[0] ? mapHover(hovers[0], offset) : undefined;
    return hoverLooksAmbiguous(hover) ? preludeHoverForText(document.getText(), position, this.preludeSource(document.getText())) : hover;
  }

  /** Provides definitions through the hidden analysis document. */
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const started = Date.now();
    const offset = this.analysisOffset(document);
    const analysisPosition = this.analysisPosition(position, offset);
    const result = await this.enqueueAnalysisRequest(document.getText(), position.line, () => vscode.commands.executeCommand<Array<vscode.Location | vscode.DefinitionLink>>("vscode.executeDefinitionProvider", this.documents.analysisUri, analysisPosition));
    this.cleanupGeneratedTabs();
    this.logger?.log("overlay.feature", { feature: "definition", items: result?.length ?? 0, ms: Date.now() - started, offset, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
    return result as vscode.Definition | vscode.DefinitionLink[];
  }

  /** Provides references through the hidden analysis document. */
  async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const started = Date.now();
    const offset = this.analysisOffset(document);
    const analysisPosition = this.analysisPosition(position, offset);
    const result = await this.enqueueAnalysisRequest(document.getText(), position.line, () => vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", this.documents.analysisUri, analysisPosition));
    this.cleanupGeneratedTabs();
    const mapped = mapLocations(result ?? [], this.documents.analysisUri, this.documents.editorUri, offset);
    this.logger?.log("overlay.feature", { feature: "references", items: mapped.length, ms: Date.now() - started, offset, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
    return mapped;
  }

  /** Provides document highlights through the hidden analysis document. */
  async provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.DocumentHighlight[] | undefined> {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const started = Date.now();
    const offset = this.analysisOffset(document);
    const analysisPosition = this.analysisPosition(position, offset);
    const result = await this.enqueueAnalysisRequest(document.getText(), position.line, () => vscode.commands.executeCommand<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", this.documents.analysisUri, analysisPosition));
    this.cleanupGeneratedTabs();
    const mapped = (result ?? []).map((item) => new vscode.DocumentHighlight(mapRange(item.range, offset), item.kind));
    this.logger?.log("overlay.feature", { feature: "highlights", items: mapped.length, ms: Date.now() - started, offset, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
    return mapped;
  }

  /** Provides signature help through the hidden analysis document. */
  async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): Promise<vscode.SignatureHelp | undefined> {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const text = document.getText();
    if (!this.preludeSource(text).trim() && document.languageId !== OVERLAY_SHELL_LANGUAGE_ID) {
      return undefined;
    }
    const started = Date.now();
    const requestVersion = ++this.signatureVersion;
    const offset = this.analysisOffset(document);
    const analysisPosition = this.analysisPosition(position, offset);
    await suggestionDelay(SIGNATURE_DEBOUNCE_MS);
    if (token.isCancellationRequested || requestVersion !== this.signatureVersion || this.completionSuggestionBusy) {
      return undefined;
    }
    const cancelled = () => token.isCancellationRequested || requestVersion !== this.signatureVersion || this.completionSuggestionBusy;
    const provider = this.documents.withCancellableAnalysisSnapshot(text, position.line, cancelled, () => vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", this.documents.analysisUri, analysisPosition, context.triggerCharacter));
    void provider.then(() => this.cleanupGeneratedTabs(), () => undefined);
    const ready = await withLatencyBudget(provider, SIGNATURE_BUDGET_MS);
    const current = !cancelled();
    const result = ready.completed && current ? ready.value : undefined;
    this.logger?.log("overlay.feature", { completed: ready.completed, current, feature: "signature", items: result?.signatures.length ?? 0, ms: Date.now() - started, offset, trigger: context.triggerCharacter, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
    return result;
  }

  /** Forwards complete Pylance semantic tokens while removing the hidden analysis prelude. */
  async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
    if (!this.isEditorDocument(document) || token.isCancellationRequested) {
      return undefined;
    }
    const started = Date.now();
    const requestVersion = ++this.semanticVersion;
    const text = document.getText();
    const analysisUserStartLine = this.documents.lineOffset();
    const visibleUserStartLine = semanticVisibleUserStartLine(text, this.documents.preludeText(), analysisUserStartLine);
    await suggestionDelay(SEMANTIC_TOKEN_DEBOUNCE_MS);
    const cancelled = () => token.isCancellationRequested || requestVersion !== this.semanticVersion || this.completionSuggestionBusy;
    if (cancelled()) { return undefined; }
    const result = await this.documents.withCancellableAnalysisSnapshot(text, visibleUserStartLine, cancelled, () => vscode.commands.executeCommand<vscode.SemanticTokens | undefined>("vscode.provideDocumentSemanticTokens", this.documents.analysisUri));
    if (!result || cancelled()) { return undefined; }
    const data = mapOverlaySemanticTokenData(result.data, analysisUserStartLine, visibleUserStartLine, document.lineCount);
    this.logger?.log("overlay.feature", { feature: "semanticTokens", items: data.length / 5, ms: Date.now() - started });
    return new vscode.SemanticTokens(data, result.resultId);
  }

  /** Returns whether a document is the visible overlay editor document. */
  private isEditorDocument(document: vscode.TextDocument): boolean {
    return document.uri.toString() === this.documents.editorUri.toString();
  }

  /** Returns whether a completion clone still describes the current visible editor text. */
  private completionContextStillCurrent(context: CompletionResolveContext): boolean {
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === this.documents.editorUri.toString());
    return !document || document.getText() === context.text;
  }

  /** Serializes one complete analysis snapshot through the provider that reads it. */
  private enqueueAnalysisRequest<T>(text: string, focusLine: number, request: () => PromiseLike<T>): Promise<T> {
    return this.documents.withAnalysisSnapshot(text, focusLine, request);
  }

  /** Returns the line delta needed for the current editor document shape. */
  private analysisOffset(document: vscode.TextDocument): number {
    return analysisOffsetForText(document.getText(), this.documents.inputStartLine(), this.documents.lineOffset());
  }

  /** Converts an editor position to the hidden analysis document position. */
  private analysisPosition(position: vscode.Position, offset: number): vscode.Position {
    clearTimeout(this.cleanupTimer);
    return position.translate(offset, 0);
  }

  /** Registers the visible custom-language provider with Pylance's exact semantic legend. */
  private async registerSemanticTokenProvider(selector: vscode.DocumentSelector): Promise<void> {
    let lastError = "semantic legend unavailable";
    for (let attempt = 0; attempt < SEMANTIC_REGISTRATION_ATTEMPTS && !this.disposed; attempt += 1) {
      try {
        await vscode.workspace.openTextDocument(this.documents.analysisUri);
        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>("vscode.provideDocumentSemanticTokensLegend", this.documents.analysisUri);
        if (legend && !this.disposed) {
          const registration = vscode.languages.registerDocumentSemanticTokensProvider(selector, this, legend);
          if (this.disposed) { registration.dispose(); } else { this.disposables.push(registration); }
          this.logger?.log("overlay.semantic.registration", { modifiers: legend.tokenModifiers.length, tokenTypes: legend.tokenTypes.length });
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await suggestionDelay(SEMANTIC_REGISTRATION_DELAY_MS);
    }
    if (!this.disposed) { this.logger?.log("overlay.semantic.registration.error", { error: lastError }); }
  }

  /** Associates returned completion clones with the current visible source for lazy resolution. */
  private rememberCompletionResolutions(result: vscode.CompletionList | vscode.CompletionItem[], text: string, position: vscode.Position, triggerCharacter: string | undefined): void {
    const offset = analysisOffsetForText(text, this.documents.inputStartLine(), this.documents.lineOffset());
    const protectedLineCount = protectedLineCountForText(text, offset);
    completionItems(result).forEach((item, index) => {
      const query = (item as CompletionItemWithQuerySnapshot)[COMPLETION_QUERY_SNAPSHOT];
      this.completionResolutions.set(item, {
        analysisText: query?.text ?? text,
        focusLine: position.line,
        focusCharacter: position.character,
        index,
        offset,
        position: query?.position ?? position,
        protectedLineCount,
        text,
        triggerCharacter
      });
    });
  }

  /** Returns the best prelude source for provider-only fallback logic. */
  private preludeSource(text: string): string {
    const index = text.indexOf(INPUT_MARKER);
    return index >= 0 && text.slice(0, index).trim() ? text : this.documents.preludeText();
  }

  /** Closes tabs that VS Code may expose while resolving hidden provider requests. */
  private cleanupGeneratedTabs(): void {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => void closeGeneratedOverlayTabs([this.documents.analysisUri]), 150);
  }
}

/** Waits for a bounded language-feature debounce interval. */
function suggestionDelay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** Returns the provider line offset after detecting the editor-only marker text. */
function analysisOffsetForText(text: string, inputStartLine: number, lineOffset: number): number {
  const markerLine = markerLineForText(text);
  if (markerLine > 0) { return inputStartLine - markerLine - 2; }
  return lineOffset;
}

/** Returns lines protected from completion import edits in the generated prelude. */
function protectedLineCountForText(text: string, fallback: number): number {
  const markerLine = markerLineForText(text);
  return markerLine > 0 ? markerLine : Math.max(0, fallback);
}

/** Returns the zero-based marker line in one editor text snapshot. */
function markerLineForText(text: string): number {
  let marker = -1;
  text.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (line.trim() === INPUT_MARKER) { marker = index; }
  });
  return marker;
}

/** Returns the first visible user line corresponding to analysis source after its hidden prelude. */
function semanticVisibleUserStartLine(text: string, prelude: string, analysisUserStartLine: number): number {
  const marker = markerLineForText(text);
  if (marker >= 0) { return marker + 1; }
  return prelude && text.startsWith(prelude) ? analysisUserStartLine : 0;
}

/** Maps completion ranges back from the analysis document to the visible editor. */
function mapCompletionResult(result: vscode.CompletionList | vscode.CompletionItem[] | undefined, offset: number, protectedLineCount = offset, context?: CompletionEditContext): vscode.CompletionList | vscode.CompletionItem[] {
  const items = result instanceof vscode.CompletionList ? result.items : result ?? [];
  for (const item of items) {
    mapCompletionItem(item, offset, protectedLineCount, context);
  }
  return result instanceof vscode.CompletionList ? new vscode.CompletionList(items, result.isIncomplete) : items;
}

/** Prepends Django-specific completions when generic Python providers are too broad. */
function withDjangoCompletions(result: vscode.CompletionList | vscode.CompletionItem[], visibleText: string, position: vscode.Position, analysisText: string): vscode.CompletionList | vscode.CompletionItem[] {
  const djangoItem = djangoManagerCompletionForText(visibleText, position, analysisText);
  if (!djangoItem) {
    return result;
  }
  if ((result instanceof vscode.CompletionList ? result.items : result).some((item) => completionLabel(item) === "objects")) {
    return result;
  }
  const items = result instanceof vscode.CompletionList ? [djangoItem, ...result.items] : [djangoItem, ...result];
  return result instanceof vscode.CompletionList ? new vscode.CompletionList(items, result.isIncomplete) : items;
}

/** Returns a completion label as plain text. */
function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Returns whether an unresolved item carries the module metadata used by lazy auto-imports. */
function completionMayNeedLazyImportResolution(item: vscode.CompletionItem, context: CompletionEditContext): boolean {
  if (!bareCompletionContext(context)) { return false; }
  const description = typeof item.label === "string" ? "" : item.label.description?.trim() ?? "";
  return !!description || /\b(?:auto[ -]?import|import\s+from)\b/iu.test(item.detail ?? "");
}

/** Builds a high-priority Django manager completion for model classes. */
function djangoManagerCompletionForText(visibleText: string, position: vscode.Position, analysisText: string): vscode.CompletionItem | undefined {
  const line = lineAtText(visibleText, position.line).slice(0, position.character);
  const match = line.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
  if (!match || match[2] === "objects") {
    return undefined;
  }
  const symbol = importedPreludeSymbolDetails(analysisText).get(match[1]);
  if (!symbol || symbol.tokenType !== "class") {
    return undefined;
  }
  const typed = match[2] ?? "";
  const item = new vscode.CompletionItem("objects", vscode.CompletionItemKind.Property);
  item.detail = "Django model manager";
  item.documentation = new vscode.MarkdownString(`Manager for \`${match[1]}\`.`);
  item.range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
  item.sortText = "\u0000objects";
  item.textEdit = new vscode.TextEdit(item.range, "objects");
  return item;
}

/** Returns how many completion items a provider result contains. */
function completionCount(result: vscode.CompletionList | vscode.CompletionItem[] | undefined): number {
  return result instanceof vscode.CompletionList ? result.items.length : result?.length ?? 0;
}

/** Returns completion items independently of their array or list container. */
function completionItems(result: vscode.CompletionList | vscode.CompletionItem[] | undefined): vscode.CompletionItem[] {
  return result instanceof vscode.CompletionList ? result.items : result ?? [];
}

/** Returns a safe inside-word retry when providers omit the exact completed import name. */
function completionEndFallback(text: string, position: vscode.Position, triggerCharacter: string | undefined, result: vscode.CompletionList | vscode.CompletionItem[] | undefined): CompletionEndFallback | undefined {
  if (triggerCharacter || /[A-Za-z0-9_]/u.test(lineAtText(text, position.line)[position.character] ?? "")) { return undefined; }
  const prefix = lineAtText(text, position.line).slice(0, position.character);
  const match = prefix.match(/[A-Za-z_]\w*$/u);
  if (!match || match[0].length < 2 || (match.index ?? 0) > 0 && prefix[(match.index ?? 0) - 1] === ".") { return undefined; }
  const identifier = match[0];
  return completionItems(result).some((item) => completionLabelStartsWith(item, identifier))
    ? undefined
    : { identifier, position: position.translate(0, -1), text: textWithoutCharacterBeforePosition(text, position) };
}

/** Returns whether a completion label already extends the active identifier prefix. */
function completionLabelStartsWith(item: vscode.CompletionItem, identifier: string): boolean {
  return completionLabel(item).toLowerCase().startsWith(identifier.toLowerCase());
}

/** Marks fallback items so lazy resolution repeats the same hidden query snapshot. */
function rememberCompletionQuerySnapshot<T extends vscode.CompletionList | vscode.CompletionItem[]>(result: T, snapshot: CompletionQuerySnapshot): T {
  for (const item of completionItems(result)) {
    (item as CompletionItemWithQuerySnapshot)[COMPLETION_QUERY_SNAPSHOT] = snapshot;
  }
  return result;
}

/** Removes the single UTF-16 character immediately before a source position. */
function textWithoutCharacterBeforePosition(text: string, position: vscode.Position): string {
  const offset = offsetAtTextPosition(text, position);
  return offset > 0 ? `${text.slice(0, offset - 1)}${text.slice(offset)}` : text;
}

/** Converts a line/character pair to a bounded source offset without a TextDocument. */
function offsetAtTextPosition(text: string, position: vscode.Position): number {
  let line = 0;
  let lineStart = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    if (line >= position.line) { break; }
    line += 1;
    lineStart = (match.index ?? 0) + match[0].length;
  }
  return Math.min(text.length, lineStart + Math.max(0, position.character));
}

/** Finds the lazily resolved version of one previously returned completion item. */
function matchingCompletionItem(items: vscode.CompletionItem[], expected: vscode.CompletionItem, preferredIndex: number): vscode.CompletionItem | undefined {
  const identity = completionIdentity(expected);
  const preferred = items[preferredIndex];
  return preferred && completionIdentity(preferred) === identity
    ? preferred
    : items.find((item) => completionIdentity(item) === identity);
}

/** Builds a stable identity from fields that completion resolution cannot change. */
function completionIdentity(item: vscode.CompletionItem): string {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const description = typeof item.label === "string" ? "" : item.label.description ?? "";
  return JSON.stringify([label, description, item.kind, item.sortText, item.filterText]);
}

/** Maps one completion item range shape back to the visible editor. */
function mapCompletionRange(range: vscode.CompletionItem["range"], offset: number): vscode.CompletionItem["range"] {
  if (!range) {
    return range;
  }
  if (range instanceof vscode.Range) {
    return mapRange(range, offset);
  }
  return { inserting: mapRange(range.inserting, offset), replacing: mapRange(range.replacing, offset) };
}

/** Maps one completion item and its edits back to the visible editor. */
function mapCompletionItem(item: vscode.CompletionItem, offset: number, protectedLineCount: number, context?: CompletionEditContext): vscode.CompletionItem {
  item.range = mapCompletionRange(item.range, offset);
  item.textEdit = mapTextEdit(item.textEdit, offset, protectedLineCount);
  const inferred = context ? completionImportText(item, context) : undefined;
  item.additionalTextEdits = mapAdditionalTextEdits(item.additionalTextEdits ?? [], offset, protectedLineCount, context, inferred ? [inferred] : []);
  return item;
}

/** Maps ordinary additional edits while relocating imports into the active independent execution unit. */
function mapAdditionalTextEdits(edits: vscode.TextEdit[], offset: number, protectedLineCount: number, context?: CompletionEditContext, inferredImports: string[] = []): vscode.TextEdit[] | undefined {
  if (!context) { const mapped = compact(edits.map((edit) => mapTextEdit(edit, offset, protectedLineCount))); return mapped.length ? mapped : undefined; }
  const floor = completionInputFloor(context.text), unit = overlayExecutionUnitRange(context.text, context.focusLine, floor) ?? { end: context.focusLine, start: context.focusLine };
  const mapped: vscode.TextEdit[] = [], imports = [...inferredImports];
  let hasLocalImportEdit = false;
  for (const edit of edits) {
    const visible = mapTextEdit(edit, offset, protectedLineCount);
    const autoImport = isAutoImportEdit(edit.newText);
    if (autoImport && (!visible || !rangeInsideUnit(visible.range, unit) || emptyRange(edit.range))) {
      if (!inferredImports.length) { imports.push(edit.newText); }
      continue;
    }
    if (visible && rangeInsideUnit(visible.range, unit)) {
      hasLocalImportEdit ||= autoImport || rangeTargetsImportLine(visible.range, context.text);
      mapped.push(autoImport ? normalizedTextEdit(visible, context.text) : visible);
    }
  }
  if (hasLocalImportEdit) { imports.splice(0, inferredImports.length); }
  const insertion = autoImportInsertion(context.text, unit);
  const importText = relocatedAutoImportText(imports, context.text, unit, insertion);
  if (importText) {
    mapped.unshift(new vscode.TextEdit(
      new vscode.Range(insertion.line, insertion.character, insertion.line, insertion.character),
      importText
    ));
  }
  return mapped.length ? mapped : undefined;
}

/** Returns the first user line after an optional legacy input marker. */
function completionInputFloor(text: string): number { const marker = markerLineForText(text); return marker >= 0 ? marker + 1 : 0; }

/** Returns whether an edit stays wholly inside the current execution unit. */
function rangeInsideUnit(range: vscode.Range, unit: OverlayExecutionUnitRange): boolean { return range.start.line >= unit.start && range.end.line <= unit.end; }

/** Returns whether one edit only inserts text at a position. */
function emptyRange(range: vscode.Range): boolean { return range.start.line === range.end.line && range.start.character === range.end.character; }

/** Returns whether an edit changes an existing import statement in the focused unit. */
function rangeTargetsImportLine(range: vscode.Range, text: string): boolean {
  return /^\s*(?:from|import)\b/u.test(lineAtText(text, range.start.line));
}

/** Returns whether Pylance supplied an import statement suitable for unit-local relocation. */
function isAutoImportEdit(text: string): boolean { return /^\s*(?:from\s+(?:\.+|\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\b|import\s+[A-Za-z_]\w*)/u.test(text); }

/** Returns a non-overlapping insertion point after leading future imports when present. */
function autoImportInsertion(text: string, unit: OverlayExecutionUnitRange): AutoImportInsertion {
  let line = unit.start;
  while (line <= unit.end && /^\s*from\s+__future__\s+import\b/u.test(lineAtText(text, line))) { line += 1; }
  if (line === unit.start) {
    return { afterFuture: false, character: 0, followingLine: line, line };
  }
  const futureLine = line - 1;
  return { afterFuture: true, character: lineAtText(text, futureLine).length, followingLine: line, line: futureLine };
}

/** Normalizes and combines relocated import blocks using the visible document's line ending. */
function relocatedAutoImportText(imports: string[], text: string, unit: OverlayExecutionUnitRange, insertion: AutoImportInsertion): string {
  if (!imports.length) { return ""; }
  const eol = documentEol(text);
  const blocks = [...new Set(imports.map((item) => normalizeLineBreaks(item, eol).trim()).filter(Boolean))]
    .filter((item) => !unitContainsImport(text, unit, item));
  if (!blocks.length) { return ""; }
  const firstLine = lineAtText(text, insertion.followingLine).trim();
  if (insertion.afterFuture) {
    const separator = firstLine && !/^(?:from|import)\b/u.test(firstLine) ? eol : "";
    return `${eol}${blocks.join(eol)}${separator}`;
  }
  const separator = !firstLine || /^(?:from|import)\b/u.test(firstLine) ? eol : `${eol}${eol}`;
  return `${blocks.join(eol)}${separator}`;
}

/** Returns whether an identical import block is already present in the focused unit only. */
function unitContainsImport(text: string, unit: OverlayExecutionUnitRange, importText: string): boolean {
  const normalizedUnit = text.split(/\r\n|\n|\r/).slice(unit.start, unit.end + 1).join("\n");
  const normalizedImport = normalizeLineBreaks(importText, "\n").trim();
  return normalizedImport.includes("\n")
    ? normalizedUnit.includes(normalizedImport)
    : normalizedUnit.split("\n").some((line) => line.trim() === normalizedImport);
}

/** Returns a text edit whose inserted line endings match the visible document. */
function normalizedTextEdit(edit: vscode.TextEdit, text: string): vscode.TextEdit {
  return new vscode.TextEdit(edit.range, normalizeLineBreaks(edit.newText, documentEol(text)));
}

/** Returns the first existing line ending used for new completion edits. */
function documentEol(text: string): string { return text.match(/\r\n|\n|\r/)?.[0] ?? "\n"; }

/** Rewrites every supported line ending without introducing doubled carriage returns. */
function normalizeLineBreaks(text: string, eol: string): string { return text.replace(/\r\n|\n|\r/g, eol); }

/** Extracts a strict Python import fence carried by a lazy Pylance auto-import item. */
function completionAutoImportText(item: vscode.CompletionItem): string | undefined {
  const description = typeof item.label === "string" ? "" : item.label.description?.trim() ?? "";
  const documentation = typeof item.documentation === "string" ? item.documentation : item.documentation?.value;
  if (!description || !documentation) { return undefined; }
  const match = documentation.match(/```(?:python)?[ \t]*[\r\n]+([\s\S]*?)[\r\n]+```/iu);
  const candidate = match?.[1]?.trim();
  return candidate && isAutoImportEdit(candidate) && importOnlyText(candidate) ? candidate : undefined;
}

/** Returns an import from Pylance metadata or a different visible unit that binds the completion. */
function completionImportText(item: vscode.CompletionItem, context: CompletionEditContext): string | undefined {
  return completionAutoImportText(item) ?? visibleUnitImportText(item, context);
}

/** Copies a top-level import binding from another unit so the focused unit stays executable alone. */
function visibleUnitImportText(item: vscode.CompletionItem, context: CompletionEditContext): string | undefined {
  const floor = completionInputFloor(context.text);
  const unit = overlayExecutionUnitRange(context.text, context.focusLine, floor);
  if (!unit || !bareCompletionContext(context)) { return undefined; }
  const name = completionLabel(item);
  const lines = context.text.split(/\r\n|\n|\r/);
  for (let line = floor; line < lines.length; line += 1) {
    if (line >= unit.start && line <= unit.end) { continue; }
    const source = lines[line];
    if (source !== source.trimStart() || !/^(?:from|import)\b/u.test(source)) { continue; }
    if (parseImportSymbols(source).some((symbol) => symbol.name === name)) { return source.trim(); }
  }
  return undefined;
}

/** Returns whether completion occurs on a bare name instead of an attribute after a dot. */
function bareCompletionContext(context: CompletionEditContext): boolean {
  if (context.focusCharacter === undefined) { return true; }
  const prefix = lineAtText(context.text, context.focusLine).slice(0, context.focusCharacter);
  const tokenStart = prefix.search(/[A-Za-z_]\w*$/u);
  return tokenStart < 1 || prefix[tokenStart - 1] !== ".";
}

/** Returns whether fenced auto-import metadata contains imports and whitespace only. */
function importOnlyText(text: string): boolean {
  return text.split(/\r\n|\n|\r/).every((line) => !line.trim() || /^(?:from|import)\b/u.test(line.trim()));
}

/** Maps one completion text edit back to the visible editor. */
function mapTextEdit(edit: vscode.TextEdit | undefined, offset: number, protectedLineCount = offset): vscode.TextEdit | undefined {
  if (!edit || edit.range.start.line < protectedLineCount) {
    return undefined;
  }
  return new vscode.TextEdit(mapRange(edit.range, offset), edit.newText);
}

/** Maps one hover back to the visible editor. */
function mapHover(hover: vscode.Hover, offset: number): vscode.Hover {
  return new vscode.Hover(hover.contents, hover.range ? mapRange(hover.range, offset) : undefined);
}

/** Returns whether a hover is missing or collapsed to Any. */
function hoverLooksAmbiguous(hover: vscode.Hover | undefined): boolean {
  if (!hover) {
    return true;
  }
  return /\b(?:Any|Unknown)\b/.test(hover.contents.map((content) => typeof content === "string" ? content : "value" in content ? content.value : "").join("\n"));
}

/** Builds a precise fallback hover for symbols imported by the hidden prelude. */
function preludeHoverForText(visibleText: string, position: vscode.Position, analysisText: string): vscode.Hover | undefined {
  const word = wordAtText(visibleText, position);
  if (!word) {
    return undefined;
  }
  const symbol = importedPreludeSymbolDetails(analysisText).get(word.text);
  if (!symbol) {
    return undefined;
  }
  const docs = new vscode.MarkdownString(`\`\`\`python\n${symbol.importLine ?? word.text}\n\`\`\``);
  return new vscode.Hover(docs, new vscode.Range(position.line, word.start, position.line, word.end));
}

/** Maps locations from the analysis document back to the visible editor. */
function mapLocations(locations: vscode.Location[], analysisUri: vscode.Uri, editorUri: vscode.Uri, offset: number): vscode.Location[] {
  return locations.map((location) => sameUri(location.uri, analysisUri)
    ? new vscode.Location(editorUri, mapRange(location.range, offset))
    : location);
}

/** Maps a range from the analysis document to the visible editor. */
function mapRange(range: vscode.Range, offset: number): vscode.Range {
  return new vscode.Range(
    Math.max(0, range.start.line - offset),
    range.start.character,
    Math.max(0, range.end.line - offset),
    range.end.character
  );
}

/** Returns imported names from the generated prelude with display metadata. */
function importedPreludeSymbolDetails(text: string): Map<string, { importLine?: string; tokenType: string }> {
  const symbols = new Map<string, string>();
  for (const line of preludeText(text).split(/\r?\n/)) {
    for (const symbol of parseImportSymbols(line)) {
      symbols.set(symbol.name, symbol.tokenType);
    }
  }
  return new Map([...symbols].map(([name, tokenType]) => [name, { importLine: importLineForName(text, name), tokenType }]));
}

/** Parses one Python import line into bound names and semantic token types. */
function parseImportSymbols(line: string): Array<{ name: string; tokenType: string }> {
  const trimmed = line.trim();
  const declaration = trimmed.match(/^([A-Za-z_]\w*)\s*:/);
  if (declaration) {
    return [{ name: declaration[1], tokenType: "variable" }];
  }
  const moduleImport = trimmed.match(/^import\s+(.+)$/);
  if (moduleImport) {
    return parseImportedNames(moduleImport[1], true);
  }
  const fromImport = trimmed.match(/^from\s+(?:\.+|\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/);
  return fromImport ? parseImportedNames(fromImport[1], false) : [];
}

/** Parses the comma-separated import names bound by one import statement. */
function parseImportedNames(value: string, moduleImport: boolean): Array<{ name: string; tokenType: string }> {
  const names: Array<{ name: string; tokenType: string }> = [];
  for (const rawPart of value.replace(/[()]/g, "").split(",")) {
    const part = rawPart.trim();
    const match = part.match(/^([A-Za-z_][\w.]*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
    if (!match || match[1] === "*") {
      continue;
    }
    const boundName = match[2] ?? (moduleImport ? match[1].split(".", 1)[0] : match[1]);
    if (/^[A-Za-z_]\w*$/.test(boundName)) {
      names.push({ name: boundName, tokenType: importedTokenType(boundName, moduleImport) });
    }
  }
  return names;
}

/** Infers a display-oriented semantic token type for one imported name. */
function importedTokenType(name: string, moduleImport: boolean): string {
  if (moduleImport) {
    return "namespace";
  }
  if (/^[A-Z]/.test(name)) {
    return "class";
  }
  return "variable";
}

/** Returns the generated prelude before the visible shell input marker. */
function preludeText(text: string): string {
  const index = text.indexOf(INPUT_MARKER);
  return index >= 0 ? text.slice(0, index) : text;
}

/** Returns one line of text or an empty string when out of range. */
function lineAtText(text: string, line: number): string {
  return text.split(/\r\n|\n|\r/)[line] ?? "";
}

/** Returns the identifier around a visible text position. */
function wordAtText(text: string, position: vscode.Position): { end: number; start: number; text: string } | undefined {
  const line = lineAtText(text, position.line);
  const pattern = /\b[A-Za-z_]\w*\b/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (position.character >= match.index && position.character <= match.index + match[0].length) {
      return { end: match.index + match[0].length, start: match.index, text: match[0] };
    }
  }
  return undefined;
}

/** Returns the prelude import line that binds one name when it is simple enough. */
function importLineForName(text: string, name: string): string | undefined {
  return preludeText(text).split(/\r?\n/).find((line) => parseImportSymbols(line).some((symbol) => symbol.name === name));
}

/** Returns whether two VS Code URIs identify the same document. */
function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

/** Removes undefined values while preserving item types. */
function compact<T>(values: Array<T | undefined>): T[] {
  return values.filter((value): value is T => value !== undefined);
}

export const __test = { analysisOffsetForText, djangoManagerCompletionForText, mapCompletionResult, preludeHoverForText, protectedLineCountForText, semanticVisibleUserStartLine };
