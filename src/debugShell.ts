// Debugpy bootstrap helpers for attaching VS Code to the live Django shell.

export const DEBUGPY_MARKER_PREFIX = "__DJANGO_SHELL_DEBUGPY__";

export interface DebugpyEndpoint {
  host: string;
  inProcess?: boolean;
  port: number;
  reused: boolean;
}

export interface DebugpyBootstrapResult {
  endpoint?: DebugpyEndpoint;
  error?: string;
  ok: boolean;
}

export interface DebugpyAttachOptions {
  connectHost?: string;
  connectPort?: number;
  listenHost: string;
  listenHostConfigured?: boolean;
  listenPort: number;
  remoteRoot?: string;
}

export interface DebugpySettingsReader {
  /** Reads one debugger setting with a fallback value. */
  get<T>(section: string, defaultValue: T): T;
  /** Returns VS Code configuration inspection metadata when available. */
  inspect?<T>(section: string): { defaultValue?: T; globalValue?: T; workspaceFolderValue?: T; workspaceValue?: T } | undefined;
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

/** Builds Python code that starts debugpy once and prints a parseable endpoint marker. */
export function buildDebugpyBootstrapCode(host: string, port: number, marker = DEBUGPY_MARKER_PREFIX, searchPaths: string[] = []): string {
  return [
    "import json as _djs_debug_json",
    "import os as _djs_debug_os",
    "import socket as _djs_debug_socket",
    "import sys as _djs_debug_sys",
    "try:",
    "    _djs_debug_endpoint = globals().get('_django_shell_debugpy_endpoint')",
    "    _djs_debug_in_process = bool(globals().get('_django_shell_debugpy_in_process'))",
    "    if not _djs_debug_endpoint:",
    `        _djs_debug_paths = ${pythonStringArray(searchPaths)}`,
    "        _djs_debug_os.environ.setdefault('PYDEVD_DISABLE_FILE_VALIDATION', '1')",
        "        try:",
        "            import debugpy as _djs_debugpy",
        "        except Exception:",
    "            for _djs_debug_path in _djs_debug_paths:",
    "                if _djs_debug_path and _djs_debug_path not in _djs_debug_sys.path:",
    "                    _djs_debug_sys.path.insert(0, _djs_debug_path)",
    "            import debugpy as _djs_debugpy",
    `        _djs_debug_host = ${pythonString(host)}`,
    `        _djs_debug_port = ${port}`,
    "        _djs_debug_requested = (_djs_debug_host, _djs_debug_port)",
    "        try:",
    "            _djs_debug_listen_result = _djs_debugpy.listen(_djs_debug_requested)",
    "        except RuntimeError as _djs_debug_listen_error:",
    "            if 'timed out waiting for adapter to connect' not in str(_djs_debug_listen_error):",
    "                raise",
    "            _djs_debug_in_process = True",
    "            if not _djs_debug_port:",
    "                _djs_debug_probe = _djs_debug_socket.socket()",
    "                try:",
    "                    _djs_debug_probe.bind((_djs_debug_host, 0))",
    "                    _djs_debug_port = int(_djs_debug_probe.getsockname()[1])",
    "                finally:",
    "                    _djs_debug_probe.close()",
    "                _djs_debug_requested = (_djs_debug_host, _djs_debug_port)",
    "            _djs_debug_listen_result = _djs_debugpy.listen(_djs_debug_requested, in_process_debug_adapter=True)",
    "        if isinstance(_djs_debug_listen_result, (list, tuple)) and len(_djs_debug_listen_result) >= 2:",
    "            _djs_debug_endpoint = (_djs_debug_listen_result[0] or _djs_debug_host, int(_djs_debug_listen_result[1]))",
    "        else:",
    "            _djs_debug_endpoint = _djs_debug_requested",
    "        globals()['_django_shell_debugpy_endpoint'] = _djs_debug_endpoint",
    "        globals()['_django_shell_debugpy_in_process'] = _djs_debug_in_process",
    "        _djs_debug_reused = False",
    "    else:",
    "        import debugpy as _djs_debugpy",
    "        _djs_debug_reused = True",
    "    if hasattr(_djs_debugpy, 'breakpoint'):",
    "        _djs_debug_os.environ['PYTHONBREAKPOINT'] = 'debugpy.breakpoint'",
    "        _djs_debug_sys.breakpointhook = _djs_debugpy.breakpoint",
    `    print(${pythonString(marker)} + _djs_debug_json.dumps({"ok": True, "host": _djs_debug_endpoint[0], "inProcess": _djs_debug_in_process, "port": _djs_debug_endpoint[1], "reused": _djs_debug_reused}))`,
    "except Exception as _djs_debug_error:",
    `    print(${pythonString(marker)} + _djs_debug_json.dumps({"ok": False, "error": repr(_djs_debug_error)}))`
  ].join("\n");
}

/** Reads debugger attach settings without depending on VS Code types in this helper module. */
export function readDjangoShellDebugOptions(configuration: DebugpySettingsReader): DebugpyAttachOptions {
  return {
    connectHost: stringSetting(configuration.get("connectHost", "")),
    connectPort: normalizeDebugpyPort(configuration.get("connectPort", 0)),
    listenHost: stringSetting(configuration.get("listenHost", "127.0.0.1")) || "127.0.0.1",
    listenHostConfigured: configuredSetting(configuration, "listenHost"),
    listenPort: normalizeDebugpyPort(configuration.get("listenPort", 0)),
    remoteRoot: stringSetting(configuration.get("remoteRoot", ""))
  };
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
    const endpoint: DebugpyEndpoint = { host: parsed.host, port: parsed.port, reused: Boolean(parsed.reused) };
    if (parsed.inProcess !== undefined) {
      endpoint.inProcess = Boolean(parsed.inProcess);
    }
    return { endpoint, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** Builds the VS Code Python debug attach configuration for a shell debugpy endpoint. */
export function buildDjangoShellDebugConfiguration(endpoint: DebugpyEndpoint, cwd: string, options?: Partial<DebugpyAttachOptions>): DjangoShellDebugConfiguration {
  const connectHost = options?.connectHost || connectableDebugHost(endpoint.host);
  const connectPort = options?.connectPort || endpoint.port;
  const remoteRoot = options?.remoteRoot || cwd;
  return {
    connect: { host: connectHost, port: connectPort },
    cwd,
    django: true,
    justMyCode: false,
    name: "Django Shell",
    pathMappings: [{ localRoot: cwd, remoteRoot }],
    request: "attach",
    type: "python"
  };
}

/** Returns the host passed to debugpy.listen(), widening only for explicit remote attach hosts. */
export function effectiveDebugpyListenHost(options: DebugpyAttachOptions): string {
  if (!options.listenHostConfigured && options.connectHost && isLoopbackDebugHost(options.listenHost) && !isLocalAttachHost(options.connectHost)) {
    return "0.0.0.0";
  }
  return options.listenHost;
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** Encodes JavaScript strings as a Python list literal. */
function pythonStringArray(values: string[]): string {
  return `[${values.map((value) => pythonString(value)).join(", ")}]`;
}

/** Normalizes one debugger host value from config. */
function stringSetting(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalizes one debugger port value, using zero to mean "let debugpy choose". */
function normalizeDebugpyPort(value: unknown): number {
  const port = Math.floor(Number(value));
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 0;
}

/** Returns whether a setting has a user or workspace override. */
function configuredSetting(configuration: DebugpySettingsReader, section: string): boolean {
  const inspected = configuration.inspect?.(section);
  return Boolean(inspected && (inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
}

/** Converts listen-any addresses into a client-connectable loopback host. */
function connectableDebugHost(host: string): string {
  const value = stringSetting(host) || "127.0.0.1";
  return value === "0.0.0.0" || value === "::" ? "127.0.0.1" : value;
}

/** Returns whether a host is a local loopback interface. */
function isLoopbackDebugHost(host: string): boolean {
  const value = normalizedHost(host);
  return value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){0,3}$/.test(value);
}

/** Returns whether a connect host points at this machine rather than a remote server. */
function isLocalAttachHost(host: string): boolean {
  const value = normalizedHost(host);
  return isLoopbackDebugHost(value) || value === "0.0.0.0" || value === "::";
}

/** Normalizes one host string for local/remote classification. */
function normalizedHost(host: string): string {
  return stringSetting(host).toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}
