// SSH port-forward helpers for remote Django shell debugging.
import { spawn, type ChildProcessByStdio } from "child_process";
import * as net from "net";
import type { Readable } from "stream";
import type { DiagnosticLogger } from "./diagnostics";

export interface SshExecTarget {
  args: string[];
  destination: string;
}

export interface SshPortForward {
  dispose(): void;
  host: string;
  port: number;
}

/** Parses a submitted ssh command into a reusable forwarding target. */
export function parseSshExecTarget(command: string): SshExecTarget | undefined {
  const tokens = shellWords(command);
  const ssh = tokens.findIndex((token) => token === "ssh" || token.endsWith("/ssh"));
  if (ssh < 0) { return undefined; }
  const args = tokens.slice(ssh + 1);
  const destinationIndex = sshDestinationIndex(args);
  if (destinationIndex < 0) { return undefined; }
  const destination = args[destinationIndex];
  if (!destination || destination.startsWith("-")) { return undefined; }
  return { args: args.slice(0, destinationIndex), destination };
}

/** Starts an SSH local port-forward to a remote debugpy port. */
export async function startSshPortForward(target: SshExecTarget, remotePort: number, logger?: DiagnosticLogger): Promise<SshPortForward> {
  const localPort = await freeLocalPort();
  const args = sshPortForwardArgs(target, localPort, remotePort);
  const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
  logger?.log("debug.ssh.portForward.start", { args: args.join(" "), destination: target.destination, localPort, remotePort });
  await waitForSshPortForward(child, localPort, logger);
  return { dispose: () => child.kill(), host: "127.0.0.1", port: localPort };
}

/** Builds ssh local port-forward arguments for tests and process spawning. */
export function sshPortForwardArgs(target: SshExecTarget, localPort: number, remotePort: number): string[] {
  return [...target.args, "-o", "ExitOnForwardFailure=yes", "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, target.destination];
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

/** Returns the token index for the ssh destination argument. */
function sshDestinationIndex(args: string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") { return index + 1 < args.length ? index + 1 : -1; }
    if (token === "-W") { return -1; }
    if (sshOptionConsumesNext(token)) { index += 1; continue; }
    if (sshOptionConsumesInlineValue(token)) { continue; }
    if (token.startsWith("-")) { continue; }
    return index;
  }
  return -1;
}

/** Returns whether one ssh option consumes the following argv token. */
function sshOptionConsumesNext(token: string): boolean {
  return ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-w"].includes(token);
}

/** Returns whether one ssh option already carries its value in the same argv token. */
function sshOptionConsumesInlineValue(token: string): boolean {
  return /^-[bcDEeFIiJLlmOoOpQRSWw].+/.test(token);
}

/** Finds an available local loopback port for ssh port-forward. */
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

/** Waits until the SSH process stays alive long enough for ExitOnForwardFailure to catch bind failures. */
function waitForSshPortForward(child: ChildProcessByStdio<null, Readable, Readable>, localPort: number, logger?: DiagnosticLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false, output = "";
    const timer = setTimeout(() => { logger?.log("debug.ssh.portForward.ready", { localPort, output }); finish(); }, 1200);
    const finish = (error?: Error): void => {
      if (done) { return; }
      done = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else { resolve(); }
    };
    const collect = (chunk: Buffer): void => { output = `${output}${chunk.toString("utf8")}`.slice(-1200); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => finish(new Error(`ssh port-forward exited before ready: code=${code ?? ""} signal=${signal ?? ""} ${output}`)));
  });
}
