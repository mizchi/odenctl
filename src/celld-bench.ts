import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runLoadBenchmark, summarizeLatencies, type BenchmarkResult } from "./bench.ts";
import { startCelldDev } from "./celld-dev.ts";

export interface CelldCase {
  workload: "read" | "increment";
  prefix: string;
  iterations: number;
  warmup: number;
  concurrency: number;
  objects: number;
  timeoutMs: number;
}

export interface CelldBenchOptions {
  celldBin: string;
  hostBin: string;
  component: string;
  iterations: number;
  warmup: number;
  concurrency: number[];
  objects: number;
  timeoutMs: number;
  format: "markdown" | "json";
  output?: string;
}

export interface CelldBenchResult extends BenchmarkResult {
  objects: number;
  warmupCount: number;
  warmupElapsedMs: number;
  verifiedCount: number;
  /** Includes launch, compilation, instantiation, warmup, calls, verification and exit. */
  processElapsedMs?: number;
}

export interface CelldBenchReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: Record<string, string | number>;
  results: CelldBenchResult[];
}

export function parseCelldBenchArgs(args: string[]): CelldBenchOptions {
  const options: CelldBenchOptions = {
    celldBin: process.env.ODEN_CELLD_BIN ?? "celld",
    hostBin: "target/release/oden",
    component: "examples/durable-counter/target/benchmark/wasm32-wasip2/release/durable_counter_example.wasm",
    iterations: 100, warmup: 10, concurrency: [1, 8], objects: 1, timeoutMs: 60_000, format: "markdown",
  };
  const integer = (value: string, min: number, max: number) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`expected integer ${min}..${max}: ${value}`);
    return n;
  };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--celld-bin": options.celldBin = value; break;
      case "--host-bin": options.hostBin = value; break;
      case "--component": options.component = value; break;
      case "--iterations": options.iterations = integer(value, 1, 1_000_000); break;
      case "--warmup": options.warmup = integer(value, 0, 1_000_000); break;
      case "--concurrency": options.concurrency = [...new Set(value.split(",").map((v) => integer(v, 1, 1024)))]; break;
      case "--objects": options.objects = integer(value, 1, 1024); break;
      case "--timeout-ms": options.timeoutMs = integer(value, 1, 86_400_000); break;
      case "--output": options.output = value; break;
      case "--format":
        if (value !== "markdown" && value !== "json") throw new Error("format must be markdown or json");
        options.format = value; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

async function gatewayFetch(target: { endpoint: string; token: string }, name: string, timeoutMs: number, id?: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(`${target.endpoint}/v1/objects/COUNTER/${encodeURIComponent(name)}/fetch`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method: id ? "POST" : "GET", path: id ? "/increment" : "/", headers: [], body: "", ...(id ? { requestId: id } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`gateway status ${response.status}`);
  const envelope = JSON.parse(text);
  assert.ok(typeof envelope.body === "string", "actor body must be base64");
  if (envelope.status !== 200) throw new Error(`actor status ${envelope.status}: ${Buffer.from(envelope.body, "base64").toString("utf8").slice(0, 256)}`);
  const counter = JSON.parse(Buffer.from(envelope.body, "base64").toString("utf8"));
  assert.ok(Number.isSafeInteger(counter.n) && counter.n >= 0, "actor returned an invalid counter");
  return counter.n;
}

/** Both phases use bounded concurrency and distinct IDs; only the second is timed in the result. */
export async function runGatewayCase(target: { endpoint: string; token: string }, options: CelldCase, signal?: AbortSignal): Promise<CelldBenchResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const batch = async (phase: string, count: number) => {
    let next = 0;
    let firstError: unknown;
    const result = await runLoadBenchmark({
      name: `gateway.${options.workload}`, iterations: count, concurrency: options.concurrency,
      operation: async () => {
        if (firstError) throw firstError;
        const index = next++;
        try {
          const id = options.workload === "increment" ? `${options.prefix}:${phase}:${index}` : undefined;
          const n = await gatewayFetch(target, `${options.prefix}-${index % options.objects}`, options.timeoutMs, id, signal);
          assert.ok(options.workload === "increment" ? n > 0 : n === 0, "unexpected counter value");
        } catch (error) { firstError ??= error; throw error; }
      },
    });
    if (firstError) throw firstError;
    return result;
  };
  const warmup = await batch("warmup", options.warmup);
  const result = await batch("measured", options.iterations);
  let verifiedCount = 0;
  for (let i = 0; i < options.objects; i++) {
    const assigned = (count: number) => Math.floor(count / options.objects) + Number(i < count % options.objects);
    const expected = options.workload === "increment" ? assigned(options.warmup) + assigned(options.iterations) : 0;
    const actual = await gatewayFetch(target, `${options.prefix}-${i}`, options.timeoutMs, undefined, signal);
    assert.equal(actual, expected, `counter ${i}: committed updates must match all requests`);
    verifiedCount += actual;
  }
  return { ...result, objects: options.objects, warmupCount: options.warmup, warmupElapsedMs: warmup.elapsedMs, verifiedCount };
}

export function summarizeGuestCase(raw: unknown, options: CelldCase, processElapsedMs: number): CelldBenchResult {
  assert.ok(raw !== null && typeof raw === "object");
  const report = raw as Record<string, unknown>;
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.latenciesMs) && report.latenciesMs.length === options.iterations, "guest sample count mismatch");
  assert.ok(report.latenciesMs.every((v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0), "invalid guest latencies");
  assert.ok(typeof report.elapsedMs === "number" && Number.isFinite(report.elapsedMs) && report.elapsedMs > 0, "invalid guest elapsed time");
  assert.ok(typeof report.warmupElapsedMs === "number" && Number.isFinite(report.warmupElapsedMs) && report.warmupElapsedMs >= 0);
  assert.equal(report.warmupCount, options.warmup);
  const expected = options.workload === "increment" ? options.warmup + options.iterations : 0;
  assert.equal(report.verifiedCount, expected, "guest committed count mismatch");
  return {
    name: `wit.${options.workload}`, iterations: options.iterations, concurrency: options.concurrency,
    ...summarizeLatencies(report.latenciesMs, report.elapsedMs, 0),
    objects: options.objects, warmupCount: options.warmup, warmupElapsedMs: report.warmupElapsedMs,
    verifiedCount: expected, processElapsedMs,
  };
}

export async function runCelldBenchmark(options: CelldBenchOptions, signal?: AbortSignal): Promise<CelldBenchReport> {
  const exec = promisify(execFile);
  // Fail before starting celld if a build or tool is missing.
  const [component, hostVersion, celldVersion] = await Promise.all([
    readFile(options.component),
    exec(resolve(options.hostBin), ["--version"], { timeout: 20_000, signal }),
    exec(options.celldBin, ["--version"], { timeout: 20_000, signal }),
  ]);
  const dev = await startCelldDev(options.celldBin, signal);
  try {
    const runtimeConfig = join(dev.directory, "runtime.json");
    await writeFile(runtimeConfig, JSON.stringify({
      timeout_ms: options.timeoutMs, max_concurrent_requests: Math.max(...options.concurrency),
      durable: { counter: { endpoint: dev.endpoint, namespace: "COUNTER", token_env: "BENCH_GATEWAY_TOKEN" } },
    }));
    const results: CelldBenchResult[] = [];
    for (const workload of ["read", "increment"] as const) {
      for (const concurrency of options.concurrency) {
        // Use both client orders across the concurrency settings.
        const routes = concurrency === options.concurrency[0] ? ["gateway", "wit"] : ["wit", "gateway"];
        for (const route of routes) {
          signal?.throwIfAborted();
          const scenario: CelldCase = { ...options, workload, concurrency, prefix: `bench-${route}-${workload}-${randomBytes(8).toString("hex")}` };
          if (route === "gateway") {
            results.push(await runGatewayCase(dev, scenario, signal));
          } else {
            const started = performance.now();
            const { stdout } = await exec(resolve(options.hostBin), ["run", resolve(options.component), "--config", runtimeConfig, "--",
              "counter", scenario.prefix, workload, String(options.iterations), String(options.warmup), String(concurrency), String(options.objects),
            ], { env: { ...process.env, BENCH_GATEWAY_TOKEN: dev.token }, timeout: options.timeoutMs + 30_000, maxBuffer: 64 * 1024 * 1024, signal });
            results.push(summarizeGuestCase(JSON.parse(stdout), scenario, performance.now() - started));
          }
        }
      }
    }
    return {
      schemaVersion: 1, generatedAt: new Date().toISOString(),
      environment: {
        node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model ?? "unknown",
        hostVersion: hostVersion.stdout.trim(), celldVersion: celldVersion.stdout.split(/\r?\n/).find((line) => line.startsWith("celld ")) ?? "unknown", hostBinary: resolve(options.hostBin),
        componentSha256: createHash("sha256").update(component).digest("hex"),
        baselineClient: "Node.js fetch", witClient: "Wasmtime + Rust reqwest", storage: "celld dev SQLite (temporary directory)",
      },
      results,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\ncelld logs:\n${dev.logs()}`, { cause: error });
  } finally { await dev.stop(); }
}

export function formatCelldBenchmark(report: CelldBenchReport): string {
  return [
    "# celld Durable Objects benchmark", "",
    ...Object.entries(report.environment).map(([key, value]) => `${key}: ${value}`), "",
    "| Case | Concurrency | Objects | Count | RPS | p50 ms | p95 ms | p99 ms | CLI total ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.results.map((r) => `| ${r.name} | ${r.concurrency} | ${r.objects} | ${r.count} | ${r.throughputRps} | ${r.p50Ms} | ${r.p95Ms} | ${r.p99Ms} | ${r.processElapsedMs?.toFixed(3) ?? "—"} |`), "",
    "Latencies/RPS exclude warmup, compilation and final state verification. CLI total includes all of them.",
    "All requests must succeed and final counters must match. HTTP clients differ, so this is not an isolated measurement of WIT overhead.", "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const options = parseCelldBenchArgs(process.argv.slice(2));
    const report = await runCelldBenchmark(options, abort.signal);
    const json = JSON.stringify(report, null, 2) + "\n";
    if (options.output) {
      await mkdir(dirname(resolve(options.output)), { recursive: true });
      await writeFile(options.output, json);
    }
    process.stdout.write(options.format === "json" ? json : formatCelldBenchmark(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
