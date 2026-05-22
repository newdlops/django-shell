// Embedded PTY session for the setup cell inside a Django shell console notebook.

import { randomBytes } from "crypto";
import * as pty from "node-pty";
import * as vscode from "vscode";
import { SerializedAsyncQueue } from "./asyncQueue";
import { BackendClient, BackendRequestPayload } from "./backendClient";
import { BACKEND_RESPONSE_PREFIX, buildBackendBootstrapCommand, parseBackendFailedMarker, parseBackendReadyMarker, parseBackendResponseMarker } from "./backendBootstrap";
import { DiagnosticLogger } from "./diagnostics";
import { buildShellEnv } from "./env";
import { ensureNodePtyHelperExecutable } from "./ptyHelper";
import { getShellLaunch } from "./shellLaunch";
import { DjangoTerminalMode, InputLineTracker, detectPrimaryPythonPrompt, isDjangoShellCommand, nextModeForOutput, nextModeForSubmittedLine } from "./terminalState";

const KEEPALIVE_IDLE_MS = 45000; const KEEPALIVE_INTERVAL_MS = 30000; const KEEPALIVE_USER_IDLE_MS = 15000; const PTY_REQUEST_TIMEOUT_MS = 90000;

export interface NotebookPtyOptions {
  autoActivateWorkspaceVenv: boolean;
  backendRuntimePath: string;
  cwd: string;
  diagnosticLogger?: DiagnosticLogger;
  djangoSettingsModule?: string;
  sessionId: string;
  settingsCandidates?: string[];
}

export interface NotebookTerminalSnapshot {
  mode: DjangoTerminalMode;
  ready: boolean;
  secretPrompt: boolean;
  selectedSettingsModule: string;
  sessionId: string;
  settingsCandidates: string[];
  state: string;
  text: string;
}

/** Runs a shell in node-pty and attaches the Django backend after a Python prompt appears. */
export class NotebookPtySession implements vscode.Disposable {
  private client: BackendClient | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<NotebookTerminalSnapshot>();
  private readonly dataEmitter = new vscode.EventEmitter<string>();
  private displayText = "";
  private generation = 0;
  private inputTracker = new InputLineTracker();
  private keepaliveInFlight = false;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private lastDjangoCommandAt = 0;
  private lastOutputAt = 0; private lastPrimaryPromptAt = 0; private lastTerminalInputAt = 0;
  private mode: DjangoTerminalMode = "shell";
  private outputTail = "";
  private process: pty.IPty | undefined;
  private readonly ptyQueue = new SerializedAsyncQueue();
  private readonly ptyRequests = new Map<string, { reject: (error: Error) => void; resolve: (buffer: string) => void; timer: NodeJS.Timeout }>();
  private ptyRequestBuffer = "";
  private ptyRequestSeq = 1;
  private spawnedAt = 0;
  private started = false;
  private state = "starting";
  private suppressBackendOutput = false;
  private token = "";

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidData = this.dataEmitter.event;

  /** Stores launch options for the embedded notebook terminal. */
  constructor(private readonly options: NotebookPtyOptions) {}

  /** Returns the backend client when Django shell attachment has completed. */
  get backend(): BackendClient | undefined {
    return this.client;
  }

  /** Starts the interactive login shell used for setup prompts. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const now = Date.now();
    this.spawnedAt = now;
    this.lastOutputAt = now;
    this.lastPrimaryPromptAt = 0;
    this.lastTerminalInputAt = 0;
    ensureNodePtyHelperExecutable();
    const launch = getShellLaunch();
    const env = buildShellEnv(this.options.cwd, {
      autoActivateWorkspaceVenv: this.options.autoActivateWorkspaceVenv,
      djangoSettingsModule: this.options.djangoSettingsModule
    });
    this.options.diagnosticLogger?.log("terminal.spawn", {
      cwd: this.options.cwd,
      djangoSettingsModule: env.DJANGO_SETTINGS_MODULE,
      djangoSettingsSelected: this.options.djangoSettingsModule,
      pathHead: firstPathEntry(env.PATH),
      shell: launch.file,
      shellArgs: launch.args.join(" "),
      virtualEnv: env.VIRTUAL_ENV
    });
    const generation = ++this.generation;
    this.process = pty.spawn(launch.file, launch.args, {
      cols: 100,
      cwd: this.options.cwd,
      env,
      name: "xterm-256color",
      rows: 30
    });
    this.process.onData((data) => {
      if (generation === this.generation) {
        this.handleOutput(data);
      }
    });
    this.process.onExit((event) => {
      if (generation !== this.generation) {
        return;
      }
      this.suppressBackendOutput = false;
      this.stopKeepalive();
      this.rejectPtyRequests("Django shell PTY process exited.");
      this.state = this.client ? "ready" : "closed";
      this.options.diagnosticLogger?.log("terminal.exit", {
        exitCode: event.exitCode,
        sessionId: this.options.sessionId,
        signal: event.signal,
        state: this.state
      });
      this.fireChange();
    });
    this.fireChange();
  }

  /** Writes renderer input to the embedded PTY. */
  write(data: string): void {
    if (data) {
      this.lastTerminalInputAt = Date.now();
    }
    this.trackInput(data);
    this.process?.write(data);
  }

  /** Updates the settings module shown in the notebook setup UI. */
  setDjangoSettingsModule(value: string | undefined): void {
    this.options.djangoSettingsModule = value;
    this.fireChange();
  }

  /** Updates settings candidates shown by the setup renderer after async discovery. */
  setSettingsCandidates(values: string[]): void {
    this.options.settingsCandidates = values;
    this.fireChange();
  }

  /** Restarts the embedded PTY so environment-only settings changes take effect. */
  restart(): void {
    if (!this.started) {
      this.fireChange();
      return;
    }
    this.options.diagnosticLogger?.log("terminal.restart", {
      djangoSettingsSelected: this.options.djangoSettingsModule,
      sessionId: this.options.sessionId
    });
    const previous = this.process;
    this.generation += 1;
    this.resetRuntimeState();
    previous?.kill();
    this.start();
  }

  /** Resizes the embedded PTY to match the notebook renderer terminal. */
  resize(columns: number, rows: number): void {
    this.process?.resize(columns, rows);
  }

  /** Stops the embedded PTY and releases listeners. */
  dispose(): void {
    this.generation += 1;
    this.stopKeepalive();
    this.process?.kill();
    this.rejectPtyRequests("Django shell PTY session disposed.");
    this.dataEmitter.dispose();
    this.changeEmitter.dispose();
  }

  /** Returns the latest renderable terminal state. */
  snapshot(): NotebookTerminalSnapshot {
    return { mode: this.mode, ready: Boolean(this.client), secretPrompt: isSecretPrompt(this.displayText), selectedSettingsModule: this.options.djangoSettingsModule ?? "", sessionId: this.options.sessionId, settingsCandidates: this.options.settingsCandidates ?? [], state: this.state, text: trimTerminalText(this.displayText) };
  }

  /** Processes PTY output, detects prompts, and attaches the backend once. */
  private handleOutput(data: string): void {
    this.lastOutputAt = Date.now();
    const previousMode = this.mode;
    const suppressVisible = this.suppressBackendOutput || this.ptyRequests.size > 0;
    this.outputTail = `${this.outputTail}${data}`.slice(-4000);
    if (detectPrimaryPythonPrompt(this.outputTail)) {
      this.lastPrimaryPromptAt = this.lastOutputAt;
    }
    if (this.ptyRequests.size) {
      this.ptyRequestBuffer = `${this.ptyRequestBuffer}${data}`.slice(-1_250_000);
      this.inspectPtyResponses();
    }
    this.mode = nextModeForOutput(this.mode, this.outputTail);
    if (this.mode === "unknown-python") {
      this.mode = "django";
    }
    this.logModeTransition(previousMode);
    if (this.mode === "django" && !this.token) {
      this.attachBackend();
    }
    this.inspectMarkers();
    const visibleData = suppressVisible ? "" : data;
    if (visibleData) {
      this.displayText = `${this.displayText}${visibleData}`.slice(-16000);
      this.dataEmitter.fire(visibleData);
    }
    this.fireChange();
  }

  /** Injects the backend bootstrap command into the detected Python shell. */
  private attachBackend(): void {
    this.state = "attaching";
    this.token = randomBytes(16).toString("hex");
    const bootstrap = buildBackendBootstrapCommand(this.options.backendRuntimePath, this.token);
    this.options.diagnosticLogger?.log("backend.attach", {
      bootstrapBytes: bootstrap.bytes,
      bootstrapMode: bootstrap.mode,
      remoteName: vscode.env.remoteName,
      runtimePath: this.options.backendRuntimePath,
      sinceDjangoCommandMs: this.lastDjangoCommandAt ? Date.now() - this.lastDjangoCommandAt : undefined,
      sinceSpawnMs: Date.now() - this.spawnedAt,
      sessionId: this.options.sessionId
    });
    this.suppressBackendOutput = true;
    this.process?.write(bootstrap.command);
  }

  /** Parses backend ready or failed markers from recent PTY output. */
  private inspectMarkers(): void {
    if (this.client) {
      return;
    }
    const ready = parseBackendReadyMarker(this.outputTail);
    if (ready && ready.token === this.token) {
      this.suppressBackendOutput = false;
      this.client = new BackendClient(ready, this.options.diagnosticLogger, (payload) => this.requestViaPty(payload));
      this.state = "ready";
      this.startKeepalive();
      this.options.diagnosticLogger?.log("backend.ready", {
        host: ready.host,
        port: ready.port,
        sessionId: this.options.sessionId
      });
      return;
    }
    const failed = parseBackendFailedMarker(this.outputTail);
    if (failed) {
      this.suppressBackendOutput = false;
      this.state = "failed";
      this.displayText = `${this.displayText}\n${failed}`;
      this.options.diagnosticLogger?.log("backend.failed", {
        error: failed,
        sessionId: this.options.sessionId
      });
    }
  }

  /** Sends a backend request through the interactive PTY when TCP loopback is unreachable. */
  private requestViaPty(payload: BackendRequestPayload): Promise<string> {
    const queuedAt = Date.now();
    return this.ptyQueue.run("backend", () => new Promise<string>((resolve, reject) => {
      const started = Date.now();
      if (!this.process) {
        reject(new Error("Django shell PTY is not running."));
        return;
      }
      const id = `${Date.now().toString(36)}-${this.ptyRequestSeq++}`;
      const timer = setTimeout(() => {
        this.ptyRequests.delete(id);
        this.options.diagnosticLogger?.log("backend.pty.timeout", {
          id,
          kind: payload.kind,
          ms: Date.now() - started,
          sessionId: this.options.sessionId,
          timeoutMs: PTY_REQUEST_TIMEOUT_MS
        });
        reject(new Error(`Timed out waiting for Django shell backend PTY response after ${PTY_REQUEST_TIMEOUT_MS}ms.`));
      }, PTY_REQUEST_TIMEOUT_MS);
      this.ptyRequestBuffer = "";
      this.ptyRequests.set(id, { reject, resolve, timer });
      this.options.diagnosticLogger?.log("backend.pty.request", {
        id,
        kind: payload.kind,
        lightweight: payload.lightweight,
        queueMs: started - queuedAt,
        sessionId: this.options.sessionId
      });
      this.process.write(buildPtyBackendRequest(id, payload, this.token));
    }));
  }

  /** Starts conservative runtime keepalive probes after backend attachment. */
  private startKeepalive(): void {
    if (this.keepaliveTimer) {
      return;
    }
    this.keepaliveTimer = setInterval(() => this.runKeepalive(), KEEPALIVE_INTERVAL_MS);
  }

  /** Stops runtime keepalive probes for closed or restarting sessions. */
  private stopKeepalive(): void {
    if (!this.keepaliveTimer) {
      return;
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    this.keepaliveInFlight = false;
  }

  /** Sends a hidden lightweight request only when the Python prompt is idle. */
  private runKeepalive(): void {
    const backend = this.client;
    const now = Date.now();
    if (!backend || !this.process || this.mode !== "django" || this.keepaliveInFlight || this.ptyRequests.size > 0) {
      return;
    }
    if (!this.lastPrimaryPromptAt || this.lastPrimaryPromptAt < this.lastTerminalInputAt) {
      return;
    }
    if (now - this.lastOutputAt < KEEPALIVE_IDLE_MS || now - this.lastTerminalInputAt < KEEPALIVE_USER_IDLE_MS) {
      return;
    }
    this.keepaliveInFlight = true;
    const started = Date.now();
    void backend.environment().then((result) => {
      this.options.diagnosticLogger?.log("backend.keepalive", {
        idleMs: started - this.lastOutputAt,
        ms: Date.now() - started,
        ok: result.ok,
        sessionId: this.options.sessionId,
        transport: backend.transport
      });
    }, (error: unknown) => {
      this.options.diagnosticLogger?.log("backend.keepalive", {
        error: error instanceof Error ? error.message : String(error),
        idleMs: started - this.lastOutputAt,
        ms: Date.now() - started,
        ok: false,
        sessionId: this.options.sessionId,
        transport: backend.transport
      });
    }).finally(() => {
      this.keepaliveInFlight = false;
    });
  }

  /** Resolves pending PTY backend requests from response markers in raw terminal output. */
  private inspectPtyResponses(): void {
    const marker = parseBackendResponseMarker(this.ptyRequestBuffer);
    if (!marker) {
      return;
    }
    const pending = this.ptyRequests.get(marker.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.ptyRequests.delete(marker.id);
    this.ptyRequestBuffer = "";
    pending.resolve(`${JSON.stringify(marker.response)}\n`);
  }

  /** Rejects and clears every pending PTY backend request. */
  private rejectPtyRequests(message: string): void {
    for (const [id, pending] of this.ptyRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${message} ${id}`));
    }
    this.ptyRequests.clear();
  }

  /** Emits a render snapshot for the setup cell output. */
  private fireChange(): void {
    this.changeEmitter.fire(this.snapshot());
  }

  /** Resets in-memory runtime state before a fresh PTY launch. */
  private resetRuntimeState(): void {
    this.stopKeepalive();
    this.client = undefined;
    this.displayText = "";
    this.inputTracker = new InputLineTracker();
    this.lastDjangoCommandAt = 0;
    this.lastOutputAt = 0;
    this.lastPrimaryPromptAt = 0;
    this.lastTerminalInputAt = 0;
    this.mode = "shell";
    this.outputTail = "";
    this.process = undefined;
    this.ptyRequestBuffer = "";
    this.spawnedAt = 0;
    this.started = false;
    this.state = "starting";
    this.suppressBackendOutput = false;
    this.token = "";
    this.rejectPtyRequests("Django shell backend PTY request cancelled.");
  }

  /** Tracks submitted terminal lines and logs shell-to-Django command timing. */
  private trackInput(data: string): void {
    for (const submitted of this.inputTracker.handleInput(data)) {
      const line = submitted.line.trim();
      const previousMode = this.mode;
      const nextMode = nextModeForSubmittedLine(this.mode, line);
      const djangoCandidate = isDjangoShellCommand(line);
      if (djangoCandidate) {
        this.lastDjangoCommandAt = Date.now();
      }
      this.mode = nextMode;
      if (previousMode === "django" && nextMode === "shell") {
        this.detachBackendForShellExit();
      }
      this.options.diagnosticLogger?.log("terminal.command", {
        command: safeCommand(line, this.displayText),
        djangoCandidate,
        lineLength: line.length,
        mode: this.mode,
        previousMode,
        sinceSpawnMs: Date.now() - this.spawnedAt
      });
    }
  }

  /** Logs visible terminal mode transitions that determine cold-start timing. */
  private logModeTransition(previousMode: DjangoTerminalMode): void {
    if (previousMode === this.mode) {
      return;
    }
    this.options.diagnosticLogger?.log("terminal.mode", {
      mode: this.mode,
      previousMode,
      sinceDjangoCommandMs: this.lastDjangoCommandAt ? Date.now() - this.lastDjangoCommandAt : undefined,
      sinceSpawnMs: Date.now() - this.spawnedAt
    });
  }

  /** Drops the attached backend when the user leaves the Python shell. */
  private detachBackendForShellExit(): void {
    this.stopKeepalive(); this.client = undefined; this.suppressBackendOutput = false; this.token = ""; this.state = "starting"; this.rejectPtyRequests("Django shell backend detached."); this.fireChange();
  }
}

/** Keeps the rendered setup terminal bounded and hides backend marker lines. */
function trimTerminalText(text: string): string {
  return text
    .replace(/__DJANGO_SHELL_BACKEND_(?:READY|FAILED|RESPONSE)__\{[^\r\n]*\}/g, "")
    .slice(-12000);
}

/** Builds a one-line Python command that services a backend request through PTY output. */
function buildPtyBackendRequest(id: string, payload: BackendRequestPayload, token: string): string {
  const request = JSON.stringify({ ...payload, token });
  const trimCode = [
    "for _djs_k in ('stdout','stderr','result','traceback','error'):",
    "    _djs_v = _djs_resp.get(_djs_k) if isinstance(_djs_resp, dict) else None",
    "    if isinstance(_djs_v, str) and len(_djs_v) > _djs_limit:",
    "        _djs_resp[_djs_k] = _djs_v[:_djs_limit] + '\\n... truncated by django-shell PTY fallback ...'"
  ].join("\n");
  const python = [
    "import json as _djs_json",
    `_djs_req=_djs_json.loads(${pythonString(request)})`,
    `_djs_resp=_djs_backend_module._run_request(globals(), ${pythonString(token)}, _djs_req, globals().get("_djs_backend_initial_names", set()))`,
    "_djs_limit=750000",
    `exec(${pythonString(trimCode)})`,
    `print(${pythonString(BACKEND_RESPONSE_PREFIX)}+_djs_json.dumps({"id":${pythonString(id)},"response":_djs_resp}), flush=True)`
  ].join("; ");
  return `exec(${pythonString(python)})\r`;
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** Detects password-like prompts so the renderer can mask the next input. */
function isSecretPrompt(text: string): boolean {
  return /(password|passcode|otp|token|verification code)[^\r\n:]*:?\s*$/i.test(text.slice(-300));
}

/** Returns the first PATH entry so diagnostics stay compact. */
function firstPathEntry(value: string | undefined): string | undefined {
  return value?.split(process.platform === "win32" ? ";" : ":")[0];
}

/** Redacts submitted commands when the visible terminal is asking for a secret. */
function safeCommand(line: string, visibleText: string): string {
  return isSecretPrompt(visibleText) ? "<redacted>" : line.slice(0, 160);
}
