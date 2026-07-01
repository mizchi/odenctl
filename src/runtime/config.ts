export interface RuntimeConfigEnv {
  RUNTIME_NODE_ID?: string;
  RUNTIME_PUBLIC_URL?: string;
  RUNTIME_MEMORY_MB?: string;
  RUNTIME_PROJECT_CONCURRENCY_LIMITS?: string;
  RUNTIME_PROJECT_RATE_LIMITS?: string;
  RUNTIME_REGION?: string;
  RUNTIME_LABELS?: string;
  RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS?: string;
  RUNTIME_ROUTE_SNAPSHOT_FILE?: string;
  WASMPLANE_RUNTIME_IDENTITY_KEY_ID?: string;
  WASMPLANE_RUNTIME_IDENTITY_KEYS?: string;
  WASMPLANE_RUNTIME_IDENTITY_CERT_SHA256?: string;
  WASMPLANE_RUNTIME_CACHE_MAX_BYTES?: string;
  WASMPLANE_RUNTIME_CACHE_MAX_AGE_MS?: string;
  WASMPLANE_RUNTIME_CACHE_GC_INTERVAL_MS?: string;
  FLY_APP_NAME?: string;
  FLY_MACHINE_ID?: string;
  FLY_REGION?: string;
  FLY_VM_MEMORY_MB?: string;
}

export interface ProjectRateLimitConfig {
  requestsPerSecond: number;
  burst?: number;
}

export interface RuntimeAdvertisedIdentity {
  keyId: string;
  certificateSha256?: string;
}

export interface RuntimeCacheRetentionPolicy {
  maxBytes?: number;
  maxAgeMs?: number;
}

export function resolveRuntimeNodeId(env: RuntimeConfigEnv, host: string, port: number): string {
  if (env.RUNTIME_NODE_ID) {
    return env.RUNTIME_NODE_ID;
  }
  if (env.FLY_MACHINE_ID) {
    return `rt_${env.FLY_MACHINE_ID}`;
  }
  return `rt_${host.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${port}`;
}

export function resolveRuntimePublicUrl(env: RuntimeConfigEnv, host: string, port: number): string {
  if (env.RUNTIME_PUBLIC_URL && env.RUNTIME_PUBLIC_URL !== "auto") {
    return env.RUNTIME_PUBLIC_URL;
  }
  if (env.FLY_MACHINE_ID && env.FLY_APP_NAME) {
    return `http://${env.FLY_MACHINE_ID}.vm.${env.FLY_APP_NAME}.internal:${port}`;
  }
  return `http://${host}:${port}`;
}

export function resolveRuntimeMemoryMb(env: RuntimeConfigEnv, fallback: number): number {
  return positiveInteger(env.RUNTIME_MEMORY_MB ?? env.FLY_VM_MEMORY_MB, fallback);
}

export function resolveRuntimeRegion(env: RuntimeConfigEnv): string | undefined {
  return firstNonEmpty(env.RUNTIME_REGION, env.FLY_REGION)?.toLowerCase();
}

export function parseRuntimeLabels(env: RuntimeConfigEnv): Record<string, string> | undefined {
  const raw = env.RUNTIME_LABELS;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const labels: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    labels[key] = value;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

export function parseRuntimeIdentityKeys(env: RuntimeConfigEnv): Record<string, string> | undefined {
  const raw = env.WASMPLANE_RUNTIME_IDENTITY_KEYS;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const keys: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const keyId = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (!runtimeIdentityKeyId(keyId) || secret.length === 0) {
      continue;
    }
    keys[keyId] = secret;
  }
  return Object.keys(keys).length > 0 ? keys : undefined;
}

export function resolveRuntimeIdentity(env: RuntimeConfigEnv): RuntimeAdvertisedIdentity | undefined {
  const keyId = env.WASMPLANE_RUNTIME_IDENTITY_KEY_ID?.trim();
  if (!keyId || !runtimeIdentityKeyId(keyId)) {
    return undefined;
  }
  const certificateSha256 = env.WASMPLANE_RUNTIME_IDENTITY_CERT_SHA256?.trim().toLowerCase();
  return {
    keyId,
    ...(certificateSha256 && /^[a-f0-9]{64}$/.test(certificateSha256) ? { certificateSha256 } : {}),
  };
}

export function parseRuntimeCacheRetentionPolicy(env: RuntimeConfigEnv): RuntimeCacheRetentionPolicy | undefined {
  const maxBytes = positiveIntegerOrUndefined(env.WASMPLANE_RUNTIME_CACHE_MAX_BYTES);
  const maxAgeMs = positiveIntegerOrUndefined(env.WASMPLANE_RUNTIME_CACHE_MAX_AGE_MS);
  if (maxBytes === undefined && maxAgeMs === undefined) {
    return undefined;
  }
  return {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  };
}

export function parseRuntimeCacheGcIntervalMs(env: RuntimeConfigEnv): number | undefined {
  return positiveIntegerOrUndefined(env.WASMPLANE_RUNTIME_CACHE_GC_INTERVAL_MS);
}

export function parseRuntimeShutdownDrainTimeoutMs(env: RuntimeConfigEnv, fallback: number): number {
  return positiveInteger(env.RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS, fallback);
}

export function resolveRuntimeRouteSnapshotFile(env: RuntimeConfigEnv): string | undefined {
  return firstNonEmpty(env.RUNTIME_ROUTE_SNAPSHOT_FILE);
}

export function parseProjectConcurrencyLimits(env: RuntimeConfigEnv): Record<string, number> | undefined {
  const raw = env.RUNTIME_PROJECT_CONCURRENCY_LIMITS;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const limits: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const [projectId, value, ...rest] = entry.split("=");
    if (rest.length > 0 || !projectId || !value) {
      continue;
    }
    const trimmedProjectId = projectId.trim();
    const parsed = nonnegativeInteger(value.trim());
    if (trimmedProjectId.length === 0 || parsed === undefined) {
      continue;
    }
    limits[trimmedProjectId] = parsed;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

export function parseProjectRateLimits(env: RuntimeConfigEnv): Record<string, ProjectRateLimitConfig> | undefined {
  const raw = env.RUNTIME_PROJECT_RATE_LIMITS;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const limits: Record<string, ProjectRateLimitConfig> = {};
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const projectId = entry.slice(0, separator).trim();
    const [rateValue, burstValue, ...rest] = entry.slice(separator + 1).trim().split(":");
    const requestsPerSecond = nonnegativeNumber(rateValue);
    const burst = burstValue === undefined ? undefined : nonnegativeInteger(burstValue);
    if (
      projectId.length === 0
      || rest.length > 0
      || requestsPerSecond === undefined
      || (burstValue !== undefined && burst === undefined)
    ) {
      continue;
    }
    limits[projectId] = burst === undefined ? { requestsPerSecond } : { requestsPerSecond, burst };
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerOrUndefined(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

function nonnegativeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonnegativeNumber(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runtimeIdentityKeyId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);
}
