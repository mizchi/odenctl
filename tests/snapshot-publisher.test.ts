import assert from "node:assert/strict";
import { test } from "node:test";
import { publishRouteSnapshot } from "../src/control-plane/snapshot-publisher.ts";
import type { RouteSnapshot } from "../src/control-plane/contracts.ts";

test("snapshot publisher retries retryable runtime failures per target", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  let now = 0;

  const report = await publishRouteSnapshot(
    snapshot(),
    [{ id: "rt_retry", url: "http://runtime.local" }],
    async (url, init) => {
      calls.push({ url, body: init.body });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
          async text() {
            return "warming";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { routes: 1, generatedAt: "2026-06-26T10:00:00.000Z", snapshotId: "snap_retry" };
        },
        async text() {
          return "ok";
        },
      };
    },
    {
      maxAttempts: 3,
      retryDelayMs: 0,
      nowMs: () => {
        now += 10;
        return now;
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(report.targets[0], {
    id: "rt_retry",
    url: "http://runtime.local",
    ok: true,
    status: 200,
    routes: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    snapshotId: "snap_retry",
    attempts: 2,
    elapsedMs: 10,
  });
});

test("snapshot publisher does not retry non-retryable runtime responses", async () => {
  let calls = 0;

  const report = await publishRouteSnapshot(
    snapshot(),
    [{ id: "rt_bad", url: "http://runtime.local" }],
    async () => {
      calls += 1;
      return {
        ok: false,
        status: 401,
        async json() {
          return {};
        },
        async text() {
          return "unauthorized";
        },
      };
    },
    { maxAttempts: 3, retryDelayMs: 0, nowMs: () => 100 },
  );

  assert.equal(report.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(report.targets[0], {
    id: "rt_bad",
    url: "http://runtime.local",
    ok: false,
    status: 401,
    error: "unauthorized",
    attempts: 1,
    elapsedMs: 0,
  });
});

test("snapshot publisher can send target-specific route snapshots", async () => {
  const sent: Array<{ url: string; snapshot: RouteSnapshot }> = [];
  const baseSnapshot = snapshotWithRoute();
  const filteredSnapshot = { ...baseSnapshot, id: "snap_filtered", routes: [] };

  const report = await publishRouteSnapshot(
    baseSnapshot,
    [
      { id: "rt_full", url: "http://full.runtime.local" },
      { id: "rt_filtered", url: "http://filtered.runtime.local", snapshot: filteredSnapshot },
    ],
    async (url, init) => {
      const body = JSON.parse(init.body) as RouteSnapshot;
      sent.push({ url, snapshot: body });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            routes: body.routes.length,
            generatedAt: body.generatedAt,
            snapshotId: body.id,
          };
        },
        async text() {
          return "ok";
        },
      };
    },
    { nowMs: () => 0 },
  );

  assert.equal(report.snapshot.id, baseSnapshot.id);
  assert.deepEqual(
    report.targets.map((target) => ({ id: target.id, routes: target.routes, snapshotId: target.snapshotId })),
    [
      { id: "rt_full", routes: 1, snapshotId: baseSnapshot.id },
      { id: "rt_filtered", routes: 0, snapshotId: "snap_filtered" },
    ],
  );
  assert.deepEqual(sent.map((call) => ({ url: call.url, routes: call.snapshot.routes.length })), [
    { url: "http://full.runtime.local/__runtime/snapshots/routes", routes: 1 },
    { url: "http://filtered.runtime.local/__runtime/snapshots/routes", routes: 0 },
  ]);
});

function snapshot(): RouteSnapshot {
  return {
    id: "snap_retry",
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes: [],
  };
}

function snapshotWithRoute(): RouteSnapshot {
  return {
    ...snapshot(),
    routes: [{
      host: "hello.example.dev",
      pathPrefix: "/",
      projectId: "prj_hello",
      deploymentId: "dep_hello",
      targets: [{
        deploymentId: "dep_hello",
        weight: 100,
        world: "wasi:http/service@0.3.0",
        worldVersion: "0.3.0",
        runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
        limits: {
          cpuMs: 50,
          memoryMb: 64,
          wallMs: 1000,
          requestBytes: 1048576,
          subrequests: 20,
          responseBytes: 1048576,
        },
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [],
          arbitraryFilesystem: false,
          arbitrarySockets: false,
          processSpawn: false,
        },
        artifact: {
          id: "art_hello",
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          location: "file:///tmp/worker.wasm",
        },
      }],
      world: "wasi:http/service@0.3.0",
      worldVersion: "0.3.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
      limits: {
        cpuMs: 50,
        memoryMb: 64,
        wallMs: 1000,
        requestBytes: 1048576,
        subrequests: 20,
        responseBytes: 1048576,
      },
      capabilities: {
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [],
        arbitraryFilesystem: false,
        arbitrarySockets: false,
        processSpawn: false,
      },
      artifact: {
        id: "art_hello",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        location: "file:///tmp/worker.wasm",
      },
    }],
  };
}
