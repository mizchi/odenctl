import type { ProjectUsageSummary } from "./contracts.ts";
import type { ProjectResourceUsage } from "./repository.ts";

export interface ProjectEnforcementRatePolicy {
  requestsPerSecond: number;
  burst?: number;
}

export interface ProjectEnforcementPolicy {
  cpuMs?: number;
  memoryMbMs?: number;
  storageBytes?: number;
  concurrency?: number;
  rate?: ProjectEnforcementRatePolicy;
}

export type ProjectEnforcementPolicies = Record<string, ProjectEnforcementPolicy>;

export interface ProjectEnforcementReport {
  projectId: string;
  organizationId?: string;
  generatedAt: string;
  from?: string;
  to?: string;
  policy: ProjectEnforcementPolicy;
  usage: {
    cpuMs: number;
    memoryMbMs: number;
    storageBytes: number;
  };
  resources: ProjectResourceUsage;
  enforcement: {
    cpu: MeteredEnforcement;
    memory: MeteredEnforcement;
    storage: MeteredEnforcement;
    concurrency: ConfiguredEnforcement;
    rate: RateEnforcement;
  };
}

export interface MeteredEnforcement {
  used: number;
  limit?: number;
  remaining?: number;
  status: "ok" | "exceeded" | "unlimited";
}

export interface ConfiguredEnforcement {
  limit?: number;
  status: "configured" | "unlimited";
}

export interface RateEnforcement {
  requestsPerSecond?: number;
  burst?: number;
  status: "configured" | "unlimited";
}

export function createProjectEnforcementReport(input: {
  summary: ProjectUsageSummary;
  resources: ProjectResourceUsage;
  policy?: ProjectEnforcementPolicy;
  generatedAt: string;
}): ProjectEnforcementReport {
  const policy = input.policy ?? {};
  return {
    projectId: input.summary.projectId,
    ...(input.summary.organizationId ? { organizationId: input.summary.organizationId } : {}),
    generatedAt: input.generatedAt,
    ...(input.summary.from ? { from: input.summary.from } : {}),
    ...(input.summary.to ? { to: input.summary.to } : {}),
    policy,
    usage: {
      cpuMs: input.summary.totals.cpuMs,
      memoryMbMs: input.summary.totals.memoryMbMs,
      storageBytes: input.summary.totals.storageBytes,
    },
    resources: input.resources,
    enforcement: {
      cpu: metered(input.summary.totals.cpuMs, policy.cpuMs),
      memory: metered(input.summary.totals.memoryMbMs, policy.memoryMbMs),
      storage: metered(input.summary.totals.storageBytes, policy.storageBytes),
      concurrency: configured(policy.concurrency),
      rate: rate(policy.rate),
    },
  };
}

export function projectEnforcementPoliciesFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProjectEnforcementPolicies | undefined {
  const policies: ProjectEnforcementPolicies = {};
  mergeNumberPolicies(policies, env.WASMPLANE_ENFORCEMENT_CPU_MS_LIMITS, "cpuMs");
  mergeNumberPolicies(policies, env.WASMPLANE_ENFORCEMENT_MEMORY_MB_MS_LIMITS, "memoryMbMs");
  mergeNumberPolicies(policies, env.WASMPLANE_ENFORCEMENT_STORAGE_BYTES_LIMITS, "storageBytes");
  mergeNumberPolicies(policies, env.WASMPLANE_ENFORCEMENT_CONCURRENCY_LIMITS, "concurrency");
  mergeRatePolicies(policies, env.WASMPLANE_ENFORCEMENT_RATE_LIMITS);
  return Object.keys(policies).length > 0 ? policies : undefined;
}

function metered(used: number, limit: number | undefined): MeteredEnforcement {
  if (limit === undefined) {
    return { used, status: "unlimited" };
  }
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    status: used > limit ? "exceeded" : "ok",
  };
}

function configured(limit: number | undefined): ConfiguredEnforcement {
  return limit === undefined ? { status: "unlimited" } : { limit, status: "configured" };
}

function rate(value: ProjectEnforcementRatePolicy | undefined): RateEnforcement {
  return value
    ? {
      requestsPerSecond: value.requestsPerSecond,
      ...(value.burst !== undefined ? { burst: value.burst } : {}),
      status: "configured",
    }
    : { status: "unlimited" };
}

function mergeNumberPolicies(
  policies: ProjectEnforcementPolicies,
  raw: string | undefined,
  key: keyof Pick<ProjectEnforcementPolicy, "cpuMs" | "memoryMbMs" | "storageBytes" | "concurrency">,
) {
  for (const [projectId, value] of parseProjectValues(raw)) {
    const parsed = positiveNumber(value);
    if (parsed === undefined) {
      continue;
    }
    policies[projectId] = { ...(policies[projectId] ?? {}), [key]: parsed };
  }
}

function mergeRatePolicies(policies: ProjectEnforcementPolicies, raw: string | undefined) {
  for (const [projectId, value] of parseProjectValues(raw)) {
    const [rateValue, burstValue, ...rest] = value.split(":");
    const requestsPerSecond = positiveNumber(rateValue);
    const burst = burstValue === undefined ? undefined : positiveNumber(burstValue);
    if (rest.length > 0 || requestsPerSecond === undefined || (burstValue !== undefined && burst === undefined)) {
      continue;
    }
    policies[projectId] = {
      ...(policies[projectId] ?? {}),
      rate: { requestsPerSecond, ...(burst !== undefined ? { burst } : {}) },
    };
  }
}

function parseProjectValues(raw: string | undefined): Array<[string, string]> {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw.split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      return [];
    }
    const projectId = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    return projectId && value ? [[projectId, value] as [string, string]] : [];
  });
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
