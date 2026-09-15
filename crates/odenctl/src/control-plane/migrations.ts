import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  applySqliteMigrations,
  SQLITE_SCHEMA_MIGRATION_IDS,
} from "./repository.ts";
import {
  applyPostgresMigrations,
  POSTGRES_SCHEMA_MIGRATION_IDS,
  type PostgresRepositoryOptions,
} from "./postgres-repository.ts";

const { Pool } = pg;

export type ControlPlaneMigrationConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string; ssl: boolean; maxConnections?: number };

export interface ControlPlaneMigrationStatus {
  kind: ControlPlaneMigrationConfig["kind"];
  ok: boolean;
  currentVersion?: string;
  latestVersion?: string;
  applied: string[];
  pending: string[];
  unexpected: string[];
}

export async function applyControlPlaneMigrations(
  config: ControlPlaneMigrationConfig,
): Promise<ControlPlaneMigrationStatus> {
  if (config.kind === "sqlite") {
    applySqliteMigrations(config.path);
  } else {
    await applyPostgresMigrations(postgresOptions(config));
  }
  return checkControlPlaneMigrations(config);
}

export async function checkControlPlaneMigrations(
  config: ControlPlaneMigrationConfig,
): Promise<ControlPlaneMigrationStatus> {
  if (config.kind === "sqlite") {
    return sqliteMigrationStatus(config.path);
  }
  return postgresMigrationStatus(postgresOptions(config));
}

export function expectedControlPlaneMigrationIds(
  kind: ControlPlaneMigrationConfig["kind"],
): string[] {
  return kind === "sqlite"
    ? SQLITE_SCHEMA_MIGRATION_IDS
    : POSTGRES_SCHEMA_MIGRATION_IDS;
}

function sqliteMigrationStatus(path: string): ControlPlaneMigrationStatus {
  if (path === ":memory:") {
    return migrationStatus("sqlite", SQLITE_SCHEMA_MIGRATION_IDS, SQLITE_SCHEMA_MIGRATION_IDS);
  }
  if (!existsSync(path)) {
    return migrationStatus("sqlite", [], SQLITE_SCHEMA_MIGRATION_IDS);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!sqliteTableExists(db, "schema_migrations")) {
      return migrationStatus("sqlite", [], SQLITE_SCHEMA_MIGRATION_IDS);
    }
    const rows = db
      .prepare("select id from schema_migrations order by id asc")
      .all() as Array<{ id: string }>;
    return migrationStatus("sqlite", rows.map((row) => row.id), SQLITE_SCHEMA_MIGRATION_IDS);
  } finally {
    db.close();
  }
}

async function postgresMigrationStatus(
  options: PostgresRepositoryOptions,
): Promise<ControlPlaneMigrationStatus> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 1,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const table = await pool.query("select to_regclass('public.schema_migrations') as name");
    if (!table.rows[0]?.name) {
      return migrationStatus("postgres", [], POSTGRES_SCHEMA_MIGRATION_IDS);
    }
    const result = await pool.query("select id from schema_migrations order by id asc");
    return migrationStatus(
      "postgres",
      result.rows.map((row: any) => row.id),
      POSTGRES_SCHEMA_MIGRATION_IDS,
    );
  } finally {
    await pool.end();
  }
}

function migrationStatus(
  kind: ControlPlaneMigrationConfig["kind"],
  applied: string[],
  expected: string[],
): ControlPlaneMigrationStatus {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const pending = expected.filter((id) => !appliedSet.has(id));
  const unexpected = applied.filter((id) => !expectedSet.has(id));
  const currentVersion = [...expected].reverse().find((id) => appliedSet.has(id));
  const latestVersion = expected.at(-1);
  return {
    kind,
    ok: pending.length === 0 && unexpected.length === 0,
    currentVersion,
    latestVersion,
    applied,
    pending,
    unexpected,
  };
}

function sqliteTableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(name);
  return Boolean(row);
}

function postgresOptions(config: Extract<ControlPlaneMigrationConfig, { kind: "postgres" }>): PostgresRepositoryOptions {
  return {
    connectionString: config.url,
    ssl: config.ssl,
    max: config.maxConnections,
  };
}
