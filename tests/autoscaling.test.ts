import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import {
  decideRuntimeAutoscaling,
  runtimeSaturationSignals,
  warmAndActivateRuntimeNode,
} from "../src/control-plane/autoscaling.ts";
import { reconcileFlyMachinesAutoscaling } from "../src/control-plane/fly-autoscaler.ts";

test("runtime autoscaling exports saturation signals and scales up above threshold", () => {
  const nodes = [
    runtimeNode("rt_1", 80, 100),
    runtimeNode("rt_2", 90, 100),
  ];

  assert.deepEqual(runtimeSaturationSignals(nodes), [
    {
      id: "rt_1",
      url: "http://rt-1.internal",
      status: "active",
      activeRequests: 80,
      concurrentRequests: 100,
      loadRatio: 0.8,
      saturated: false,
    },
    {
      id: "rt_2",
      url: "http://rt-2.internal",
      status: "active",
      activeRequests: 90,
      concurrentRequests: 100,
      loadRatio: 0.9,
      saturated: false,
    },
  ]);

  assert.deepEqual(decideRuntimeAutoscaling(nodes, {
    minNodes: 1,
    maxNodes: 4,
    targetLoadRatio: 0.7,
    scaleUpThreshold: 0.75,
    scaleUpStep: 2,
  }), {
    action: "scale_up",
    reason: "load_above_threshold",
    currentNodes: 2,
    desiredNodes: 4,
    add: 2,
    remove: 0,
    averageLoadRatio: 0.85,
    candidateNodeIds: [],
  });
});

test("runtime autoscaling scales down low-load nodes while respecting min nodes", () => {
  const nodes = [
    runtimeNode("rt_busy", 25, 100),
    runtimeNode("rt_idle", 0, 100),
    runtimeNode("rt_cool", 10, 100),
  ];

  assert.deepEqual(decideRuntimeAutoscaling(nodes, {
    minNodes: 1,
    maxNodes: 4,
    targetLoadRatio: 0.7,
    scaleDownThreshold: 0.2,
    scaleDownStep: 1,
  }), {
    action: "scale_down",
    reason: "load_below_threshold",
    currentNodes: 3,
    desiredNodes: 2,
    add: 0,
    remove: 1,
    averageLoadRatio: 0.117,
    candidateNodeIds: ["rt_idle"],
  });
});

test("warm and activate registers a new runtime as draining before publishing", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const calls: Array<{ url: string; method: string; authorization?: string; body: any }> = [];
  const report = await warmAndActivateRuntimeNode({
    controlPlane: control,
    runtimeNode: {
      id: "rt_new",
      url: "http://rt-new.internal",
      region: "nrt",
      labels: { pool: "default" },
      capacity: { concurrentRequests: 100, memoryMb: 512 },
      version: "wasmplane-runtime/0.1.0",
    },
    snapshot: emptySnapshot(),
    runtimeNodeToken: "runtime-secret",
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        authorization: init.headers.authorization,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, routes: 0, generatedAt: fixedNow(), snapshotId: "snap_empty" };
        },
        async text() {
          return "ok";
        },
      };
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    {
      url: "http://rt-new.internal/__runtime/snapshots/routes",
      method: "PUT",
      authorization: "Bearer runtime-secret",
      body: emptySnapshot(),
    },
  ]);
  assert.equal(control.listRuntimeNodes()[0]?.status, "active");
  assert.equal(control.listRuntimeNodes()[0]?.lastSeenAt, fixedNow());
});

test("Fly autoscaler creates and stops machines from autoscaling decisions", async () => {
  const calls: Array<{ url: string; method: string; body?: any; authorization?: string }> = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      url,
      method: init.method,
      authorization: init.headers.authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ id: "machine-new", state: "started" }), { status: 200 });
  };

  const scaleUp = await reconcileFlyMachinesAutoscaling({
    appName: "wasmplane-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/wasmplane-runtime:deployment-1" },
    decision: {
      action: "scale_up",
      reason: "load_above_threshold",
      currentNodes: 1,
      desiredNodes: 2,
      add: 1,
      remove: 0,
      averageLoadRatio: 0.9,
      candidateNodeIds: [],
    },
    fetch: fetchImpl as any,
  });
  const scaleDown = await reconcileFlyMachinesAutoscaling({
    appName: "wasmplane-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: {},
    decision: {
      action: "scale_down",
      reason: "load_below_threshold",
      currentNodes: 2,
      desiredNodes: 1,
      add: 0,
      remove: 1,
      averageLoadRatio: 0.05,
      candidateNodeIds: ["rt_machine-old"],
    },
    machines: [{ id: "machine-old", state: "started", region: "nrt" }],
    fetch: fetchImpl as any,
  });

  assert.deepEqual(scaleUp.actions, [{ type: "create", machineId: "machine-new", ok: true, status: 200 }]);
  assert.deepEqual(scaleDown.actions, [{ type: "stop", machineId: "machine-old", ok: true, status: 200 }]);
  assert.deepEqual(calls, [
    {
      url: "https://api.machines.dev/v1/apps/wasmplane-runtime/machines",
      method: "POST",
      authorization: "Bearer fly-token",
      body: {
        config: { image: "registry.fly.io/wasmplane-runtime:deployment-1" },
        region: "nrt",
      },
    },
    {
      url: "https://api.machines.dev/v1/apps/wasmplane-runtime/machines/machine-old/stop",
      method: "POST",
      authorization: "Bearer fly-token",
      body: undefined,
    },
  ]);
});

function runtimeNode(id: string, activeRequests: number, concurrentRequests: number) {
  return {
    id,
    url: `http://${id.replace("_", "-")}.internal`,
    status: "active" as const,
    registeredAt: fixedNow(),
    lastSeenAt: fixedNow(),
    capacity: { concurrentRequests, memoryMb: 512 },
    load: { activeRequests },
  };
}

function emptySnapshot() {
  return {
    id: "snap_empty",
    schemaVersion: 1 as const,
    generatedAt: fixedNow(),
    routes: [],
  };
}

function sequenceIds() {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}

function fixedNow() {
  return "2026-06-30T10:00:00.000Z";
}
