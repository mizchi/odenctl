import { ControlPlaneError } from "./errors.ts";
import type { ProjectResourceUsage } from "./repository.ts";

export interface ProjectQuotas {
  maxArtifacts?: number;
  maxDeployments?: number;
  maxRoutes?: number;
  maxSecrets?: number;
  maxKvNamespaces?: number;
}

export type ProjectQuotaResource =
  | "artifact"
  | "deployment"
  | "route"
  | "secret"
  | "kv namespace";

export function enforceProjectQuota(
  projectId: string,
  quotas: ProjectQuotas | undefined,
  usage: ProjectResourceUsage,
  resource: ProjectQuotaResource,
) {
  const limit = quotaLimit(quotas, resource);
  if (limit === undefined) {
    return;
  }
  const count = usageCount(usage, resource);
  if (count >= limit) {
    throw new ControlPlaneError(
      "validation",
      `${resource} quota exceeded for project ${projectId}: ${count}/${limit}`,
    );
  }
}

export function projectQuotasFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProjectQuotas | undefined {
  const quotas: ProjectQuotas = {
    maxArtifacts: positiveLimit(envInteger(env.WASMPLANE_QUOTA_MAX_ARTIFACTS)),
    maxDeployments: positiveLimit(envInteger(env.WASMPLANE_QUOTA_MAX_DEPLOYMENTS)),
    maxRoutes: positiveLimit(envInteger(env.WASMPLANE_QUOTA_MAX_ROUTES)),
    maxSecrets: positiveLimit(envInteger(env.WASMPLANE_QUOTA_MAX_SECRETS)),
    maxKvNamespaces: positiveLimit(envInteger(env.WASMPLANE_QUOTA_MAX_KV_NAMESPACES)),
  };
  return Object.values(quotas).some((value) => value !== undefined) ? quotas : undefined;
}

function quotaLimit(quotas: ProjectQuotas | undefined, resource: ProjectQuotaResource): number | undefined {
  switch (resource) {
    case "artifact":
      return positiveLimit(quotas?.maxArtifacts);
    case "deployment":
      return positiveLimit(quotas?.maxDeployments);
    case "route":
      return positiveLimit(quotas?.maxRoutes);
    case "secret":
      return positiveLimit(quotas?.maxSecrets);
    case "kv namespace":
      return positiveLimit(quotas?.maxKvNamespaces);
  }
}

function usageCount(usage: ProjectResourceUsage, resource: ProjectQuotaResource): number {
  switch (resource) {
    case "artifact":
      return usage.artifacts;
    case "deployment":
      return usage.deployments;
    case "route":
      return usage.routes;
    case "secret":
      return usage.secrets;
    case "kv namespace":
      return usage.kvNamespaces;
  }
}

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function envInteger(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
