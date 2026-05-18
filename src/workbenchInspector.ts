// Locates and probes the VS Code Electron main-process Node inspector.

import { execFileSync } from "child_process";
import * as http from "http";
import WebSocket from "ws";

interface InspectorCdpResponse {
  id?: number;
  result?: { result?: { value?: unknown } };
}

const DEFAULT_INSPECTOR_PORT = 9229;

/** Finds the VS Code main process in this extension host's parent chain. */
export function findMainPid(): number | undefined {
  try {
    const out = execFileSync("/bin/ps", ["-o", "pid=,ppid=,command=", "-ax"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    const processes = parseProcesses(out);
    let cursor = process.pid;
    const visited = new Set<number>();
    while (cursor > 0 && !visited.has(cursor)) {
      visited.add(cursor);
      const proc = processes.get(cursor);
      if (!proc) {
        break;
      }
      if (isVscodeMainProcessCommand(proc.command)) {
        return proc.pid;
      }
      cursor = proc.ppid;
    }
    const parent = processes.get(process.ppid);
    return parent && isVscodeMainProcessCommand(parent.command) ? parent.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Polls the default inspector range until a WebSocket URL appears for one process. */
export async function waitForInspectorUrlForPid(pid: number): Promise<{ attempts: number; url?: string }> {
  let attempts = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await findInspectorUrlForPid(pid, 1);
    attempts += found.attempts;
    if (found.url) {
      return { attempts, url: found.url };
    }
    await delay(100);
  }
  return { attempts };
}

/** Finds the Node inspector WebSocket URL owned by one process id. */
export async function findInspectorUrlForPid(pid: number, rounds = 40): Promise<{ attempts: number; url?: string }> {
  let attempts = 0;
  const wrongTargets = new Set<string>();
  for (let round = 0; round < rounds; round++) {
    for (let port = DEFAULT_INSPECTOR_PORT; port < DEFAULT_INSPECTOR_PORT + 40; port++) {
      const urls = await inspectorUrlsAtPort(port);
      attempts += 1;
      for (const url of urls) {
        if (wrongTargets.has(url)) {
          continue;
        }
        const owner = await inspectorProcessId(url);
        if (owner === pid) {
          return { attempts, url };
        }
        if (owner !== undefined) {
          wrongTargets.add(url);
        }
      }
    }
    await delay(25);
  }
  return { attempts };
}

/** Parses ps output into a process table. */
function parseProcesses(output: string): Map<number, { command: string; pid: number; ppid: number }> {
  const processes = new Map<number, { command: string; pid: number; ppid: number }>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      processes.set(pid, { command: match[3], pid, ppid });
    }
  }
  return processes;
}

/** Returns true when a process command looks like the Electron main process. */
function isVscodeMainProcessCommand(command: string): boolean {
  if (/Helper(?:\.app|\s|\))/.test(command)) {
    return false;
  }
  return [
    /\/Visual Studio Code\.app\/Contents\/MacOS\/(?:Electron|Code)(?:\s|$)/,
    /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\/(?:Electron|Code - Insiders)(?:\s|$)/,
    /\/VSCodium\.app\/Contents\/MacOS\/(?:Electron|VSCodium)(?:\s|$)/,
    /\/Code - OSS\.app\/Contents\/MacOS\/(?:Electron|Code - OSS)(?:\s|$)/,
    /\/Cursor\.app\/Contents\/MacOS\/Cursor(?:\s|$)/,
    /\/Windsurf\.app\/Contents\/MacOS\/Windsurf(?:\s|$)/,
    /\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/
  ].some((pattern) => pattern.test(command));
}

/** Reads the inspector target list for one localhost port. */
async function inspectorUrlsAtPort(port: number): Promise<string[]> {
  try {
    const text = await httpGet(`http://127.0.0.1:${port}/json/list`);
    const targets = JSON.parse(text) as Array<{ webSocketDebuggerUrl?: string }>;
    return targets.map((target) => target.webSocketDebuggerUrl).filter((url): url is string => Boolean(url));
  } catch {
    return [];
  }
}

/** Returns the process id exposed by one Node inspector target. */
async function inspectorProcessId(url: string): Promise<number | undefined> {
  const value = await evaluateInspectorExpression(url, "typeof process !== 'undefined' ? process.pid : 0", 350);
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/** Evaluates one small expression in an inspector target. */
function evaluateInspectorExpression(url: string, expression: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | undefined;
    const done = (value: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // The probe socket may already be closed.
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    try {
      socket = new WebSocket(url);
      socket.on("open", () => {
        socket?.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(String(data)) as InspectorCdpResponse;
          if (message.id === 1) {
            done(message.result?.result?.value);
          }
        } catch {
          done(undefined);
        }
      });
      socket.on("error", () => done(undefined));
      socket.on("close", () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}

/** Fetches one local HTTP URL as text. */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 250 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout: ${url}`));
    });
  });
}

/** Waits without blocking the extension host event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
