import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyConfiguredControlPlaneMigrations,
  checkConfiguredControlPlaneMigrations,
  resolveControlPlaneDatabaseConfig,
} from "../src/control-plane/database.ts";

test("control-plane database config prefers DATABASE_URL Postgres over local SQLite", () => {
  assert.deepEqual(resolveControlPlaneDatabaseConfig({}), {
    kind: "sqlite",
    path: "odenctl.sqlite",
  });
  assert.deepEqual(resolveControlPlaneDatabaseConfig({ ODENCTL_DB: "/data/control.sqlite" }), {
    kind: "sqlite",
    path: "/data/control.sqlite",
  });
  assert.deepEqual(
    resolveControlPlaneDatabaseConfig({
      DATABASE_URL: "postgres://user:secret@db.example.com:5432/odenctl?sslmode=require",
      ODENCTL_DB: "/data/control.sqlite",
    }),
    {
      kind: "postgres",
      url: "postgres://user:secret@db.example.com:5432/odenctl?sslmode=require",
      ssl: true,
    },
  );
  assert.deepEqual(
    resolveControlPlaneDatabaseConfig({
      ODENCTL_DATABASE_URL: "postgres://user:secret@db.internal:5432/odenctl",
      ODENCTL_POSTGRES_SSL: "0",
    }),
    {
      kind: "postgres",
      url: "postgres://user:secret@db.internal:5432/odenctl",
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
    "canary_decisions",
    "fly_autoscaler_coordination",
    "organizations",
    "users",
    "project_memberships",
    "api_keys",
    "usage_events",
    "production_quota_increases",
    "custom_domains",
    "deploy_previews",
    "edge_worker_releases",
    "edge_worker_release_operations",
    "billing_invoices",
    "billing_webhook_deliveries",
    "billing_invoice_adjustments",
    "billing_invoice_retention_policies",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
  }
  assert.match(sql, /targets_json jsonb/);
  assert.match(sql, /signature_json jsonb/);
  assert.match(sql, /provenance_json jsonb/);
  assert.match(sql, /world_version text not null default '0\.1\.0'/);
  assert.match(sql, /capacity_json jsonb/);
  assert.match(sql, /labels_json jsonb/);
  assert.match(sql, /load_json jsonb/);
  assert.match(sql, /identity_json jsonb/);
  assert.match(sql, /snapshot_id text/);
  assert.match(sql, /canary_decisions_created_at_idx/);
  assert.match(sql, /create index if not exists routes_lookup_idx/);
  assert.match(sql, /create index if not exists runtime_nodes_status_last_seen_idx/);
  assert.match(sql, /create index if not exists fly_autoscaler_coordination_lease_idx/);
  assert.match(sql, /create index if not exists usage_events_project_time_idx/);
  assert.match(sql, /create index if not exists custom_domains_project_idx/);
  assert.match(sql, /create index if not exists deploy_previews_project_idx/);
  assert.match(sql, /create index if not exists edge_worker_releases_project_idx/);
  assert.match(sql, /create index if not exists edge_worker_release_operations_pending_idx/);
  assert.match(sql, /statement_json jsonb not null/);
  assert.match(sql, /artifact_json jsonb not null/);
  assert.match(sql, /status text not null default 'active' check \(status in \('creating', 'active', 'deleting', 'deleted', 'failed'\)\)/);
  assert.match(sql, /deleted_at text/);
  assert.match(sql, /content_digest text not null/);
  assert.match(sql, /unique \(organization_id, period_key\)/);
  assert.match(sql, /payload_json jsonb not null/);
  assert.match(sql, /billing_webhook_deliveries_status_next_idx/);
  assert.match(sql, /billing_invoice_adjustments_invoice_idx/);
  assert.match(sql, /billing_invoice_retention_policies_org_idx/);
  assert.match(sql, /billing_provider text not null default 'none'/);
  assert.match(sql, /billing_customer_id text/);
  assert.match(sql, /payment_status text not null default 'payment_pending'/);
  assert.match(sql, /billing_email text/);
  assert.match(sql, /payment_status_updated_at text not null/);
  assert.match(sql, /email_verified_at text/);
  assert.match(sql, /invite_status text not null default 'pending'/);
  assert.match(sql, /accepted_at text/);
  assert.match(sql, /create table if not exists production_quota_increases/);
  assert.match(sql, /requested_quotas_json jsonb not null/);
  assert.match(sql, /production_quota_increases_org_idx/);
  assert.doesNotMatch(sql, /pragma/i);
  assert.doesNotMatch(sql, /\binteger primary key\b/i);
});

test("control-plane migration status tracks SQLite schema version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-migration-status-"));
  const dbPath = join(dir, "control.sqlite");

  const pending = await checkConfiguredControlPlaneMigrations({
    env: { ODENCTL_DB: dbPath },
  });
  assert.equal(pending.kind, "sqlite");
  assert.equal(pending.ok, false);
  assert.equal(pending.currentVersion, undefined);
  assert.ok(pending.latestVersion);
  assert.ok(pending.pending.includes(pending.latestVersion));

  const applied = await applyConfiguredControlPlaneMigrations({
    env: { ODENCTL_DB: dbPath },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.currentVersion, applied.latestVersion);
  assert.deepEqual(applied.pending, []);
  assert.equal(applied.applied.at(-1), applied.latestVersion);
});
