import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHostInvokeArgs,
  formatBenchmarkMarkdown,
  parseBenchArgs,
  runLoadBenchmark,
  summarizeLatencies,
} from "../src/bench.ts";

test("benchmark latency summary reports common percentiles and throughput", () => {
  const summary = summarizeLatencies([4, 1, 3, 2], 1000, 0);

  assert.deepEqual(summary, {
    count: 4,
    errors: 0,
    elapsedMs: 1000,
    throughputRps: 4,
    minMs: 1,
    avgMs: 2.5,
    p50Ms: 2,
    p95Ms: 4,
    p99Ms: 4,
    maxMs: 4,
  });
});

test("load benchmark respects configured concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await runLoadBenchmark({
    name: "fake",
    iterations: 8,
    concurrency: 3,
    nowMs: fakeClock(5),
    async operation() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    },
  });

  assert.equal(result.name, "fake");
  assert.equal(result.iterations, 8);
  assert.equal(result.concurrency, 3);
  assert.equal(result.errors, 0);
  assert.equal(maxActive, 3);
});

test("sub-millisecond batches keep their measured throughput", () => {
  assert.equal(summarizeLatencies([0.1, 0.1], 0.5, 0).throughputRps, 4000);
  assert.equal(summarizeLatencies([], 0, 0).throughputRps, 0);
});

test("host invoke args include component, request, limits, and capabilities", () => {
  const args = buildHostInvokeArgs({
    componentPath: "/tmp/worker.component.wasm",
    method: "POST",
    uri: "http://hello.example.dev/",
    body: "payload",
    headers: [{ name: "content-type", value: "text/plain" }],
    limits: {
      cpuMs: 50,
      wallMs: 1000,
      memoryMb: 64,
      requestBytes: 1048576,
      responseBytes: 1048576,
      subrequests: 20,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
  });

  assert.deepEqual(args.slice(0, 11), [
    "invoke",
    "--component",
    "/tmp/worker.component.wasm",
    "--method",
    "POST",
    "--uri",
    "http://hello.example.dev/",
    "--headers",
    JSON.stringify([{ name: "content-type", value: "text/plain" }]),
    "--body",
    "payload",
  ]);
  assert.ok(args.includes("--capabilities"));
  assert.ok(args.includes("--cpu-ms"));
  assert.ok(args.includes("--wall-ms"));
});

test("host invoke args can target precompiled cwasm artifacts", () => {
  const args = buildHostInvokeArgs({
    precompiledPath: "/tmp/worker.component.cwasm",
    method: "GET",
    uri: "http://hello.example.dev/",
    body: "",
    headers: [],
  });

  assert.deepEqual(args.slice(0, 7), [
    "invoke",
    "--precompiled",
    "/tmp/worker.component.cwasm",
    "--method",
    "GET",
    "--uri",
    "http://hello.example.dev/",
  ]);
});

test("host invoke args reject ambiguous component sources", () => {
  assert.throws(
    () =>
      buildHostInvokeArgs({
        componentPath: "/tmp/worker.component.wasm",
        precompiledPath: "/tmp/worker.component.cwasm",
        method: "GET",
        uri: "http://hello.example.dev/",
        body: "",
        headers: [],
      }),
    /expected exactly one/,
  );
});

test("benchmark CLI args parse benchmark modes and concurrency list", () => {
  const options = parseBenchArgs([
    "all",
    "--component",
    "worker.component.wasm",
    "--host-bin",
    "target/debug/wasmplane-wasip3-host",
    "--iterations",
    "100",
    "--warmup",
    "5",
    "--concurrency",
    "1,4,16",
    "--runtime-url",
    "http://127.0.0.1:8788",
    "--format",
    "json",
  ]);

  assert.equal(options.mode, "all");
  assert.equal(options.componentPath, "worker.component.wasm");
  assert.equal(options.hostBin, "target/debug/wasmplane-wasip3-host");
  assert.equal(options.iterations, 100);
  assert.equal(options.warmup, 5);
  assert.deepEqual(options.concurrency, [1, 4, 16]);
  assert.equal(options.runtimeUrl, "http://127.0.0.1:8788");
  assert.equal(options.format, "json");
});

test("benchmark markdown contains one row per result", () => {
  const markdown = formatBenchmarkMarkdown({
    schemaVersion: 1,
    generatedAt: "2026-06-29T00:00:00.000Z",
    environment: {
      node: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      cpus: 10,
    },
    results: [
      {
        name: "host.invoke.cwasm",
        iterations: 10,
        concurrency: 1,
        count: 10,
        errors: 0,
        elapsedMs: 100,
        throughputRps: 100,
        minMs: 1,
        avgMs: 2,
        p50Ms: 2,
        p95Ms: 3,
        p99Ms: 4,
        maxMs: 4,
      },
    ],
  });

  assert.match(markdown, /host\.invoke\.cwasm/);
  assert.match(markdown, /\| benchmark \| concurrency \| iterations \| rps \| avg ms \| p50 ms \| p95 ms \| p99 ms \| errors \|/);
});

function fakeClock(stepMs: number) {
  let value = 0;
  return () => {
    value += stepMs;
    return value;
  };
}
