import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteSnapshot } from "../crates/odenctl/src/control-plane/contracts.ts";
import {
  createInMemoryRouteSnapshotReplicaStore,
  replicateRouteSnapshot,
  routeSnapshotReplicaTargetsFromEnv,
} from "../crates/odenctl/src/control-plane/snapshot-replication.ts";

test("snapshot replication reports inconsistent replica acknowledgements", async () => {
  const calls: Array<{ url: string; authorization?: string; body: any }> = [];
  let now = 0;
  const report = await replicateRouteSnapshot(
    snapshot("snap_primary", "2026-07-01T00:00:10.000Z"),
    [{ id: "replica_iad", region: "iad", url: "https://iad-control.internal", token: "replica-token" }],
    async (url, init) => {
      calls.push({
        url,
        authorization: init.headers.authorization,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            accepted: true,
            snapshotId: "snap_old",
            generatedAt: "2026-07-01T00:00:00.000Z",
          };
        },
        async text() {
          return "ok";
        },
      };
    },
    {
      retryDelayMs: 0,
      nowMs: () => {
        now += 5;
        return now;
      },
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.consistent, false);
  assert.deepEqual(calls, [{
    url: "https://iad-control.internal/replication/snapshots/routes",
    authorization: "Bearer replica-token",
    body: snapshot("snap_primary", "2026-07-01T00:00:10.000Z"),
  }]);
  assert.deepEqual(report.replicas[0], {
    id: "replica_iad",
    region: "iad",
    url: "https://iad-control.internal",
    ok: true,
    consistent: false,
    status: 200,
    snapshotId: "snap_old",
    generatedAt: "2026-07-01T00:00:00.000Z",
    error: "replica acknowledged a different snapshot",
    attempts: 1,
    elapsedMs: 5,
  });
});

test("in-memory snapshot replica store rejects stale snapshots", () => {
  const store = createInMemoryRouteSnapshotReplicaStore();
  const first = store.apply({
    snapshot: snapshot("snap_new", "2026-07-01T00:00:10.000Z"),
    sourceRegion: "nrt",
    receivedAt: "2026-07-01T00:00:11.000Z",
  });
  const stale = store.apply({
    snapshot: snapshot("snap_old", "2026-07-01T00:00:00.000Z"),
    sourceRegion: "nrt",
    receivedAt: "2026-07-01T00:00:12.000Z",
  });

  assert.equal(first.accepted, true);
  assert.deepEqual(stale, {
    accepted: false,
    stale: true,
    snapshotId: "snap_new",
    generatedAt: "2026-07-01T00:00:10.000Z",
    receivedAt: "2026-07-01T00:00:11.000Z",
  });
  assert.equal(store.current()?.snapshot.id, "snap_new");
});

test("route snapshot replica targets parse region-qualified env entries", () => {
  assert.deepEqual(
    routeSnapshotReplicaTargetsFromEnv(
      "iad=https://iad-control.internal,lhr=https://lhr-control.internal",
      "replica-token",
    ),
    [
      {
        id: "replica-iad",
        region: "iad",
        url: "https://iad-control.internal",
        token: "replica-token",
      },
      {
        id: "replica-lhr",
        region: "lhr",
        url: "https://lhr-control.internal",
        token: "replica-token",
      },
    ],
  );
});

function snapshot(id: string, generatedAt: string): RouteSnapshot {
  return {
    id,
    schemaVersion: 1,
    generatedAt,
    routes: [],
  };
}
