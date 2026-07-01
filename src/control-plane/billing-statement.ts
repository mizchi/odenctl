import type { ProjectUsageSummary } from "./contracts.ts";
import type { UsageQuotaPeriod } from "./usage-quota.ts";

export type ProjectBillingMetric =
  | "invocations"
  | "cpuMs"
  | "wallMs"
  | "memoryMbMs"
  | "egressBytes"
  | "storageBytes"
  | "sqliteUnits";

export interface ProjectBillingRates {
  invocationsPerMillionUsd?: number;
  cpuMsPerMillionUsd?: number;
  wallMsPerMillionUsd?: number;
  memoryMbMsPerMillionUsd?: number;
  egressGbUsd?: number;
  storageGbMonthUsd?: number;
  sqliteUnitUsd?: number;
}

export interface ProjectBillingLineItem {
  metric: ProjectBillingMetric;
  quantity: number;
  unit: string;
  unitPriceUsd: number;
  amountUsd: number;
}

export interface ProjectBillingStatement {
  projectId: string;
  organizationId?: string;
  generatedAt: string;
  currency: "USD";
  period: UsageQuotaPeriod;
  usage: ProjectUsageSummary["totals"];
  lineItems: ProjectBillingLineItem[];
  totalUsd: number;
}

export interface OrganizationBillingStatement {
  organizationId: string;
  generatedAt: string;
  currency: "USD";
  period: UsageQuotaPeriod;
  usage: ProjectUsageSummary["totals"];
  projects: ProjectBillingStatement[];
  totalUsd: number;
}

export function createProjectBillingStatement(input: {
  summary: ProjectUsageSummary;
  period: UsageQuotaPeriod;
  rates?: ProjectBillingRates;
  generatedAt: string;
}): ProjectBillingStatement {
  const rates = input.rates ?? {};
  const totals = input.summary.totals;
  const lineItems = [
    lineItem("invocations", totals.invocations / 1_000_000, "million invocations", rates.invocationsPerMillionUsd),
    lineItem("cpuMs", totals.cpuMs / 1_000_000, "million cpu ms", rates.cpuMsPerMillionUsd),
    lineItem("wallMs", totals.wallMs / 1_000_000, "million wall ms", rates.wallMsPerMillionUsd),
    lineItem("memoryMbMs", totals.memoryMbMs / 1_000_000, "million MB-ms", rates.memoryMbMsPerMillionUsd),
    lineItem("egressBytes", totals.egressBytes / 1024 ** 3, "GB", rates.egressGbUsd),
    lineItem("storageBytes", totals.storageBytes / 1024 ** 3, "GB-month", rates.storageGbMonthUsd),
    lineItem("sqliteUnits", totals.sqliteUnits, "unit-month", rates.sqliteUnitUsd),
  ].filter((item): item is ProjectBillingLineItem => item !== undefined);

  return {
    projectId: input.summary.projectId,
    ...(input.summary.organizationId ? { organizationId: input.summary.organizationId } : {}),
    generatedAt: input.generatedAt,
    currency: "USD",
    period: input.period,
    usage: totals,
    lineItems,
    totalUsd: roundUsd(lineItems.reduce((sum, item) => sum + item.amountUsd, 0)),
  };
}

export function createOrganizationBillingStatement(input: {
  organizationId: string;
  summaries: ProjectUsageSummary[];
  period: UsageQuotaPeriod;
  rates?: ProjectBillingRates;
  generatedAt: string;
}): OrganizationBillingStatement {
  const projects = input.summaries.map((summary) =>
    createProjectBillingStatement({
      summary,
      period: input.period,
      rates: input.rates,
      generatedAt: input.generatedAt,
    })
  );
  return {
    organizationId: input.organizationId,
    generatedAt: input.generatedAt,
    currency: "USD",
    period: input.period,
    usage: sumUsage(input.summaries),
    projects,
    totalUsd: roundUsd(projects.reduce((sum, project) => sum + project.totalUsd, 0)),
  };
}

export function projectBillingRatesFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProjectBillingRates | undefined {
  const rates: ProjectBillingRates = {
    ...numberRate("invocationsPerMillionUsd", env.WASMPLANE_BILLING_INVOCATION_PER_MILLION_USD),
    ...numberRate("cpuMsPerMillionUsd", env.WASMPLANE_BILLING_CPU_MS_PER_MILLION_USD),
    ...numberRate("wallMsPerMillionUsd", env.WASMPLANE_BILLING_WALL_MS_PER_MILLION_USD),
    ...numberRate("memoryMbMsPerMillionUsd", env.WASMPLANE_BILLING_MEMORY_MB_MS_PER_MILLION_USD),
    ...numberRate("egressGbUsd", env.WASMPLANE_BILLING_EGRESS_GB_USD),
    ...numberRate("storageGbMonthUsd", env.WASMPLANE_BILLING_STORAGE_GB_MONTH_USD),
    ...numberRate("sqliteUnitUsd", env.WASMPLANE_BILLING_SQLITE_UNIT_USD),
  };
  return Object.keys(rates).length > 0 ? rates : undefined;
}

function lineItem(
  metric: ProjectBillingMetric,
  quantity: number,
  unit: string,
  unitPriceUsd: number | undefined,
): ProjectBillingLineItem | undefined {
  const price = positiveRate(unitPriceUsd);
  if (price === undefined) {
    return undefined;
  }
  const roundedQuantity = roundQuantity(quantity);
  return {
    metric,
    quantity: roundedQuantity,
    unit,
    unitPriceUsd: price,
    amountUsd: roundUsd(roundedQuantity * price),
  };
}

function numberRate<K extends keyof ProjectBillingRates>(
  key: K,
  raw: string | undefined,
): Pick<ProjectBillingRates, K> | Record<string, never> {
  const rate = positiveRate(raw === undefined ? undefined : Number(raw));
  return rate === undefined ? {} : { [key]: rate } as Pick<ProjectBillingRates, K>;
}

function positiveRate(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function roundQuantity(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumUsage(summaries: ProjectUsageSummary[]): ProjectUsageSummary["totals"] {
  return summaries.reduce(
    (totals, summary) => ({
      invocations: totals.invocations + summary.totals.invocations,
      cpuMs: totals.cpuMs + summary.totals.cpuMs,
      wallMs: totals.wallMs + summary.totals.wallMs,
      memoryMbMs: totals.memoryMbMs + summary.totals.memoryMbMs,
      egressBytes: totals.egressBytes + summary.totals.egressBytes,
      storageBytes: totals.storageBytes + summary.totals.storageBytes,
      sqliteUnits: totals.sqliteUnits + summary.totals.sqliteUnits,
    }),
    {
      invocations: 0,
      cpuMs: 0,
      wallMs: 0,
      memoryMbMs: 0,
      egressBytes: 0,
      storageBytes: 0,
      sqliteUnits: 0,
    },
  );
}
