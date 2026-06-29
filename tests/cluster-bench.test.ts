import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClusterRouteSnapshot,
  formatClusterBenchmarkMarkdown,
  parseClusterBenchArgs,
} from "../src/cluster-bench.ts";

test("cluster benchmark CLI args parse node counts and concurrency list", () => {
  const options = parseClusterBenchArgs([
    "--component",
    "worker.component.wasm",
    "--host-bin",
    "target/debug/wasmplane-wasip3-host",
    "--nodes",
    "1,2,4",
    "--iterations",
    "100",
    "--warmup",
    "3",
    "--concurrency",
    "1,8,32",
    "--format",
    "json",
  ]);

  assert.equal(options.componentPath, "worker.component.wasm");
  assert.equal(options.hostBin, "target/debug/wasmplane-wasip3-host");
  assert.deepEqual(options.nodeCounts, [1, 2, 4]);
  assert.equal(options.iterations, 100);
  assert.equal(options.warmup, 3);
  assert.deepEqual(options.concurrency, [1, 8, 32]);
  assert.equal(options.format, "json");
});

test("cluster route snapshot keeps primary deployment aligned with first target", () => {
  const snapshot = buildClusterRouteSnapshot({
    deploymentId: "dep_green",
    componentLocation: "file:///tmp/worker.component.wasm",
    digest: `sha256:${"a".repeat(64)}`,
    generatedAt: "2026-06-29T00:00:00.000Z",
    hostHeader: "hello.example.dev",
    pathPrefix: "/",
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.routes[0]?.deploymentId, "dep_green");
  assert.equal(snapshot.routes[0]?.targets[0]?.deploymentId, "dep_green");
  assert.equal(snapshot.routes[0]?.artifact.location, "file:///tmp/worker.component.wasm");
});

test("cluster benchmark markdown includes switch and throughput tables", () => {
  const markdown = formatClusterBenchmarkMarkdown({
    schemaVersion: 1,
    generatedAt: "2026-06-29T00:00:00.000Z",
    environment: {
      node: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      cpus: 10,
    },
    throughput: [
      {
        name: "cluster.http.cwasm",
        nodes: 2,
        iterations: 10,
        concurrency: 4,
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
    switches: [
      {
        name: "cluster.switch.cold",
        nodes: 2,
        ok: true,
        publishMs: 5,
        visibleAfterPublishMs: 20,
        totalMs: 25,
        attempts: 2,
        errors: 0,
      },
    ],
  });

  assert.match(markdown, /cluster\.switch\.cold/);
  assert.match(markdown, /cluster\.http\.cwasm/);
  assert.match(markdown, /\| operation \| nodes \| publish ms \| visible ms \| total ms \|/);
  assert.match(markdown, /\| benchmark \| nodes \| concurrency \| iterations \| rps \|/);
});
