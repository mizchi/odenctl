import type { ProjectUsageSummary, UsageMetricName } from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export const USAGE_QUOTA_METRICS = [
  "invocations",
  "cpuMs",
  "wallMs",
  "memoryMbMs",
  "egressBytes",
  "storageBytes",
  "sqliteUnits",
] as const;

export type UsageQuotaMetric = (typeof USAGE_QUOTA_METRICS)[number];
export type UsageQuotaPeriodKind = "calendar_month";

export interface ProjectUsageQuotaPolicy {
  period?: UsageQuotaPeriodKind;
  invocations?: number;
  cpuMs?: number;
  wallMs?: number;
  memoryMbMs?: number;
  egressBytes?: number;
  storageBytes?: number;
  sqliteUnits?: number;
}

export type ProjectUsageQuotaPolicies = Record<string, ProjectUsageQuotaPolicy>;

export interface UsageQuotaPeriod {
  kind: UsageQuotaPeriodKind;
  key: string;
  from: string;
  to: string;
}

export interface UsageQuotaMeteredStatus {
  used: number;
  limit?: number;
  remaining?: number;
  status: "ok" | "exceeded" | "unlimited";
}

export interface ProjectUsageQuotaReport {
  projectId: string;
  organizationId?: string;
  generatedAt: string;
  period: UsageQuotaPeriod;
  limits: ProjectUsageQuotaPolicy;
  usage: ProjectUsageSummary["totals"];
  enforcement: Record<UsageQuotaMetric, UsageQuotaMeteredStatus>;
}

export function usageQuotaPeriodFor(
  at: string,
  policy: ProjectUsageQuotaPolicy | undefined,
): UsageQuotaPeriod {
  const kind = policy?.period ?? "calendar_month";
  if (kind !== "calendar_month") {
    throw new ControlPlaneError("validation", `usage quota period ${kind} is not supported`);
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new ControlPlaneError("validation", "usage quota timestamp must be a valid ISO datetime");
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return {
    kind,
    key: `${year.toString().padStart(4, "0")}-${(month + 1).toString().padStart(2, "0")}`,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

export function createProjectUsageQuotaReport(input: {
  summary: ProjectUsageSummary;
  period: UsageQuotaPeriod;
  policy?: ProjectUsageQuotaPolicy;
  generatedAt: string;
}): ProjectUsageQuotaReport {
  const limits = { period: "calendar_month" as const, ...(input.policy ?? {}) };
  return {
    projectId: input.summary.projectId,
    ...(input.summary.organizationId ? { organizationId: input.summary.organizationId } : {}),
    generatedAt: input.generatedAt,
    period: input.period,
    limits,
    usage: input.summary.totals,
    enforcement: Object.fromEntries(
      USAGE_QUOTA_METRICS.map((metric) => [
        metric,
        metered(input.summary.totals[metric], limits[metric]),
      ]),
    ) as Record<UsageQuotaMetric, UsageQuotaMeteredStatus>,
  };
}

export function enforceProjectUsageQuota(input: {
  projectId: string;
  policy: ProjectUsageQuotaPolicy | undefined;
  period: UsageQuotaPeriod;
  summary: ProjectUsageSummary;
  metric: UsageMetricName;
  quantity: number;
}) {
  const quotaMetric = usageMetricToQuotaMetric(input.metric);
  const limit = positiveLimit(input.policy?.[quotaMetric]);
  if (limit === undefined) {
    return;
  }
  const used = input.summary.totals[quotaMetric];
  const next = used + input.quantity;
  if (next > limit) {
    throw new ControlPlaneError(
      "validation",
      [
        `usage quota exceeded for project ${input.projectId}:`,
        `${quotaMetric} ${formatNumber(next)}/${formatNumber(limit)}`,
        `in ${input.period.key}`,
      ].join(" "),
    );
  }
}

export function projectUsageQuotasFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProjectUsageQuotaPolicies | undefined {
  const policies: ProjectUsageQuotaPolicies = {};
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_INVOCATION_LIMITS, "invocations");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_CPU_MS_LIMITS, "cpuMs");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_WALL_MS_LIMITS, "wallMs");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_MEMORY_MB_MS_LIMITS, "memoryMbMs");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_EGRESS_BYTES_LIMITS, "egressBytes");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_STORAGE_BYTES_LIMITS, "storageBytes");
  mergeNumberPolicies(policies, env.ODENCTL_USAGE_QUOTA_SQLITE_UNIT_LIMITS, "sqliteUnits");
  return Object.keys(policies).length > 0 ? policies : undefined;
}

function usageMetricToQuotaMetric(metric: UsageMetricName): UsageQuotaMetric {
  switch (metric) {
    case "invocation":
      return "invocations";
    case "cpu_ms":
      return "cpuMs";
    case "wall_ms":
      return "wallMs";
    case "memory_mb_ms":
      return "memoryMbMs";
    case "egress_bytes":
      return "egressBytes";
    case "storage_bytes":
      return "storageBytes";
    case "sqlite_unit":
      return "sqliteUnits";
  }
}

function metered(used: number, limit: number | undefined): UsageQuotaMeteredStatus {
  const normalizedLimit = positiveLimit(limit);
  if (normalizedLimit === undefined) {
    return { used, status: "unlimited" };
  }
  return {
    used,
    limit: normalizedLimit,
    remaining: Math.max(0, normalizedLimit - used),
    status: used > normalizedLimit ? "exceeded" : "ok",
  };
}

function mergeNumberPolicies(
  policies: ProjectUsageQuotaPolicies,
  raw: string | undefined,
  key: UsageQuotaMetric,
) {
  for (const [projectId, value] of parseProjectValues(raw)) {
    const parsed = positiveLimit(Number(value));
    if (parsed === undefined) {
      continue;
    }
    policies[projectId] = {
      period: "calendar_month",
      ...(policies[projectId] ?? {}),
      [key]: parsed,
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

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
