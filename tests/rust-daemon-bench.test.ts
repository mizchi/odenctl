import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPreparedRouteTablePayload,
  buildWorkerFetchHeaders,
  formatRustDaemonBenchmarkMarkdown,
  parseRustDaemonBenchArgs,
} from "../src/rust-daemon-bench.ts";

test("rust daemon benchmark args parse route and pooling settings", () => {
  const options = parseRustDaemonBenchArgs([
    "--component",
    "worker.component.wasm",
    "--host-bin",
    "target/debug/oden-host",
    "--port",
    "8791",
    "--iterations",
    "100",
    "--warmup",
    "5",
    "--concurrency",
    "1,8,32",
    "--host",
    "hello.example.dev",
    "--path",
    "/api",
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
    "--http-workers",
    "32",
  ]);

  assert.equal(options.componentPath, "worker.component.wasm");
  assert.equal(options.hostBin, "target/debug/oden-host");
  assert.equal(options.port, 8791);
  assert.deepEqual(options.concurrency, [1, 8, 32]);
  assert.equal(options.hostHeader, "hello.example.dev");
  assert.equal(options.path, "/api");
  assert.deepEqual(options.poolingArgs, [
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
  ]);
  assert.deepEqual(options.daemonRuntimeArgs, [
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
    "--http-workers",
    "32",
  ]);
});

test("rust daemon benchmark builds a prepared route payload", () => {
  const payload = buildPreparedRouteTablePayload({
    host: "Hello.Example.Dev:443",
    pathPrefix: "/api/",
    deploymentId: "dep_bench",
    precompiledPath: "/tmp/worker.component.cwasm",
  });

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.routes[0]?.host, "Hello.Example.Dev:443");
  assert.equal(payload.routes[0]?.pathPrefix, "/api/");
  assert.equal(payload.routes[0]?.deploymentId, "dep_bench");
  assert.equal(payload.routes[0]?.precompiled, "/tmp/worker.component.cwasm");
  assert.equal(payload.routes[0]?.runtime.backend, "wasmtime");
  assert.equal(payload.routes[0]?.runtime.wasi, "wasip3");
});

test("rust daemon benchmark keeps HTTP connections reusable", () => {
  const headers = buildWorkerFetchHeaders({ hostHeader: "hello.example.dev" });

  assert.equal(headers["x-forwarded-host"], "hello.example.dev");
  assert.equal(headers["content-type"], "text/plain");
  assert.equal(headers.connection, undefined);
});

test("rust daemon benchmark markdown labels direct daemon results", () => {
  const markdown = formatRustDaemonBenchmarkMarkdown({
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    target: "http://127.0.0.1:8791",
    results: [{
      name: "rust-daemon.http",
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
    }],
  });

  assert.match(markdown, /# odenctl Rust daemon benchmark/);
  assert.match(markdown, /\| rust-daemon\.http \| 1 \| 10 \| 100 \|/);
});
