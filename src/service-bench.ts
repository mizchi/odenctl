import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { createHistogram, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startServiceProcess } from "./service-process.ts";

export interface ServiceBenchOptions {
  hostBin: string; component: string; config?: string;
  modes: Array<"fresh" | "resident">; concurrency: number[];
  iterations: number; warmup: number; durationMs: number; cycles: number;
  path: string; timeoutMs: number; output?: string;
}
export function parseServiceBenchOptions(args: string[]): ServiceBenchOptions {
  const options: ServiceBenchOptions = {
    hostBin: "target/release/wasmplane", component: "examples/service-rust/target/wasm32-wasip2/release/service_rust.wasm",
    modes: ["fresh", "resident"], concurrency: [1, 8], iterations: 1000, warmup: 20, durationMs: 0, cycles: 1, path: "/", timeoutMs: 10_000,
  };
  const number = (value: string | undefined, flag: string, min: number, max: number) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${flag} must be ${min}..${max}`);
    return result;
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]; const value = args[++index];
    if (!value) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--host-bin": options.hostBin = value; break;
      case "--component": options.component = value; break;
      case "--config": options.config = value; break;
      case "--mode":
        if (!["fresh", "resident", "all"].includes(value)) throw new Error("mode must be fresh, resident or all");
        options.modes = value === "all" ? ["fresh", "resident"] : [value as "fresh" | "resident"]; break;
      case "--concurrency": options.concurrency = value.split(",").map(v => number(v, flag, 1, 1024)); break;
      case "--iterations": options.iterations = number(value, flag, 1, 100_000_000); break;
      case "--warmup": options.warmup = number(value, flag, 0, 1_000_000); break;
      case "--duration-ms": options.durationMs = number(value, flag, 0, 86_400_000); break;
      case "--cycles": options.cycles = number(value, flag, 1, 1000); break;
      case "--timeout-ms": options.timeoutMs = number(value, flag, 1, 300_000); break;
      case "--path": if (!value.startsWith("/") || value.startsWith("//")) throw new Error("path must start with a single /"); options.path = value; break;
      case "--output": options.output = value; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  return options;
}

async function rssBytes(pid: number) {
  const { stdout } = await promisify(execFile)("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000 });
  const value = Number(stdout.trim()) * 1024;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid RSS for pid ${pid}`);
  return value;
}

async function measure(options: ServiceBenchOptions, mode: "fresh" | "resident", concurrency: number, cycle: number, signal?: AbortSignal) {
  const args = ["serve", resolve(options.component), "--addr", "127.0.0.1:0", ...(mode === "resident" ? ["--resident"] : []), ...(options.config ? ["--config", resolve(options.config)] : [])];
  const server = await startServiceProcess(resolve(options.hostBin), args, process.env, signal);
  // Keep deadline timers and abort listeners bounded by in-flight concurrency.
  const pending = new Set<AbortController>();
  const abort = () => { for (const request of pending) request.abort(signal?.reason); };
  signal?.addEventListener("abort", abort, { once: true });
  let sampleTask: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const request = async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
      pending.add(deadline);
      if (signal?.aborted) deadline.abort(signal.reason);
      try {
        const response = await fetch(server.url + options.path, { signal: deadline.signal });
        await response.arrayBuffer();
        return String(response.status);
      } catch { return "transport"; }
      finally { clearTimeout(timer); pending.delete(deadline); }
    };
    const firstStarted = performance.now();
    const firstStatus = await request();
    const firstRequestMs = performance.now() - firstStarted;
    if (!firstStatus.startsWith("2")) throw new Error(`first request failed (${firstStatus}): ${server.logs()}`);
    for (let i = 0; i < options.warmup; i++) {
      signal?.throwIfAborted();
      const status = await request(); if (!status.startsWith("2")) throw new Error(`warmup failed (${status}): ${server.logs()}`);
    }
    const baselineBytes = await rssBytes(server.pid);
    const rss = { baselineBytes, peakBytes: baselineBytes, endBytes: baselineBytes, samples: 1, sampleErrors: 0, growthBytes: 0 };
    const sample = async () => {
      try { const bytes = await rssBytes(server.pid); rss.endBytes = bytes; rss.peakBytes = Math.max(rss.peakBytes, bytes); rss.samples++; }
      catch { rss.sampleErrors++; }
    };
    // At most one ps process in flight. Retain aggregates, not an unbounded sample list.
    timer = setInterval(() => { if (!sampleTask) sampleTask = sample().finally(() => { sampleTask = undefined; }); }, 100);
    const histogram = createHistogram();
    const statusCounts: Record<string, number> = {};
    let issued = 0; let requests = 0; let errors = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      // A duration run ignores iterations and stops issuing at its deadline, then drains.
      while (options.durationMs > 0 ? performance.now() - start < options.durationMs : issued < options.iterations) {
        signal?.throwIfAborted();
        issued++;
        const before = performance.now();
        const status = await request();
        histogram.record(Math.max(1, Math.round((performance.now() - before) * 1_000_000)));
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        requests++; if (!status.startsWith("2")) errors++;
      }
    }));
    const durationMs = performance.now() - start;
    clearInterval(timer); timer = undefined;
    await sampleTask; await sample();
    rss.growthBytes = rss.endBytes - baselineBytes;
    const shutdown = await server.stop();
    return {
      mode, concurrency, cycle, startupMs: server.startupMs, firstRequestMs,
      durationMs, requests, errors, statusCounts, successRps: (requests - errors) / (durationMs / 1000),
      latency: { p50Ms: histogram.percentile(50) / 1e6, p95Ms: histogram.percentile(95) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 },
      rss, shutdown,
    };
  } finally { clearInterval(timer); abort(); signal?.removeEventListener("abort", abort); await sampleTask; await server.stop(); }
}

export async function runServiceBenchmark(options: ServiceBenchOptions, signal?: AbortSignal, onResult?: (result: Awaited<ReturnType<typeof measure>>) => void) {
  signal?.throwIfAborted();
  const { stdout } = await promisify(execFile)(resolve(options.hostBin), ["--version"]);
  const results: Array<Awaited<ReturnType<typeof measure>>> = [];
  for (let cycle = 1; cycle <= options.cycles; cycle++) {
    for (const concurrency of options.concurrency) {
      for (const mode of options.modes) {
        const result = await measure(options, mode, concurrency, cycle, signal);
        results.push(result);
        onResult?.(result);
      }
    }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    environment: { runtime: stdout.trim(), node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cpus: cpus().length },
    componentSha256: createHash("sha256").update(await readFile(options.component)).digest("hex"),
    // Configuration values may contain secrets; record only its digest.
    configSha256: options.config ? createHash("sha256").update(await readFile(options.config)).digest("hex") : null,
    workload: { iterations: options.durationMs ? null : options.iterations, durationMs: options.durationMs, warmup: options.warmup, concurrency: options.concurrency, cycles: options.cycles, path: options.path, timeoutMs: options.timeoutMs },
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes("--help")) {
      console.log("service-bench [--host-bin path] [--component path] [--mode all|fresh|resident] [--iterations 1000] [--duration-ms 0] [--warmup 20] [--concurrency 1,8] [--cycles 1] [--config path] [--path /] [--timeout-ms 10000] [--output report.json]");
    } else {
      const options = parseServiceBenchOptions(process.argv.slice(2));
      const controller = new AbortController();
      const interrupt = () => controller.abort(new Error("benchmark interrupted"));
      process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
      let report: Awaited<ReturnType<typeof runServiceBenchmark>>;
      try { report = await runServiceBenchmark(options, controller.signal, (result) => {
        console.error(`${result.mode} c=${result.concurrency} cycle=${result.cycle}: ${result.requests} requests, ${result.errors} errors, ${result.successRps.toFixed(0)} RPS, RSS growth ${result.rss.growthBytes} bytes`);
      }); }
      finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
      const json = JSON.stringify(report, null, 2) + "\n";
      if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, json); }
      process.stdout.write(json);
      if (report.results.some(r => r.errors || r.rss.sampleErrors || r.shutdown.exitCode !== 0 || r.shutdown.forced || r.shutdown.pidAlive)) process.exitCode = 1;
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
}
