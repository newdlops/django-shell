// VS Code debug-adapter registration for Django Shell's internal native tracer.

import * as vscode from "vscode";
import { DJANGO_SHELL_NATIVE_DEBUG_TYPE, parseDjangoShellNativeDebugConfiguration } from "./debugEngine";

/** Creates socket-backed debug adapter descriptors for validated Django Shell sessions. */
export class DjangoShellNativeDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  /** Connects VS Code only to the loopback endpoint produced by Django Shell itself. */
  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
    const configuration = parseDjangoShellNativeDebugConfiguration(session.configuration);
    return new vscode.DebugAdapterServer(configuration.port, configuration.host);
  }
}

/** Registers the private native debug type and owns its disposable through the extension context. */
export function registerDjangoShellNativeDebugAdapter(context: vscode.ExtensionContext): vscode.Disposable {
  const registration = vscode.debug.registerDebugAdapterDescriptorFactory(DJANGO_SHELL_NATIVE_DEBUG_TYPE, new DjangoShellNativeDebugAdapterFactory());
  context.subscriptions.push(registration);
  return registration;
}
