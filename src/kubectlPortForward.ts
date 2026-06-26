// Kubernetes port-forward helpers for remote Django shell debugging.

import { spawn, type ChildProcessByStdio } from "child_process";
import * as net from "net";
import type { Readable } from "stream";
import type { DiagnosticLogger } from "./diagnostics";

export interface KubectlExecTarget {
  context?: string;
  namespace?: string;
  resource: string;
}

export interface KubectlPortForward {
  dispose(): void;
  host: string;
  port: number;
}

/** Parses a submitted kubectl exec command into a target usable by kubectl port-forward. */
export function parseKubectlExecTarget(command: string): KubectlExecTarget | undefined {
  const tokens = shellWords(command);
  const kubectl = tokens.findIndex((token) => token === "kubectl" || token.endsWith("/kubectl"));
  if (kubectl < 0) { return undefined; }
  const exec = tokens.indexOf("exec", kubectl + 1);
  if (exec < 0) { return undefined; }
  const target: Partial<KubectlExecTarget> = {};
  readKubectlFlagScope(tokens.slice(kubectl + 1, exec), target);
  const resource = readExecResource(tokens.slice(exec + 1), target);
  return resource ? { context: target.context, namespace: target.namespace, resource: normalizeResource(resource) } : undefined;
}

/** Starts kubectl port-forward for a debugpy port and resolves when kubectl reports readiness. */
export async function startKubectlPortForward(target: KubectlExecTarget, remotePort: number, logger?: DiagnosticLogger): Promise<KubectlPortForward> {
  const localPort = await freeLocalPort();
  const args = kubectlPortForwardArgs(target, localPort, remotePort);
  const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
  logger?.log("debug.kubectl.portForward.start", { args: args.join(" "), localPort, remotePort, resource: target.resource });
  await waitForPortForward(child, logger);
  return { dispose: () => child.kill(), host: "127.0.0.1", port: localPort };
}

/** Builds kubectl port-forward arguments for tests and process spawning. */
export function kubectlPortForwardArgs(target: KubectlExecTarget, localPort: number, remotePort: number): string[] {
  const args: string[] = [];
  if (target.context) { args.push("--context", target.context); }
  if (target.namespace) { args.push("--namespace", target.namespace); }
  args.push("port-forward", target.resource, `${localPort}:${remotePort}`);
  return args;
}

/** Reads shell words with simple quote and backslash handling. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "", quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && index + 1 < command.length) { current += command[index + 1]; index += 1; continue; }
    if (quote) { if (char === quote) { quote = ""; } else { current += char; } continue; }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { words.push(current); current = ""; } continue; }
    current += char;
  }
  if (current) { words.push(current); }
  return words;
}

/** Reads namespace and context flags from kubectl global arguments. */
function readKubectlFlagScope(tokens: string[], target: Partial<KubectlExecTarget>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    index = readScopedFlag(tokens, index, target);
  }
}

/** Reads the exec target resource while skipping exec-only flags. */
function readExecResource(tokens: string[], target: Partial<KubectlExecTarget>): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") { return undefined; }
    const next = readScopedFlag(tokens, index, target);
    if (next !== index) { index = next; continue; }
    if (token === "-i" || token === "-t" || token === "-it" || token === "-ti" || token === "--stdin" || token === "--tty") { continue; }
    if (token === "-c" || token === "--container") { index += 1; continue; }
    if (token.startsWith("--container=") || token.startsWith("-c")) { continue; }
    if (!token.startsWith("-")) { return token; }
  }
  return undefined;
}

/** Reads namespace/context flags and returns the consumed token index. */
function readScopedFlag(tokens: string[], index: number, target: Partial<KubectlExecTarget>): number {
  const token = tokens[index];
  if (token === "-n" || token === "--namespace") { target.namespace = tokens[index + 1]; return index + 1; }
  if (token.startsWith("--namespace=")) { target.namespace = token.slice("--namespace=".length); return index; }
  if (token.startsWith("-n") && token.length > 2) { target.namespace = token.slice(2); return index; }
  if (token === "--context") { target.context = tokens[index + 1]; return index + 1; }
  if (token.startsWith("--context=")) { target.context = token.slice("--context=".length); return index; }
  return index;
}

/** Normalizes a bare kubectl exec pod name into a port-forward resource. */
function normalizeResource(resource: string): string {
  return resource.includes("/") ? resource : `pod/${resource}`;
}

/** Finds an available local loopback port for kubectl port-forward. */
function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("No local port was allocated.")));
    });
  });
}

/** Waits until kubectl reports a forwarding line or exits with an error. */
function waitForPortForward(child: ChildProcessByStdio<null, Readable, Readable>, logger?: DiagnosticLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false, output = "";
    const timer = setTimeout(() => finish(new Error(`kubectl port-forward did not become ready. ${output}`)), 8000);
    const finish = (error?: Error): void => {
      if (done) { return; }
      done = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else { resolve(); }
    };
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-1200);
      if (/Forwarding from /.test(output)) { logger?.log("debug.kubectl.portForward.ready", { output }); finish(); }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => finish(new Error(`kubectl port-forward exited before ready: code=${code ?? ""} signal=${signal ?? ""} ${output}`)));
  });
}
