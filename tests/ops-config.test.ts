import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOperationalRequirements,
  operationalConfigFromEnv,
} from "../src/ops-config.ts";

test("operational config exposes non-secret production posture from environment", () => {
  const config = operationalConfigFromEnv({
    DATABASE_URL: "postgres://user:pass@db.example/wasmplane?sslmode=require",
    WASMPLANE_ARTIFACT_STORE: "s3",
    WASMPLANE_VOLUME_SQLITE_ROOT: "/data/sqlite",
    WASMPLANE_RUNTIME_NODES: "https://rt-a.internal,https://rt-b.internal",
    WASMPLANE_ROUTE_SNAPSHOT_REPLICAS: "nrt=https://cp-nrt,iad=https://cp-iad",
    WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS: "1000",
    WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES: "alarm-demo,rooms",
  });

  assert.deepEqual(config, {
    schemaVersion: 1,
    database: { kind: "postgres", external: true },
    artifactStore: { kind: "s3", external: true },
    volumeSqlite: { enabled: true },
    runtimeNodes: { staticTargets: 2 },
    routeSnapshotReplicas: { configured: 2 },
    durableObjectAlarms: { enabled: true, namespaces: ["alarm-demo", "rooms"] },
  });
});

test("operational requirements can require external database and artifact store", () => {
  const sqliteLocal = operationalConfigFromEnv({
    WASMPLANE_DB: "/data/wasmplane.sqlite",
    WASMPLANE_ARTIFACT_DIR: "/data/artifacts",
  });

  assert.throws(
    () => assertOperationalRequirements(sqliteLocal, {
      WASMPLANE_REQUIRE_EXTERNAL_DATABASE: "1",
    }),
    /requires DATABASE_URL or WASMPLANE_DATABASE_URL/,
  );
  assert.throws(
    () => assertOperationalRequirements(sqliteLocal, {
      WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE: "1",
    }),
    /requires an external artifact store/,
  );

  assert.doesNotThrow(() =>
    assertOperationalRequirements(
      operationalConfigFromEnv({
        DATABASE_URL: "postgres://db.example/wasmplane",
        WASMPLANE_ARTIFACT_STORE: "s3",
      }),
      {
        WASMPLANE_REQUIRE_EXTERNAL_DATABASE: "1",
        WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE: "1",
      },
    )
  );
});
