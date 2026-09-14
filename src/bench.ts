import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type CapabilityPolicy,
  type RuntimeLimits,
} from "./control-plane/contracts.ts";
import { createFileArtifactStore } from "./runtime/artifacts.ts";
import { createRuntimeSupervisor } from "./runtime/supervisor.ts";
import { createWasip3HostBackend } from "./runtime/wasip3-host.ts";

export type BenchMode = "host" | "cold" | "http" | "all";
export type BenchFormat = "markdown" | "json";

export interface BenchOptions {
  mode: BenchMode;
  componentPath?: string;
  hostBin: string;
  iterations: number;
  warmup: number;
  concurrency: number[];
  runtimeUrl?: string;
  hostHeader: string;
  path: string;
  method: string;
  body: string;
  format: BenchFormat;
  output?: string;
  timeoutMs: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  results: BenchmarkResult[];
}

export interface BenchmarkResult {
  name: string;
  iterations: number;
  concurrency: number;
  count: number;
  errors: number;
  elapsedMs: number;
  throughputRps: number;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RunLoadBenchmarkInput {
  name: string;
  iterations: number;
  concurrency: number;
  operation: () => Promise<void>;
  nowMs?: () => number;
}

export interface HostInvokeArgsInput {
  componentPath?: string;
  precompiledPath?: string;
  method: string;
  uri: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
  limits?: Partial<RuntimeLimits>;
  capabilities?: CapabilityPolicy;
}

const defaultLimits: RuntimeLimits = {
  cpuMs: 50,
  memoryMb: 64,
  wallMs: 1000,
  requestBytes: 1048576,
  responseBytes: 1048576,
  subrequests: 20,
};

const defaultCapabilities: CapabilityPolicy = {
  outboundHttp: { enabled: false, allow: [] },
  kv: [],
  secrets: [],
  arbitraryFilesystem: false,
  arbitrarySockets: false,
  processSpawn: false,
};

export async function runBenchmarkSuite(options: BenchOptions): Promise<BenchmarkReport> {
  const results: BenchmarkResult[] = [];
  if (options.mode === "host" || options.mode === "all") {
    requireComponent(options);
    results.push(...await runHostInvokeBenchmarks(options));
  }
  if (options.mode === "cold" || options.mode === "all") {
    requireComponent(options);
    results.push(...await runColdStartBenchmarks(options));
  }
  if (options.mode === "http" || (options.mode === "all" && options.runtimeUrl)) {
    requireRuntimeUrl(options);
    results.push(...await runHttpBenchmarks(options));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
    },
    results,
  };
}

export async function runHostInvokeBenchmarks(options: BenchOptions): Promise<BenchmarkResult[]> {
  const componentPath = requireComponent(options);
  const uri = `http://${options.hostHeader}${options.path}`;
  const precompiledPath = await precompileComponentForBenchmark(options, componentPath);
  const common = {
    componentPath,
    method: options.method,
    uri,
    headers: [],
    body: options.body,
    limits: defaultLimits,
    capabilities: defaultCapabilities,
  };
  const variants = [
    {
      name: "host.invoke.component",
      args: buildHostInvokeArgs(common),
    },
    {
      name: "host.invoke.cwasm",
      args: buildHostInvokeArgs({
        ...common,
        componentPath: undefined,
        precompiledPath,
      }),
    },
  ];
  const results: BenchmarkResult[] = [];
  for (const variant of variants) {
    for (let index = 0; index < options.warmup; index += 1) {
      await runCommand(options.hostBin, variant.args, options.timeoutMs);
    }
    results.push(...await Promise.all(
      options.concurrency.map((concurrency) =>
        runLoadBenchmark({
          name: variant.name,
          iterations: options.iterations,
          concurrency,
          operation: async () => {
            await runCommand(options.hostBin, variant.args, options.timeoutMs);
          },
        }),
      ),
    ));
  }
  return results;
}

export async function runColdStartBenchmarks(options: BenchOptions): Promise<BenchmarkResult[]> {
  const componentPath = requireComponent(options);
  const componentBytes = await readFile(componentPath);
  const digest = `sha256:${createHash("sha256").update(componentBytes).digest("hex")}`;
  const artifact = {
    id: "art_bench",
    digest,
    location: pathToFileURL(componentPath).href,
  };
  const cacheDir = await mkdtemp(join(tmpdir(), "odenctl-bench-cache-"));
  const artifactStore = createFileArtifactStore();

  async function prepareWithNewSupervisor() {
    const supervisor = createRuntimeSupervisor({
      snapshot: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        routes: [benchmarkRoute(artifact)],
      },
      artifactStore,
      backend: createWasip3HostBackend({
        cacheDir,
        hostBin: options.hostBin,
      }),
    });
    await supervisor.prepareRoute({ host: options.hostHeader, path: options.path });
  }

  const cold = await runLoadBenchmark({
    name: "runtime.prepare.cold",
    iterations: 1,
    concurrency: 1,
    operation: prepareWithNewSupervisor,
  });
  const warmCache = await runLoadBenchmark({
    name: "runtime.prepare.warm-cache",
    iterations: Math.max(1, Math.min(options.iterations, 20)),
    concurrency: 1,
    operation: prepareWithNewSupervisor,
  });

  return [cold, warmCache];
}

export async function runHttpBenchmarks(options: BenchOptions): Promise<BenchmarkResult[]> {
  const baseUrl = requireRuntimeUrl(options).replace(/\/+$/, "");
  const url = `${baseUrl}${options.path}`;
  for (let index = 0; index < options.warmup; index += 1) {
    await fetchRuntime(url, options);
  }
  return Promise.all(
    options.concurrency.map((concurrency) =>
      runLoadBenchmark({
        name: "runtime.http",
        iterations: options.iterations,
        concurrency,
        operation: async () => {
          await fetchRuntime(url, options);
        },
      }),
    ),
  );
}

export async function runLoadBenchmark(input: RunLoadBenchmarkInput): Promise<BenchmarkResult> {
  const nowMs = input.nowMs ?? (() => performance.now());
  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const started = nowMs();
  const workers = Array.from({ length: Math.min(input.concurrency, input.iterations) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= input.iterations) {
        return;
      }
      const operationStarted = nowMs();
      try {
        await input.operation();
      } catch {
        errors += 1;
      } finally {
        latencies.push(nowMs() - operationStarted);
      }
    }
  });
  await Promise.all(workers);
  const elapsedMs = nowMs() - started;
  return {
    name: input.name,
    iterations: input.iterations,
    concurrency: input.concurrency,
    ...summarizeLatencies(latencies, elapsedMs, errors),
  };
}

export function summarizeLatencies(latencies: number[], elapsedMs: number, errors: number) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const count = sorted.length;
  const total = sorted.reduce((sum, item) => sum + item, 0);
  return {
    count,
    errors,
    elapsedMs: round3(elapsedMs),
    throughputRps: round3(elapsedMs > 0 ? count / (elapsedMs / 1000) : 0),
    minMs: round3(sorted[0] ?? 0),
    avgMs: round3(count === 0 ? 0 : total / count),
    p50Ms: round3(percentile(sorted, 0.50)),
    p95Ms: round3(percentile(sorted, 0.95)),
    p99Ms: round3(percentile(sorted, 0.99)),
    maxMs: round3(sorted[sorted.length - 1] ?? 0),
  };
}

export function buildHostInvokeArgs(input: HostInvokeArgsInput): string[] {
  if (Boolean(input.componentPath) === Boolean(input.precompiledPath)) {
    throw new Error("expected exactly one of componentPath or precompiledPath");
  }
  const sourceArgs = input.precompiledPath
    ? ["--precompiled", input.precompiledPath]
    : ["--component", input.componentPath as string];
  const args = [
    "invoke",
    ...sourceArgs,
    "--method",
    input.method,
    "--uri",
    input.uri,
    "--headers",
    JSON.stringify(input.headers),
    "--body",
    input.body,
  ];
  if (input.limits?.wallMs !== undefined) {
    args.push("--wall-ms", String(input.limits.wallMs));
  }
  if (input.limits?.cpuMs !== undefined) {
    args.push("--cpu-ms", String(input.limits.cpuMs));
  }
  if (input.limits?.memoryMb !== undefined) {
    args.push("--memory-mb", String(input.limits.memoryMb));
  }
  if (input.limits?.requestBytes !== undefined) {
    args.push("--request-bytes", String(input.limits.requestBytes));
  }
  if (input.limits?.responseBytes !== undefined) {
    args.push("--response-bytes", String(input.limits.responseBytes));
  }
  if (input.limits?.subrequests !== undefined) {
    args.push("--subrequests", String(input.limits.subrequests));
  }
  if (input.capabilities) {
    args.push("--capabilities", JSON.stringify(input.capabilities));
  }
  return args;
}

async function precompileComponentForBenchmark(
  options: BenchOptions,
  componentPath: string,
): Promise<string> {
  const cacheDir = await mkdtemp(join(tmpdir(), "odenctl-bench-cwasm-"));
  const precompiledPath = join(cacheDir, "worker.component.cwasm");
  await runCommand(
    options.hostBin,
    ["compile", "--component", componentPath, "--out", precompiledPath],
    options.timeoutMs,
  );
  return precompiledPath;
}

export function parseBenchArgs(args: string[]): BenchOptions {
  const [first, ...rest] = args;
  const mode = isMode(first) ? first : "all";
  const items = isMode(first) ? rest : args;
  const options: BenchOptions = {
    mode,
    hostBin: "target/debug/oden-host",
    iterations: 50,
    warmup: 5,
    concurrency: [1, 2, 4],
    hostHeader: "hello.example.dev",
    path: "/",
    method: "GET",
    body: "",
    format: "markdown",
    timeoutMs: 30_000,
  };

  for (let index = 0; index < items.length; index += 1) {
    const flag = items[index];
    const value = items[index + 1];
    switch (flag) {
      case "--component":
        options.componentPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--host-bin":
        options.hostBin = requiredValue(flag, value);
        index += 1;
        break;
      case "--iterations":
        options.iterations = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--warmup":
        options.warmup = nonNegativeInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parseConcurrency(requiredValue(flag, value));
        index += 1;
        break;
      case "--runtime-url":
        options.runtimeUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--host":
        options.hostHeader = requiredValue(flag, value);
        index += 1;
        break;
      case "--path":
        options.path = normalizePath(requiredValue(flag, value));
        index += 1;
        break;
      case "--method":
        options.method = requiredValue(flag, value).toUpperCase();
        index += 1;
        break;
      case "--body":
        options.body = requiredValue(flag, value);
        index += 1;
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
      case "--timeout-ms":
        options.timeoutMs = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      default:
        throw new Error(`unknown benchmark argument ${flag}`);
    }
  }
  return options;
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    "# odenctl benchmark",
    "",
    `generated: ${report.generatedAt}`,
    `environment: node ${report.environment.node}, ${report.environment.platform}/${report.environment.arch}, cpus=${report.environment.cpus}`,
    "",
    "| benchmark | concurrency | iterations | rps | avg ms | p50 ms | p95 ms | p99 ms | errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.name} | ${result.concurrency} | ${result.iterations} | ${result.throughputRps} | ${result.avgMs} | ${result.p50Ms} | ${result.p95Ms} | ${result.p99Ms} | ${result.errors} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function fetchRuntime(url: string, options: BenchOptions): Promise<void> {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      "x-forwarded-host": options.hostHeader,
      "content-type": "text/plain",
    },
    body: options.method === "GET" || options.method === "HEAD" ? undefined : options.body,
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`runtime HTTP request failed with ${response.status}`);
  }
}

function benchmarkRoute(artifact: { id: string; digest: string; location: string }) {
  const runtime = { backend: MVP_RUNTIME_BACKEND, version: "wasmtime-42", wasi: MVP_WASI_PROFILE };
  const capabilities = defaultCapabilities;
  return {
    host: "hello.example.dev",
    pathPrefix: "/",
    projectId: "prj_bench",
    deploymentId: "dep_bench",
    world: MVP_WORKER_WORLD,
    worldVersion: MVP_WORKER_WORLD_VERSION,
    runtime,
    limits: defaultLimits,
    capabilities,
    artifact,
    targets: [{
      deploymentId: "dep_bench",
      weight: 100,
      world: MVP_WORKER_WORLD,
      worldVersion: MVP_WORKER_WORLD_VERSION,
      runtime,
      limits: defaultLimits,
      capabilities,
      artifact,
    }],
  };
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isMode(value: string | undefined): value is BenchMode {
  return value === "host" || value === "cold" || value === "http" || value === "all";
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseConcurrency(value: string): number[] {
  const concurrency = value.split(",").map((item) => positiveInteger(item.trim(), "--concurrency"));
  if (concurrency.length === 0) {
    throw new Error("--concurrency must include at least one value");
  }
  return concurrency;
}

function parseFormat(value: string): BenchFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown");
}

function normalizePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function requireComponent(options: BenchOptions): string {
  if (!options.componentPath) {
    throw new Error(`benchmark mode ${options.mode} requires --component <component.wasm>`);
  }
  return options.componentPath;
}

function requireRuntimeUrl(options: BenchOptions): string {
  if (!options.runtimeUrl) {
    throw new Error(`benchmark mode ${options.mode} requires --runtime-url <url>`);
  }
  return options.runtimeUrl;
}

async function main() {
  const options = parseBenchArgs(process.argv.slice(2));
  const report = await runBenchmarkSuite(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatBenchmarkMarkdown(report);
  if (options.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
