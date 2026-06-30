import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClusterRouteSnapshot,
  clusterEngineCacheVariant,
  clusterHostPoolingArgs,
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
    "--placement",
    "--autoscaling",
    "--format",
    "json",
  ]);

  assert.equal(options.componentPath, "worker.component.wasm");
  assert.equal(options.hostBin, "target/debug/wasmplane-wasip3-host");
  assert.deepEqual(options.nodeCounts, [1, 2, 4]);
  assert.equal(options.iterations, 100);
  assert.equal(options.warmup, 3);
  assert.deepEqual(options.concurrency, [1, 8, 32]);
  assert.equal(options.placement, true);
  assert.equal(options.autoscaling, true);
  assert.equal(options.format, "json");
});

test("cluster benchmark CLI args parse daemon host mode and pooling args", () => {
  const options = parseClusterBenchArgs([
    "--component",
    "worker.component.wasm",
    "--host-daemon-url",
    "http://127.0.0.1:8790",
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
    "--pooling-total-core-instances",
    "256",
    "--pooling-total-memories",
    "64",
    "--pooling-total-tables",
    "128",
  ]);

  assert.equal(options.hostDaemonUrl, "http://127.0.0.1:8790");
  assert.deepEqual(clusterHostPoolingArgs(options), [
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
    "--pooling-total-core-instances",
    "256",
    "--pooling-total-memories",
    "64",
    "--pooling-total-tables",
    "128",
  ]);
});

test("cluster benchmark daemon cache variant stays short and path safe", () => {
  const args = clusterHostPoolingArgs(parseClusterBenchArgs([
    "--component",
    "worker.component.wasm",
    "--host-daemon-url",
    "http://127.0.0.1:8790",
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
    "--pooling-total-core-instances",
    "256",
    "--pooling-total-memories",
    "64",
    "--pooling-total-tables",
    "128",
    "--pooling-table-elements",
    "4096",
    "--pooling-component-instance-mb",
    "2",
    "--pooling-core-instance-mb",
    "3",
  ]));

  const variant = clusterEngineCacheVariant(args);

  assert.match(variant, /^engine-[a-f0-9]{16}$/);
  assert.equal(variant.length, "engine-".length + 16);
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
    placements: [
      {
        name: "cluster.placement.region",
        nodes: 2,
        region: "nrt",
        selectedNodes: 1,
        skippedNodes: 1,
        ok: true,
        publishMs: 4,
        selectedVisibleMs: 12,
        skippedVerifiedMs: 1,
        totalMs: 17,
        errors: 0,
      },
    ],
    autoscaling: [
      {
        name: "cluster.autoscale.scale_up_warm",
        action: "scale_up",
        nodes: 2,
        fromNodes: 1,
        toNodes: 2,
        ok: true,
        publishMs: 6,
        visibleMs: 18,
        totalMs: 24,
        errors: 0,
      },
      {
        name: "cluster.autoscale.scale_down_exclude",
        action: "scale_down",
        nodes: 2,
        fromNodes: 2,
        toNodes: 1,
        ok: true,
        publishMs: 3,
        visibleMs: 7,
        totalMs: 10,
        errors: 0,
      },
    ],
  });

  assert.match(markdown, /cluster\.switch\.cold/);
  assert.match(markdown, /cluster\.http\.cwasm/);
  assert.match(markdown, /cluster\.placement\.region/);
  assert.match(markdown, /cluster\.autoscale\.scale_up_warm/);
  assert.match(markdown, /cluster\.autoscale\.scale_down_exclude/);
  assert.match(markdown, /\| operation \| nodes \| publish ms \| visible ms \| total ms \|/);
  assert.match(markdown, /\| benchmark \| nodes \| region \| selected \| skipped \|/);
  assert.match(markdown, /\| benchmark \| action \| nodes \| from \| to \|/);
  assert.match(markdown, /\| benchmark \| nodes \| concurrency \| iterations \| rps \|/);
});
