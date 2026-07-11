// Python feature bridge for the Django shell overlay editor.

import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { closeGeneratedOverlayTabs } from "./generatedOverlayTabs";
import { withLatencyBudget } from "./latencyBudget";
import { OverlayCompletionRequestCache } from "./overlayCompletionRequestCache";
import { OVERLAY_SHELL_LANGUAGE_ID } from "./overlayLanguage";
import { INPUT_MARKER, OverlayMemoryDocument } from "./overlayMemoryDocument";

const SEMANTIC_TOKEN_TYPES = ["namespace", "class", "function", "variable"];
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES);
const COMPLETION_DEBOUNCE_MS = 30;
const SIGNATURE_BUDGET_MS = 200;
const SIGNATURE_DEBOUNCE_MS = 40;

/** Forwards overlay editor language requests to the raw hidden analysis document. */
export class OverlayPythonFeatureBridge implements vscode.CompletionItemProvider, vscode.DefinitionProvider, vscode.DocumentHighlightProvider, vscode.Disposable, vscode.HoverProvider, vscode.ReferenceProvider, vscode.SignatureHelpProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly completionCache: OverlayCompletionRequestCache;
  private analysisSuggestionBusy = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private signatureVersion = 0;

  /** Stores memory documents used for visible and analysis text. */
  constructor(private readonly documents: OverlayMemoryDocument, private readonly logger?: DiagnosticLogger) { this.completionCache = new OverlayCompletionRequestCache(logger); }

  /** Registers Python providers for this instance's overlay editor file (console-cell.py or query-cell.py). */
  activate(): void {
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
  }

  /** Releases provider registrations. */
  dispose(): void {
    clearTimeout(this.cleanupTimer);
    this.signatureVersion += 1;
    this.completionCache.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Invalidates completion results and pending work after hidden imports change. */
  invalidateCompletions(): void { this.completionCache.clear(); }

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
    const result = await this.completionCache.provide(document, position, context.triggerCharacter, (isCurrent) => this.loadCompletionItems(text, position, context, isCurrent));
    return withDjangoCompletions(result, text, position, prelude);
  }

  /** Loads uncached completions through the hidden analysis document. */
  private async loadCompletionItems(text: string, position: vscode.Position, context: vscode.CompletionContext, isCurrent: () => boolean): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    const started = Date.now();
    const offset = analysisOffsetForText(text, this.documents.inputStartLine(), this.documents.lineOffset());
    const protectedLineCount = protectedLineCountForText(text, offset);
    const analysisPosition = this.analysisPosition(position, offset);
    if (!context.triggerCharacter) {
      await completionDebounce();
    }
    if (!isCurrent()) {
      return [];
    }
    if (this.analysisSuggestionBusy) {
      return [];
    }
    this.analysisSuggestionBusy = true;
    try {
      const result = await this.enqueueAnalysisRequest(text, position.line, () => isCurrent()
        ? vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>("vscode.executeCompletionItemProvider", this.documents.analysisUri, analysisPosition, context.triggerCharacter)
        : Promise.resolve([]));
      this.cleanupGeneratedTabs();
      const current = isCurrent();
      this.logger?.log("overlay.feature", { current, feature: "completion", items: current ? completionCount(result) : 0, ms: Date.now() - started, offset, trigger: context.triggerCharacter, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
      return current ? mapCompletionResult(result, offset, protectedLineCount) : [];
    } finally {
      this.analysisSuggestionBusy = false;
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
    if (token.isCancellationRequested || requestVersion !== this.signatureVersion || this.analysisSuggestionBusy) {
      return undefined;
    }
    this.analysisSuggestionBusy = true;
    let providerStarted = false;
    try {
      const provider = this.enqueueAnalysisRequest(text, position.line, () => token.isCancellationRequested || requestVersion !== this.signatureVersion
        ? Promise.resolve(undefined)
        : Promise.resolve(vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", this.documents.analysisUri, analysisPosition, context.triggerCharacter)));
      providerStarted = true;
      const tracked = provider.finally(() => { this.analysisSuggestionBusy = false; });
      void tracked.then(() => this.cleanupGeneratedTabs(), () => undefined);
      const ready = await withLatencyBudget(tracked, SIGNATURE_BUDGET_MS);
      const current = !token.isCancellationRequested && requestVersion === this.signatureVersion;
      const result = ready.completed && current ? ready.value : undefined;
      this.logger?.log("overlay.feature", { completed: ready.completed, current, feature: "signature", items: result?.signatures.length ?? 0, ms: Date.now() - started, offset, trigger: context.triggerCharacter, visibleLine: position.line + 1, analysisLine: analysisPosition.line + 1 });
      return result;
    } finally {
      if (!providerStarted) { this.analysisSuggestionBusy = false; }
    }
  }

  /** Provides semantic tokens for prelude-imported names in the visible shell input. */
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
    if (!this.isEditorDocument(document)) {
      return undefined;
    }
    const started = Date.now();
    const result = semanticTokensForVisibleText(document.getText(), this.preludeSource(document.getText()));
    this.logger?.log("overlay.feature", { feature: "semanticTokens", items: result.count, ms: Date.now() - started, symbols: result.symbols });
    return result.tokens;
  }

  /** Returns whether a document is the visible overlay editor document. */
  private isEditorDocument(document: vscode.TextDocument): boolean {
    return document.uri.toString() === this.documents.editorUri.toString();
  }

  /** Serializes one focused analysis snapshot through the provider that reads it. */
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

/** Waits briefly so ordinary typing bursts collapse before hidden-provider work starts. */
function completionDebounce(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, COMPLETION_DEBOUNCE_MS)); }

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
  return text.split(/\r?\n/).findIndex((line) => line.trim() === INPUT_MARKER);
}

/** Maps completion ranges back from the analysis document to the visible editor. */
function mapCompletionResult(result: vscode.CompletionList | vscode.CompletionItem[] | undefined, offset: number, protectedLineCount = offset): vscode.CompletionList | vscode.CompletionItem[] {
  const items = result instanceof vscode.CompletionList ? result.items : result ?? [];
  for (const item of items) {
    mapCompletionItem(item, offset, protectedLineCount);
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
function mapCompletionItem(item: vscode.CompletionItem, offset: number, protectedLineCount: number): vscode.CompletionItem {
  item.range = mapCompletionRange(item.range, offset);
  item.textEdit = mapTextEdit(item.textEdit, offset, protectedLineCount);
  const additionalTextEdits = compact((item.additionalTextEdits ?? []).map((edit) => mapTextEdit(edit, offset, protectedLineCount)));
  item.additionalTextEdits = additionalTextEdits.length ? additionalTextEdits : undefined;
  return item;
}

/** Maps one completion text edit back to the visible editor. */
function mapTextEdit(edit: vscode.TextEdit | undefined, offset: number, protectedLineCount = offset): vscode.TextEdit | undefined {
  if (!edit || edit.range.end.line < protectedLineCount) {
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

/** Builds semantic tokens for visible code that references hidden prelude imports. */
function semanticTokensForText(text: string): { count: number; symbols: number; tokens: vscode.SemanticTokens } {
  return semanticTokensForVisibleText(userTextFromFullText(text), text);
}

/** Builds semantic tokens for visible code using a separate prelude source. */
function semanticTokensForVisibleText(visibleText: string, preludeSource: string): { count: number; symbols: number; tokens: vscode.SemanticTokens } {
  const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
  const symbols = importedPreludeSymbols(preludeSource);
  const lines = visibleText.split(/\r?\n/);
  let count = 0;
  for (let line = 0; line < lines.length; line++) {
    count += pushLineSemanticTokens(builder, line, lines[line], symbols);
  }
  return { count, symbols: symbols.size, tokens: builder.build() };
}

/** Pushes semantic tokens for one source line and returns how many were added. */
function pushLineSemanticTokens(builder: vscode.SemanticTokensBuilder, line: number, source: string, symbols: Map<string, string>): number {
  let count = 0;
  const code = source.split("#", 1)[0] ?? "";
  const pattern = /\b[A-Za-z_]\w*\b/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const tokenType = symbols.get(match[0]);
    if (!tokenType) {
      continue;
    }
    builder.push(line, match.index, match[0].length, SEMANTIC_TOKEN_TYPES.indexOf(tokenType));
    count += 1;
  }
  return count;
}

/** Returns imported names from the generated prelude and their token type. */
function importedPreludeSymbols(text: string): Map<string, string> {
  return new Map([...importedPreludeSymbolDetails(text)].map(([name, symbol]) => [name, symbol.tokenType]));
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
  const fromImport = trimmed.match(/^from\s+[A-Za-z_][\w.]*\s+import\s+(.+)$/);
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

/** Returns visible user text from a generated full analysis document. */
function userTextFromFullText(text: string): string {
  const index = text.indexOf(`${INPUT_MARKER}\n`);
  if (index < 0) {
    return text;
  }
  return text.slice(index + INPUT_MARKER.length + 1);
}

/** Returns one line of text or an empty string when out of range. */
function lineAtText(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? "";
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

export const __test = { SEMANTIC_TOKEN_TYPES, analysisOffsetForText, djangoManagerCompletionForText, mapCompletionResult, preludeHoverForText, protectedLineCountForText, semanticTokensForText, semanticTokensForVisibleText };
