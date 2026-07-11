// Embedded PTY session for the setup cell inside a Django shell console notebook.

import { randomBytes } from "crypto";
import * as pty from "node-pty";
import * as vscode from "vscode";
import { SerializedAsyncQueue } from "./asyncQueue";
import { BackendClient, BackendProgressSnapshot, BackendRequestPayload, BackendTransportMode, parseLoadFeatureResponse } from "./backendClient";
import { BACKEND_AUTOIMPORT_ENV, BACKEND_FEATURE_PARTS_KEY, BACKEND_PAYLOAD_ENV, BACKEND_PROGRESS_PREFIX, BACKEND_RESPONSE_PREFIX, BackendBootstrapCommand, BackendPtyResponse, backendBootstrapPayload, backendFeaturePayload, buildBackendBootstrapCommand, buildFeatureLoadPtyCommand, buildInlineBackendBootstrapCommand, parseBackendFailedMarker, parseBackendNeedsInline, parseBackendProgressMarkers, parseBackendReadyMarker, parseBackendResponseMarkers } from "./backendBootstrap";
import { buildPtyBackendRequest, buildPtyExecuteCell, firstPathEntry, isSecretPrompt, safeCommand, trimTerminalText } from "./notebookPtyText";
import { DiagnosticLogger } from "./diagnostics";
import { type DebugpyBundlePayload, buildDebugpyBundleInstallCommand, parseDebugpyBundleInstallResult } from "./debugpyBundle";
import { buildShellEnv } from "./env";
import { type KubectlExecTarget, type KubectlPortForward, parseKubectlExecTarget, startKubectlPortForward } from "./kubectlPortForward";
import { ensureNodePtyHelperExecutable } from "./ptyHelper";
import { getShellLaunch } from "./shellLaunch";
import { appendShellTranscript } from "./shellTranscript";
import { type SshExecTarget, type SshPortForward, parseSshExecTarget, startSshPortForward } from "./sshPortForward";
import { DjangoTerminalMode, InputLineTracker, detectPrimaryPythonPrompt, isDjangoShellCommand, nextModeForOutput, nextModeForSubmittedLine } from "./terminalState";

const KEEPALIVE_IDLE_MS = 45000; const KEEPALIVE_INTERVAL_MS = 30000; const KEEPALIVE_USER_IDLE_MS = 15000;
const DEBUGPY_STAGE_TIMEOUT_MS = 90000;
const FEATURE_LOAD_TIMEOUT_MS = 60000;

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
  private readonly progressEmitter = new vscode.EventEmitter<BackendProgressSnapshot>();
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
  private readonly ptyRequests = new Map<string, { reject: (error: Error) => void; resolve: (buffer: string) => void; timer?: NodeJS.Timeout }>();
  private pendingCell: { reject: (error: Error) => void; resolve: (buffer: string) => void; timer?: NodeJS.Timeout } | undefined;
  private ipython = false;
  private cellCapture = false;
  private bootstrapRetried = false;
  private bootstrapRetryPending = false;
  private readonly bootstrapWriteTimers = new Set<NodeJS.Timeout>();
  private readonly debugpyBundlePaths = new Map<string, string>();
  private ptyRequestBuffer = "";
  private ptyProgressBuffer = "";
  private readonly ptyResponseChunks = new Map<string, { chunks: string[]; count: number }>();
  private ptyRequestSeq = 1;
  private backendForward: KubectlPortForward | SshPortForward | undefined;
  private debugpyForward: KubectlPortForward | SshPortForward | undefined;
  private kubectlTarget: KubectlExecTarget | undefined;
  private shellLogTail = "";
  private sshTarget: SshExecTarget | undefined;
  private spawnedAt = 0;
  private started = false;
  private state = "starting";
  private suppressBackendOutput = false;
  private token = "";

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidData = this.dataEmitter.event;
  readonly onDidProgress = this.progressEmitter.event;

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
    const env = buildShellEnv(this.options.cwd, { autoActivateWorkspaceVenv: this.options.autoActivateWorkspaceVenv, djangoSettingsModule: this.options.djangoSettingsModule });
    // Carry the backend source out-of-band so the typed bootstrap stays a short line (no large blob in the shell-audit log).
    env[BACKEND_PAYLOAD_ENV] = backendBootstrapPayload(this.options.backendRuntimePath) ?? "";
    env[BACKEND_AUTOIMPORT_ENV] = vscode.workspace.getConfiguration("djangoShell").get<boolean>("autoImportModels", true) ? "1" : "0";
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
    this.clearDebugpyPortForward();
    this.clearBackendPortForward();
    this.clearBootstrapWriteTimers();
    this.process?.kill();
    this.rejectPtyRequests("Django shell PTY session disposed.");
    this.dataEmitter.dispose();
    this.changeEmitter.dispose();
    this.progressEmitter.dispose();
  }

  /** Returns the latest renderable terminal state. */
  snapshot(): NotebookTerminalSnapshot {
    return { mode: this.mode, ready: Boolean(this.client), secretPrompt: isSecretPrompt(this.displayText), selectedSettingsModule: this.options.djangoSettingsModule ?? "", sessionId: this.options.sessionId, settingsCandidates: this.options.settingsCandidates ?? [], state: this.state, text: trimTerminalText(this.displayText) };
  }

  /** Returns whether the backend was attached through the inline fallback used for terminal-only remote shells. */
  isRemoteTerminalBackend(): boolean {
    return this.bootstrapRetried;
  }

  /** Starts an automatic port-forward for remote debugpy when the setup command exposed a kubectl or SSH target. */
  async forwardDebugpy(remotePort: number): Promise<KubectlPortForward | SshPortForward | undefined> {
    if (!this.bootstrapRetried) { return undefined; }
    this.clearDebugpyPortForward();
    if (this.kubectlTarget) { return this.forwardKubectlDebugpy(remotePort); }
    if (this.sshTarget) { return this.forwardSshDebugpy(remotePort); }
    this.options.diagnosticLogger?.log("debug.portForward.unavailable", { remotePort, sessionId: this.options.sessionId });
    return undefined;
  }

  /** Tunnels the remote backend socket to a local port so model reads run in parallel with a busy remote PTY. */
  private async forwardBackendSocket(remotePort: number, client: BackendClient): Promise<void> {
    const kubectl = this.kubectlTarget;
    const ssh = this.sshTarget;
    if ((!kubectl && !ssh) || !remotePort) {
      this.options.diagnosticLogger?.log("backend.portForward.unavailable", { remotePort, sessionId: this.options.sessionId });
      return;
    }
    try {
      const forward = kubectl ? await startKubectlPortForward(kubectl, remotePort, this.options.diagnosticLogger) : await startSshPortForward(ssh as SshExecTarget, remotePort, this.options.diagnosticLogger);
      if (this.client !== client) {
        forward.dispose();
        return;
      }
      this.clearBackendPortForward();
      this.backendForward = forward;
      client.useForwardedEndpoint(forward.host, forward.port);
      this.options.diagnosticLogger?.log("backend.portForward.ready", { localPort: forward.port, remotePort, sessionId: this.options.sessionId });
    } catch (error) {
      this.options.diagnosticLogger?.log("backend.portForward.error", { error: error instanceof Error ? error.message : String(error), remotePort, sessionId: this.options.sessionId });
    }
  }

  /** Stops the backend socket tunnel owned by this PTY session. */
  private clearBackendPortForward(): void {
    this.backendForward?.dispose();
    this.backendForward = undefined;
  }

  /** Starts an automatic kubectl port-forward for remote debugpy. */
  private async forwardKubectlDebugpy(remotePort: number): Promise<KubectlPortForward | undefined> {
    const target = this.kubectlTarget;
    if (!target) { return undefined; }
    try {
      this.debugpyForward = await startKubectlPortForward(target, remotePort, this.options.diagnosticLogger);
      return this.debugpyForward;
    } catch (error) {
      this.options.diagnosticLogger?.log("debug.kubectl.portForward.error", { error: error instanceof Error ? error.message : String(error), remotePort });
      return undefined;
    }
  }

  /** Starts an automatic SSH local port-forward for remote debugpy. */
  private async forwardSshDebugpy(remotePort: number): Promise<SshPortForward | undefined> {
    const target = this.sshTarget;
    if (!target) { return undefined; }
    try {
      this.debugpyForward = await startSshPortForward(target, remotePort, this.options.diagnosticLogger);
      return this.debugpyForward;
    } catch (error) {
      this.options.diagnosticLogger?.log("debug.ssh.portForward.error", { error: error instanceof Error ? error.message : String(error), remotePort });
      return undefined;
    }
  }

  /** Stops any automatic debugpy kubectl port-forward process owned by this PTY session. */
  clearDebugpyPortForward(): void {
    this.debugpyForward?.dispose();
    this.debugpyForward = undefined;
  }

  /** Stages the bundled debugpy package into the active remote shell and returns its remote import root. Cheapest transport first: a probe reuses an install left by an earlier session, then the socket tunnel carries the whole bundle in one request; typing thousands of paced terminal lines is only the last resort. */
  async stageDebugpyBundle(payload: DebugpyBundlePayload): Promise<string | undefined> {
    const cached = this.debugpyBundlePaths.get(payload.digest);
    if (cached) {
      return cached;
    }
    const staged = await this.probeStagedDebugpyBundle(payload) ?? await this.uploadDebugpyBundleViaSocket(payload) ?? await this.typeDebugpyBundleViaPty(payload);
    this.debugpyBundlePaths.set(payload.digest, staged);
    return staged;
  }

  /** Returns the remote path of an already-staged bundle when the digest-keyed directory survives from a prior session. */
  private async probeStagedDebugpyBundle(payload: DebugpyBundlePayload): Promise<string | undefined> {
    const client = this.client;
    if (!client) {
      return undefined;
    }
    try {
      const probe = await client.stageDebugpyProbe(payload.digest);
      if (probe.ok && probe.path) {
        this.options.diagnosticLogger?.log("debugpy.bundle.reused", { path: probe.path, sessionId: this.options.sessionId });
        return probe.path;
      }
    } catch (error) {
      this.options.diagnosticLogger?.log("debugpy.bundle.probe.error", { error: error instanceof Error ? error.message : String(error), sessionId: this.options.sessionId });
    }
    return undefined;
  }

  /** Ships the compressed bundle through the backend socket tunnel in one request, when that transport is reachable. */
  private async uploadDebugpyBundleViaSocket(payload: DebugpyBundlePayload): Promise<string | undefined> {
    const client = this.client;
    if (!client) {
      return undefined;
    }
    const started = Date.now();
    try {
      const uploaded = await client.stageDebugpyUpload(payload.digest, payload.data);
      if (uploaded.ok && uploaded.path) {
        this.options.diagnosticLogger?.log("debugpy.bundle.install", { bytes: payload.data.length, files: payload.fileCount, ms: Date.now() - started, path: uploaded.path, sessionId: this.options.sessionId, transport: "tcp" });
        return uploaded.path;
      }
      this.options.diagnosticLogger?.log("debugpy.bundle.socket.error", { error: uploaded.error ?? "Socket staging returned no path.", sessionId: this.options.sessionId });
    } catch (error) {
      this.options.diagnosticLogger?.log("debugpy.bundle.socket.error", { error: error instanceof Error ? error.message : String(error), sessionId: this.options.sessionId });
    }
    return undefined;
  }

  /** Types the chunked bundle installer into the interactive PTY — the slow last-resort transport. */
  private async typeDebugpyBundleViaPty(payload: DebugpyBundlePayload): Promise<string> {
    const id = `debugpy-${Date.now().toString(36)}-${this.ptyRequestSeq++}`;
    const install = buildDebugpyBundleInstallCommand(payload, id, BACKEND_RESPONSE_PREFIX);
    const buffer = await this.writePacedPtyRequest(id, install.command, DEBUGPY_STAGE_TIMEOUT_MS, "debugpyBundle");
    const result = parseDebugpyBundleInstallResult(buffer);
    if (!result.ok || !result.path) {
      throw new Error(result.error ?? "Bundled debugpy install failed.");
    }
    this.options.diagnosticLogger?.log("debugpy.bundle.install", { bytes: install.bytes, chunks: install.chunks, files: payload.fileCount, path: result.path, sessionId: this.options.sessionId, transport: "pty" });
    return result.path;
  }

  /** Processes PTY output, detects prompts, and attaches the backend once. */
  private handleOutput(data: string): void {
    this.lastOutputAt = Date.now();
    if (this.options.diagnosticLogger?.enabled()) { this.shellLogTail = appendShellTranscript(this.options.diagnosticLogger, this.shellLogTail, data); }
    const previousMode = this.mode;
    const suppressVisible = this.suppressBackendOutput || this.ptyRequests.size > 0 || this.pendingCell !== undefined;
    this.outputTail = `${this.outputTail}${data}`.slice(-4000);
    if (detectPrimaryPythonPrompt(this.outputTail)) {
      this.lastPrimaryPromptAt = this.lastOutputAt;
    }
    if (this.ptyRequests.size || this.pendingCell) {
      this.ptyRequestBuffer = `${this.ptyRequestBuffer}${data}`;
      this.ptyProgressBuffer = `${this.ptyProgressBuffer}${data}`;
      this.inspectPtyProgress();
      this.inspectPtyResponses();
    } else if (this.ptyProgressBuffer || data.includes(BACKEND_PROGRESS_PREFIX)) {
      this.ptyProgressBuffer = `${this.ptyProgressBuffer}${data}`;
      this.inspectPtyProgress();
    } else {
      this.ptyProgressBuffer = progressMarkerTail(data);
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
    this.bootstrapRetried = false;
    this.bootstrapRetryPending = false;
    this.token = randomBytes(16).toString("hex");
    this.writeBootstrap(buildBackendBootstrapCommand(this.options.backendRuntimePath, this.token));
  }

  /** Logs and types one bootstrap command, suppressing its echoed source from the visible terminal. */
  private writeBootstrap(bootstrap: BackendBootstrapCommand): void {
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
    this.clearBootstrapWriteTimers();
    if (bootstrap.mode === "inline") {
      this.writeInlineBootstrapPaced(bootstrap.command);
      return;
    }
    this.process?.write(bootstrap.command);
  }

  /** Writes the remote inline bootstrap in paced lines so kubectl/IPython PTYs do not drop the queued payload. */
  private writeInlineBootstrapPaced(command: string): void {
    const lines = command.replace(/\r$/, "").split("\r");
    const sessionGeneration = this.generation;
    const writeLine = (index: number): void => {
      if (sessionGeneration !== this.generation || !this.process || this.client) {
        return;
      }
      this.process.write(`${lines[index]}\r`);
      if (index + 1 >= lines.length) {
        return;
      }
      const delay = index === 0 ? 350 : 20;
      const timer = setTimeout(() => {
        this.bootstrapWriteTimers.delete(timer);
        writeLine(index + 1);
      }, delay);
      this.bootstrapWriteTimers.add(timer);
    };
    writeLine(0);
  }

  /** Delivers the deferred model-browser feature on the FIRST browse request (lazy): over the socket when a tunnel is up (the remote win), else typed as a paced PTY request serialized behind the shared queue so it cannot interleave with cells. Throws when delivery fails so the client retries on a later browse. */
  private async deliverModelBrowserFeature(client: BackendClient): Promise<void> {
    if (this.client !== client) { throw new Error("Django shell session restarted before the model browser feature loaded."); }
    const payload = backendFeaturePayload(this.options.backendRuntimePath);
    if (!payload) { return; }
    try {
      const result = await client.loadFeature(payload);
      if (result?.ok) { this.options.diagnosticLogger?.log("backend.feature.loaded", { reused: result.reused ? 1 : 0, sessionId: this.options.sessionId, transport: "socket" }); return; }
      throw new Error(result?.error || "loadfeature returned not-ok");
    } catch (error) {
      this.options.diagnosticLogger?.log("backend.feature.socket.failed", { error: error instanceof Error ? error.message : String(error), sessionId: this.options.sessionId });
    }
    const id = `feature-${Date.now().toString(36)}-${this.ptyRequestSeq++}`;
    const command = buildFeatureLoadPtyCommand(this.options.backendRuntimePath, buildPtyBackendRequest(id, { kind: "loadfeature", partsKey: BACKEND_FEATURE_PARTS_KEY }, this.token));
    if (!command) { throw new Error("The deferred model browser source is unavailable for typed delivery."); }
    const buffer = await this.writePacedPtyRequest(id, command, FEATURE_LOAD_TIMEOUT_MS, "featureLoad");
    const result = parseLoadFeatureResponse(buffer);
    if (!result.ok) { throw new Error(result.error || "Typed loadfeature returned not-ok."); }
    this.options.diagnosticLogger?.log("backend.feature.loaded", { reused: result.reused ? 1 : 0, sessionId: this.options.sessionId, transport: "pty" });
  }

  /** Cancels delayed inline bootstrap writes for a restarted or disposed PTY. */
  private clearBootstrapWriteTimers(): void {
    for (const timer of this.bootstrapWriteTimers) {
      clearTimeout(timer);
    }
    this.bootstrapWriteTimers.clear();
  }

  /** Parses backend ready or failed markers from recent PTY output. */
  private inspectMarkers(): void {
    if (this.client) {
      return;
    }
    const ready = parseBackendReadyMarker(this.outputTail);
    if (ready && ready.token === this.token) {
      this.suppressBackendOutput = false;
      this.ipython = Boolean(ready.ipython);
      this.cellCapture = Boolean(ready.cellCapture);
      this.client = new BackendClient(ready, this.options.diagnosticLogger, (payload) => this.requestViaPty(payload));
      const preferred = vscode.workspace.getConfiguration("djangoShell").get<string>("modelBrowser.transport", "pty");
      if (["orm", "auto", "tcp", "pty"].includes(preferred)) { this.client.setTransportMode(preferred as BackendTransportMode); }
      // Inline bootstrap was used → remote shell (SSH/kubectl): the backend's 127.0.0.1 socket isn't reachable directly, so
      // skip it, then try a tunnel to the backend port so parallel model reads work beside a busy remote PTY. The deferred
      // model-browser half is NOT pushed here — the client loads it lazily on the first browse request.
      if (this.bootstrapRetried) {
        this.client.markSocketUnavailable();
        const client = this.client;
        const forward = this.forwardBackendSocket(ready.port, client);
        client.setModelBrowserFeatureLoader(() => forward.then(() => this.deliverModelBrowserFeature(client)));
      }
      this.state = "ready";
      this.startKeepalive();
      this.options.diagnosticLogger?.log("backend.ready", { autoImported: ready.autoImported, host: ready.host, port: ready.port, remote: this.bootstrapRetried, sessionId: this.options.sessionId });
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
      return;
    }
    // The env/disk bootstrap could load neither the spawn-env payload nor a local runtime file — a remote shell (SSH,
    // kubectl/docker exec). It signalled this cleanly (no traceback in the audit) OR, for any other unexpected bootstrap
    // error, raised a traceback. Either way, arm a one-time inline retry that embeds the source.
    if (this.token && !this.bootstrapRetried && (parseBackendNeedsInline(this.outputTail) || /Traceback \(most recent call last\)/.test(this.outputTail))) {
      this.bootstrapRetryPending = true;
    }
    // Send the large inline payload only once the shell is back at a ready prompt — typing the compressed backend source
    // (tens of KB across many paced lines) while the failure traceback is still printing corrupts it (the PTY mangles input
    // written before the prompt returns). Fewer, near-max-width lines keep this window short — see backendBootstrap chunking.
    if (this.bootstrapRetryPending && !this.bootstrapRetried && detectPrimaryPythonPrompt(this.outputTail)) {
      const inline = buildInlineBackendBootstrapCommand(this.options.backendRuntimePath, this.token);
      this.bootstrapRetried = true;
      this.bootstrapRetryPending = false;
      if (inline) {
        this.outputTail = "";
        this.writeBootstrap(inline);
      }
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
      // Type the user's literal code as the cell so the shell's raw_cell stays pure; the bootstrap-installed
      // capture hook emits the response marker (no wrapper). IPython handles multi-line cells; the plain REPL
      // only captures one statement per prompt, so multi-line plain-shell code falls through to the wrapper.
      if ((payload.kind === "execute" || payload.kind === "ormcell") && typeof payload.code === "string" && this.cellCapture && (this.ipython || !payload.code.includes("\n")) && !wantsPtyProgress(payload) && !wantsPtyDebugWrapper(payload)) {
        this.ptyRequestBuffer = "";
        this.ptyProgressBuffer = "";
        this.pendingCell = { reject, resolve };
        this.options.diagnosticLogger?.log("backend.pty.request", { code: typeof payload.code === "string" ? payload.code.slice(0, 200) : undefined, kind: payload.kind, literalCell: true, queueMs: started - queuedAt, sessionId: this.options.sessionId });
        this.process.write(buildPtyExecuteCell(payload.code, this.ipython));
        return;
      }
      const id = `${Date.now().toString(36)}-${this.ptyRequestSeq++}`;
      this.ptyRequestBuffer = "";
      this.ptyProgressBuffer = "";
      this.ptyRequests.set(id, { reject, resolve });
      this.options.diagnosticLogger?.log("backend.pty.request", { code: typeof payload.code === "string" ? payload.code.slice(0, 200) : undefined, id, kind: payload.kind, lightweight: payload.lightweight, queueMs: started - queuedAt, sessionId: this.options.sessionId });
      this.process.write(buildPtyBackendRequest(id, payload, this.token));
    }), payload.kind === "execute" ? "high" : "normal");
  }

  /** Writes a generated multi-line PTY command in paced chunks and resolves through the normal response marker path. */
  private writePacedPtyRequest(id: string, command: string, timeoutMs: number, kind: string): Promise<string> {
    const queuedAt = Date.now();
    return this.ptyQueue.run("backend", () => new Promise<string>((resolve, reject) => {
      const started = Date.now();
      if (!this.process) {
        reject(new Error("Django shell PTY is not running."));
        return;
      }
      this.ptyRequestBuffer = "";
      this.ptyProgressBuffer = "";
      const timer = setTimeout(() => {
        this.ptyRequests.delete(id);
        reject(new Error(`Django shell PTY request timed out after ${timeoutMs}ms. ${id}`));
      }, timeoutMs);
      this.ptyRequests.set(id, { reject, resolve, timer });
      this.options.diagnosticLogger?.log("backend.pty.request", { id, kind, queueMs: started - queuedAt, sessionId: this.options.sessionId });
      this.writePtyCommandPaced(id, command);
    }));
  }

  /** Types one generated PTY command line-by-line so remote terminals do not drop a large queued paste. */
  private writePtyCommandPaced(id: string, command: string): void {
    const lines = command.replace(/\r$/, "").split("\r");
    const sessionGeneration = this.generation;
    const writeLine = (index: number): void => {
      if (sessionGeneration !== this.generation || !this.process || !this.ptyRequests.has(id)) {
        return;
      }
      this.process.write(`${lines[index]}\r`);
      if (index + 1 >= lines.length) {
        return;
      }
      const timer = setTimeout(() => {
        this.bootstrapWriteTimers.delete(timer);
        writeLine(index + 1);
      }, index === 0 ? 100 : 10);
      this.bootstrapWriteTimers.add(timer);
    };
    writeLine(0);
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
    if (!backend || !this.process || this.mode !== "django" || this.keepaliveInFlight || this.ptyRequests.size > 0 || this.pendingCell) {
      return;
    }
    // Terminal mode reconstructs reads as readable Django cells; `environment` has no command equivalent, so a
    // keepalive there would only type `_djs_rpc` plumbing into the live server shell. Skip it entirely.
    if (backend.transportMode === "pty") {
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
      this.options.diagnosticLogger?.log("backend.keepalive", { idleMs: started - this.lastOutputAt, ms: Date.now() - started, ok: result.ok, sessionId: this.options.sessionId, transport: backend.transport });
    }, (error: unknown) => {
      this.options.diagnosticLogger?.log("backend.keepalive", { error: error instanceof Error ? error.message : String(error), idleMs: started - this.lastOutputAt, ms: Date.now() - started, ok: false, sessionId: this.options.sessionId, transport: backend.transport });
    }).finally(() => {
      this.keepaliveInFlight = false;
    });
  }

  /** Resolves pending PTY backend requests from response markers in raw terminal output. */
  private inspectPtyResponses(): void {
    const parsed = parseBackendResponseMarkers(this.ptyRequestBuffer);
    this.ptyRequestBuffer = parsed.rest;
    if (!parsed.markers.length) {
      return;
    }
    for (const marker of parsed.markers) {
      this.handlePtyResponseMarker(marker);
    }
  }

  /** Emits streamed backend progress markers received while a PTY request is running. */
  private inspectPtyProgress(): void {
    const parsed = parseBackendProgressMarkers(this.ptyProgressBuffer);
    this.ptyProgressBuffer = progressMarkerTail(parsed.rest);
    for (const marker of parsed.markers) {
      if (marker && typeof marker === "object") {
        this.progressEmitter.fire(marker as BackendProgressSnapshot);
      }
    }
  }

  /** Handles one complete PTY response marker, assembling chunked responses when needed. */
  private handlePtyResponseMarker(marker: BackendPtyResponse): void {
    if (marker.chunk) {
      const response = this.assemblePtyResponseChunk(marker);
      if (response === undefined) {
        return;
      }
      this.resolvePtyResponse(marker.id, response);
      return;
    }
    this.resolvePtyResponse(marker.id, marker.response);
  }

  /** Stores one response chunk and returns the parsed response after all chunks arrive. */
  private assemblePtyResponseChunk(marker: BackendPtyResponse): unknown | undefined {
    const chunk = marker.chunk;
    if (!chunk || !Number.isInteger(chunk.count) || !Number.isInteger(chunk.index) || chunk.count <= 0 || chunk.index < 0 || chunk.index >= chunk.count) {
      return undefined;
    }
    const entry = this.ptyResponseChunks.get(marker.id) ?? { chunks: new Array<string>(chunk.count), count: chunk.count };
    if (entry.count !== chunk.count) {
      this.ptyResponseChunks.delete(marker.id);
      return undefined;
    }
    entry.chunks[chunk.index] = chunk.data;
    this.ptyResponseChunks.set(marker.id, entry);
    for (let index = 0; index < entry.count; index += 1) {
      if (typeof entry.chunks[index] !== "string") {
        return undefined;
      }
    }
    this.ptyResponseChunks.delete(marker.id);
    return JSON.parse(entry.chunks.join(""));
  }

  /** Resolves a pending PTY backend request from one parsed response payload. */
  private resolvePtyResponse(id: string, response: unknown): void {
    const pending = this.ptyRequests.get(id);
    if (pending) {
      if (pending.timer) { clearTimeout(pending.timer); }
      this.ptyRequests.delete(id);
      pending.resolve(`${JSON.stringify(response)}\n`);
      return;
    }
    // A literal-cell execute has no extension-assigned id; the run-cell hook's marker resolves it (FIFO).
    if (this.pendingCell) {
      const cell = this.pendingCell;
      this.pendingCell = undefined;
      if (cell.timer) { clearTimeout(cell.timer); }
      cell.resolve(`${JSON.stringify(response)}\n`);
    }
  }

  /** Rejects and clears every pending PTY backend request. */
  private rejectPtyRequests(message: string): void {
    for (const [id, pending] of this.ptyRequests) {
      if (pending.timer) { clearTimeout(pending.timer); }
      pending.reject(new Error(`${message} ${id}`));
    }
    this.ptyRequests.clear();
    this.ptyResponseChunks.clear();
    this.ptyProgressBuffer = "";
    if (this.pendingCell) {
      if (this.pendingCell.timer) { clearTimeout(this.pendingCell.timer); }
      this.pendingCell.reject(new Error(message));
      this.pendingCell = undefined;
    }
  }

  /** Emits a render snapshot for the setup cell output. */
  private fireChange(): void {
    this.changeEmitter.fire(this.snapshot());
  }

  /** Resets in-memory runtime state before a fresh PTY launch. */
  private resetRuntimeState(): void {
    this.stopKeepalive();
    this.clearBootstrapWriteTimers();
    this.clearDebugpyPortForward();
    this.clearBackendPortForward();
    this.client = undefined;
    this.ipython = false;
    this.cellCapture = false;
    this.bootstrapRetried = false;
    this.bootstrapRetryPending = false;
    this.debugpyBundlePaths.clear();
    this.displayText = "";
    this.inputTracker = new InputLineTracker();
    this.kubectlTarget = undefined;
    this.sshTarget = undefined;
    this.lastDjangoCommandAt = 0;
    this.lastOutputAt = 0;
    this.lastPrimaryPromptAt = 0;
    this.lastTerminalInputAt = 0;
    this.mode = "shell";
    this.outputTail = "";
    this.process = undefined;
    this.ptyProgressBuffer = "";
    this.ptyRequestBuffer = "";
    this.ptyResponseChunks.clear();
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
      this.kubectlTarget = parseKubectlExecTarget(line) ?? this.kubectlTarget;
      this.sshTarget = parseSshExecTarget(line) ?? this.sshTarget;
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
    this.stopKeepalive(); this.clearBackendPortForward(); this.client = undefined; this.ipython = false; this.cellCapture = false; this.suppressBackendOutput = false; this.token = ""; this.state = "starting"; this.rejectPtyRequests("Django shell backend detached."); this.fireChange();
  }
}

/** Returns whether a PTY execute request should use the instrumentable RPC path instead of a literal cell. */
function wantsPtyProgress(payload: BackendRequestPayload): boolean {
  if (payload.kind !== "execute" || typeof payload.code !== "string") {
    return false;
  }
  return /\bfor\b|\btqdm\s*\(|\.iterator\s*\(|\.objects\b|QuerySet\b/.test(payload.code);
}

/** Returns whether a PTY execute request must keep backend compile metadata for debugger breakpoints. */
function wantsPtyDebugWrapper(payload: BackendRequestPayload): boolean {
  return payload.kind === "execute" && Array.isArray(payload.breakpointLines);
}

/** Returns the progress marker tail worth keeping across PTY output chunks. */
function progressMarkerTail(output: string): string {
  const markerIndex = output.lastIndexOf(BACKEND_PROGRESS_PREFIX);
  if (markerIndex >= 0) {
    return output.slice(markerIndex);
  }
  const maxLength = Math.min(output.length, BACKEND_PROGRESS_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = output.slice(-length);
    if (BACKEND_PROGRESS_PREFIX.startsWith(suffix)) {
      return suffix;
    }
  }
  return "";
}
