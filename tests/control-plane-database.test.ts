import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveControlPlaneDatabaseConfig } from "../src/control-plane/database.ts";

test("control-plane database config prefers DATABASE_URL Postgres over local SQLite", () => {
  assert.deepEqual(resolveControlPlaneDatabaseConfig({}), {
    kind: "sqlite",
    path: "wasmplane.sqlite",
  });
  assert.deepEqual(resolveControlPlaneDatabaseConfig({ WASMPLANE_DB: "/data/control.sqlite" }), {
    kind: "sqlite",
    path: "/data/control.sqlite",
  });
  assert.deepEqual(
    resolveControlPlaneDatabaseConfig({
      DATABASE_URL: "postgres://user:secret@db.example.com:5432/wasmplane?sslmode=require",
      WASMPLANE_DB: "/data/control.sqlite",
    }),
    {
      kind: "postgres",
      url: "postgres://user:secret@db.example.com:5432/wasmplane?sslmode=require",
      ssl: true,
    },
  );
  assert.deepEqual(
    resolveControlPlaneDatabaseConfig({
      WASMPLANE_DATABASE_URL: "postgres://user:secret@db.internal:5432/wasmplane",
      WASMPLANE_POSTGRES_SSL: "0",
    }),
    {
      kind: "postgres",
      url: "postgres://user:secret@db.internal:5432/wasmplane",
      ssl: false,
    },
  );
});

test("Postgres schema covers control-plane tables without SQLite-only syntax", async () => {
  const sql = await readFile("db/postgres/001_init.sql", "utf8");
  for (const table of [
    "schema_migrations",
    "projects",
    "artifacts",
    "secrets",
    "kv_namespaces",
    "deployments",
    "routes",
    "runtime_nodes",
    "route_snapshot_publications",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
  }
  assert.match(sql, /targets_json jsonb/);
  assert.match(sql, /capacity_json jsonb/);
  assert.match(sql, /snapshot_id text/);
  assert.match(sql, /create index if not exists routes_lookup_idx/);
  assert.match(sql, /create index if not exists runtime_nodes_status_last_seen_idx/);
  assert.doesNotMatch(sql, /pragma/i);
  assert.doesNotMatch(sql, /\binteger primary key\b/i);
});
