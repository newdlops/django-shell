// Internal debug-engine selection and native debug-adapter configuration contracts.

export type DjangoShellDebugEngine = "debugpy" | "experimental";

export const DEFAULT_DJANGO_SHELL_DEBUG_ENGINE: DjangoShellDebugEngine = "debugpy";
export const DJANGO_SHELL_NATIVE_DEBUG_TYPE = "django-shell-native";

/** Network endpoint exposed by an in-process Django Shell debug adapter. */
export interface DjangoShellDebugAdapterEndpoint {
  host: string;
  port: number;
}

/** Strict internal configuration used to connect VS Code to the native tracer. */
export interface DjangoShellNativeDebugConfiguration extends Record<string, unknown> {
  __djangoShellSession: true;
  cwd: string;
  engine: "experimental";
  host: string;
  name: string;
  port: number;
  request: "attach";
  type: typeof DJANGO_SHELL_NATIVE_DEBUG_TYPE;
}

/** Normalizes a setting value while retaining debugpy as the stable default. */
export function normalizeDjangoShellDebugEngine(value: unknown): DjangoShellDebugEngine {
  return value === "experimental" ? "experimental" : DEFAULT_DJANGO_SHELL_DEBUG_ENGINE;
}

/** Builds the private VS Code attach configuration for Django Shell's native tracer. */
export function buildDjangoShellNativeDebugConfiguration(endpoint: DjangoShellDebugAdapterEndpoint, cwd: string): DjangoShellNativeDebugConfiguration {
  const normalized = validateNativeDebugEndpoint(endpoint.host, endpoint.port);
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("The Django shell workspace path is required for native debugging.");
  }
  return {
    __djangoShellSession: true,
    cwd,
    engine: "experimental",
    host: normalized.host,
    name: "Django Shell",
    port: normalized.port,
    request: "attach",
    type: DJANGO_SHELL_NATIVE_DEBUG_TYPE
  };
}

/** Strictly validates an internal native debug configuration before opening its socket. */
export function parseDjangoShellNativeDebugConfiguration(value: unknown): DjangoShellNativeDebugConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rejected an invalid Django Shell native debug adapter configuration.");
  }
  const configuration = value as Record<string, unknown>;
  if (configuration.__djangoShellSession !== true || configuration.engine !== "experimental") {
    throw new Error("Rejected a native debug adapter request that is not owned by Django Shell.");
  }
  if (configuration.type !== DJANGO_SHELL_NATIVE_DEBUG_TYPE || configuration.request !== "attach") {
    throw new Error("Django Shell native debugging only accepts internal attach sessions.");
  }
  if (typeof configuration.cwd !== "string" || !configuration.cwd.trim() || typeof configuration.name !== "string" || !configuration.name.trim()) {
    throw new Error("Django Shell native debugging received incomplete session metadata.");
  }
  const endpoint = validateNativeDebugEndpoint(configuration.host, configuration.port);
  return {
    __djangoShellSession: true,
    cwd: configuration.cwd,
    engine: "experimental",
    host: endpoint.host,
    name: configuration.name,
    port: endpoint.port,
    request: "attach",
    type: DJANGO_SHELL_NATIVE_DEBUG_TYPE
  } as DjangoShellNativeDebugConfiguration;
}

/** Resolves which engine owns an existing Django Shell debug session. */
export function debugEngineForSession(type: string, configuration: Record<string, unknown>): DjangoShellDebugEngine {
  return type === DJANGO_SHELL_NATIVE_DEBUG_TYPE && configuration.engine === "experimental" && configuration.__djangoShellSession === true ? "experimental" : "debugpy";
}

/** Validates one loopback-only native debug adapter endpoint. */
function validateNativeDebugEndpoint(hostValue: unknown, portValue: unknown): DjangoShellDebugAdapterEndpoint {
  const host = typeof hostValue === "string" ? hostValue.trim().toLowerCase() : "";
  const octets = host.split(".");
  const ipv4Loopback = octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  const loopback = host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || ipv4Loopback;
  if (!loopback) {
    throw new Error("Django Shell native debugging requires a loopback endpoint.");
  }
  if (typeof portValue !== "number" || !Number.isInteger(portValue) || portValue <= 0 || portValue > 65535) {
    throw new Error("Django Shell native debugging received an invalid adapter port.");
  }
  return { host, port: portValue };
}
