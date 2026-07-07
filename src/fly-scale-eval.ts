import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { BenchmarkReport, BenchOptions } from "./bench.ts";
import { formatBenchmarkMarkdown, runBenchmarkSuite } from "./bench.ts";
import { runOpsSmoke, type OpsSmokeResult } from "./ops-smoke.ts";

const execFileAsync = promisify(execFile);

export interface FlyScaleEvaluationOptions {
  controlApp: string;
  runtimeApp: string;
  collectorApp: string;
  region: string;
  controlUrl: string;
  runtimeUrl: string;
  collectorUrl: string;
  controlToken?: string;
  runtimeToken?: string;
  targetRuntimeMachines: number;
  workerHost: string;
  workerPath: string;
  iterations: number;
  warmup: number;
  concurrency: number[];
  requireExternalDatabase: boolean;
  failureDrill: boolean;
  scaleWaitMs: number;
  restartRuntimeMachineId?: string;
  restartControlMachineId?: string;
  volumeSqliteDrillId?: string;
  maxP95Ms?: number;
  maxErrorRate?: number;
  minThroughputRps?: number;
  maxPublishMs?: number;
  execute: boolean;
  format: "markdown" | "json";
  output?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  commandRunner?: CommandRunner;
  benchmarkRunner?: BenchmarkRunner;
}

export interface FlyScaleEvaluationPlanStep {
  name: string;
  command: string;
  destructive?: boolean;
}

export interface FlyScaleEvaluationStepResult extends FlyScaleEvaluationPlanStep {
  status: "planned" | "ok" | "failed";
  elapsedMs?: number;
  detail?: string;
}

export interface FlyScaleEvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  executed: boolean;
  steps: FlyScaleEvaluationStepResult[];
  slo?: FlyScaleEvaluationSloReport;
  smoke?: OpsSmokeResult;
  benchmark?: BenchmarkReport;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type BenchmarkRunner = (options: BenchOptions) => Promise<BenchmarkReport>;

export interface FlyScaleEvaluationSloReport {
  ok: boolean;
  checks: FlyScaleEvaluationSloCheck[];
}

export interface FlyScaleEvaluationSloCheck {
  name: string;
  ok: boolean;
  threshold: number;
  value?: number;
  detail?: string;
}

export function parseFlyScaleEvaluationArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): FlyScaleEvaluationOptions {
  const options: FlyScaleEvaluationOptions = {
    controlApp: env.FLY_CONTROL_APP ?? "mz-wasmplane-control",
    runtimeApp: env.FLY_RUNTIME_APP ?? "mz-wasmplane-runtime",
    collectorApp: env.FLY_COLLECTOR_APP ?? "mz-wasmplane-otel-collector",
    region: env.FLY_REGION ?? "nrt",
    controlUrl: normalizeBaseUrl(env.WASMPLANE_CONTROL_PLANE_URL ?? flyUrl(env.FLY_CONTROL_APP ?? "mz-wasmplane-control")),
    runtimeUrl: normalizeBaseUrl(env.WASMPLANE_RUNTIME_URL ?? flyUrl(env.FLY_RUNTIME_APP ?? "mz-wasmplane-runtime")),
    collectorUrl: normalizeBaseUrl(
      env.WASMPLANE_COLLECTOR_URL ?? flyUrl(env.FLY_COLLECTOR_APP ?? "mz-wasmplane-otel-collector"),
    ),
    controlToken: nonEmpty(env.WASMPLANE_CONTROL_PLANE_TOKEN ?? env.CONTROL_PLANE_TOKEN),
    runtimeToken: nonEmpty(env.WASMPLANE_RUNTIME_TOKEN),
    targetRuntimeMachines: positiveInteger(env.WASMPLANE_FLY_EVAL_RUNTIME_MACHINES, 2),
    workerHost: env.WASMPLANE_SMOKE_WORKER_HOST ?? "hello.example.dev",
    workerPath: ensurePath(env.WASMPLANE_SMOKE_WORKER_PATH ?? "/"),
    iterations: positiveInteger(env.WASMPLANE_FLY_EVAL_ITERATIONS, 300),
    warmup: nonnegativeInteger(env.WASMPLANE_FLY_EVAL_WARMUP, 10),
    concurrency: parseIntegerList(env.WASMPLANE_FLY_EVAL_CONCURRENCY ?? "1,8,32,64,128"),
    requireExternalDatabase: env.WASMPLANE_FLY_EVAL_REQUIRE_EXTERNAL_DB !== "0",
    failureDrill: envFlag(env.WASMPLANE_FLY_EVAL_FAILURE_DRILL),
    scaleWaitMs: positiveInteger(env.WASMPLANE_FLY_EVAL_SCALE_WAIT_MS, 30_000),
    maxP95Ms: optionalPositiveNumber(env.WASMPLANE_FLY_EVAL_MAX_P95_MS, "WASMPLANE_FLY_EVAL_MAX_P95_MS"),
    maxErrorRate: optionalRate(env.WASMPLANE_FLY_EVAL_MAX_ERROR_RATE, "WASMPLANE_FLY_EVAL_MAX_ERROR_RATE"),
    minThroughputRps: optionalPositiveNumber(
      env.WASMPLANE_FLY_EVAL_MIN_THROUGHPUT_RPS,
      "WASMPLANE_FLY_EVAL_MIN_THROUGHPUT_RPS",
    ),
    maxPublishMs: optionalPositiveNumber(env.WASMPLANE_FLY_EVAL_MAX_PUBLISH_MS, "WASMPLANE_FLY_EVAL_MAX_PUBLISH_MS"),
    execute: false,
    format: "markdown",
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--") {
      continue;
    }
    switch (flag) {
      case "--control-app":
        options.controlApp = requiredValue(flag, value);
        options.controlUrl = flyUrl(options.controlApp);
        index += 1;
        break;
      case "--runtime-app":
        options.runtimeApp = requiredValue(flag, value);
        options.runtimeUrl = flyUrl(options.runtimeApp);
        index += 1;
        break;
      case "--collector-app":
        options.collectorApp = requiredValue(flag, value);
        options.collectorUrl = flyUrl(options.collectorApp);
        index += 1;
        break;
      case "--region":
        options.region = requiredValue(flag, value);
        index += 1;
        break;
      case "--control-url":
        options.controlUrl = normalizeBaseUrl(requiredValue(flag, value));
        index += 1;
        break;
      case "--runtime-url":
        options.runtimeUrl = normalizeBaseUrl(requiredValue(flag, value));
        index += 1;
        break;
      case "--collector-url":
        options.collectorUrl = normalizeBaseUrl(requiredValue(flag, value));
        index += 1;
        break;
      case "--control-token":
        options.controlToken = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-token":
        options.runtimeToken = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-machines":
        options.targetRuntimeMachines = positiveInteger(requiredValue(flag, value), undefined, flag);
        index += 1;
        break;
      case "--host":
        options.workerHost = requiredValue(flag, value);
        index += 1;
        break;
      case "--path":
        options.workerPath = ensurePath(requiredValue(flag, value));
        index += 1;
        break;
      case "--iterations":
        options.iterations = positiveInteger(requiredValue(flag, value), undefined, flag);
        index += 1;
        break;
      case "--warmup":
        options.warmup = nonnegativeInteger(requiredValue(flag, value), undefined, flag);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parseIntegerList(requiredValue(flag, value));
        index += 1;
        break;
      case "--scale-wait-ms":
        options.scaleWaitMs = positiveInteger(requiredValue(flag, value), undefined, flag);
        index += 1;
        break;
      case "--restart-runtime-machine":
        options.restartRuntimeMachineId = requiredValue(flag, value);
        index += 1;
        break;
      case "--restart-control-machine":
        options.restartControlMachineId = requiredValue(flag, value);
        index += 1;
        break;
      case "--volume-sqlite-drill-id":
        options.volumeSqliteDrillId = requiredValue(flag, value);
        index += 1;
        break;
      case "--max-p95-ms":
        options.maxP95Ms = positiveNumber(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-error-rate":
        options.maxErrorRate = rateNumber(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--min-throughput-rps":
        options.minThroughputRps = positiveNumber(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-publish-ms":
        options.maxPublishMs = positiveNumber(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--skip-external-db-check":
        options.requireExternalDatabase = false;
        break;
      case "--skip-failure-drill":
        options.failureDrill = false;
        break;
      case "--failure-drill":
        options.failureDrill = true;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--format":
        options.format = parseFormat(requiredValue(flag, value));
        index += 1;
        break;
      case "--json":
        options.format = "json";
        break;
      case "--output":
        options.output = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown fly scale evaluation argument ${flag}`);
    }
  }
  return options;
}

export function buildFlyScaleEvaluationPlan(options: FlyScaleEvaluationOptions): FlyScaleEvaluationPlanStep[] {
  const steps: FlyScaleEvaluationPlanStep[] = [
    {
      name: "scale runtime machines",
      command: [
        "fly scale count",
        options.targetRuntimeMachines,
        "-a",
        options.runtimeApp,
        "-r",
        options.region,
        "--with-new-volumes --yes",
      ].join(" "),
    },
    {
      name: "publish route snapshot",
      command: `POST ${options.controlUrl}/snapshots/routes/publish`,
    },
    {
      name: "production smoke",
      command: [
        "pnpm ops-smoke --",
        options.requireExternalDatabase ? "--require-external-db" : "",
        "--min-runtime-nodes",
        options.targetRuntimeMachines,
      ].filter(Boolean).join(" "),
    },
    {
      name: "http throughput benchmark",
      command: [
        "pnpm bench http",
        "--runtime-url",
        options.runtimeUrl,
        "--host",
        options.workerHost,
        "--path",
        options.workerPath,
        "--iterations",
        options.iterations,
        "--warmup",
        options.warmup,
        "--concurrency",
        options.concurrency.join(","),
      ].join(" "),
    },
  ];

  if (options.failureDrill) {
    steps.push(
      {
        name: "runtime drain drill",
        command: `POST ${options.runtimeUrl}/__runtime/drain`,
      },
      {
        name: "runtime activate",
        command: `POST ${options.runtimeUrl}/__runtime/activate`,
      },
    );
  }
  if (options.restartRuntimeMachineId) {
    steps.push({
      name: "restart runtime machine",
      command: `fly machine restart ${options.restartRuntimeMachineId} -a ${options.runtimeApp}`,
      destructive: true,
    });
  }
  if (options.restartControlMachineId) {
    steps.push({
      name: "restart control machine",
      command: `fly machine restart ${options.restartControlMachineId} -a ${options.controlApp}`,
      destructive: true,
    });
  }
  if (options.volumeSqliteDrillId) {
    steps.push({
      name: "volume sqlite backup drill",
      command: `fly ssh console -a ${options.controlApp} -C "cd /app && pnpm wasmplane volume-sqlite backup --root /data/sqlite --id ${options.volumeSqliteDrillId} --backup-id fly-drill"`,
      destructive: true,
    });
  }
  return steps;
}

export async function runFlyScaleEvaluation(
  options: FlyScaleEvaluationOptions,
): Promise<FlyScaleEvaluationReport> {
  const plan = buildFlyScaleEvaluationPlan(options);
  if (!options.execute) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ok: true,
      executed: false,
      steps: plan.map((step) => ({ ...step, status: "planned" })),
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const benchmarkRunner = options.benchmarkRunner ?? runBenchmarkSuite;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const steps: FlyScaleEvaluationStepResult[] = [];
  let smoke: OpsSmokeResult | undefined;
  let benchmark: BenchmarkReport | undefined;
  let slo: FlyScaleEvaluationSloReport | undefined;

  try {
    await timedStep(steps, plan[0], () =>
      commandRunner("fly", [
        "scale",
        "count",
        String(options.targetRuntimeMachines),
        "-a",
        options.runtimeApp,
        "-r",
        options.region,
        "--with-new-volumes",
        "--yes",
      ])
    );
    await sleep(options.scaleWaitMs);
    await timedStep(steps, plan[1], async () => {
      await postJson(fetchImpl, `${options.controlUrl}/snapshots/routes/publish`, options.controlToken, {});
    });
    await timedStep(steps, plan[2], async () => {
      smoke = await runOpsSmoke({
        controlUrl: options.controlUrl,
        runtimeUrl: options.runtimeUrl,
        collectorUrl: options.collectorUrl,
        controlToken: options.controlToken,
        runtimeToken: options.runtimeToken,
        workerHost: options.workerHost,
        workerPath: options.workerPath,
        requireExternalDatabase: options.requireExternalDatabase,
        minRuntimeNodes: options.targetRuntimeMachines,
        fetch: fetchImpl,
      });
      if (!smoke.ok) {
        throw new Error("production smoke failed");
      }
    });
    await timedStep(steps, plan[3], async () => {
      benchmark = await benchmarkRunner({
        mode: "http",
        hostBin: "target/debug/wasmplane-wasip3-host",
        runtimeUrl: options.runtimeUrl,
        hostHeader: options.workerHost,
        path: options.workerPath,
        method: "GET",
        body: "",
        iterations: options.iterations,
        warmup: options.warmup,
        concurrency: options.concurrency,
        format: "json",
        timeoutMs: 30_000,
      });
      slo = evaluateFlyScaleEvaluationSlo(options, steps, benchmark);
      if (slo && !slo.ok) {
        throw new Error("production SLO checks failed");
      }
    });

    let nextPlanIndex = 4;
    if (options.failureDrill) {
      await timedStep(steps, plan[nextPlanIndex++], async () => {
        await postJson(fetchImpl, `${options.runtimeUrl}/__runtime/drain`, options.runtimeToken, {});
        const readiness = await fetchImpl(`${options.runtimeUrl}/__runtime/readyz`);
        if (readiness.status !== 503) {
          throw new Error(`expected drained runtime readiness 503, got ${readiness.status}`);
        }
      });
      await timedStep(steps, plan[nextPlanIndex++], async () => {
        await postJson(fetchImpl, `${options.runtimeUrl}/__runtime/activate`, options.runtimeToken, {});
        const readiness = await fetchImpl(`${options.runtimeUrl}/__runtime/readyz`);
        if (!readiness.ok) {
          throw new Error(`expected active runtime readiness 2xx, got ${readiness.status}`);
        }
      });
    }
    if (options.restartRuntimeMachineId) {
      await timedStep(steps, plan[nextPlanIndex++], () =>
        commandRunner("fly", ["machine", "restart", options.restartRuntimeMachineId as string, "-a", options.runtimeApp])
      );
    }
    if (options.restartControlMachineId) {
      await timedStep(steps, plan[nextPlanIndex++], () =>
        commandRunner("fly", ["machine", "restart", options.restartControlMachineId as string, "-a", options.controlApp])
      );
    }
    if (options.volumeSqliteDrillId) {
      await timedStep(steps, plan[nextPlanIndex++], () =>
        commandRunner("fly", [
          "ssh",
          "console",
          "-a",
          options.controlApp,
          "-C",
          `cd /app && pnpm wasmplane volume-sqlite backup --root /data/sqlite --id ${options.volumeSqliteDrillId} --backup-id fly-drill`,
        ])
      );
    }
  } catch {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ok: false,
      executed: true,
      steps,
      slo,
      smoke,
      benchmark,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: steps.every((step) => step.status === "ok"),
    executed: true,
    steps,
    slo,
    smoke,
    benchmark,
  };
}

export function formatFlyScaleEvaluationMarkdown(report: FlyScaleEvaluationReport): string {
  const lines = [
    "# wasmplane Fly scale evaluation",
    "",
    `generated: ${report.generatedAt}`,
    `executed: ${report.executed}`,
    `ok: ${report.ok}`,
    "",
    "| step | status | elapsed ms | command |",
    "| --- | --- | ---: | --- |",
  ];
  for (const step of report.steps) {
    lines.push(`| ${step.name} | ${step.status} | ${step.elapsedMs ?? ""} | \`${step.command}\` |`);
  }
  if (report.benchmark) {
    lines.push("", formatBenchmarkMarkdown(report.benchmark).trimEnd());
  }
  if (report.slo) {
    lines.push(
      "",
      "## SLO checks",
      "",
      "| check | status | value | threshold | detail |",
      "| --- | --- | ---: | ---: | --- |",
    );
    for (const check of report.slo.checks) {
      lines.push(
        `| ${check.name} | ${check.ok ? "ok" : "failed"} | ${check.value ?? ""} | ${check.threshold} | ${check.detail ?? ""} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function evaluateFlyScaleEvaluationSlo(
  options: FlyScaleEvaluationOptions,
  steps: FlyScaleEvaluationStepResult[],
  benchmark: BenchmarkReport | undefined,
): FlyScaleEvaluationSloReport | undefined {
  const checks: FlyScaleEvaluationSloCheck[] = [];
  if (options.maxPublishMs !== undefined) {
    const publish = steps.find((step) => step.name === "publish route snapshot");
    const value = publish?.elapsedMs;
    checks.push({
      name: "route publish elapsed",
      ok: value !== undefined && value <= options.maxPublishMs,
      value,
      threshold: options.maxPublishMs,
      detail: value === undefined ? "publish step did not complete" : undefined,
    });
  }

  const needsHttp = options.maxP95Ms !== undefined
    || options.maxErrorRate !== undefined
    || options.minThroughputRps !== undefined;
  const httpResults = benchmark?.results.filter((result) => result.name === "runtime.http") ?? [];
  if (needsHttp && httpResults.length === 0) {
    if (options.maxP95Ms !== undefined) {
      checks.push(noBenchmarkCheck("http p95 latency", options.maxP95Ms));
    }
    if (options.maxErrorRate !== undefined) {
      checks.push(noBenchmarkCheck("http error rate", options.maxErrorRate));
    }
    if (options.minThroughputRps !== undefined) {
      checks.push(noBenchmarkCheck("http throughput", options.minThroughputRps));
    }
  } else {
    if (options.maxP95Ms !== undefined) {
      const value = Math.max(...httpResults.map((result) => result.p95Ms));
      checks.push({
        name: "http p95 latency",
        ok: value <= options.maxP95Ms,
        value: round3(value),
        threshold: options.maxP95Ms,
      });
    }
    if (options.maxErrorRate !== undefined) {
      const total = httpResults.reduce((sum, result) => sum + result.count, 0);
      const errors = httpResults.reduce((sum, result) => sum + result.errors, 0);
      const value = total === 0 ? 1 : errors / total;
      checks.push({
        name: "http error rate",
        ok: value <= options.maxErrorRate,
        value: round3(value),
        threshold: options.maxErrorRate,
      });
    }
    if (options.minThroughputRps !== undefined) {
      const value = Math.min(...httpResults.map((result) => result.throughputRps));
      checks.push({
        name: "http throughput",
        ok: value >= options.minThroughputRps,
        value: round3(value),
        threshold: options.minThroughputRps,
      });
    }
  }

  if (checks.length === 0) {
    return undefined;
  }
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function noBenchmarkCheck(name: string, threshold: number): FlyScaleEvaluationSloCheck {
  return {
    name,
    ok: false,
    threshold,
    detail: "no runtime.http benchmark results",
  };
}

async function timedStep(
  results: FlyScaleEvaluationStepResult[],
  step: FlyScaleEvaluationPlanStep,
  operation: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  try {
    await operation();
    results.push({ ...step, status: "ok", elapsedMs: Date.now() - started });
  } catch (error) {
    results.push({ ...step, status: "failed", elapsedMs: Date.now() - started, detail: errorMessage(error) });
    throw error;
  }
}

async function defaultCommandRunner(command: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout, stderr };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  body: unknown,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json().catch(() => ({}));
}

function parseFormat(value: string): "markdown" | "json" {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error("--format must be markdown or json");
}

function parseIntegerList(value: string): number[] {
  const parsed = value.split(",").map((item) => positiveInteger(item.trim(), undefined, "integer list"));
  if (parsed.length === 0) {
    throw new Error("expected at least one integer");
  }
  return parsed;
}

function positiveInteger(value: string | undefined, fallback?: number, label = "value"): number {
  if (!value) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`expected ${label}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveNumber(value: string | undefined, label: string): number | undefined {
  return value === undefined || value.trim() === "" ? undefined : positiveNumber(value, label);
}

function positiveNumber(value: string, label = "value"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function optionalRate(value: string | undefined, label: string): number | undefined {
  return value === undefined || value.trim() === "" ? undefined : rateNumber(value, label);
}

function rateNumber(value: string, label = "value"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | undefined, fallback?: number, label = "value"): number {
  if (!value) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`expected ${label}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected value after ${flag}`);
  }
  return value;
}

function flyUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensurePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main(): Promise<void> {
  const options = parseFlyScaleEvaluationArgs(process.argv.slice(2));
  const report = await runFlyScaleEvaluation(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatFlyScaleEvaluationMarkdown(report);
  if (options.output) {
    await writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
