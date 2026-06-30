import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteSnapshot, RuntimeNode } from "../src/control-plane/contracts.ts";
import { selectRuntimeNodesForSnapshot } from "../src/control-plane/placement.ts";

test("placement policy selects project nodes by region and labels with load preference", () => {
  const nodes = [
    runtimeNode("rt_busy", "nrt", { pool: "default" }, 80),
    runtimeNode("rt_room", "nrt", { pool: "default" }, 10),
    runtimeNode("rt_other_pool", "nrt", { pool: "canary" }, 0),
    runtimeNode("rt_other_region", "iad", { pool: "default" }, 0),
  ];

  assert.deepEqual(
    selectRuntimeNodesForSnapshot(nodes, snapshot(["prj_a"]), {
      projects: {
        prj_a: {
          regions: ["nrt"],
          labels: { pool: "default" },
          maxTargets: 1,
        },
      },
    }).map((node) => node.id),
    ["rt_room"],
  );
});

test("placement policy keeps all nodes for projects without a rule", () => {
  const nodes = [
    runtimeNode("rt_busy", "nrt", { pool: "default" }, 80),
    runtimeNode("rt_room", "iad", { pool: "default" }, 10),
  ];

  assert.deepEqual(
    selectRuntimeNodesForSnapshot(nodes, snapshot(["prj_unconfigured"]), {
      projects: {
        prj_other: { regions: ["nrt"] },
      },
    }).map((node) => node.id),
    ["rt_room", "rt_busy"],
  );
});

test("placement policy publishes empty snapshots to every node", () => {
  const nodes = [
    runtimeNode("rt_a", "nrt", { pool: "default" }, 0),
    runtimeNode("rt_b", "iad", { pool: "default" }, 0),
  ];

  assert.deepEqual(
    selectRuntimeNodesForSnapshot(nodes, { schemaVersion: 1, generatedAt: fixedNow(), routes: [] }, {
      projects: {
        prj_other: { regions: ["nrt"] },
      },
    }).map((node) => node.id),
    ["rt_a", "rt_b"],
  );
});

function runtimeNode(
  id: string,
  region: string,
  labels: Record<string, string>,
  activeRequests: number,
): RuntimeNode {
  return {
    id,
    url: `http://${id}.runtime.local`,
    status: "active",
    registeredAt: fixedNow(),
    lastSeenAt: fixedNow(),
    region,
    labels,
    capacity: { concurrentRequests: 100, memoryMb: 1024 },
    load: { activeRequests },
  };
}

function fixedNow() {
  return "2026-06-26T10:00:00.000Z";
}

function snapshot(projectIds: string[]): RouteSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes: projectIds.map((projectId) => ({
      host: `${projectId}.example.dev`,
      pathPrefix: "/",
      projectId,
      deploymentId: `dep_${projectId}`,
      targets: [{ deploymentId: `dep_${projectId}`, weight: 100 }],
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
      limits: {
        cpuMs: 50,
        memoryMb: 64,
        wallMs: 1000,
        requestBytes: 1048576,
        subrequests: 20,
        hostCalls: 100,
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
        id: `art_${projectId}`,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        location: "file:///tmp/worker.wasm",
      },
    })),
  };
}
