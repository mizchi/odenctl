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

test("volume sqlite registry serializes queued writes per database and rejects excess pending writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-writer-queue-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    maxPendingWritesPerDatabase: 2,
  });

  try {
    registry.ensureDatabase({ id: "prj_api" });
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key)");
    });

    let releaseFirstWrite!: () => void;
    const order: string[] = [];
    const first = registry.writeDatabase("prj_api", async (db) => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      db.prepare("insert into events (id) values (?)").run("first");
      order.push("first-end");
    });
    const second = registry.writeDatabase("prj_api", (db) => {
      order.push("second");
      db.prepare("insert into events (id) values (?)").run("second");
    });
    await assert.rejects(
      registry.writeDatabase("prj_api", (db) => {
        db.prepare("insert into events (id) values (?)").run("third");
      }),
      /writer queue for prj_api is full/,
    );

    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);
    assert.deepEqual(registry.stats().writerQueues.databases, [{
      id: "prj_api",
      active: true,
      queued: 1,
      pending: 2,
    }]);

    releaseFirstWrite();
    await Promise.all([first, second]);

    registry.withDatabase("prj_api", (db) => {
      assert.deepEqual(
        db.prepare("select id from events order by rowid asc").all().map((row: any) => row.id),
        ["first", "second"],
      );
    });
    assert.equal(registry.stats().writerQueues.rejectedWrites, 1);
  } finally {
    registry.close();
  }
});

test("volume sqlite registry keeps writer queues independent per database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-independent-writers-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    maxPendingWritesPerDatabase: 1,
  });

  try {
    registry.ensureDatabase({ id: "tenant_a" });
    registry.ensureDatabase({ id: "tenant_b" });
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = registry.writeDatabase("tenant_a", async () => {
      started.push("tenant_a");
      await gate;
    });
    const second = registry.writeDatabase("tenant_b", async () => {
      started.push("tenant_b");
      await gate;
    });

    await Promise.resolve();
    assert.deepEqual(started.sort(), ["tenant_a", "tenant_b"]);
    release();
    await Promise.all([first, second]);
  } finally {
    registry.close();
  }
});

test("volume sqlite registry prunes old backups by per-database retention count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-backup-gc-"));
  const clock = incrementingClock("2026-07-01T00:00:00.000Z");
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    now: clock.now,
    maxBackupsPerDatabase: 2,
  });

  try {
    registry.ensureDatabase({ id: "prj_api" });
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key)");
    });
    const first = registry.exportDatabase({ id: "prj_api", backupId: "backup_1" });
    const second = registry.exportDatabase({ id: "prj_api", backupId: "backup_2" });
    const third = registry.exportDatabase({ id: "prj_api", backupId: "backup_3" });

    assert.deepEqual(registry.listBackups("prj_api").map((backup) => backup.id), ["backup_3", "backup_2"]);
    await assert.rejects(stat(first.path), /ENOENT/);
    await stat(second.path);
    await stat(third.path);
    assert.equal(registry.stats().backups, 2);
  } finally {
    registry.close();
  }
});

test("volume sqlite registry prunes backups explicitly by age while keeping newest entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-volume-sqlite-backup-age-gc-"));
  const clock = sequenceClock([
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:01.000Z",
    "2026-07-01T00:00:02.000Z",
    "2026-07-02T00:00:00.000Z",
  ]);
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    now: clock.now,
  });

  try {
    registry.ensureDatabase({ id: "prj_api" });
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key)");
    });
    const first = registry.exportDatabase({ id: "prj_api", backupId: "backup_1" });
    const second = registry.exportDatabase({ id: "prj_api", backupId: "backup_2" });
    const report = registry.pruneBackups({
      id: "prj_api",
      keepLatest: 1,
      olderThanMs: 12 * 60 * 60 * 1000,
    });

    assert.deepEqual(report.deleted.map((backup) => backup.id), ["backup_1"]);
    assert.deepEqual(registry.listBackups("prj_api").map((backup) => backup.id), ["backup_2"]);
    await assert.rejects(stat(first.path), /ENOENT/);
    await stat(second.path);
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

function incrementingClock(start: string) {
  let value = Date.parse(start);
  return {
    now() {
      const current = new Date(value).toISOString();
      value += 1000;
      return current;
    },
  };
}

function sequenceClock(values: string[]) {
  const copy = [...values];
  return {
    now() {
      return copy.shift() ?? values[values.length - 1];
    },
  };
}

function firstPragmaValue(row: unknown): unknown {
  assert.equal(typeof row, "object");
  assert.notEqual(row, null);
  return Object.values(row as Record<string, unknown>)[0];
}
