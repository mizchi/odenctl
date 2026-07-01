import { mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneError } from "./errors.ts";

export interface VolumeSqliteDatabaseRecord {
  id: string;
  path: string;
  kind: string;
  ownerId?: string;
  schemaVersion: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface EnsureVolumeSqliteDatabaseInput {
  id: string;
  kind?: string;
  ownerId?: string;
  schemaVersion?: number;
}

export interface VolumeSqliteRegistryOptions {
  rootDir: string;
  catalogPath?: string;
  maxOpenDatabases?: number;
  busyTimeoutMs?: number;
  now?: () => string;
}

export interface SqliteDatabasePoolOptions {
  maxOpen: number;
  busyTimeoutMs?: number;
  configure?: (db: DatabaseSync, path: string) => void;
}

export interface SqliteDatabasePoolEntry {
  id: string;
  path: string;
}

export function createVolumeSqliteRegistry(options: VolumeSqliteRegistryOptions): VolumeSqliteRegistry {
  return new VolumeSqliteRegistry(options);
}

export class VolumeSqliteRegistry {
  readonly rootDir: string;
  readonly databaseDir: string;
  readonly catalogPath: string;
  private readonly catalog: DatabaseSync;
  private readonly pool: SqliteDatabasePool;
  private readonly now: () => string;

  constructor(options: VolumeSqliteRegistryOptions) {
    this.rootDir = resolve(options.rootDir);
    this.databaseDir = join(this.rootDir, "dbs");
    this.catalogPath = resolve(options.catalogPath ?? join(this.rootDir, "catalog.sqlite"));
    assertPathInside(this.rootDir, this.catalogPath, "volume sqlite catalog path");
    mkdirSync(this.databaseDir, { recursive: true });
    mkdirSync(dirname(this.catalogPath), { recursive: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalog = new DatabaseSync(this.catalogPath);
    configureSqliteDatabase(this.catalog, { busyTimeoutMs: options.busyTimeoutMs });
    this.catalog.exec(catalogSchema);
    this.pool = new SqliteDatabasePool({
      maxOpen: options.maxOpenDatabases ?? 64,
      busyTimeoutMs: options.busyTimeoutMs,
    });
  }

  ensureDatabase(input: EnsureVolumeSqliteDatabaseInput): VolumeSqliteDatabaseRecord {
    const id = databaseId(input.id);
    const kind = databaseKind(input.kind ?? "project");
    const ownerId = optionalIdentifier(input.ownerId, "volume sqlite database owner id");
    const schemaVersion = nonnegativeInteger(input.schemaVersion ?? 0, "volume sqlite database schema version");
    const existing = this.getDatabase(id);
    if (existing) {
      const lastUsedAt = this.now();
      this.catalog
        .prepare(
          `update volume_sqlite_databases set
            kind = ?,
            owner_id = ?,
            schema_version = max(schema_version, ?),
            last_used_at = ?
          where id = ?`,
        )
        .run(kind, ownerId ?? null, schemaVersion, lastUsedAt, id);
      const updated = this.getDatabase(id) as VolumeSqliteDatabaseRecord;
      this.initializeDatabaseFile(updated);
      return updated;
    }

    const createdAt = this.now();
    const path = this.pathForDatabase(id);
    mkdirSync(dirname(path), { recursive: true });
    this.catalog
      .prepare(
        `insert into volume_sqlite_databases (
          id,
          path,
          kind,
          owner_id,
          schema_version,
          created_at,
          last_used_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, path, kind, ownerId ?? null, schemaVersion, createdAt, createdAt);
    const record = this.getDatabase(id) as VolumeSqliteDatabaseRecord;
    this.initializeDatabaseFile(record);
    return record;
  }

  getDatabase(id: string): VolumeSqliteDatabaseRecord | undefined {
    const row = this.catalog
      .prepare("select * from volume_sqlite_databases where id = ?")
      .get(databaseId(id));
    return row ? recordFromRow(row) : undefined;
  }

  listDatabases(): VolumeSqliteDatabaseRecord[] {
    return this.catalog
      .prepare("select * from volume_sqlite_databases order by id asc")
      .all()
      .map(recordFromRow);
  }

  withDatabase<T>(id: string, callback: (db: DatabaseSync, record: VolumeSqliteDatabaseRecord) => T): T {
    const record = this.getDatabase(id);
    if (!record) {
      throw new ControlPlaneError("not_found", `volume sqlite database ${id} was not found`);
    }
    const lastUsedAt = this.now();
    this.catalog
      .prepare("update volume_sqlite_databases set last_used_at = ? where id = ?")
      .run(lastUsedAt, record.id);
    const updated = { ...record, lastUsedAt };
    return callback(this.pool.open(updated), updated);
  }

  stats() {
    return {
      databases: this.listDatabases().length,
      pool: this.pool.stats(),
    };
  }

  close(): void {
    this.pool.closeAll();
    this.catalog.close();
  }

  private pathForDatabase(id: string): string {
    const path = resolve(join(this.databaseDir, `${id}.sqlite`));
    assertPathInside(this.databaseDir, path, "volume sqlite database path");
    return path;
  }

  private initializeDatabaseFile(record: VolumeSqliteDatabaseRecord): void {
    this.withDatabase(record.id, (db) => {
      const current = userVersion(db);
      if (current < record.schemaVersion) {
        db.exec(`pragma user_version = ${record.schemaVersion}`);
      }
    });
  }
}

export class SqliteDatabasePool {
  private readonly maxOpen: number;
  private readonly configure: (db: DatabaseSync, path: string) => void;
  private readonly entries = new Map<string, { path: string; db: DatabaseSync }>();

  constructor(options: SqliteDatabasePoolOptions) {
    this.maxOpen = positiveInteger(options.maxOpen, "sqlite database pool maxOpen");
    this.configure = options.configure
      ?? ((db) => configureSqliteDatabase(db, { busyTimeoutMs: options.busyTimeoutMs }));
  }

  open(entry: SqliteDatabasePoolEntry): DatabaseSync {
    const id = databaseId(entry.id);
    const path = resolve(entry.path);
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing.db;
    }
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    this.configure(db, path);
    this.entries.set(id, { path, db });
    this.evictOverflow();
    return db;
  }

  close(id: string): boolean {
    const normalized = databaseId(id);
    const entry = this.entries.get(normalized);
    if (!entry) {
      return false;
    }
    this.entries.delete(normalized);
    entry.db.close();
    return true;
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.db.close();
    }
    this.entries.clear();
  }

  stats() {
    return {
      maxOpen: this.maxOpen,
      open: this.entries.size,
      openIds: [...this.entries.keys()],
    };
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxOpen) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      this.close(oldest);
    }
  }
}

function configureSqliteDatabase(db: DatabaseSync, options: { busyTimeoutMs?: number } = {}): void {
  const busyTimeoutMs = nonnegativeInteger(options.busyTimeoutMs ?? 5000, "sqlite busy timeout");
  db.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    pragma foreign_keys = on;
    pragma busy_timeout = ${busyTimeoutMs};
  `);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("pragma user_version").get() as Record<string, unknown>;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : 0;
}

function recordFromRow(row: any): VolumeSqliteDatabaseRecord {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function databaseId(value: string): string {
  return identifier(value, "volume sqlite database id");
}

function databaseKind(value: string): string {
  return identifier(value, "volume sqlite database kind");
}

function optionalIdentifier(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return identifier(value, field);
}

function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new ControlPlaneError(
      "validation",
      `${field} must start with an alphanumeric character and contain only alphanumerics, dot, dash, or underscore`,
    );
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ControlPlaneError("validation", `${field} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneError("validation", `${field} must be a nonnegative integer`);
  }
  return value;
}

function assertPathInside(root: string, path: string, field: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new ControlPlaneError("validation", `${field} must be inside ${normalizedRoot}`);
  }
}

const catalogSchema = `
create table if not exists volume_sqlite_databases (
  id text primary key,
  path text not null unique,
  kind text not null,
  owner_id text,
  schema_version integer not null default 0,
  created_at text not null,
  last_used_at text not null
);

create index if not exists volume_sqlite_databases_owner_idx
  on volume_sqlite_databases (owner_id, kind, id);

create index if not exists volume_sqlite_databases_last_used_idx
  on volume_sqlite_databases (last_used_at asc, id asc);
`;
