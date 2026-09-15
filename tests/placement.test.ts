import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteSnapshot, RuntimeNode } from "../crates/odenctl/src/control-plane/contracts.ts";
import {
  planRuntimeSnapshotPlacements,
  runtimePlacementPolicyFromEnv,
  selectRuntimeNodesForSnapshot,
} from "../crates/odenctl/src/control-plane/placement.ts";

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

test("placement policy fails over to fallback regions when primary has no targets", () => {
  const nodes = [
    runtimeNode("rt_iad_busy", "iad", { pool: "default" }, 80),
    runtimeNode("rt_iad_room", "iad", { pool: "default" }, 5),
    runtimeNode("rt_lhr", "lhr", { pool: "default" }, 0),
    runtimeNode("rt_other_pool", "iad", { pool: "canary" }, 0),
  ];

  assert.deepEqual(
    selectRuntimeNodesForSnapshot(nodes, snapshot(["prj_a"]), {
      projects: {
        prj_a: {
          regions: ["nrt"],
          labels: { pool: "default" },
          maxTargets: 1,
          failover: [
            { regions: ["iad"], labels: { pool: "default" }, maxTargets: 1 },
            { regions: ["lhr"], labels: { pool: "default" }, maxTargets: 1 },
          ],
        },
      },
    }).map((node) => node.id),
    ["rt_iad_room"],
  );
});

test("placement policy rejects non-positive maxTargets instead of falling through to failover", () => {
  const nodes = [
    runtimeNode("rt_nrt", "nrt", { pool: "default" }, 0),
    runtimeNode("rt_iad", "iad", { pool: "default" }, 0),
  ];

  assert.throws(
    () =>
      selectRuntimeNodesForSnapshot(nodes, snapshot(["prj_a"]), {
        projects: {
          prj_a: {
            regions: ["nrt"],
            maxTargets: 0,
            failover: [{ regions: ["iad"] }],
          },
        },
      }),
    /maxTargets/,
  );
});

test("placement policy keeps primary targets before using failover", () => {
  const nodes = [
    runtimeNode("rt_nrt", "nrt", { pool: "default" }, 50),
    runtimeNode("rt_iad", "iad", { pool: "default" }, 0),
  ];

  assert.deepEqual(
    selectRuntimeNodesForSnapshot(nodes, snapshot(["prj_a"]), {
      projects: {
        prj_a: {
          regions: ["nrt"],
          labels: { pool: "default" },
          failover: [{ regions: ["iad"], labels: { pool: "default" } }],
        },
      },
    }).map((node) => node.id),
    ["rt_nrt"],
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

test("placement plan publishes empty snapshots to every node", () => {
  const nodes = [
    runtimeNode("rt_a", "nrt", { pool: "default" }, 0),
    runtimeNode("rt_b", "iad", { pool: "default" }, 0),
  ];

  assert.deepEqual(
    planRuntimeSnapshotPlacements(nodes, { schemaVersion: 1, generatedAt: fixedNow(), routes: [] }, {
      projects: {
        prj_other: { regions: ["nrt"] },
      },
    }).map((plan) => ({ node: plan.node.id, routes: plan.snapshot.routes.length })),
    [
      { node: "rt_a", routes: 0 },
      { node: "rt_b", routes: 0 },
    ],
  );
});

test("placement policy routes isolated tenants only to isolation pool snapshots", () => {
  const nodes = [
    runtimeNode("rt_default", "nrt", { pool: "default" }, 0),
    runtimeNode("rt_isolated", "nrt", { pool: "isolation" }, 0),
  ];

  const plans = planRuntimeSnapshotPlacements(nodes, snapshot(["prj_normal", "prj_noisy"]), {
    default: { labels: { pool: "default" } },
    isolation: {
      projects: {
        prj_noisy: { labels: { pool: "isolation" } },
      },
    },
  });

  assert.deepEqual(
    plans.map((plan) => ({
      node: plan.node.id,
      projects: plan.snapshot.routes.map((route) => route.projectId),
    })),
    [
      { node: "rt_default", projects: ["prj_normal"] },
      { node: "rt_isolated", projects: ["prj_noisy"] },
    ],
  );
  assert.notEqual(plans[0]?.snapshot.id, plans[1]?.snapshot.id);
});

test("placement policy can force-drain tenants from every runtime snapshot", () => {
  const nodes = [
    runtimeNode("rt_default", "nrt", { pool: "default" }, 0),
    runtimeNode("rt_isolated", "nrt", { pool: "isolation" }, 0),
  ];

  const plans = planRuntimeSnapshotPlacements(nodes, snapshot(["prj_noisy"]), {
    isolation: {
      drainedProjects: ["prj_noisy"],
    },
  });

  assert.deepEqual(
    plans.map((plan) => ({
      node: plan.node.id,
      routes: plan.snapshot.routes.length,
    })),
    [
      { node: "rt_default", routes: 0 },
      { node: "rt_isolated", routes: 0 },
    ],
  );
});

test("placement policy parses isolation pool and drained tenants from environment", () => {
  assert.deepEqual(runtimePlacementPolicyFromEnv({
    ODENCTL_ISOLATION_POOL_PROJECTS: "prj_noisy=isolation, prj_gpu=gpu",
    ODENCTL_DRAINED_PROJECTS: "prj_blocked",
  }), {
    isolation: {
      projects: {
        prj_noisy: { labels: { pool: "isolation" } },
        prj_gpu: { labels: { pool: "gpu" } },
      },
      drainedProjects: ["prj_blocked"],
    },
  });
  assert.equal(runtimePlacementPolicyFromEnv({}), undefined);
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
      world: "wasi:http/service@0.3.0",
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
        id: `art_${projectId}`,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        location: "file:///tmp/worker.wasm",
      },
    })),
  };
}
