// Debugpy attach orchestration for local and remote Django shell backends.
import * as path from "path";
import * as vscode from "vscode";
import type { BackendClient, BackendExecutionResult } from "./backendClient";
import { createDebugpyBundlePayload, type DebugpyBundlePayload } from "./debugpyBundle";
import { DEBUGPY_MARKER_PREFIX, buildDebugpyBootstrapCode, type DebugpyBootstrapResult, parseDebugpyBootstrapResult } from "./debugShell";
import type { DiagnosticLogger } from "./diagnostics";

export interface DebugpyBundleStager {
  stageDebugpyBundle(payload: DebugpyBundlePayload): Promise<string | undefined>;
}

export interface DebugpyStartOptions {
  backend: BackendClient;
  host: string;
  logger?: DiagnosticLogger;
  port: number;
  stager?: DebugpyBundleStager;
}

/** Starts debugpy in the backend, staging the bundled pure-Python copy when a remote shell cannot import it. */
export async function startDebugpyInBackend(options: DebugpyStartOptions): Promise<DebugpyBootstrapResult> {
  const searchPaths = debugpySearchPaths();
  const first = await runDebugpyBootstrap(options.backend, options.host, options.port, searchPaths, options.logger);
  if (first.ok || !shouldStageBundledDebugpy(first.error) || !options.stager) {
    return first;
  }
  const payload = createDebugpyBundlePayload(searchPaths);
  if (!payload) {
    return first;
  }
  let remotePath: string;
  try {
    remotePath = await stageBundledDebugpy(options.stager, payload, options.logger);
  } catch (error) {
    return { error: `${first.error ?? "debugpy is not importable."}\nBundled debugpy staging failed: ${error instanceof Error ? error.message : String(error)}`, ok: false };
  }
  const second = await runDebugpyBootstrap(options.backend, options.host, options.port, [remotePath, ...searchPaths], options.logger);
  if (second.ok) {
    return second;
  }
  return {
    error: `debugpy failed after staging bundled copy at ${remotePath}: ${second.error ?? "unknown debugpy error"}\nInitial error: ${first.error ?? "unknown debugpy error"}`,
    ok: false
  };
}

/** Runs one debugpy bootstrap request and appends captured output to parseable failures. */
async function runDebugpyBootstrap(backend: BackendClient, host: string, port: number, searchPaths: string[], logger?: DiagnosticLogger): Promise<DebugpyBootstrapResult> {
  const code = buildDebugpyBootstrapCode(host, port, DEBUGPY_MARKER_PREFIX, searchPaths);
  logger?.log("debugpy.bootstrap.request", { listenHost: host, listenPort: port, searchPaths: searchPaths.length });
  const result = await backend.debugpy(code);
  const text = executionText(result);
  const parsed = parseDebugpyBootstrapResult(text);
  if (parsed.ok) {
    logger?.log("debugpy.bootstrap.endpoint", { endpointHost: parsed.endpoint?.host, endpointPort: parsed.endpoint?.port, inProcess: parsed.endpoint?.inProcess, listenHost: host, listenPort: port, reused: parsed.endpoint?.reused, transport: backend.transport });
    return parsed;
  }
  logger?.log("debugpy.bootstrap.error", { error: parsed.error, listenHost: host, listenPort: port, output: text.slice(0, 500), transport: backend.transport });
  return { error: parsed.error ? `${parsed.error}\n${text}` : text, ok: false };
}

/** Stages the bundled debugpy payload through the PTY session and logs the result. */
async function stageBundledDebugpy(stager: DebugpyBundleStager, payload: DebugpyBundlePayload, logger?: DiagnosticLogger): Promise<string> {
  try {
    const remotePath = await stager.stageDebugpyBundle(payload);
    if (remotePath) {
      logger?.log("debugpy.bundle.staged", { files: payload.fileCount, path: remotePath });
      return remotePath;
    }
    throw new Error("Bundled debugpy staging returned no remote path.");
  } catch (error) {
    logger?.log("debugpy.bundle.stage.error", { error: error instanceof Error ? error.message : String(error), files: payload.fileCount });
    throw error;
  }
}

/** Returns bundled debugpy import roots from the Python Debugger extension when it is installed. */
function debugpySearchPaths(): string[] {
  const debugpyExtension = vscode.extensions.getExtension("ms-python.debugpy");
  return debugpyExtension ? [path.join(debugpyExtension.extensionPath, "bundled", "libs")] : [];
}

/** Returns whether a debugpy bootstrap failure is likely fixed by staging the bundled module. */
function shouldStageBundledDebugpy(error: string | undefined): boolean {
  return /(?:ModuleNotFoundError|ImportError|No module named).*debugpy/i.test(error ?? "");
}

/** Joins backend execution streams into the same text rendered to the console. */
function executionText(result: BackendExecutionResult): string {
  return [result.stdout, result.stderr, result.result, result.traceback, result.error].filter(Boolean).join("\n") || "(no output)";
}
