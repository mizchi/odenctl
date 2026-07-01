import type { ProjectUsageSummary, UsageMetricName } from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";
import {
  createProjectBillingStatement,
  type ProjectBillingRates,
  type ProjectBillingStatement,
} from "./billing-statement.ts";
import type { UsageQuotaPeriod, UsageQuotaPeriodKind } from "./usage-quota.ts";

export interface ProjectBillingBudgetPolicy {
  period?: UsageQuotaPeriodKind;
  maxUsd?: number;
}

export type ProjectBillingBudgetPolicies = Record<string, ProjectBillingBudgetPolicy>;

export interface ProjectBillingBudgetReport {
  projectId: string;
  organizationId?: string;
  generatedAt: string;
  period: UsageQuotaPeriod;
  limitUsd?: number;
  usedUsd: number;
  remainingUsd?: number;
  status: "ok" | "exceeded" | "unlimited";
  statement: ProjectBillingStatement;
}

export function createProjectBillingBudgetReport(input: {
  summary: ProjectUsageSummary;
  period: UsageQuotaPeriod;
  rates?: ProjectBillingRates;
  policy?: ProjectBillingBudgetPolicy;
  generatedAt: string;
}): ProjectBillingBudgetReport {
  const statement = createProjectBillingStatement({
    summary: input.summary,
    period: input.period,
    rates: input.rates,
    generatedAt: input.generatedAt,
  });
  const limitUsd = positiveUsd(input.policy?.maxUsd);
  const usedUsd = statement.totalUsd;
  return {
    projectId: input.summary.projectId,
    ...(input.summary.organizationId ? { organizationId: input.summary.organizationId } : {}),
    generatedAt: input.generatedAt,
    period: input.period,
    ...(limitUsd === undefined ? {} : { limitUsd }),
    usedUsd,
    ...(limitUsd === undefined ? {} : { remainingUsd: roundUsd(Math.max(0, limitUsd - usedUsd)) }),
    status: limitUsd === undefined ? "unlimited" : usedUsd > limitUsd ? "exceeded" : "ok",
    statement,
  };
}

export function enforceProjectBillingBudget(input: {
  projectId: string;
  policy: ProjectBillingBudgetPolicy | undefined;
  period: UsageQuotaPeriod;
  summary: ProjectUsageSummary;
  rates?: ProjectBillingRates;
  metric: UsageMetricName;
  quantity: number;
}) {
  const limitUsd = positiveUsd(input.policy?.maxUsd);
  if (limitUsd === undefined) {
    return;
  }
  const projected = createProjectBillingStatement({
    summary: addUsage(input.summary, input.metric, input.quantity),
    period: input.period,
    rates: input.rates,
    generatedAt: input.period.to,
  });
  if (projected.totalUsd <= limitUsd) {
    return;
  }
  throw new ControlPlaneError(
    "validation",
    [
      `billing budget exceeded for project ${input.projectId}:`,
      `$${formatUsd(projected.totalUsd)}/$${formatUsd(limitUsd)}`,
      `in ${input.period.key}`,
    ].join(" "),
  );
}

export function projectBillingBudgetsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProjectBillingBudgetPolicies | undefined {
  const policies: ProjectBillingBudgetPolicies = {};
  for (const [projectId, value] of parseProjectValues(env.WASMPLANE_BILLING_MONTHLY_USD_LIMITS)) {
    const maxUsd = positiveUsd(Number(value));
    if (maxUsd === undefined) {
      continue;
    }
    policies[projectId] = {
      period: "calendar_month",
      maxUsd,
    };
  }
  return Object.keys(policies).length > 0 ? policies : undefined;
}

function addUsage(
  summary: ProjectUsageSummary,
  metric: UsageMetricName,
  quantity: number,
): ProjectUsageSummary {
  const totals = { ...summary.totals };
  totals[usageMetricToBillingTotal(metric)] += quantity;
  return {
    ...summary,
    totals,
  };
}

function usageMetricToBillingTotal(metric: UsageMetricName): keyof ProjectUsageSummary["totals"] {
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

function positiveUsd(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return roundUsd(value);
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
