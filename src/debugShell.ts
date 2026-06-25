// Debugpy bootstrap helpers for attaching VS Code to the live Django shell.

import * as net from "net";

export const DEBUGPY_MARKER_PREFIX = "__DJANGO_SHELL_DEBUGPY__";

export interface DebugpyEndpoint {
  host: string;
  port: number;
  reused: boolean;
}

export interface DebugpyBootstrapResult {
  endpoint?: DebugpyEndpoint;
  error?: string;
  ok: boolean;
}

export interface DjangoShellDebugConfiguration {
  connect: {
    host: string;
    port: number;
  };
  cwd: string;
  django: boolean;
  justMyCode: boolean;
  name: string;
  pathMappings: Array<{
    localRoot: string;
    remoteRoot: string;
  }>;
  request: "attach";
  type: "python";
}

/** Finds a currently free loopback port for debugpy to bind inside the shell. */
export function findAvailableLoopbackPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

/** Builds Python code that starts debugpy once and prints a parseable endpoint marker. */
export function buildDebugpyBootstrapCode(host: string, port: number, marker = DEBUGPY_MARKER_PREFIX, searchPaths: string[] = []): string {
  return [
    "import json as _djs_debug_json",
    "import os as _djs_debug_os",
    "import sys as _djs_debug_sys",
    "try:",
    "    _djs_debug_endpoint = globals().get('_django_shell_debugpy_endpoint')",
    "    if not _djs_debug_endpoint:",
    `        _djs_debug_paths = ${pythonStringArray(searchPaths)}`,
        "        try:",
        "            import debugpy as _djs_debugpy",
        "        except Exception:",
    "            for _djs_debug_path in _djs_debug_paths:",
    "                if _djs_debug_path and _djs_debug_path not in _djs_debug_sys.path:",
    "                    _djs_debug_sys.path.insert(0, _djs_debug_path)",
    "            import debugpy as _djs_debugpy",
    `        _djs_debug_host = ${pythonString(host)}`,
    `        _djs_debug_port = ${port}`,
    "        _djs_debugpy.listen((_djs_debug_host, _djs_debug_port))",
    "        _djs_debug_endpoint = (_djs_debug_host, _djs_debug_port)",
    "        globals()['_django_shell_debugpy_endpoint'] = _djs_debug_endpoint",
    "        _djs_debug_reused = False",
    "    else:",
    "        import debugpy as _djs_debugpy",
    "        _djs_debug_reused = True",
    "    if hasattr(_djs_debugpy, 'breakpoint'):",
    "        _djs_debug_os.environ['PYTHONBREAKPOINT'] = 'debugpy.breakpoint'",
    "        _djs_debug_sys.breakpointhook = _djs_debugpy.breakpoint",
    `    print(${pythonString(marker)} + _djs_debug_json.dumps({"ok": True, "host": _djs_debug_endpoint[0], "port": _djs_debug_endpoint[1], "reused": _djs_debug_reused}))`,
    "except Exception as _djs_debug_error:",
    `    print(${pythonString(marker)} + _djs_debug_json.dumps({"ok": False, "error": repr(_djs_debug_error)}))`
  ].join("\n");
}

/** Parses the marker emitted by the debugpy bootstrap code. */
export function parseDebugpyBootstrapResult(output: string, marker = DEBUGPY_MARKER_PREFIX): DebugpyBootstrapResult {
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) {
    return { error: "debugpy did not return an endpoint. Install debugpy in the active Python environment and try again.", ok: false };
  }
  const line = output.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0]?.trim() ?? "";
  try {
    const parsed = JSON.parse(line) as Partial<DebugpyEndpoint> & { error?: string; ok?: boolean };
    if (!parsed.ok) {
      return { error: parsed.error ?? "debugpy failed to start.", ok: false };
    }
    if (typeof parsed.host !== "string" || typeof parsed.port !== "number" || parsed.port <= 0) {
      return { error: "debugpy returned an invalid endpoint.", ok: false };
    }
    return { endpoint: { host: parsed.host, port: parsed.port, reused: Boolean(parsed.reused) }, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** Builds the VS Code Python debug attach configuration for a shell debugpy endpoint. */
export function buildDjangoShellDebugConfiguration(endpoint: DebugpyEndpoint, cwd: string): DjangoShellDebugConfiguration {
  return {
    connect: { host: endpoint.host, port: endpoint.port },
    cwd,
    django: true,
    justMyCode: false,
    name: "Django Shell",
    pathMappings: [{ localRoot: cwd, remoteRoot: cwd }],
    request: "attach",
    type: "python"
  };
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** Encodes JavaScript strings as a Python list literal. */
function pythonStringArray(values: string[]): string {
  return `[${values.map((value) => pythonString(value)).join(", ")}]`;
}
