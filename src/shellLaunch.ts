// Shell launch selection for opening an interactive setup shell.

export interface ShellLaunch {
  args: string[];
  file: string;
}

/** Returns the shell executable and arguments needed for an interactive setup session. */
export function getShellLaunch(): ShellLaunch {
  const shell = getUserShell();
  return { file: shell, args: interactiveShellArgs(shell) };
}

/** Resolves the user's preferred shell for the current platform. */
function getUserShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
}

/** Returns arguments that make common Unix shells behave like normal interactive login shells. */
function interactiveShellArgs(shell: string): string[] {
  if (process.platform === "win32") {
    return [];
  }
  const name = shell.split(/[\\/]/).at(-1);
  return name === "bash" || name === "zsh" ? ["-l"] : [];
}
