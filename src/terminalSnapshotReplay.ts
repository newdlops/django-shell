// Reconciles setup-terminal snapshots with live PTY data delivered before the first baseline.

export interface TerminalReplayResult {
  clear: boolean;
  write: string;
}

export interface TerminalReplayState {
  buffered: string;
  snapshotWritten: boolean;
}

/** Creates empty replay state for one setup terminal renderer. */
export function createTerminalReplayState(): TerminalReplayState {
  return { buffered: "", snapshotWritten: false };
}

/** Buffers live data until a baseline snapshot prevents pre-panel output loss. */
export function consumeTerminalData(state: TerminalReplayState, data: string): TerminalReplayResult {
  if (state.snapshotWritten) {
    return { clear: false, write: data };
  }
  state.buffered += data;
  return { clear: false, write: "" };
}

/** Installs one snapshot baseline and appends only live data it does not already contain. */
export function applyTerminalSnapshot(state: TerminalReplayState, snapshot: { state?: string; text?: string }): TerminalReplayResult {
  const text = String(snapshot.text || "");
  if (snapshot.state === "starting" && !text) {
    state.buffered = "";
    state.snapshotWritten = false;
    return { clear: true, write: "" };
  }
  if (state.snapshotWritten) {
    return { clear: false, write: "" };
  }
  let overlap = Math.min(text.length, state.buffered.length);
  while (overlap > 0 && text.slice(-overlap) !== state.buffered.slice(0, overlap)) { overlap -= 1; }
  const suffix = state.buffered.slice(overlap);
  state.buffered = "";
  state.snapshotWritten = true;
  return { clear: false, write: text + suffix };
}
