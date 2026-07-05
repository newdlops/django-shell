// Debugpy bundle packaging helpers for remote Django shell debugger attach.
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { deflateSync } from "zlib";

export interface DebugpyBundleInstallCommand {
  bytes: number;
  chunks: number;
  command: string;
}

export interface DebugpyBundleInstallResult {
  error?: string;
  ok: boolean;
  path?: string;
}

export interface DebugpyBundlePayload {
  data: string;
  digest: string;
  fileCount: number;
}

type DebugpyBundleFile = [string, string];

const DEBUGPY_BUNDLE_CHUNK_SIZE = 900;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".py", ".pyi", ".txt", ".typed"]);
// Runtime-dead weight for a debugpy.listen() attach: pydevd_attach_to_process (attach-by-pid injection, ~26% of the
// bundle), _pydev_runfiles (pytest runner integration), and the never-imported top-level `packaging` copy. Licenses are
// kept for attribution; wheel-inventory files (RECORD/METADATA/...) are dropped with the old TEXT_FILENAMES list.
const SKIPPED_DIRECTORIES = new Set(["__pycache__", "_pydev_runfiles", "pydevd_attach_to_process"]);
const SKIPPED_DIRECTORY_PREFIXES = ["packaging"];

/** Builds a compressed text-file debugpy bundle from the first usable bundled libs path. */
export function createDebugpyBundlePayload(searchPaths: string[]): DebugpyBundlePayload | undefined {
  const root = searchPaths.find((candidate) => fs.existsSync(path.join(candidate, "debugpy", "__init__.py")));
  if (!root) {
    return undefined;
  }
  const files = readDebugpyBundleFiles(root);
  if (!files.length) {
    return undefined;
  }
  const compressed = deflateSync(Buffer.from(JSON.stringify(files), "utf8"));
  return {
    data: compressed.toString("base64"),
    digest: createHash("sha256").update(compressed).digest("hex"),
    fileCount: files.length
  };
}

/** Builds paced Python statements that unpack a debugpy bundle and emit a PTY response marker. */
export function buildDebugpyBundleInstallCommand(payload: DebugpyBundlePayload, requestId: string, responsePrefix: string): DebugpyBundleInstallCommand {
  const partsKey = `_djs_debugpy_bundle_${payload.digest.slice(0, 16)}_${safeKeyPart(requestId)}`;
  const codeKey = `${partsKey}_code`;
  const chunks = payloadChunks(payload.data);
  const python = buildInstallerPython(payload.digest, payload.fileCount, partsKey, requestId, responsePrefix);
  const lines = [
    `globals()[${pythonString(partsKey)}]=[]`,
    ...chunks.map((chunk) => `globals().setdefault(${pythonString(partsKey)},[]).append(${pythonString(chunk)})`),
    `globals()[${pythonString(codeKey)}]=[]`,
    ...payloadChunks(python).map((chunk) => `globals().setdefault(${pythonString(codeKey)},[]).append(${pythonString(chunk)})`),
    `exec(''.join(globals().pop(${pythonString(codeKey)},[])))`
  ];
  const command = `${lines.join("\r")}\r`;
  return { bytes: command.length, chunks: chunks.length, command };
}

/** Parses the staged debugpy installation response returned by the PTY marker resolver. */
export function parseDebugpyBundleInstallResult(buffer: string): DebugpyBundleInstallResult {
  try {
    const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<DebugpyBundleInstallResult>;
    if (parsed.ok && typeof parsed.path === "string" && parsed.path) {
      return { ok: true, path: parsed.path };
    }
    return { error: typeof parsed.error === "string" ? parsed.error : "Bundled debugpy install failed.", ok: false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** Recursively reads portable debugpy text files from a bundled libs root. */
function readDebugpyBundleFiles(root: string): DebugpyBundleFile[] {
  const files: DebugpyBundleFile[] = [];
  visitDebugpyBundleDirectory(root, root, files);
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

/** Adds bundleable files below one directory to the output list. */
function visitDebugpyBundleDirectory(root: string, directory: string, files: DebugpyBundleFile[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (!isSkippedDebugpyBundleDirectory(entry.name)) {
        visitDebugpyBundleDirectory(root, path.join(directory, entry.name), files);
      }
      continue;
    }
    if (!entry.isFile() || !shouldBundleDebugpyFile(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    files.push([relative, fs.readFileSync(absolute).toString("base64")]);
  }
}

/** Returns whether one directory holds no code the staged debugpy needs at runtime. */
function isSkippedDebugpyBundleDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name) || SKIPPED_DIRECTORY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Returns whether one bundled file is portable enough to copy into a remote Python environment. */
function shouldBundleDebugpyFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filename)) || filename.startsWith("LICENSE");
}

/** Builds the remote Python installer body used after payload chunks have been staged. */
function buildInstallerPython(digest: string, fileCount: number, partsKey: string, requestId: string, responsePrefix: string): string {
  return [
    "import base64 as _djs_b,json as _djs_j,os as _djs_o,sys as _djs_s,tempfile as _djs_t,traceback as _djs_tb,zlib as _djs_z",
    `_djs_prefix=${pythonString(responsePrefix)}; _djs_id=${pythonString(requestId)}; _djs_key=${pythonString(partsKey)}; _djs_digest=${pythonString(digest)}; _djs_count=${fileCount}`,
    "def _djs_emit(_djs_response):",
    "    print(_djs_prefix + _djs_j.dumps({'id': _djs_id, 'response': _djs_response}), flush=True)",
    "try:",
    "    _djs_root = _djs_o.path.join(_djs_t.gettempdir(), 'django-shell-debugpy-' + _djs_digest[:16])",
    "    _djs_init = _djs_o.path.join(_djs_root, 'debugpy', '__init__.py')",
    "    if not _djs_o.path.exists(_djs_init):",
    "        _djs_payload = ''.join(globals().pop(_djs_key, []))",
    "        if not _djs_payload:",
    "            raise RuntimeError('Bundled debugpy payload was empty.')",
    "        _djs_files = _djs_j.loads(_djs_z.decompress(_djs_b.b64decode(_djs_payload)).decode('utf-8'))",
    "        _djs_root_norm = _djs_o.path.normpath(_djs_root)",
    "        _djs_i = 0",
    "        while _djs_i < len(_djs_files):",
    "            _djs_rel, _djs_data = _djs_files[_djs_i]",
    "            _djs_target = _djs_o.path.normpath(_djs_o.path.join(_djs_root_norm, *_djs_rel.split('/')))",
    "            if not (_djs_target == _djs_root_norm or _djs_target.startswith(_djs_root_norm + _djs_o.sep)):",
    "                raise RuntimeError('Unsafe debugpy bundle path: ' + _djs_rel)",
    "            _djs_o.makedirs(_djs_o.path.dirname(_djs_target), exist_ok=True)",
    "            with open(_djs_target, 'wb') as _djs_file:",
    "                _djs_file.write(_djs_b.b64decode(_djs_data))",
    "            _djs_i += 1",
    "    else:",
    "        globals().pop(_djs_key, None)",
    "    if _djs_root not in _djs_s.path:",
    "        _djs_s.path.insert(0, _djs_root)",
    "    _djs_emit({'files': _djs_count, 'ok': True, 'path': _djs_root})",
    "except Exception:",
    "    _djs_emit({'error': _djs_tb.format_exc(), 'ok': False})",
    "finally:",
    "    globals().pop(_djs_key, None)"
  ].join("\n");
}

/** Splits one base64 payload into terminal-safe line chunks. */
function payloadChunks(payload: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < payload.length; index += DEBUGPY_BUNDLE_CHUNK_SIZE) {
    chunks.push(payload.slice(index, index + DEBUGPY_BUNDLE_CHUNK_SIZE));
  }
  return chunks;
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** Converts a request id into a short globals-key suffix. */
function safeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "request";
}
