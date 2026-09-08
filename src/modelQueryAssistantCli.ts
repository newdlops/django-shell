// Shell-free executable resolution and bounded process execution for Query Builder AI assistance.
import { constants } from "fs";
import { StringDecoder } from "string_decoder";
import { terminateAssistantProcess } from "./assistantProcess";
import { access } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { QUERY_ASSISTANT_LIMITS, type QueryAssistantProvider, type QueryAssistantProviderSettings } from "./modelQueryAssistantProtocol";

/** One provider process invocation with stdin prompt input. */
export interface QueryAssistantCommand { args: string[]; command: string; cwd: string; provider: QueryAssistantProvider; }
/** Defines a bounded local metadata command without a generation prompt. */
export interface QueryAssistantMetadataCommand { args: string[]; command: string; cwd: string; }
/** Injectable filesystem and login-shell seams for deterministic provider discovery tests. */
export interface QueryAssistantCliDependencies { access?: (candidate: string, mode: number) => Promise<void>; loginShellPath?: () => Promise<string>; }
/** Injectable child-process and timer seams for deterministic bounded-run tests. */
export interface QueryAssistantRunDependencies {
  clearTimer?: (timer: unknown) => void;
  setTimer?: (callback: () => void, timeout: number) => unknown;
  spawn?: (command: string, args: string[], options: { cwd: string; detached?: boolean; env: NodeJS.ProcessEnv; shell: false; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;
}
/** Injectable process seams for a metadata-only capture with ignored stdin. */
export interface QueryAssistantMetadataDependencies {
  clearTimer?: (timer: unknown) => void;
  setTimer?: (callback: () => void, timeout: number) => unknown;
  spawn?: (command: string, args: string[], options: { cwd: string; detached?: boolean; env: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
}
const LOGIN_PATH_TIMEOUT_MS = 3000;
const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** Returns whether bounded stderr specifically rejects one configured model, effort, or argv flag. */
function rejectedAssistantSettings(stderr: string): boolean {
  return /(?:\b(?:unknown|unrecognized|unsupported)\s+(?:option|flag|argument)\b|\bunexpected\s+(?:option|flag|argument)\s+['"]?--[a-z0-9][a-z0-9-]*['"]?(?:\s+(?:was\s+)?found)?\b|\binvalid\s+(?:option|flag|argument|model|effort|reasoning(?:\s+level)?)\b|\b(?:model|effort|reasoning(?:\s+level)?)\b.{0,80}\b(?:unknown|unrecognized|unsupported|not supported|not available|not found)\b|\b(?:unknown|unrecognized|unsupported|invalid|not supported|not available|not found)\b.{0,80}\b(?:model|effort|reasoning(?:\s+level)?)\b)/.test(stderr);
}
/** Returns whether bounded stderr explicitly reports a provider authentication failure. */
function rejectedAssistantAuthentication(stderr: string): boolean {
  return /(?:\b(?:authentication|authorization)\s+(?:failed|failure|required|error|denied)\b|\b(?:not\s+logged\s+in|login\s+(?:required|failed)|please\s+(?:log\s+in|authenticate)|you\s+must\s+(?:log\s+in|authenticate)|unauthorized)\b|\b(?:invalid|expired|missing)\s+(?:(?:api\s+)?key|token|credentials?)\b)/.test(stderr);
}
/** Builds only the two approved local CLI argv contracts. */
export function buildQueryAssistantCommand(provider: QueryAssistantProvider, command: string, cwd: string, selection: QueryAssistantProviderSettings = { autoUpdateModel: true, model: "", reasoningEffort: "" }): QueryAssistantCommand {
  const validModel = typeof selection.model === "string" && selection.model.length <= QUERY_ASSISTANT_LIMITS.model && (!selection.model || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(selection.model));
  const validEffort = ["", "low", "medium", "high", "xhigh", "max", "ultra"].includes(selection.reasoningEffort);
  if (typeof selection.autoUpdateModel !== "boolean" || !validModel || !validEffort || !selection.autoUpdateModel && !selection.model) { throw new Error("unsupported-settings"); }
  return provider === "claude"
    ? { args: ["-p", "--output-format", "text", "--no-session-persistence", "--tools", "", ...(!selection.autoUpdateModel ? ["--model", selection.model] : []), ...(selection.reasoningEffort ? ["--effort", selection.reasoningEffort] : [])], command, cwd, provider }
    : { args: ["exec", "--sandbox", "read-only", "--ephemeral", "--color", "never", "-C", cwd, ...(selection.reasoningEffort ? ["-c", `model_reasoning_effort=\"${selection.reasoningEffort}\"`] : []), ...(!selection.autoUpdateModel ? ["--model", selection.model] : []), "-"], command, cwd, provider };
}
/** Expands only a leading home-directory shorthand in a configured command path. */
export function expandAssistantHome(command: string): string { return command === "~" ? os.homedir() : command.startsWith("~/") ? path.join(os.homedir(), command.slice(2)) : command; }
/** Checks that a filesystem candidate can be executed without invoking it. */
async function executable(candidate: string, dependencies: QueryAssistantCliDependencies = {}): Promise<boolean> { try { await (dependencies.access ?? access)(candidate, constants.X_OK); return true; } catch { return false; } }
/** Reads a fixed login-shell PATH command without interpreting configured provider values. */
export function readQueryAssistantLoginShellPath(): Promise<string> { return new Promise((resolve) => {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"); const child = spawn(shell, ["-lc", "printf %s \"$PATH\""], { detached: process.platform !== "win32", env: process.env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); const decoder = new StringDecoder("utf8"); let settled = false; let output = "";
  /** Resolves the bounded fixed shell-path probe once. */
  const finish = (value: string) => { if (settled) { return; } settled = true; clearTimeout(timer); terminateAssistantProcess(child, process.platform !== "win32"); resolve(value.slice(0, 30000).trim()); };
  const timer = setTimeout(() => finish(""), LOGIN_PATH_TIMEOUT_MS); child.stdout.on("data", (chunk: Buffer) => { output = (output + decoder.write(chunk)).slice(0, 30000); }); child.on("error", () => finish("")); child.on("close", (code) => finish(code === 0 ? output + decoder.end() : ""));
}); }
/** Merges PATH segments in priority order without duplicate directory probes. */
export function mergeQueryAssistantPath(values: string[]): string { const seen = new Set<string>(); return values.flatMap((value) => value.split(path.delimiter)).map((value) => value.trim()).filter((value) => Boolean(value) && !seen.has(value) && Boolean(seen.add(value))).join(path.delimiter); }
/** Builds a provider environment from current, login-shell, and bounded common install paths. */
export async function prepareQueryAssistantEnvironment(environment: NodeJS.ProcessEnv = process.env, dependencies: QueryAssistantCliDependencies = {}): Promise<NodeJS.ProcessEnv> { const login = await (dependencies.loginShellPath ?? readQueryAssistantLoginShellPath)(); return { ...environment, NO_COLOR: "1", PATH: mergeQueryAssistantPath([environment.PATH || "", login, ...COMMON_CLI_PATHS, path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin")]), TERM: "dumb" }; }
/** Resolves a configured executable name or explicit path without a shell. */
export async function resolveQueryAssistantExecutable(command: string, environment: NodeJS.ProcessEnv = process.env, dependencies: QueryAssistantCliDependencies = {}): Promise<string | undefined> {
  const configured = expandAssistantHome(command.trim());
  if (!configured) { return undefined; }
  if (configured.includes(path.sep)) { return await executable(configured, dependencies) ? configured : undefined; }
  const folders = (environment.PATH || "").split(path.delimiter).filter(Boolean);
  for (const folder of folders) { const candidate = path.join(folder, configured); if (await executable(candidate, dependencies)) { return candidate; } }
  return undefined;
}
/** Returns the restricted terminal environment used by a provider child process. */
export function queryAssistantEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { return { ...environment, NO_COLOR: "1", TERM: "dumb" }; }
/** Runs one bounded local provider request with argv and stdin only. */
export function runQueryAssistantCommand(spec: QueryAssistantCommand, prompt: string, timeout: number, signal: AbortSignal, environment: NodeJS.ProcessEnv = queryAssistantEnvironment(), dependencies: QueryAssistantRunDependencies = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    let child: ChildProcess;
    try { child = (dependencies.spawn ?? spawn)(spec.command, spec.args, { cwd: spec.cwd, detached: process.platform !== "win32", env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(new Error("provider-failed")); return; }
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8"); let stdoutBytes = 0;
    let stdout = ""; let stderr = ""; let stderrTail = ""; let settingsRejected = false; let authentication = false; let settled = false; let timer: unknown;
    const stdoutData = (chunk: Buffer) => { if (settled) { return; } if (stdoutBytes + chunk.length > QUERY_ASSISTANT_LIMITS.output) { finish(new Error("output-too-large")); return; } stdoutBytes += chunk.length; stdout += stdoutDecoder.write(chunk); };
    const stderrData = (chunk: Buffer) => { if (settled) { return; } const text = stderrDecoder.write(chunk); const classified = `${stderrTail}${text}`.toLowerCase(); authentication ||= rejectedAssistantAuthentication(classified); settingsRejected ||= rejectedAssistantSettings(classified); stderrTail = classified.slice(-512); const remaining = QUERY_ASSISTANT_LIMITS.stderr - Buffer.byteLength(stderr); if (remaining > 0) { stderr += text.slice(0, remaining); } };
    const childError = (caught: NodeJS.ErrnoException) => finish(new Error(caught.code === "ENOENT" ? "provider-unavailable" : "provider-failed"));
    const childClose = (code: number | null) => { stdout += stdoutDecoder.end(); stderrDecoder.end(); if (code === 0) { finish(); return; } finish(new Error(settingsRejected ? "unsupported-settings" : authentication ? "authentication" : "provider-failed")); };
    const stdinError = (caught: NodeJS.ErrnoException) => { if (caught.code !== "EPIPE" && !settled) { finish(new Error("provider-failed")); } };
    /** Neutralizes late child errors after terminal completion without retaining data. */
    const ignoreError = () => undefined;
    /** Detaches all data/error listeners so late terminal-path output is inert. */
    const detach = () => { child.stdout?.removeListener("data", stdoutData); child.stderr?.removeListener("data", stderrData); child.removeListener("error", childError); child.removeListener("close", childClose); child.stdin?.removeListener("error", stdinError); child.on("error", ignoreError); child.stdin?.on("error", ignoreError); };
    /** Settles the child exactly once and detaches cancellation timing. */
    const finish = (failure?: Error) => { if (settled) { return; } settled = true; if (failure) { terminateAssistantProcess(child, process.platform !== "win32"); } detach(); if (timer !== undefined) { (dependencies.clearTimer ?? ((value: unknown) => clearTimeout(value as NodeJS.Timeout)))(timer); } signal.removeEventListener("abort", abort); failure ? reject(failure) : resolve(stdout); };
    /** Terminates a child after user cancellation without exposing its output. */
    const abort = () => { finish(new Error("cancelled")); };
    timer = (dependencies.setTimer ?? setTimeout)(() => { finish(new Error("timeout")); }, timeout);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", stdoutData); child.stderr!.on("data", stderrData); child.on("error", childError); child.on("close", childClose); child.stdin!.on("error", stdinError);
    child.stdin!.end(prompt);
  });
}
/** Captures one bounded local help/catalog command without passing any prompt on stdin. */
export function runQueryAssistantMetadataCommand(spec: QueryAssistantMetadataCommand, signal: AbortSignal, environment: NodeJS.ProcessEnv = queryAssistantEnvironment(), dependencies: QueryAssistantMetadataDependencies = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    let child: ChildProcess;
    try { child = (dependencies.spawn ?? spawn)(spec.command, spec.args, { cwd: spec.cwd, detached: process.platform !== "win32", env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new Error("provider-unavailable")); return; }
    const outputDecoder = new StringDecoder("utf8"), errorDecoder = new StringDecoder("utf8"); let bytes = 0;
    let output = ""; let stderr = ""; let settled = false; let timer: unknown;
    const append = (target: "stdout" | "stderr", chunk: Buffer) => { if (settled || bytes + chunk.length > QUERY_ASSISTANT_LIMITS.metadataOutput) { if (!settled) { finish(new Error("output-too-large")); } return; } bytes += chunk.length; if (target === "stdout") { output += outputDecoder.write(chunk); } else { stderr += errorDecoder.write(chunk); } };
    const stdoutData = (chunk: Buffer) => append("stdout", chunk); const stderrData = (chunk: Buffer) => append("stderr", chunk);
    const childError = () => finish(new Error("provider-unavailable")); const childClose = (code: number | null) => { output += outputDecoder.end(); errorDecoder.end(); finish(code === 0 ? undefined : new Error("provider-failed")); };
    /** Neutralizes late metadata errors after terminal completion. */
    const ignoreError = () => undefined;
    /** Detaches metadata listeners after every terminal outcome. */
    const detach = () => { child.stdout?.removeListener("data", stdoutData); child.stderr?.removeListener("data", stderrData); child.removeListener("error", childError); child.removeListener("close", childClose); child.on("error", ignoreError); };
    /** Settles the metadata process exactly once. */
    const finish = (failure?: Error) => { if (settled) { return; } settled = true; if (failure) { terminateAssistantProcess(child, process.platform !== "win32"); } detach(); if (timer !== undefined) { (dependencies.clearTimer ?? ((value: unknown) => clearTimeout(value as NodeJS.Timeout)))(timer); } signal.removeEventListener("abort", abort); failure ? reject(failure) : resolve(output); };
    /** Kills a metadata process after cancellation without retaining output. */
    const abort = () => { finish(new Error("cancelled")); };
    timer = (dependencies.setTimer ?? setTimeout)(() => { finish(new Error("timeout")); }, QUERY_ASSISTANT_LIMITS.metadataTimeout);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", stdoutData); child.stderr!.on("data", stderrData); child.on("error", childError); child.on("close", childClose);
  });
}
