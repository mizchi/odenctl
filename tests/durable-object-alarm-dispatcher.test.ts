import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDurableObjectAlarmDispatcherJob,
  dispatchDurableObjectAlarms,
} from "../src/control-plane/durable-object-alarm-dispatcher.ts";
import { createDurableObjectStorageNamespace } from "../src/control-plane/durable-object-storage.ts";
import { createVolumeSqliteRegistry } from "../src/control-plane/volume-sqlite.ts";

test("durable object alarm dispatcher invokes due alarms and clears handled alarms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-do-alarm-dispatch-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const rooms = createDurableObjectStorageNamespace({ namespace: "rooms", registry });
  const lobby = rooms.get(rooms.idFromName("lobby"));
  const random = rooms.get(rooms.idFromName("random"));

  try {
    await lobby.storage.setAlarm(1783000800000);
    await random.storage.setAlarm(1783000800000);

    const handled: string[] = [];
    const report = await dispatchDurableObjectAlarms({
      namespace: rooms,
      now: 1783000900000,
      async handler(input) {
        handled.push(input.objectId);
        await input.storage.put("alarm:last", input.scheduledTime.toISOString());
        if (input.objectId === random.id) {
          await input.storage.setAlarm(1783001200000);
        }
      },
    });

    assert.deepEqual(report, {
      ok: true,
      checkedAt: "2026-07-02T14:01:40.000Z",
      due: 2,
      dispatched: 2,
      failed: 0,
      errors: [],
    });
    assert.deepEqual(handled.sort(), [lobby.id, random.id].sort());
    assert.equal(await lobby.storage.getAlarm(), undefined);
    assert.equal((await random.storage.getAlarm())?.getTime(), 1783001200000);
    assert.equal(await lobby.storage.get("alarm:last"), "2026-07-02T14:00:00.000Z");
  } finally {
    registry.close();
  }
});

test("durable object alarm dispatcher preserves alarms when handlers fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-do-alarm-dispatch-fail-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const rooms = createDurableObjectStorageNamespace({ namespace: "rooms", registry });
  const lobby = rooms.get(rooms.idFromName("lobby"));

  try {
    await lobby.storage.setAlarm(1783000800000);

    const report = await dispatchDurableObjectAlarms({
      namespace: rooms,
      now: 1783000900000,
      async handler() {
        throw new Error("alarm handler failed");
      },
    });

    assert.equal(report.ok, false);
    assert.equal(report.due, 1);
    assert.equal(report.dispatched, 0);
    assert.equal(report.failed, 1);
    assert.equal(report.errors[0]?.objectId, lobby.id);
    assert.match(report.errors[0]?.message ?? "", /alarm handler failed/);
    assert.equal((await lobby.storage.getAlarm())?.getTime(), 1783000800000);
  } finally {
    registry.close();
  }
});

test("durable object alarm dispatcher job schedules ticks and skips overlapping dispatches", async () => {
  const reports: unknown[] = [];
  const errors: unknown[] = [];
  const scheduled: Array<() => void> = [];
  let release!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const job = createDurableObjectAlarmDispatcherJob({
    intervalMs: 30_000,
    dispatch: async () => {
      runs += 1;
      await firstRun;
      return {
        ok: true,
        checkedAt: "2026-07-02T00:00:00.000Z",
        due: 0,
        dispatched: 0,
        failed: 0,
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
