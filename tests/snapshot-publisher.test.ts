import assert from "node:assert/strict";
import { test } from "node:test";
import { publishRouteSnapshot } from "../src/control-plane/snapshot-publisher.ts";
import type { RouteSnapshot } from "../src/control-plane/contracts.ts";

test("snapshot publisher retries retryable runtime failures per target", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  let now = 0;

  const report = await publishRouteSnapshot(
    snapshot(),
    [{ id: "rt_retry", url: "http://runtime.local" }],
    async (url, init) => {
      calls.push({ url, body: init.body });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
          async text() {
            return "warming";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { routes: 1, generatedAt: "2026-06-26T10:00:00.000Z", snapshotId: "snap_retry" };
        },
        async text() {
          return "ok";
        },
      };
    },
    {
      maxAttempts: 3,
      retryDelayMs: 0,
      nowMs: () => {
        now += 10;
        return now;
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(report.targets[0], {
    id: "rt_retry",
    url: "http://runtime.local",
    ok: true,
    status: 200,
    routes: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    snapshotId: "snap_retry",
    attempts: 2,
    elapsedMs: 10,
  });
});

test("snapshot publisher does not retry non-retryable runtime responses", async () => {
  let calls = 0;

  const report = await publishRouteSnapshot(
    snapshot(),
    [{ id: "rt_bad", url: "http://runtime.local" }],
    async () => {
      calls += 1;
      return {
        ok: false,
        status: 401,
        async json() {
          return {};
        },
        async text() {
          return "unauthorized";
        },
      };
    },
    { maxAttempts: 3, retryDelayMs: 0, nowMs: () => 100 },
  );

  assert.equal(report.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(report.targets[0], {
    id: "rt_bad",
    url: "http://runtime.local",
    ok: false,
    status: 401,
    error: "unauthorized",
    attempts: 1,
    elapsedMs: 0,
  });
});

function snapshot(): RouteSnapshot {
  return {
    id: "snap_retry",
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes: [],
  };
}
