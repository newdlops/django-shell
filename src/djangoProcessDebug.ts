// Backward-compatible exports for the former cross-extension debugger bridge.
// The experimental engine is now owned and started entirely by Django Shell.

export {
  buildDjangoShellNativeDebugConfiguration,
  debugEngineForSession,
  normalizeDjangoShellDebugEngine
} from "./debugEngine";
export { startDjangoShellNativeDebugSession } from "./nativeDebugSession";
