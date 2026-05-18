// Environment construction and inspection for Django shell terminal processes.

import * as path from "path";
import { detectDjangoSettingsModule, findVirtualEnv } from "./djangoProject";

export interface ShellEnvOptions {
  autoActivateWorkspaceVenv: boolean;
  djangoSettingsModule?: string;
}

export interface ShellEnvironmentInfo {
  cwd: string;
  djangoSettingsModule: string | undefined;
  inheritedVirtualEnv: string | undefined;
  pathPrefix: string | undefined;
  pythonPathPrefix: string;
  virtualEnv: string | undefined;
}

const DEFAULT_OPTIONS: ShellEnvOptions = { autoActivateWorkspaceVenv: true };

/** Returns the process working directory used as a fallback workspace root. */
export function workspaceRoot(): string {
  return process.cwd();
}

/** Builds the child shell environment with virtualenv, PATH, and PYTHONPATH configured. */
export function buildShellEnv(cwd: string, options: ShellEnvOptions = DEFAULT_OPTIONS): Record<string, string | undefined> {
  const info = describeShellEnvironment(cwd, options);
  const env: Record<string, string | undefined> = {
    ...process.env,
    DJANGO_SHELL_TERMINAL: "1",
    TERM_PROGRAM: "vscode"
  };
  if (info.virtualEnv && info.pathPrefix) {
    env.VIRTUAL_ENV = info.virtualEnv;
    env.PATH = [info.pathPrefix, env.PATH].filter(Boolean).join(path.delimiter);
  }
  if (info.djangoSettingsModule) {
    env.DJANGO_SETTINGS_MODULE = info.djangoSettingsModule;
  }
  env.PYTHONPATH = [cwd, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return env;
}

/** Describes how the shell process environment will be assembled. */
export function describeShellEnvironment(
  cwd: string,
  options: ShellEnvOptions = DEFAULT_OPTIONS
): ShellEnvironmentInfo {
  const virtualEnv = options.autoActivateWorkspaceVenv ? findVirtualEnv(cwd) : undefined;
  const djangoSettingsModule = options.djangoSettingsModule || process.env.DJANGO_SETTINGS_MODULE || detectDjangoSettingsModule(cwd);
  return {
    cwd,
    djangoSettingsModule,
    inheritedVirtualEnv: process.env.VIRTUAL_ENV,
    pathPrefix: virtualEnv ? path.join(virtualEnv, process.platform === "win32" ? "Scripts" : "bin") : undefined,
    pythonPathPrefix: cwd,
    virtualEnv
  };
}

/** Formats shell environment details for a concise VS Code output message. */
export function formatShellEnvironment(info: ShellEnvironmentInfo): string {
  const venv = info.virtualEnv ?? info.inheritedVirtualEnv ?? "(none)";
  const prefix = info.pathPrefix ?? "(unchanged)";
  const settings = info.djangoSettingsModule ?? "(set by your shell command)";
  return [
    "Django Shell process environment",
    `cwd: ${info.cwd}`,
    `virtualenv: ${venv}`,
    `PATH prefix: ${prefix}`,
    `PYTHONPATH prefix: ${info.pythonPathPrefix}`,
    `DJANGO_SETTINGS_MODULE: ${settings}`,
    "Django setup is still performed by the command you run in the terminal."
  ].join("\n");
}
