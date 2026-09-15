import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOperationalRequirements,
  operationalConfigFromEnv,
} from "../crates/odenctl/src/ops-config.ts";

test("operational config exposes non-secret production posture from environment", () => {
  const config = operationalConfigFromEnv({
    DATABASE_URL: "postgres://user:pass@db.example/odenctl?sslmode=require",
    ODENCTL_ARTIFACT_STORE: "s3",
    ODENCTL_VOLUME_SQLITE_ROOT: "/data/sqlite",
    ODENCTL_RUNTIME_NODES: "https://rt-a.internal,https://rt-b.internal",
    ODENCTL_ROUTE_SNAPSHOT_REPLICAS: "nrt=https://cp-nrt,iad=https://cp-iad",
    ODENCTL_DURABLE_OBJECT_ALARM_INTERVAL_MS: "1000",
    ODENCTL_DURABLE_OBJECT_ALARM_NAMESPACES: "alarm-demo,rooms",
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
    ODENCTL_DB: "/data/odenctl.sqlite",
    ODENCTL_ARTIFACT_DIR: "/data/artifacts",
  });

  assert.throws(
    () => assertOperationalRequirements(sqliteLocal, {
      ODENCTL_REQUIRE_EXTERNAL_DATABASE: "1",
    }),
    /requires DATABASE_URL or ODENCTL_DATABASE_URL/,
  );
  assert.throws(
    () => assertOperationalRequirements(sqliteLocal, {
      ODENCTL_REQUIRE_EXTERNAL_ARTIFACT_STORE: "1",
    }),
    /requires an external artifact store/,
  );

  assert.doesNotThrow(() =>
    assertOperationalRequirements(
      operationalConfigFromEnv({
        DATABASE_URL: "postgres://db.example/odenctl",
        ODENCTL_ARTIFACT_STORE: "s3",
      }),
      {
        ODENCTL_REQUIRE_EXTERNAL_DATABASE: "1",
        ODENCTL_REQUIRE_EXTERNAL_ARTIFACT_STORE: "1",
      },
    )
  );
});
