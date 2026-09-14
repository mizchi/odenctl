import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAesGcmVolumeSqliteBackupCipher,
  createVolumeSqliteRegistry,
} from "../src/control-plane/volume-sqlite.ts";
import {
  createVolumeSqliteBackupJob,
  runVolumeSqliteScheduledBackupCycle,
} from "../src/control-plane/volume-sqlite-backup-job.ts";

test("scheduled volume sqlite backup cycle encrypts backups, prunes retention, and verifies restore drills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-volume-sqlite-scheduled-backup-"));
  const clock = incrementingClock("2026-07-01T00:00:00.000Z");
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    now: clock.now,
    backupCipher: createAesGcmVolumeSqliteBackupCipher({
      primaryKey: { keyId: "scheduled", key: Buffer.alloc(32, 7) },
      randomBytes: (size) => Buffer.alloc(size, 3),
    }),
  });

  try {
    registry.ensureDatabase({ id: "tenant_a", schemaVersion: 2 });
    registry.ensureDatabase({ id: "tenant_b", schemaVersion: 3 });
    registry.withDatabase("tenant_a", (db) => {
      db.exec("create table events (id text primary key); insert into events (id) values ('a1')");
    });
    registry.withDatabase("tenant_b", (db) => {
      db.exec("create table events (id text primary key); insert into events (id) values ('b1')");
    });

    const first = runVolumeSqliteScheduledBackupCycle({
      registry,
      requireEncrypted: true,
      restoreDrill: { enabled: true },
      retention: { keepLatest: 1 },
      now: clock.now,
    });

    assert.equal(first.ok, true);
    assert.equal(first.backups.length, 2);
    assert.equal(first.backups.every((backup) => backup.encrypted === true), true);
    assert.deepEqual(first.restoreDrills.map((drill) => ({
      databaseId: drill.databaseId,
      ok: drill.ok,
      encrypted: drill.encrypted,
      schemaVersion: drill.schemaVersion,
    })), [
      { databaseId: "tenant_a", ok: true, encrypted: true, schemaVersion: 2 },
      { databaseId: "tenant_b", ok: true, encrypted: true, schemaVersion: 3 },
    ]);

    registry.withDatabase("tenant_a", (db) => {
      db.prepare("insert into events (id) values (?)").run("a2");
    });
    registry.withDatabase("tenant_b", (db) => {
      db.prepare("insert into events (id) values (?)").run("b2");
    });
    const oldBackupPaths = first.backups.map((backup) => backup.path);

    const second = runVolumeSqliteScheduledBackupCycle({
      registry,
      requireEncrypted: true,
      restoreDrill: { enabled: true },
      retention: { keepLatest: 1 },
      now: clock.now,
    });

    assert.equal(second.ok, true);
    assert.equal(second.gc.deleted.length, 2);
    assert.deepEqual(
      registry.listBackups().map((backup) => backup.id).sort(),
      second.backups.map((backup) => backup.id).sort(),
    );
    for (const oldBackupPath of oldBackupPaths) {
      await assert.rejects(stat(oldBackupPath), /ENOENT/);
    }
  } finally {
    registry.close();
  }
});

test("volume sqlite restore drill reports encrypted backup corruption without restoring into the catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-volume-sqlite-restore-drill-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    backupCipher: createAesGcmVolumeSqliteBackupCipher({
      primaryKey: { keyId: "scheduled", key: Buffer.alloc(32, 7) },
      randomBytes: (size) => Buffer.alloc(size, 3),
    }),
  });

  try {
    registry.ensureDatabase({ id: "tenant_a", schemaVersion: 5 });
    registry.withDatabase("tenant_a", (db) => {
      db.exec("create table events (id text primary key)");
    });
    const backup = registry.exportDatabase({ id: "tenant_a", backupId: "tenant_a_corrupt" });
    const bytes = await readFile(backup.path);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(backup.path, bytes);

    const drill = registry.verifyBackupRestore({ backupId: backup.id });

    assert.equal(drill.ok, false);
    assert.equal(drill.backupId, backup.id);
    assert.equal(drill.databaseId, "tenant_a");
    assert.match(drill.error ?? "", /could not be decrypted/);
    assert.deepEqual(registry.listDatabases().map((database) => database.id), ["tenant_a"]);
  } finally {
    registry.close();
  }
});

test("volume sqlite backup job schedules ticks and skips overlapping runs", async () => {
  const reports: unknown[] = [];
  const errors: unknown[] = [];
  const scheduled: Array<() => void> = [];
  let release!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const job = createVolumeSqliteBackupJob({
    intervalMs: 30_000,
    runCycle: async () => {
      runs += 1;
      await firstRun;
      return {
        ok: true,
        startedAt: "2026-07-01T00:00:00.000Z",
        finishedAt: "2026-07-01T00:00:01.000Z",
        databases: 0,
        backups: [],
        restoreDrills: [],
        gc: { deleted: [], remaining: 0, deletedBytes: 0 },
        errors: [],
      };
    },
    onReport: (report) => reports.push(report),
    onError: (error) => errors.push(error),
    setIntervalFn(callback, intervalMs) {
      assert.equal(intervalMs, 30_000);
      scheduled.push(callback);
      return callback;
    },
    clearIntervalFn(timer) {
      assert.equal(timer, scheduled[0]);
    },
  });

  job.start();
  assert.equal(job.running(), true);
  assert.equal(scheduled.length, 1);
  const first = job.tick();
  assert.equal(await job.tick(), false);
  assert.equal(runs, 1);
  release();
  assert.equal(await first, true);
  assert.equal(reports.length, 1);
  assert.equal(errors.length, 0);
  job.stop();
  assert.equal(job.running(), false);
});

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
