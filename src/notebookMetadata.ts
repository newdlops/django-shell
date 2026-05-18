// Python notebook metadata helpers for editor and IntelliSense compatibility.

type JsonObject = { [key: string]: unknown };

/** Returns notebook metadata that identifies Django shell cells as Python code. */
export function pythonNotebookMetadata(metadata: JsonObject = {}): JsonObject {
  return {
    ...metadata,
    kernelspec: {
      ...objectValue(metadata.kernelspec),
      display_name: "Python 3",
      language: "python",
      name: "python3"
    },
    language_info: {
      ...objectValue(metadata.language_info),
      codemirror_mode: { name: "ipython", version: 3 },
      file_extension: ".py",
      mimetype: "text/x-python",
      name: "python",
      nbconvert_exporter: "python",
      pygments_lexer: "ipython3"
    }
  };
}

/** Returns cell metadata that keeps Python language features attached to input cells. */
export function pythonCellMetadata(metadata: JsonObject = {}): JsonObject {
  return {
    ...metadata,
    language: "python",
    languageId: "python",
    custom: {
      ...objectValue(metadata.custom),
      vscode: {
        ...objectValue(objectValue(metadata.custom).vscode),
        languageId: "python"
      }
    },
    vscode: {
      ...objectValue(metadata.vscode),
      languageId: "python"
    }
  };
}

/** Returns a JSON object value when metadata contains one. */
function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
