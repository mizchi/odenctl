import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDurableObjectStorageNamespace,
} from "../crates/odenctl/src/control-plane/durable-object-storage.ts";
import { createVolumeSqliteRegistry } from "../crates/odenctl/src/control-plane/volume-sqlite.ts";

test("durable object storage stores private KV data per namespace object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-storage-kv-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir, now: fixedNow });
  const rooms = createDurableObjectStorageNamespace({
    namespace: "rooms",
    ownerId: "prj_chat",
    registry,
  });

  try {
    const lobbyId = rooms.idFromName("lobby");
    assert.equal(lobbyId, rooms.idFromName("lobby"));
    assert.notEqual(lobbyId, rooms.idFromName("random"));

    const lobby = rooms.get(lobbyId);
    const random = rooms.get(rooms.idFromName("random"));

    await lobby.storage.put("room:title", "Lobby");
    await lobby.storage.put({
      "members:001": { id: "u1", name: "Ada" },
      "members:002": { id: "u2", name: "Lin" },
    });

    assert.equal(await lobby.storage.get("room:title"), "Lobby");
    assert.deepEqual(await lobby.storage.get(["room:title", "missing"]), new Map([["room:title", "Lobby"]]));
    assert.equal(await random.storage.get("room:title"), undefined);
    assert.deepEqual(await lobby.storage.list({ prefix: "members:" }), new Map([
      ["members:001", { id: "u1", name: "Ada" }],
      ["members:002", { id: "u2", name: "Lin" }],
    ]));

    assert.equal(await lobby.storage.delete("members:001"), true);
    assert.equal(await lobby.storage.delete("members:missing"), false);
    assert.deepEqual(await lobby.storage.list({ prefix: "members:" }), new Map([
      ["members:002", { id: "u2", name: "Lin" }],
    ]));

    const record = registry.getDatabase(lobby.databaseId);
    assert.equal(record?.kind, "durable_object");
    assert.equal(record?.ownerId, "prj_chat");
  } finally {
    registry.close();
  }
});

test("durable object storage serializes transactions for the same object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-storage-transaction-"));
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    maxPendingWritesPerDatabase: 16,
  });
  const counters = createDurableObjectStorageNamespace({ namespace: "counters", registry });
  const counter = counters.storageForName("global");

  try {
    await counter.put("value", 0);
    await Promise.all(Array.from({ length: 10 }, async () => {
      await counter.transaction(async (txn) => {
        const value = (await txn.get<number>("value")) ?? 0;
        await Promise.resolve();
        await txn.put("value", value + 1);
      });
    }));

    assert.equal(await counter.get("value"), 10);
  } finally {
    registry.close();
  }
});

test("durable object storage exposes object-local SQL without exposing KV internals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-storage-sql-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const bookings = createDurableObjectStorageNamespace({ namespace: "bookings", registry });
  const eventA = bookings.storageForName("event-a");
  const eventB = bookings.storageForName("event-b");

  try {
    await eventA.sql.exec("create table seats (seat_id text primary key, user_id text not null)");
    await eventA.sql.exec("insert into seats (seat_id, user_id) values (?, ?)", "A1", "user-1");
    await eventB.sql.exec("create table seats (seat_id text primary key, user_id text not null)");

    assert.deepEqual(
      (await eventA.sql.exec<{ seat_id: string; user_id: string }>(
        "select seat_id, user_id from seats order by seat_id asc",
      )).toArray(),
      [{ seat_id: "A1", user_id: "user-1" }],
    );
    assert.deepEqual(
      (await eventB.sql.exec<{ seat_id: string; user_id: string }>(
        "select seat_id, user_id from seats order by seat_id asc",
      )).toArray(),
      [],
    );
    await assert.rejects(
      eventA.sql.exec("select * from __wasmplane_do_kv"),
      /reserved durable object storage table/,
    );
    await assert.rejects(
      eventA.sql.exec("select * from __wasmplane_do_meta"),
      /reserved durable object storage table/,
    );
  } finally {
    registry.close();
  }
});

test("durable object storage stores one object-local alarm time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-storage-alarm-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const rooms = createDurableObjectStorageNamespace({ namespace: "rooms", registry });
  const lobby = rooms.storageForName("lobby");
  const random = rooms.storageForName("random");

  try {
    assert.equal(await lobby.getAlarm(), undefined);

    await lobby.setAlarm(new Date("2026-07-02T10:00:00.000Z"));
    assert.equal((await lobby.getAlarm())?.toISOString(), "2026-07-02T10:00:00.000Z");
    assert.equal(await random.getAlarm(), undefined);

    await lobby.setAlarm(1783000800000);
    assert.equal((await lobby.getAlarm())?.getTime(), 1783000800000);

    assert.equal(await lobby.deleteAlarm(), true);
    assert.equal(await lobby.deleteAlarm(), false);
    assert.equal(await lobby.getAlarm(), undefined);

    await assert.rejects(lobby.setAlarm(Number.POSITIVE_INFINITY), /alarm time/);
    await assert.rejects(lobby.setAlarm(new Date(Number.NaN)), /alarm time/);
  } finally {
    registry.close();
  }
});

test("durable object namespace lists due alarms for scheduler dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-storage-due-alarms-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const rooms = createDurableObjectStorageNamespace({ namespace: "rooms", registry });
  const sessions = createDurableObjectStorageNamespace({ namespace: "sessions", registry });
  const lobby = rooms.get(rooms.idFromName("lobby"));
  const random = rooms.get(rooms.idFromName("random"));
  const session = sessions.get(sessions.idFromName("user-1"));

  try {
    await random.storage.setAlarm(1783000900000);
    await lobby.storage.setAlarm(1783000800000);
    await session.storage.setAlarm(1783000700000);

    assert.deepEqual(await rooms.listDueAlarms({ now: 1783000850000 }), [
      {
        namespace: "rooms",
        objectId: lobby.id,
        databaseId: lobby.databaseId,
        scheduledTime: new Date(1783000800000),
      },
    ]);

    assert.deepEqual(
      (await rooms.listDueAlarms({ now: 1783001000000, limit: 1 })).map((alarm) => alarm.objectId),
      [lobby.id],
    );
  } finally {
    registry.close();
  }
});

function fixedNow() {
  return "2026-07-02T00:00:00.000Z";
}
