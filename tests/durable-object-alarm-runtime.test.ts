import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createConfiguredDurableObjectAlarmDispatcherJobs,
  createDurableObjectAlarmWebhookHandler,
} from "../src/control-plane/durable-object-alarm-runtime.ts";
import { createDurableObjectStorageNamespace } from "../src/control-plane/durable-object-storage.ts";
import { createVolumeSqliteRegistry } from "../src/control-plane/volume-sqlite.ts";

test("configured durable object alarm dispatcher posts due alarms to webhook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-do-alarm-runtime-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const rooms = createDurableObjectStorageNamespace({ namespace: "rooms", registry });
  const lobby = rooms.get(rooms.idFromName("lobby"));
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  try {
    await lobby.storage.setAlarm(1783000800000);

    const jobs = createConfiguredDurableObjectAlarmDispatcherJobs({
      registry,
      env: {
        ODENCTL_DURABLE_OBJECT_ALARM_INTERVAL_MS: "1000",
        ODENCTL_DURABLE_OBJECT_ALARM_NAMESPACES: "rooms",
        ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_URL: "https://worker.example.com/__alarm",
        ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN: "alarm-token",
      },
      now: () => 1783000900000,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(jobs.length, 1);
    assert.equal(await jobs[0].tick(), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://worker.example.com/__alarm");
    assert.equal(requests[0]?.init?.method, "POST");
    assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer alarm-token");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      namespace: "rooms",
      objectId: lobby.id,
      databaseId: lobby.databaseId,
      scheduledTime: "2026-07-02T14:00:00.000Z",
    });
    assert.equal(await lobby.storage.getAlarm(), undefined);
  } finally {
    registry.close();
  }
});

test("configured durable object alarm dispatcher is disabled without interval and validates required env", () => {
  assert.deepEqual(createConfiguredDurableObjectAlarmDispatcherJobs({ env: {} }), []);
  assert.throws(
    () =>
      createConfiguredDurableObjectAlarmDispatcherJobs({
        env: { ODENCTL_DURABLE_OBJECT_ALARM_INTERVAL_MS: "1000" },
      }),
    /ODENCTL_VOLUME_SQLITE_ROOT/,
  );
});

test("durable object alarm webhook handler rejects non-success responses", async () => {
  const handler = createDurableObjectAlarmWebhookHandler({
    url: "https://worker.example.com/__alarm",
    fetchFn: async () => new Response("nope", { status: 500 }),
  });

  await assert.rejects(
    handler({
      namespace: "rooms",
      objectId: "do_lobby",
      databaseId: "db_lobby",
      scheduledTime: new Date("2026-07-02T14:00:00.000Z"),
      storage: {} as any,
    }),
    /returned 500: nope/,
  );
});
