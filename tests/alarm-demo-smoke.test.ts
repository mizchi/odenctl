import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAlarmDemoSmokeArgs,
  runAlarmDemoSmoke,
} from "../src/alarm-demo-smoke.ts";

test("alarm demo smoke args default to Fly control app and env token", () => {
  const parsed = parseAlarmDemoSmokeArgs([], {
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
  });

  assert.equal(parsed.controlUrl, "https://mz-wasmplane-control.fly.dev");
  assert.equal(parsed.token, "control-token");
  assert.equal(parsed.objectName, "heartbeat");
  assert.equal(parsed.delayMs, 1000);
  assert.equal(parsed.timeoutMs, 15000);
});

test("alarm demo smoke schedules an alarm and polls until it fires", async () => {
  const calls: Array<{ method: string; path: string; authorization?: string; body?: any }> = [];
  let statusReads = 0;
  const result = await runAlarmDemoSmoke({
    controlUrl: "https://control.example",
    token: "control-token",
    objectName: "heartbeat",
    message: "smoke",
    delayMs: 1,
    timeoutMs: 1000,
    pollMs: 1,
    sleep: async () => {},
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({
        method: init?.method ?? "GET",
        path: parsed.pathname,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (parsed.pathname === "/alarm-demo/schedules") {
        return jsonResponse(201, {
          namespace: "alarm-demo",
          objectName: "heartbeat",
          objectId: "do_heartbeat",
          alarmCount: 0,
          alarmAt: "2026-07-03T00:00:01.000Z",
        });
      }
      if (parsed.pathname === "/alarm-demo/objects/heartbeat") {
        statusReads += 1;
        return jsonResponse(200, {
          namespace: "alarm-demo",
          objectName: "heartbeat",
          objectId: "do_heartbeat",
          alarmCount: statusReads < 2 ? 0 : 1,
          alarmAt: statusReads < 2 ? "2026-07-03T00:00:01.000Z" : null,
          lastAlarmAt: statusReads < 2 ? null : "2026-07-03T00:00:01.010Z",
        });
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
    nowMs: (() => {
      let now = 0;
      return () => now++;
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.scheduled.objectName, "heartbeat");
  assert.equal(result.final.alarmCount, 1);
  assert.deepEqual(
    calls.map((call) => [call.method, call.path, call.authorization]),
    [
      ["POST", "/alarm-demo/schedules", "Bearer control-token"],
      ["GET", "/alarm-demo/objects/heartbeat", "Bearer control-token"],
      ["GET", "/alarm-demo/objects/heartbeat", "Bearer control-token"],
    ],
  );
  assert.deepEqual(calls[0]?.body, {
    objectName: "heartbeat",
    message: "smoke",
    delayMs: 1,
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
