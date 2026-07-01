import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { BenchmarkReport, BenchmarkResult } from "./bench.ts";
import type {
  ClusterAutoscalingResult,
  ClusterBenchmarkReport,
  ClusterPlacementResult,
  ClusterSwitchResult,
  ClusterThroughputResult,
} from "./cluster-bench.ts";

export interface PerfBenchmarkBudget {
  name: string;
  concurrency?: number;
  nodes?: number;
  maxP95Ms?: number;
  maxAvgMs?: number;
  minThroughputRps?: number;
  maxErrors?: number;
  maxErrorRate?: number;
}

export interface PerfClusterEventBudget {
  name: string;
  nodes?: number;
  requireOk?: boolean;
  maxPublishMs?: number;
  maxVisibleMs?: number;
  maxTotalMs?: number;
  maxErrors?: number;
}

export interface PerfBudgetConfig {
  schemaVersion: 1;
  benchmarkBudgets?: PerfBenchmarkBudget[];
  clusterSwitchBudgets?: PerfClusterEventBudget[];
  clusterPlacementBudgets?: PerfClusterEventBudget[];
  clusterAutoscalingBudgets?: PerfClusterEventBudget[];
}

export interface PerfRegressionFinding {
  kind: "benchmark" | "cluster.switch" | "cluster.placement" | "cluster.autoscaling";
  name: string;
  metric: string;
  actual?: number | boolean;
  limit?: number | boolean;
  message: string;
}

export interface PerfRegressionCheck {
  kind: PerfRegressionFinding["kind"];
  name: string;
  dimensions: Record<string, number | string>;
  ok: boolean;
}

export interface PerfRegressionReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  checked: PerfRegressionCheck[];
  findings: PerfRegressionFinding[];
}

export interface PerfRegressionCliOptions {
  budgetPath: string;
  inputPaths: string[];
  outputPath?: string;
}

type BenchmarkRow = BenchmarkResult | ClusterThroughputResult;
type ClusterEventRow = ClusterSwitchResult | ClusterPlacementResult | ClusterAutoscalingResult;

export function evaluatePerfBudgets(
  reports: unknown[],
  budget: PerfBudgetConfig,
): PerfRegressionReport {
  const findings: PerfRegressionFinding[] = [];
  const checked: PerfRegressionCheck[] = [];
  const benchmarkRows = collectBenchmarkRows(reports);
  const clusterReports = reports.filter(isClusterBenchmarkReport);

  for (const item of budget.benchmarkBudgets ?? []) {
    const matches = benchmarkRows.filter((row) => benchmarkMatches(row, item));
    if (matches.length === 0) {
      findings.push(missingFinding("benchmark", item.name, budgetDimensions(item)));
      continue;
    }
    for (const row of matches) {
      const before = findings.length;
      evaluateBenchmarkBudget(row, item, findings);
      checked.push({
        kind: "benchmark",
        name: row.name,
        dimensions: rowDimensions(row),
        ok: findings.length === before,
      });
    }
  }

  evaluateClusterEventBudgets(
    "cluster.switch",
    clusterReports.flatMap((report) => report.switches),
    budget.clusterSwitchBudgets ?? [],
    findings,
    checked,
  );
  evaluateClusterEventBudgets(
    "cluster.placement",
    clusterReports.flatMap((report) => report.placements),
    budget.clusterPlacementBudgets ?? [],
    findings,
    checked,
  );
  evaluateClusterEventBudgets(
    "cluster.autoscaling",
    clusterReports.flatMap((report) => report.autoscaling),
    budget.clusterAutoscalingBudgets ?? [],
    findings,
    checked,
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: findings.length === 0,
    checked,
    findings,
  };
}

export function formatPerfRegressionMarkdown(report: PerfRegressionReport): string {
  const lines = [
    "# wasmplane perf regression",
    "",
    `generated: ${report.generatedAt}`,
    `status: ${report.ok ? "pass" : "fail"}`,
    "",
    "## findings",
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No budget regressions detected.");
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${finding.message}`);
    }
  }
  lines.push(
    "",
    "## checked budgets",
    "",
    "| kind | name | dimensions | ok |",
    "| --- | --- | --- | --- |",
  );
  for (const check of report.checked) {
    lines.push(
      `| ${check.kind} | ${check.name} | ${formatDimensions(check.dimensions)} | ${check.ok ? "yes" : "no"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parsePerfRegressionArgs(args: string[]): PerfRegressionCliOptions {
  const options: PerfRegressionCliOptions = {
    budgetPath: "",
    inputPaths: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--budget":
        options.budgetPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--input":
        options.inputPaths.push(requiredValue(flag, value));
        index += 1;
        break;
      case "--output":
        options.outputPath = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown perf regression argument ${flag}`);
    }
  }
  if (!options.budgetPath) {
    throw new Error("expected --budget <path>");
  }
  if (options.inputPaths.length === 0) {
    throw new Error("expected at least one --input <path>");
  }
  return options;
}

function evaluateBenchmarkBudget(
  row: BenchmarkRow,
  budget: PerfBenchmarkBudget,
  findings: PerfRegressionFinding[],
) {
  if (budget.maxP95Ms !== undefined && row.p95Ms > budget.maxP95Ms) {
    findings.push(metricFinding("benchmark", row.name, "p95Ms", row.p95Ms, ">", budget.maxP95Ms));
  }
  if (budget.maxAvgMs !== undefined && row.avgMs > budget.maxAvgMs) {
    findings.push(metricFinding("benchmark", row.name, "avgMs", row.avgMs, ">", budget.maxAvgMs));
  }
  if (budget.minThroughputRps !== undefined && row.throughputRps < budget.minThroughputRps) {
    findings.push(metricFinding(
      "benchmark",
      row.name,
      "throughputRps",
      row.throughputRps,
      "<",
      budget.minThroughputRps,
    ));
  }
  if (budget.maxErrors !== undefined && row.errors > budget.maxErrors) {
    findings.push(metricFinding("benchmark", row.name, "errors", row.errors, ">", budget.maxErrors));
  }
  if (budget.maxErrorRate !== undefined) {
    const errorRate = row.count === 0 ? row.errors : row.errors / row.count;
    if (errorRate > budget.maxErrorRate) {
      findings.push(metricFinding("benchmark", row.name, "errorRate", round4(errorRate), ">", budget.maxErrorRate));
    }
  }
}

function evaluateClusterEventBudgets(
  kind: PerfRegressionFinding["kind"],
  rows: ClusterEventRow[],
  budgets: PerfClusterEventBudget[],
  findings: PerfRegressionFinding[],
  checked: PerfRegressionCheck[],
) {
  for (const budget of budgets) {
    const matches = rows.filter((row) => clusterEventMatches(row, budget));
    if (matches.length === 0) {
      findings.push(missingFinding(kind, budget.name, budgetDimensions(budget)));
      continue;
    }
    for (const row of matches) {
      const before = findings.length;
      evaluateClusterEventBudget(kind, row, budget, findings);
      checked.push({
        kind,
        name: row.name,
        dimensions: rowDimensions(row),
        ok: findings.length === before,
      });
    }
  }
}

function evaluateClusterEventBudget(
  kind: PerfRegressionFinding["kind"],
  row: ClusterEventRow,
  budget: PerfClusterEventBudget,
  findings: PerfRegressionFinding[],
) {
  if (budget.requireOk && !row.ok) {
    findings.push({
      kind,
      name: row.name,
      metric: "ok",
      actual: row.ok,
      limit: true,
      message: `${row.name} ok ${row.ok} did not satisfy requireOk`,
    });
  }
  if (budget.maxPublishMs !== undefined && row.publishMs > budget.maxPublishMs) {
    findings.push(metricFinding(kind, row.name, "publishMs", row.publishMs, ">", budget.maxPublishMs));
  }
  const visibleMs = clusterVisibleMs(row);
  if (budget.maxVisibleMs !== undefined && visibleMs !== undefined && visibleMs > budget.maxVisibleMs) {
    findings.push(metricFinding(kind, row.name, "visibleMs", visibleMs, ">", budget.maxVisibleMs));
  }
  if (budget.maxTotalMs !== undefined && row.totalMs > budget.maxTotalMs) {
    findings.push(metricFinding(kind, row.name, "totalMs", row.totalMs, ">", budget.maxTotalMs));
  }
  if (budget.maxErrors !== undefined && row.errors > budget.maxErrors) {
    findings.push(metricFinding(kind, row.name, "errors", row.errors, ">", budget.maxErrors));
  }
}

function metricFinding(
  kind: PerfRegressionFinding["kind"],
  name: string,
  metric: string,
  actual: number,
  operator: ">" | "<",
  limit: number,
): PerfRegressionFinding {
  return {
    kind,
    name,
    metric,
    actual,
    limit,
    message: `${name} ${metric} ${actual} ${operator} budget ${limit}`,
  };
}

function missingFinding(
  kind: PerfRegressionFinding["kind"],
  name: string,
  dimensions: Record<string, number | string>,
): PerfRegressionFinding {
  const suffix = Object.keys(dimensions).length > 0 ? ` (${formatDimensions(dimensions)})` : "";
  return {
    kind,
    name,
    metric: "missing",
    message: `${kind} ${name} is missing${suffix}`,
  };
}

function collectBenchmarkRows(reports: unknown[]): BenchmarkRow[] {
  const rows: BenchmarkRow[] = [];
  for (const report of reports) {
    if (isBenchmarkReport(report)) {
      rows.push(...report.results);
    } else if (isClusterBenchmarkReport(report)) {
      rows.push(...report.throughput);
    }
  }
  return rows;
}

function isBenchmarkReport(value: unknown): value is BenchmarkReport {
  const report = value as BenchmarkReport;
  return Array.isArray(report?.results);
}

function isClusterBenchmarkReport(value: unknown): value is ClusterBenchmarkReport {
  const report = value as ClusterBenchmarkReport;
  return Array.isArray(report?.throughput)
    && Array.isArray(report?.switches)
    && Array.isArray(report?.placements)
    && Array.isArray(report?.autoscaling);
}

function benchmarkMatches(row: BenchmarkRow, budget: PerfBenchmarkBudget): boolean {
  return row.name === budget.name
    && (budget.concurrency === undefined || row.concurrency === budget.concurrency)
    && (budget.nodes === undefined || ("nodes" in row && row.nodes === budget.nodes));
}

function clusterEventMatches(row: ClusterEventRow, budget: PerfClusterEventBudget): boolean {
  return row.name === budget.name
    && (budget.nodes === undefined || row.nodes === budget.nodes);
}

function rowDimensions(row: BenchmarkRow | ClusterEventRow): Record<string, number | string> {
  const dimensions: Record<string, number | string> = {};
  if ("nodes" in row) {
    dimensions.nodes = row.nodes;
  }
  if ("concurrency" in row) {
    dimensions.concurrency = row.concurrency;
  }
  if ("action" in row) {
    dimensions.action = row.action;
  }
  if ("region" in row) {
    dimensions.region = row.region;
  }
  return dimensions;
}

function budgetDimensions(
  budget: PerfBenchmarkBudget | PerfClusterEventBudget,
): Record<string, number | string> {
  const dimensions: Record<string, number | string> = {};
  if (budget.nodes !== undefined) {
    dimensions.nodes = budget.nodes;
  }
  if ("concurrency" in budget && budget.concurrency !== undefined) {
    dimensions.concurrency = budget.concurrency;
  }
  return dimensions;
}

function clusterVisibleMs(row: ClusterEventRow): number | undefined {
  if ("visibleAfterPublishMs" in row) {
    return row.visibleAfterPublishMs;
  }
  if ("selectedVisibleMs" in row) {
    return row.selectedVisibleMs;
  }
  if ("visibleMs" in row) {
    return row.visibleMs;
  }
  return undefined;
}

function formatDimensions(dimensions: Record<string, number | string>): string {
  const entries = Object.entries(dimensions);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

async function main() {
  const options = parsePerfRegressionArgs(process.argv.slice(2));
  const budget = JSON.parse(await readFile(options.budgetPath, "utf8")) as PerfBudgetConfig;
  const reports = await Promise.all(
    options.inputPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  const report = evaluatePerfBudgets(reports, budget);
  const markdown = formatPerfRegressionMarkdown(report);
  if (options.outputPath) {
    await writeFile(options.outputPath, markdown);
  } else {
    process.stdout.write(markdown);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
