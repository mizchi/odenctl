import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import {
  decideRuntimeAutoscaling,
  runtimeSaturationSignals,
  warmAndActivateRuntimeNode,
} from "../src/control-plane/autoscaling.ts";
import {
  createInMemoryFlyAutoscalerCoordinationStore,
  createPostgresFlyAutoscalerCoordinationStore,
  createSqliteFlyAutoscalerCoordinationStore,
  reconcileFlyMachinesAutoscaling,
} from "../src/control-plane/fly-autoscaler.ts";

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
      version: "oden-runtime/0.1.0",
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
    appName: "oden-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/oden-runtime:deployment-1" },
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
    appName: "oden-runtime",
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
      url: "https://api.machines.dev/v1/apps/oden-runtime/machines",
      method: "POST",
      authorization: "Bearer fly-token",
      body: {
        config: { image: "registry.fly.io/oden-runtime:deployment-1" },
        region: "nrt",
      },
    },
    {
      url: "https://api.machines.dev/v1/apps/oden-runtime/machines/machine-old/stop",
      method: "POST",
      authorization: "Bearer fly-token",
      body: undefined,
    },
  ]);
});

test("Fly autoscaler skips reconciliation when another controller holds the lease", async () => {
  const coordination = createInMemoryFlyAutoscalerCoordinationStore();
  assert.equal(await coordination.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-a",
    ttlMs: 30_000,
    nowMs: 1_000,
  }), true);
  let calls = 0;

  const report = await reconcileFlyMachinesAutoscaling({
    appName: "oden-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/oden-runtime:deployment-1" },
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
    controllerId: "controller-b",
    lease: { ttlMs: 30_000 },
    coordination,
    nowMs: () => 2_000,
    fetch: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "machine-new" }), { status: 200 });
    }) as any,
  });

  assert.equal(calls, 0);
  assert.deepEqual(report.actions, []);
  assert.equal(report.skippedReason, "lease_unavailable");
  assert.deepEqual(report.lease, {
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    acquired: false,
  });
});

test("Fly autoscaler records cooldown after scaling and skips until it expires", async () => {
  const coordination = createInMemoryFlyAutoscalerCoordinationStore();
  const calls: Array<{ url: string; method: string }> = [];
  let nowMs = 10_000;
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, method: init.method });
    return new Response(JSON.stringify({ id: `machine-${calls.length}`, state: "started" }), { status: 200 });
  };
  const decision = {
    action: "scale_up" as const,
    reason: "load_above_threshold" as const,
    currentNodes: 1,
    desiredNodes: 2,
    add: 1,
    remove: 0,
    averageLoadRatio: 0.9,
    candidateNodeIds: [],
  };

  const first = await reconcileFlyMachinesAutoscaling({
    appName: "oden-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/oden-runtime:deployment-1" },
    decision,
    controllerId: "controller-a",
    lease: { ttlMs: 30_000 },
    cooldown: { durationMs: 60_000 },
    coordination,
    nowMs: () => nowMs,
    fetch: fetchImpl as any,
  });
  nowMs = 20_000;
  const second = await reconcileFlyMachinesAutoscaling({
    appName: "oden-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/oden-runtime:deployment-1" },
    decision,
    controllerId: "controller-b",
    lease: { ttlMs: 30_000 },
    cooldown: { durationMs: 60_000 },
    coordination,
    nowMs: () => nowMs,
    fetch: fetchImpl as any,
  });
  nowMs = 71_000;
  const third = await reconcileFlyMachinesAutoscaling({
    appName: "oden-runtime",
    apiToken: "fly-token",
    region: "nrt",
    machineConfig: { image: "registry.fly.io/oden-runtime:deployment-1" },
    decision,
    controllerId: "controller-c",
    lease: { ttlMs: 30_000 },
    cooldown: { durationMs: 60_000 },
    coordination,
    nowMs: () => nowMs,
    fetch: fetchImpl as any,
  });

  assert.equal(first.actions.length, 1);
  assert.equal(first.cooldown?.active, false);
  assert.deepEqual(second.actions, []);
  assert.equal(second.skippedReason, "cooldown");
  assert.deepEqual(second.cooldown, {
    key: "fly:oden-runtime:nrt",
    active: true,
    untilMs: 70_000,
    remainingMs: 50_000,
  });
  assert.equal(third.actions.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
});

test("SQLite Fly autoscaler coordination store persists leases and cooldowns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-autoscaler-coordination-"));
  const path = join(dir, "coordination.sqlite");
  const first = createSqliteFlyAutoscalerCoordinationStore(path);

  assert.equal(await first.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-a",
    ttlMs: 30_000,
    nowMs: 10_000,
  }), true);
  assert.equal(await first.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    ttlMs: 30_000,
    nowMs: 20_000,
  }), false);
  await first.writeCooldown({
    key: "fly:oden-runtime:nrt",
    action: "scale_up",
    atMs: 10_000,
    untilMs: 70_000,
  });
  first.close();

  const second = createSqliteFlyAutoscalerCoordinationStore(path);
  assert.equal(await second.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    ttlMs: 30_000,
    nowMs: 20_000,
  }), false);
  assert.deepEqual(await second.readCooldown("fly:oden-runtime:nrt"), {
    key: "fly:oden-runtime:nrt",
    action: "scale_up",
    atMs: 10_000,
    untilMs: 70_000,
  });
  await second.releaseLease({ key: "fly:oden-runtime:nrt", holder: "controller-a" });
  assert.equal(await second.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    ttlMs: 30_000,
    nowMs: 20_000,
  }), true);
  second.close();
});

test("Postgres Fly autoscaler coordination store persists leases and cooldowns", async () => {
  const rows = new Map<string, any>();
  const queries: string[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      queries.push(sql);
      if (sql.includes("create table if not exists fly_autoscaler_coordination")) {
        return { rows: [] };
      }
      if (sql.includes("returning coordination_key")) {
        const [key, holder, expiresAtMs, _updatedAt, nowMs] = values as [string, string, number, string, number];
        const current = rows.get(key) ?? { coordination_key: key };
        if (
          current.lease_holder === holder ||
          current.lease_expires_at_ms == null ||
          Number(current.lease_expires_at_ms) <= nowMs
        ) {
          rows.set(key, {
            ...current,
            lease_holder: holder,
            lease_expires_at_ms: expiresAtMs,
          });
          return { rows: [{ coordination_key: key }] };
        }
        return { rows: [] };
      }
      if (sql.includes("set lease_holder = null")) {
        const [_updatedAt, key, holder] = values as [string, string, string];
        const current = rows.get(key);
        if (current?.lease_holder === holder) {
          rows.set(key, {
            ...current,
            lease_holder: null,
            lease_expires_at_ms: null,
          });
        }
        return { rows: [] };
      }
      if (sql.includes("select coordination_key, cooldown_action")) {
        const [key] = values as [string];
        const current = rows.get(key);
        return { rows: current ? [current] : [] };
      }
      if (sql.includes("cooldown_action") && sql.includes("on conflict")) {
        const [key, action, atMs, untilMs] = values as [string, string, number, number, string];
        const current = rows.get(key) ?? { coordination_key: key };
        rows.set(key, {
          ...current,
          cooldown_action: action,
          cooldown_at_ms: String(atMs),
          cooldown_until_ms: String(untilMs),
        });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const store = createPostgresFlyAutoscalerCoordinationStore(pool);

  assert.equal(await store.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-a",
    ttlMs: 30_000,
    nowMs: 10_000,
  }), true);
  assert.equal(await store.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    ttlMs: 30_000,
    nowMs: 20_000,
  }), false);
  await store.writeCooldown({
    key: "fly:oden-runtime:nrt",
    action: "scale_up",
    atMs: 10_000,
    untilMs: 70_000,
  });
  assert.deepEqual(await store.readCooldown("fly:oden-runtime:nrt"), {
    key: "fly:oden-runtime:nrt",
    action: "scale_up",
    atMs: 10_000,
    untilMs: 70_000,
  });
  await store.releaseLease({ key: "fly:oden-runtime:nrt", holder: "controller-a" });
  assert.equal(await store.acquireLease({
    key: "fly:oden-runtime:nrt",
    holder: "controller-b",
    ttlMs: 30_000,
    nowMs: 20_000,
  }), true);
  assert.ok(queries.some((query) => query.includes("create table if not exists fly_autoscaler_coordination")));
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
