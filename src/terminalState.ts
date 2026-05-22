// Terminal input/output state helpers for detecting when a normal shell becomes a Django Python REPL.

export type DjangoTerminalMode = "shell" | "candidate-django" | "django" | "unknown-python";

export interface SubmittedLine {
  line: string;
}

const DEFAULT_DJANGO_SHELL_PATTERNS = [
  "\\bpython(?:\\d+(?:\\.\\d+)?)?\\s+manage\\.py\\s+shell(?:_plus)?\\b",
  "\\bdjango-admin\\s+shell\\b",
  "(^|\\s)(?:\\./)?[\\w./-]+\\s+shell\\b"
];

/** Tracks raw terminal keystrokes into submitted command lines without modifying terminal behavior. */
export class InputLineTracker {
  private buffer = "";

  /** Returns the editable terminal line currently being tracked before Enter is pressed. */
  get currentLine(): string {
    return this.buffer;
  }

  /** Consumes raw terminal input bytes and returns every submitted line completed by Enter. */
  handleInput(data: string): SubmittedLine[] {
    const submitted: SubmittedLine[] = [];
    for (const char of data) {
      const line = this.handleChar(char);
      if (line) {
        submitted.push(line);
      }
    }
    return submitted;
  }

  /** Updates the tracked line for one terminal character and emits a line when it is submitted. */
  private handleChar(char: string): SubmittedLine | undefined {
    if (char === "\r" || char === "\n") {
      const line = this.buffer;
      this.buffer = "";
      return { line };
    }
    if (char === "\u007f") {
      this.buffer = this.buffer.slice(0, -1);
      return undefined;
    }
    if (char === "\u0003") {
      this.buffer = "";
      return undefined;
    }
    if (!/[\u0000-\u001f\u007f]/.test(char)) {
      this.buffer += char;
    }
    return undefined;
  }
}

/** Returns true when a submitted shell command is expected to enter a Django shell. */
export function isDjangoShellCommand(command: string, patterns = DEFAULT_DJANGO_SHELL_PATTERNS): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(command));
}

/** Detects Python or IPython prompt text in the latest terminal output. */
export function detectPythonPrompt(outputTail: string): "python" | undefined {
  if (detectPrimaryPythonPrompt(outputTail)) {
    return "python";
  }
  const plain = stripTerminalControls(outputTail);
  if (/(^|\r?\n)\.\.\. $/.test(plain)) {
    return "python";
  }
  return undefined;
}

/** Detects idle primary Python prompts that can safely receive hidden backend commands. */
export function detectPrimaryPythonPrompt(outputTail: string): "python" | undefined {
  const plain = stripTerminalControls(outputTail);
  if (/(^|\r?\n)>>> $/.test(plain)) {
    return "python";
  }
  if (/(^|\r?\n)In \[\d+\]: $/.test(plain)) {
    return "python";
  }
  return undefined;
}

/** Computes the next terminal mode after the user submits a command line. */
export function nextModeForSubmittedLine(
  mode: DjangoTerminalMode,
  line: string,
  patterns?: string[]
): DjangoTerminalMode {
  const command = line.trim();
  if (mode === "django" && isExitCommand(command)) {
    return "shell";
  }
  return isDjangoShellCommand(command, patterns) ? "candidate-django" : mode;
}

/** Computes the next terminal mode after new terminal output arrives. */
export function nextModeForOutput(mode: DjangoTerminalMode, outputTail: string): DjangoTerminalMode {
  if (!detectPythonPrompt(outputTail)) {
    return mode;
  }
  if (mode === "candidate-django" || mode === "django") {
    return "django";
  }
  return "unknown-python";
}

/** Returns true when a Django REPL exit command was submitted. */
function isExitCommand(command: string): boolean {
  return command === "exit" || command === "exit()" || command === "quit" || command === "quit()";
}

/** Removes terminal control sequences that can surround REPL prompt text. */
function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
