import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type CapabilityPolicy,
  type RouteSnapshot,
  type RuntimeLimits,
} from "./control-plane/contracts.ts";
import { publishRouteSnapshot } from "./control-plane/snapshot-publisher.ts";
import { createRuntimeArtifactStore } from "./runtime/artifacts.ts";
import { createRuntimeNodeApp } from "./runtime/node-app.ts";
import { createRuntimeSupervisor } from "./runtime/supervisor.ts";
import {
  createWasip3HostBackend,
  createWasip3HostDaemonInvoker,
  createWasip3HostInvoker,
} from "./runtime/wasip3-host.ts";
import type { BenchmarkResult, BenchFormat } from "./bench.ts";
import { runLoadBenchmark } from "./bench.ts";

export interface ClusterBenchOptions {
  componentPath?: string;
  hostBin: string;
  nodeCounts: number[];
  iterations: number;
  warmup: number;
  concurrency: number[];
  hostHeader: string;
  path: string;
  method: string;
  body: string;
  format: BenchFormat;
  output?: string;
  timeoutMs: number;
  maxConcurrentInvocations?: number;
  hostDaemonUrl?: string;
  pooling?: ClusterBenchPoolingOptions;
}

export interface ClusterBenchPoolingOptions {
  totalComponentInstances?: number;
  memoryMb?: number;
  totalCoreInstances?: number;
  totalMemories?: number;
  totalTables?: number;
  tableElements?: number;
  componentInstanceMb?: number;
  coreInstanceMb?: number;
}

export interface ClusterBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  throughput: ClusterThroughputResult[];
  switches: ClusterSwitchResult[];
}

export interface ClusterThroughputResult extends BenchmarkResult {
  nodes: number;
}

export interface ClusterSwitchResult {
  name: string;
  nodes: number;
  ok: boolean;
  publishMs: number;
  visibleAfterPublishMs: number;
  totalMs: number;
  attempts: number;
  errors: number;
}

export interface BuildClusterRouteSnapshotInput {
  deploymentId: string;
  componentLocation: string;
  digest: string;
  generatedAt: string;
  hostHeader: string;
  pathPrefix: string;
}

interface RuntimeCluster {
  nodes: RuntimeClusterNode[];
}

interface RuntimeClusterNode {
  id: string;
  url: string;
  close(): Promise<void>;
}

interface DeploymentWaitResult {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  error?: string;
}

const defaultLimits: RuntimeLimits = {
  cpuMs: 50,
  memoryMb: 64,
  wallMs: 10_000,
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

export async function runClusterBenchmarkSuite(
  options: ClusterBenchOptions,
): Promise<ClusterBenchmarkReport> {
  const componentPath = requireComponent(options);
  const digest = await sha256File(componentPath);
  const componentLocation = pathToFileURL(componentPath).href;
  const throughput: ClusterThroughputResult[] = [];
  const switches: ClusterSwitchResult[] = [];

  for (const nodeCount of options.nodeCounts) {
    const cluster = await startRuntimeCluster(nodeCount, options);
    const blueDeploymentId = `dep_blue_${nodeCount}`;
    const greenDeploymentId = `dep_green_${nodeCount}`;
    try {
      await publishRouteSnapshot(
        buildClusterRouteSnapshot({
          deploymentId: blueDeploymentId,
          componentLocation,
          digest,
          generatedAt: new Date().toISOString(),
          hostHeader: options.hostHeader,
          pathPrefix: "/",
        }),
        publishTargets(cluster.nodes),
      );
      await warmCluster(cluster.nodes, options, blueDeploymentId);

      const switchResult = await measureDeploymentSwitch(
        cluster.nodes,
        buildClusterRouteSnapshot({
          deploymentId: greenDeploymentId,
          componentLocation,
          digest,
          generatedAt: new Date().toISOString(),
          hostHeader: options.hostHeader,
          pathPrefix: "/",
        }),
        greenDeploymentId,
        options,
      );
      switches.push(switchResult);

      for (const concurrency of options.concurrency) {
        throughput.push(
          await runClusterThroughputBenchmark(
            cluster.nodes,
            options,
            greenDeploymentId,
            concurrency,
          ),
        );
      }
    } finally {
      await closeRuntimeCluster(cluster);
    }
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
    throughput,
    switches,
  };
}

export function buildClusterRouteSnapshot(
  input: BuildClusterRouteSnapshotInput,
): RouteSnapshot {
  const runtime = {
    backend: MVP_RUNTIME_BACKEND,
    version: "wasmtime-42",
    wasi: MVP_WASI_PROFILE,
  };
  const artifact = {
    id: `art_${input.deploymentId}`,
    digest: input.digest,
    location: input.componentLocation,
  };
  const target = {
    deploymentId: input.deploymentId,
    weight: 100,
    world: MVP_WORKER_WORLD,
    runtime,
    limits: defaultLimits,
    capabilities: defaultCapabilities,
    artifact,
  };
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    routes: [
      {
        host: input.hostHeader,
        pathPrefix: input.pathPrefix,
        projectId: "prj_cluster_bench",
        deploymentId: input.deploymentId,
        targets: [target],
        world: MVP_WORKER_WORLD,
        runtime,
        limits: defaultLimits,
        capabilities: defaultCapabilities,
        artifact,
      },
    ],
  };
}

export function parseClusterBenchArgs(args: string[]): ClusterBenchOptions {
  const options: ClusterBenchOptions = {
    hostBin: "target/debug/wasmplane-wasip3-host",
    nodeCounts: [1, 2, 4],
    iterations: 30,
    warmup: 2,
    concurrency: [1, 4, 16],
    hostHeader: "hello.example.dev",
    path: "/",
    method: "GET",
    body: "",
    format: "markdown",
    timeoutMs: 30_000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--component":
        options.componentPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--host-bin":
        options.hostBin = requiredValue(flag, value);
        index += 1;
        break;
      case "--nodes":
        options.nodeCounts = parsePositiveIntegerList(requiredValue(flag, value), flag);
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
        options.concurrency = parsePositiveIntegerList(requiredValue(flag, value), flag);
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
      case "--max-concurrent-invocations":
        options.maxConcurrentInvocations = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--host-daemon-url":
        options.hostDaemonUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--pooling-total-component-instances":
        options.pooling = {
          ...options.pooling,
          totalComponentInstances: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-memory-mb":
        options.pooling = {
          ...options.pooling,
          memoryMb: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-total-core-instances":
        options.pooling = {
          ...options.pooling,
          totalCoreInstances: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-total-memories":
        options.pooling = {
          ...options.pooling,
          totalMemories: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-total-tables":
        options.pooling = {
          ...options.pooling,
          totalTables: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-table-elements":
        options.pooling = {
          ...options.pooling,
          tableElements: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-component-instance-mb":
        options.pooling = {
          ...options.pooling,
          componentInstanceMb: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      case "--pooling-core-instance-mb":
        options.pooling = {
          ...options.pooling,
          coreInstanceMb: positiveInteger(requiredValue(flag, value), flag),
        };
        index += 1;
        break;
      default:
        throw new Error(`unknown cluster benchmark argument ${flag}`);
    }
  }
  if (!options.hostDaemonUrl && clusterHostPoolingArgs(options).length > 0) {
    throw new Error("--pooling-* cluster benchmark args require --host-daemon-url");
  }
  return options;
}

export function clusterHostPoolingArgs(options: ClusterBenchOptions): string[] {
  const args: string[] = [];
  appendOptionalNumberArg(args, "--pooling-total-component-instances", options.pooling?.totalComponentInstances);
  appendOptionalNumberArg(args, "--pooling-memory-mb", options.pooling?.memoryMb);
  appendOptionalNumberArg(args, "--pooling-total-core-instances", options.pooling?.totalCoreInstances);
  appendOptionalNumberArg(args, "--pooling-total-memories", options.pooling?.totalMemories);
  appendOptionalNumberArg(args, "--pooling-total-tables", options.pooling?.totalTables);
  appendOptionalNumberArg(args, "--pooling-table-elements", options.pooling?.tableElements);
  appendOptionalNumberArg(args, "--pooling-component-instance-mb", options.pooling?.componentInstanceMb);
  appendOptionalNumberArg(args, "--pooling-core-instance-mb", options.pooling?.coreInstanceMb);
  return args;
}

export function formatClusterBenchmarkMarkdown(report: ClusterBenchmarkReport): string {
  const lines = [
    "# wasmplane cluster benchmark",
    "",
    `generated: ${report.generatedAt}`,
    `environment: node ${report.environment.node}, ${report.environment.platform}/${report.environment.arch}, cpus=${report.environment.cpus}`,
    "",
    "## deploy switch",
    "",
    "| operation | nodes | publish ms | visible ms | total ms | attempts | errors | ok |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of report.switches) {
    lines.push(
      `| ${item.name} | ${item.nodes} | ${item.publishMs} | ${item.visibleAfterPublishMs} | ${item.totalMs} | ${item.attempts} | ${item.errors} | ${item.ok ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    "## throughput",
    "",
    "| benchmark | nodes | concurrency | iterations | rps | avg ms | p50 ms | p95 ms | p99 ms | errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const result of report.throughput) {
    lines.push(
      `| ${result.name} | ${result.nodes} | ${result.concurrency} | ${result.iterations} | ${result.throughputRps} | ${result.avgMs} | ${result.p50Ms} | ${result.p95Ms} | ${result.p99Ms} | ${result.errors} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function startRuntimeCluster(
  nodeCount: number,
  options: ClusterBenchOptions,
): Promise<RuntimeCluster> {
  const nodes: RuntimeClusterNode[] = [];
  try {
    for (let index = 0; index < nodeCount; index += 1) {
      const id = `runtime-${index + 1}`;
      const cacheDir = await mkdtemp(join(tmpdir(), `wasmplane-cluster-${id}-cwasm-`));
      const artifactCacheDir = await mkdtemp(join(tmpdir(), `wasmplane-cluster-${id}-artifacts-`));
      const kvStoreDir = await mkdtemp(join(tmpdir(), `wasmplane-cluster-${id}-kv-`));
      const poolingArgs = clusterHostPoolingArgs(options);
      const cacheVariant = options.hostDaemonUrl && poolingArgs.length > 0
        ? clusterEngineCacheVariant(poolingArgs)
        : undefined;
      const app = createRuntimeNodeApp({
        supervisor: createRuntimeSupervisor({
          snapshot: emptySnapshot(),
          artifactStore: createRuntimeArtifactStore({ cacheDir: artifactCacheDir }),
          backend: createWasip3HostBackend({
            cacheDir,
            hostBin: options.hostBin,
            compileArgs: options.hostDaemonUrl ? poolingArgs : undefined,
            cacheVariant,
          }),
        }),
        invoker: options.hostDaemonUrl
          ? createWasip3HostDaemonInvoker({ url: options.hostDaemonUrl })
          : createWasip3HostInvoker({ hostBin: options.hostBin, kvStoreDir }),
        maxConcurrentInvocations: options.maxConcurrentInvocations,
        eventBufferSize: 1000,
      });
      const server = await app.listen({ port: 0, host: "127.0.0.1" });
      nodes.push({
        id,
        url: serverBaseUrl(server),
        close: app.close,
      });
    }
  } catch (error) {
    await closeRuntimeCluster({ nodes });
    throw error;
  }
  return { nodes };
}

async function measureDeploymentSwitch(
  nodes: RuntimeClusterNode[],
  snapshot: RouteSnapshot,
  expectedDeploymentId: string,
  options: ClusterBenchOptions,
): Promise<ClusterSwitchResult> {
  const started = performance.now();
  const publish = await publishRouteSnapshot(snapshot, publishTargets(nodes));
  const publishDone = performance.now();
  let errors = publish.targets.filter((target) => !target.ok).length;
  if (!publish.ok) {
    return {
      name: "cluster.switch.cold",
      nodes: nodes.length,
      ok: false,
      publishMs: round3(publishDone - started),
      visibleAfterPublishMs: 0,
      totalMs: round3(performance.now() - started),
      attempts: 0,
      errors,
    };
  }

  const visibleChecks = await Promise.all(
    nodes.map((node) => waitForDeployment(node, options, expectedDeploymentId)),
  );
  errors += visibleChecks.filter((item) => !item.ok).length;
  return {
    name: "cluster.switch.cold",
    nodes: nodes.length,
    ok: errors === 0,
    publishMs: round3(publishDone - started),
    visibleAfterPublishMs: round3(Math.max(0, ...visibleChecks.map((item) => item.elapsedMs))),
    totalMs: round3(performance.now() - started),
    attempts: visibleChecks.reduce((sum, item) => sum + item.attempts, 0),
    errors,
  };
}

async function runClusterThroughputBenchmark(
  nodes: RuntimeClusterNode[],
  options: ClusterBenchOptions,
  expectedDeploymentId: string,
  concurrency: number,
): Promise<ClusterThroughputResult> {
  let cursor = 0;
  const result = await runLoadBenchmark({
    name: "cluster.http.cwasm",
    iterations: options.iterations,
    concurrency,
    operation: async () => {
      const node = nodes[cursor % nodes.length];
      cursor += 1;
      const response = await fetchWorker(node, options);
      if (response.deploymentId !== expectedDeploymentId) {
        throw new Error(`expected ${expectedDeploymentId}, got ${response.deploymentId}`);
      }
    },
  });
  return { ...result, nodes: nodes.length };
}

async function warmCluster(
  nodes: RuntimeClusterNode[],
  options: ClusterBenchOptions,
  expectedDeploymentId: string,
) {
  const rounds = Math.max(1, options.warmup);
  for (let index = 0; index < rounds; index += 1) {
    const results = await Promise.all(nodes.map((node) => waitForDeployment(node, options, expectedDeploymentId)));
    const failed = results.find((result) => !result.ok);
    if (failed) {
      throw new Error(failed.error ?? `deployment ${expectedDeploymentId} did not become visible`);
    }
  }
}

async function waitForDeployment(
  node: RuntimeClusterNode,
  options: ClusterBenchOptions,
  expectedDeploymentId: string,
): Promise<DeploymentWaitResult> {
  const started = performance.now();
  let attempts = 0;
  let lastDeployment = "";
  let lastError = "";
  while (performance.now() - started < options.timeoutMs) {
    attempts += 1;
    try {
      const response = await fetchWorker(node, options);
      lastDeployment = response.deploymentId;
      if (response.deploymentId === expectedDeploymentId) {
        return { ok: true, attempts, elapsedMs: performance.now() - started };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(5);
  }
  const suffix = lastError ? `: ${lastError}` : `, got ${lastDeployment}`;
  return {
    ok: false,
    attempts,
    elapsedMs: performance.now() - started,
    error: `deployment ${expectedDeploymentId} did not become visible on ${node.id}${suffix}`,
  };
}

async function fetchWorker(
  node: RuntimeClusterNode,
  options: ClusterBenchOptions,
): Promise<{ deploymentId: string; status: number }> {
  const response = await fetch(`${node.url}${options.path}`, {
    method: options.method,
    headers: {
      "x-forwarded-host": options.hostHeader,
      "content-type": "text/plain",
    },
    body: options.method === "GET" || options.method === "HEAD" ? undefined : options.body,
  });
  const body = await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`worker request failed with ${response.status}: ${Buffer.from(body).toString("utf8")}`);
  }
  return {
    status: response.status,
    deploymentId: response.headers.get("x-wasmplane-deployment") ?? "",
  };
}

async function closeRuntimeCluster(cluster: RuntimeCluster) {
  await Promise.all(cluster.nodes.map((node) => node.close().catch(() => undefined)));
}

function publishTargets(nodes: RuntimeClusterNode[]) {
  return nodes.map((node) => ({ id: node.id, url: node.url }));
}

function emptySnapshot(): RouteSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    routes: [],
  };
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("runtime server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function requireComponent(options: ClusterBenchOptions): string {
  if (!options.componentPath) {
    throw new Error("cluster benchmark requires --component <component.wasm>");
  }
  return options.componentPath;
}

function parsePositiveIntegerList(value: string, flag: string): number[] {
  const items = value.split(",").map((item) => positiveInteger(item.trim(), flag));
  if (items.length === 0) {
    throw new Error(`${flag} must include at least one value`);
  }
  return items;
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

function parseFormat(value: string): BenchFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown");
}

function appendOptionalNumberArg(args: string[], flag: string, value: number | undefined) {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

export function clusterEngineCacheVariant(args: string[]): string {
  const digest = createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 16);
  return `engine-${digest}`;
}

function normalizePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseClusterBenchArgs(process.argv.slice(2));
  const report = await runClusterBenchmarkSuite(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatClusterBenchmarkMarkdown(report);
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
