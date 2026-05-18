// Deprecated notebook serializer retained for existing .djshell files.

import { TextDecoder, TextEncoder } from "util";
import * as vscode from "vscode";
import { PRELUDE_CELL_ROLE, SETUP_CELL_ROLE } from "./notebookConstants";
import { pythonCellMetadata, pythonNotebookMetadata } from "./notebookMetadata";

interface RawNotebook {
  cells: RawCell[];
  metadata?: { [key: string]: unknown };
}

interface RawCell {
  languageId: string;
  metadata?: { [key: string]: unknown };
  source: string;
}

/** Converts .djshell files between JSON bytes and VS Code notebook data. */
export class DjangoConsoleSerializer implements vscode.NotebookSerializer {
  /** Reads a .djshell notebook or creates the default two-cell console. */
  async deserializeNotebook(content: Uint8Array): Promise<vscode.NotebookData> {
    const text = new TextDecoder().decode(content);
    const raw = this.parse(text);
    const cells = raw.cells.length ? raw.cells.map((cell) => toCellData(cell)) : defaultCells();
    const data = new vscode.NotebookData(cells);
    data.metadata = pythonNotebookMetadata(raw.metadata);
    return data;
  }

  /** Writes notebook cell sources back to the lightweight JSON format. */
  async serializeNotebook(data: vscode.NotebookData): Promise<Uint8Array> {
    const raw: RawNotebook = {
      cells: data.cells.filter((cell) => cell.metadata?.role !== PRELUDE_CELL_ROLE).map((cell) => serializeCell(cell)),
      metadata: pythonNotebookMetadata(data.metadata)
    };
    return new TextEncoder().encode(JSON.stringify(raw, undefined, 2));
  }

  /** Parses raw JSON while tolerating empty or malformed files. */
  private parse(text: string): RawNotebook {
    try {
      const parsed = JSON.parse(text) as Partial<RawNotebook>;
      return { cells: Array.isArray(parsed.cells) ? parsed.cells as RawCell[] : [], metadata: parsed.metadata };
    } catch {
      return { cells: [] };
    }
  }
}

/** Converts one notebook cell into the lightweight serialized JSON shape. */
function serializeCell(cell: vscode.NotebookCellData): RawCell {
  return {
    languageId: cell.languageId,
    metadata: cell.metadata?.role === SETUP_CELL_ROLE ? setupCellMetadata(cell.metadata) : cell.metadata,
    source: cell.metadata?.role === SETUP_CELL_ROLE ? "" : cell.value
  };
}

/** Creates the default setup and Python input cells. */
export function defaultCells(): vscode.NotebookCellData[] {
  const setup = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "shellscript");
  setup.metadata = setupCellMetadata();
  const input = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "python");
  input.metadata = pythonCellMetadata();
  return [setup, input];
}

/** Converts one serialized code cell into notebook cell data. */
function toCellData(raw: RawCell): vscode.NotebookCellData {
  const isSetup = raw.metadata?.role === SETUP_CELL_ROLE;
  const languageId = isSetup ? raw.languageId || "shellscript" : "python";
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, isSetup ? "" : raw.source, languageId);
  cell.metadata = isSetup ? setupCellMetadata(raw.metadata) : languageMetadata(raw.languageId, raw.metadata);
  return cell;
}

/** Returns language-specific metadata for notebook cell data. */
function languageMetadata(languageId: string, metadata: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  return languageId === "python" ? pythonCellMetadata(metadata) : metadata;
}

/** Returns metadata that keeps the setup cell focused on terminal output. */
function setupCellMetadata(metadata: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  return {
    ...metadata,
    inputCollapsed: true,
    outputCollapsed: false,
    role: SETUP_CELL_ROLE
  };
}
