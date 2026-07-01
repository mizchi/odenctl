import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createVolumeSqliteRegistry,
  SqliteDatabasePool,
} from "../src/control-plane/volume-sqlite.ts";

test("volume sqlite registry creates a cataloged database file with WAL settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    now: fixedNow,
    maxOpenDatabases: 2,
  });

  try {
    const record = registry.ensureDatabase({
      id: "prj_api",
      kind: "project",
      ownerId: "org_main",
      schemaVersion: 3,
    });

    assert.equal(record.id, "prj_api");
    assert.equal(record.kind, "project");
    assert.equal(record.ownerId, "org_main");
    assert.equal(record.schemaVersion, 3);
    assert.equal(record.createdAt, fixedNow());
    assert.equal(record.path, join(dir, "dbs", "prj_api.sqlite"));
    await stat(record.path);

    registry.withDatabase("prj_api", (db) => {
      db.exec("create table if not exists events (id text primary key)");
      const journalMode = firstPragmaValue(db.prepare("pragma journal_mode").get());
      const userVersion = firstPragmaValue(db.prepare("pragma user_version").get());
      assert.equal(journalMode, "wal");
      assert.equal(userVersion, 3);
    });

    assert.deepEqual(registry.listDatabases().map((database) => database.id), ["prj_api"]);
    assert.deepEqual(registry.stats().pool.openIds, ["prj_api"]);
  } finally {
    registry.close();
  }
});

test("volume sqlite registry exports and restores individual database files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-backup-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    now: fixedNow,
    maxOpenDatabases: 2,
  });

  try {
    registry.ensureDatabase({
      id: "prj_api",
      kind: "project",
      ownerId: "org_main",
      schemaVersion: 4,
    });
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key); insert into events (id) values ('before')");
    });

    const backup = registry.exportDatabase({ id: "prj_api", backupId: "snapshot_a" });
    assert.equal(backup.id, "snapshot_a");
    assert.equal(backup.databaseId, "prj_api");
    assert.equal(backup.path, join(dir, "backups", "snapshot_a.sqlite"));
    assert.ok(backup.sizeBytes > 0);
    assert.equal(backup.createdAt, fixedNow());
    await stat(backup.path);

    registry.withDatabase("prj_api", (db) => {
      db.exec("insert into events (id) values ('after')");
    });
    registry.restoreDatabase({ id: "prj_api", backupId: "snapshot_a" });

    registry.withDatabase("prj_api", (db) => {
      const rows = db.prepare("select id from events order by id asc").all();
      assert.deepEqual(rows.map((row: any) => row.id), ["before"]);
      assert.equal(firstPragmaValue(db.prepare("pragma user_version").get()), 4);
    });
  } finally {
    registry.close();
  }
});

test("volume sqlite registry rejects unsafe backup and restore paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-unsafe-backup-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    registry.ensureDatabase({ id: "prj_api" });
    assert.throws(
      () => registry.exportDatabase({ id: "prj_api", backupId: "../escape" }),
      /volume sqlite backup id/,
    );
    assert.throws(
      () => registry.restoreDatabase({ id: "prj_api", sourcePath: join(dir, "..", "escape.sqlite") }),
      /volume sqlite restore source path/,
    );
  } finally {
    registry.close();
  }
});

test("volume sqlite registry persists catalog records across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-restart-"));
  const first = createVolumeSqliteRegistry({ rootDir: dir, now: fixedNow });
  first.ensureDatabase({ id: "tenant_a", kind: "tenant", ownerId: "org_main" });
  first.close();

  const second = createVolumeSqliteRegistry({ rootDir: dir, now: fixedNow });
  try {
    assert.deepEqual(second.getDatabase("tenant_a"), {
      id: "tenant_a",
      path: join(dir, "dbs", "tenant_a.sqlite"),
      kind: "tenant",
      ownerId: "org_main",
      schemaVersion: 0,
      createdAt: fixedNow(),
      lastUsedAt: fixedNow(),
    });
  } finally {
    second.close();
  }
});

test("volume sqlite registry rejects path-like database ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-invalid-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    assert.throws(
      () => registry.ensureDatabase({ id: "../escape" }),
      /volume sqlite database id/,
    );
    assert.throws(
      () => registry.ensureDatabase({ id: "project/with/slash" }),
      /volume sqlite database id/,
    );
  } finally {
    registry.close();
  }
});

test("sqlite database pool evicts least recently used handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-pool-"));
  const pool = new SqliteDatabasePool({ maxOpen: 1 });
  const pathA = join(dir, "a.sqlite");
  const pathB = join(dir, "b.sqlite");

  try {
    const firstA = pool.open({ id: "a", path: pathA });
    firstA.exec("create table items (id text primary key); insert into items (id) values ('one')");
    assert.deepEqual(pool.stats().openIds, ["a"]);

    const b = pool.open({ id: "b", path: pathB });
    b.exec("create table other_items (id text primary key)");
    assert.deepEqual(pool.stats().openIds, ["b"]);
    assert.throws(() => firstA.prepare("select count(*) from items").get());

    const secondA = pool.open({ id: "a", path: pathA });
    assert.deepEqual(pool.stats().openIds, ["a"]);
    assert.notEqual(secondA, firstA);
    const count = secondA.prepare("select count(*) as count from items").get() as any;
    assert.equal(count.count, 1);
  } finally {
    pool.closeAll();
  }
});

function fixedNow() {
  return "2026-07-01T00:00:00.000Z";
}

function firstPragmaValue(row: unknown): unknown {
  assert.equal(typeof row, "object");
  assert.notEqual(row, null);
  return Object.values(row as Record<string, unknown>)[0];
}
