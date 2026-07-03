import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type CapabilityPolicy,
  type RuntimeLimits,
} from "./control-plane/contracts.ts";
import { type BenchmarkResult, runLoadBenchmark } from "./bench.ts";

export type RustDaemonBenchFormat = "markdown" | "json";

export interface RustDaemonBenchOptions {
  componentPath?: string;
  hostBin: string;
  port: number;
  iterations: number;
  warmup: number;
  concurrency: number[];
  hostHeader: string;
  path: string;
  method: string;
  body: string;
  format: RustDaemonBenchFormat;
  output?: string;
  timeoutMs: number;
  poolingArgs: string[];
  daemonRuntimeArgs: string[];
  baselineUrl?: string;
}

export interface PreparedRouteTablePayload {
  schemaVersion: 1;
  routes: PreparedRoutePayload[];
}

export interface PreparedRoutePayload {
  host: string;
  pathPrefix: string;
  projectId: string;
  deploymentId: string;
  precompiled: string;
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: {
    backend: typeof MVP_RUNTIME_BACKEND;
    version: string;
    wasi: typeof MVP_WASI_PROFILE;
  };
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
}

export interface BuildPreparedRouteTablePayloadInput {
  host: string;
  pathPrefix: string;
  deploymentId: string;
  precompiledPath: string;
  projectId?: string;
  limits?: RuntimeLimits;
  capabilities?: CapabilityPolicy;
}

export interface RustDaemonBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  target: string;
  baselineTarget?: string;
  results: BenchmarkResult[];
}

const defaultLimits: RuntimeLimits = {
  cpuMs: 50,
  memoryMb: 64,
  wallMs: 1000,
  requestBytes: 1048576,
  responseBytes: 1048576,
  subrequests: 20,
  hostCalls: 100,
};

const defaultCapabilities: CapabilityPolicy = {
  outboundHttp: { enabled: false, allow: [] },
  kv: [],
  secrets: [],
  arbitraryFilesystem: false,
  arbitrarySockets: false,
  processSpawn: false,
};

const poolingFlags = new Set([
  "--pooling-total-component-instances",
  "--pooling-memory-mb",
  "--pooling-total-core-instances",
  "--pooling-total-memories",
  "--pooling-total-tables",
  "--pooling-table-elements",
  "--pooling-component-instance-mb",
  "--pooling-core-instance-mb",
]);

const daemonOnlyFlags = new Set([
  "--max-prepared-components",
  "--max-concurrent-invocations",
  "--http-workers",
  "--experimental-instance-reuse",
  "--instance-reuse-contract",
]);

export function parseRustDaemonBenchArgs(args: string[]): RustDaemonBenchOptions {
  const options: RustDaemonBenchOptions = {
    hostBin: "target/debug/wasmplane-wasip3-host",
    port: 8791,
    iterations: 300,
    warmup: 10,
    concurrency: [1, 8, 32, 64],
    hostHeader: "hello.example.dev",
    path: "/",
    method: "GET",
    body: "",
    format: "markdown",
    timeoutMs: 30_000,
    poolingArgs: [],
    daemonRuntimeArgs: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") {
      continue;
    }
    const value = args[index + 1];
    if (poolingFlags.has(flag)) {
      const required = requiredValue(flag, value);
      options.poolingArgs.push(flag, required);
      options.daemonRuntimeArgs.push(flag, required);
      index += 1;
      continue;
    }
    if (daemonOnlyFlags.has(flag)) {
      const required = requiredValue(flag, value);
      options.daemonRuntimeArgs.push(flag, required);
      index += 1;
      continue;
    }
    switch (flag) {
      case "--component":
        options.componentPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--host-bin":
        options.hostBin = requiredValue(flag, value);
        index += 1;
        break;
      case "--port":
        options.port = positiveInteger(requiredValue(flag, value), flag);
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
      case "--baseline-url":
        options.baselineUrl = requiredValue(flag, value).replace(/\/+$/, "");
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
        throw new Error(`unknown Rust daemon benchmark argument ${flag}`);
    }
  }

  return options;
}

export function buildPreparedRouteTablePayload(input: BuildPreparedRouteTablePayloadInput): PreparedRouteTablePayload {
  return {
    schemaVersion: 1,
    routes: [{
      host: input.host,
      pathPrefix: input.pathPrefix,
      projectId: input.projectId ?? "prj_bench",
      deploymentId: input.deploymentId,
      precompiled: input.precompiledPath,
      world: MVP_WORKER_WORLD,
      worldVersion: MVP_WORKER_WORLD_VERSION,
      runtime: {
        backend: MVP_RUNTIME_BACKEND,
        version: "wasmtime-42",
        wasi: MVP_WASI_PROFILE,
      },
      limits: input.limits ?? defaultLimits,
      capabilities: input.capabilities ?? defaultCapabilities,
    }],
  };
}

export function buildWorkerFetchHeaders(options: Pick<RustDaemonBenchOptions, "hostHeader">): Record<string, string> {
  return {
    "x-forwarded-host": options.hostHeader,
    "content-type": "text/plain",
  };
}

export async function runRustDaemonBenchmarkSuite(
  options: RustDaemonBenchOptions,
): Promise<RustDaemonBenchmarkReport> {
  const componentPath = requireComponent(options);
  const workDir = await mkdtemp(join(tmpdir(), "wasmplane-rust-daemon-bench-"));
  const precompiledPath = join(workDir, "worker.component.cwasm");
  const kvStoreDir = join(workDir, "kv");
  await runCommand(
    options.hostBin,
    ["compile", "--component", componentPath, "--out", precompiledPath, ...options.poolingArgs],
    options.timeoutMs,
  );

  const daemon = spawn(options.hostBin, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--kv-store-dir",
    kvStoreDir,
    ...options.daemonRuntimeArgs,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const target = `http://127.0.0.1:${options.port}`;
  try {
    await waitForDaemon(target, daemon);
    await putPreparedRoutes(target, buildPreparedRouteTablePayload({
      host: options.hostHeader,
      pathPrefix: options.path,
      deploymentId: "dep_rust_daemon_bench",
      precompiledPath,
    }));

    const results: BenchmarkResult[] = [];
    if (options.baselineUrl) {
      results.push(...await runHttpSeries("node-runtime.http", options.baselineUrl, options));
    }
    results.push(...await runHttpSeries("rust-daemon.http", target, options));

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      target,
      ...(options.baselineUrl ? { baselineTarget: options.baselineUrl } : {}),
      results,
    };
  } finally {
    daemon.kill();
  }
}

export function formatRustDaemonBenchmarkMarkdown(report: RustDaemonBenchmarkReport): string {
  const lines = [
    "# wasmplane Rust daemon benchmark",
    "",
    `generated: ${report.generatedAt}`,
    `target: ${report.target}`,
    ...(report.baselineTarget ? [`baseline: ${report.baselineTarget}`] : []),
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

async function runHttpSeries(
  name: string,
  baseUrl: string,
  options: RustDaemonBenchOptions,
): Promise<BenchmarkResult[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}${options.path}`;
  for (let index = 0; index < options.warmup; index += 1) {
    await fetchWorker(url, options);
  }
  const results: BenchmarkResult[] = [];
  for (const concurrency of options.concurrency) {
    results.push(await runLoadBenchmark({
      name,
      iterations: options.iterations,
      concurrency,
      operation: async () => {
        await fetchWorker(url, options);
      },
    }));
  }
  return results;
}

async function fetchWorker(url: string, options: RustDaemonBenchOptions): Promise<void> {
  const response = await fetch(url, {
    method: options.method,
    headers: buildWorkerFetchHeaders(options),
    body: options.method === "GET" || options.method === "HEAD" ? undefined : options.body,
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`worker HTTP request failed with ${response.status}`);
  }
}

async function putPreparedRoutes(target: string, payload: PreparedRouteTablePayload): Promise<void> {
  const response = await fetch(`${target}/routes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`failed to publish prepared routes to daemon: ${response.status} ${text}`);
  }
}

async function waitForDaemon(target: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Rust daemon exited before readiness with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${target}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Rust daemon did not become ready: ${lastError}`);
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

function requireComponent(options: RustDaemonBenchOptions): string {
  if (!options.componentPath) {
    throw new Error("Rust daemon benchmark requires --component <component.wasm>");
  }
  return options.componentPath;
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

function parseFormat(value: string): RustDaemonBenchFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown");
}

function normalizePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

async function main() {
  const options = parseRustDaemonBenchArgs(process.argv.slice(2));
  const report = await runRustDaemonBenchmarkSuite(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatRustDaemonBenchmarkMarkdown(report);
  if (options.output) {
    await writeFileEnsuringParent(options.output, output);
  } else {
    process.stdout.write(output);
  }
}

async function writeFileEnsuringParent(path: string, content: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
