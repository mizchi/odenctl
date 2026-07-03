import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseOpsSmokeArgs,
  runOpsSmoke,
} from "../src/ops-smoke.ts";

test("ops smoke args default to the deployed Fly app names and env tokens", () => {
  const parsed = parseOpsSmokeArgs([], {
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
    WASMPLANE_RUNTIME_TOKEN: "runtime-token",
  });

  assert.equal(parsed.controlUrl, "https://mz-wasmplane-control.fly.dev");
  assert.equal(parsed.runtimeUrl, "https://mz-wasmplane-runtime.fly.dev");
  assert.equal(parsed.collectorUrl, "https://mz-wasmplane-otel-collector.fly.dev");
  assert.equal(parsed.controlToken, "control-token");
  assert.equal(parsed.runtimeToken, "runtime-token");
  assert.equal(parsed.workerHost, "hello.example.dev");
  assert.equal(parsed.workerPath, "/");
  assert.equal(parsed.requireExternalDatabase, false);
  assert.equal(parsed.minRuntimeNodes, undefined);
  assert.equal(parsed.requireRustForward, false);
});

test("ops smoke args accept production posture requirements", () => {
  const parsed = parseOpsSmokeArgs([
    "--require-external-db",
    "--min-runtime-nodes",
    "2",
    "--require-rust-forward",
  ], {
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
    WASMPLANE_RUNTIME_TOKEN: "runtime-token",
  });

  assert.equal(parsed.requireExternalDatabase, true);
  assert.equal(parsed.minRuntimeNodes, 2);
  assert.equal(parsed.requireRustForward, true);
});

test("ops smoke verifies protected control and runtime endpoints with bearer tokens", async () => {
  const calls: Array<{ path: string; authorization?: string; host?: string }> = [];
  const result = await runOpsSmoke({
    controlUrl: "https://control.example",
    runtimeUrl: "https://runtime.example",
    collectorUrl: "https://collector.example",
    controlToken: "control-token",
    runtimeToken: "runtime-token",
    workerHost: "hello.example.dev",
    workerPath: "/",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({
        path: parsed.pathname,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        host: (init?.headers as Record<string, string> | undefined)?.["x-forwarded-host"],
      });
      if (parsed.hostname === "control.example" && parsed.pathname === "/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.hostname === "runtime.example" && parsed.pathname === "/__runtime/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.hostname === "runtime.example" && parsed.pathname === "/__runtime/readyz") {
        return jsonResponse(200, {
          ok: true,
          status: "active",
          checks: { snapshot: { ok: true, loaded: 1, routes: 2 } },
        });
      }
      if (parsed.hostname === "collector.example" && parsed.pathname === "/") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.hostname === "control.example" && parsed.pathname === "/autoscaling/signals") {
        return jsonResponse(200, { signals: [] });
      }
      if (parsed.hostname === "control.example" && parsed.pathname === "/snapshots/routes") {
        return jsonResponse(200, { schemaVersion: 1, routes: [] });
      }
      if (parsed.hostname === "control.example" && parsed.pathname === "/ops/config") {
        return jsonResponse(200, {
          schemaVersion: 1,
          database: { kind: "postgres", external: true },
          artifactStore: { kind: "s3", external: true },
        });
      }
      if (parsed.hostname === "runtime.example" && parsed.pathname === "/__runtime/metrics") {
        return jsonResponse(200, {
          requests: { total: 1, matched: 1, missed: 0 },
          invocations: { total: 1, succeeded: 1, failed: 0, active: 0, rejected: 0 },
          snapshots: { loaded: 1 },
        });
      }
      if (parsed.hostname === "runtime.example" && parsed.pathname === "/") {
        return textResponse(200, "ok");
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.every((check) => check.ok), true);
  assert.deepEqual(
    calls.map((call) => [call.path, call.authorization, call.host]),
    [
      ["/healthz", undefined, undefined],
      ["/__runtime/healthz", undefined, undefined],
      ["/__runtime/readyz", undefined, undefined],
      ["/", undefined, undefined],
      ["/autoscaling/signals", "Bearer control-token", undefined],
      ["/snapshots/routes", "Bearer control-token", undefined],
      ["/ops/config", "Bearer control-token", undefined],
      ["/__runtime/metrics", "Bearer runtime-token", undefined],
      ["/", undefined, "hello.example.dev"],
    ],
  );
});

test("ops smoke verifies external database and minimum active runtime nodes", async () => {
  const result = await runOpsSmoke({
    controlUrl: "https://control.example",
    runtimeUrl: "https://runtime.example",
    collectorUrl: "https://collector.example",
    controlToken: "control-token",
    runtimeToken: "runtime-token",
    requireExternalDatabase: true,
    minRuntimeNodes: 2,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/__runtime/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/__runtime/readyz") {
        return jsonResponse(200, {
          ok: true,
          status: "active",
          checks: { snapshot: { loaded: 1 } },
        });
      }
      if (parsed.hostname === "collector.example" && parsed.pathname === "/") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/autoscaling/signals") {
        return jsonResponse(200, { signals: [] });
      }
      if (parsed.pathname === "/snapshots/routes") {
        return jsonResponse(200, { schemaVersion: 1, routes: [] });
      }
      if (parsed.pathname === "/ops/config") {
        return jsonResponse(200, {
          schemaVersion: 1,
          database: { kind: "postgres", external: true },
          artifactStore: { kind: "s3", external: true },
        });
      }
      if (parsed.pathname === "/runtime-nodes") {
        return jsonResponse(200, [
          { id: "rt_a", status: "active" },
          { id: "rt_b", status: "active" },
          { id: "rt_c", status: "draining" },
        ]);
      }
      if (parsed.pathname === "/__runtime/metrics") {
        return jsonResponse(200, {
          requests: {},
          invocations: {},
          snapshots: {},
        });
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "control external database")?.ok, true);
  assert.equal(result.checks.find((check) => check.name === "control active runtime nodes")?.ok, true);
});

test("ops smoke can require rust-forward daemon routes", async () => {
  const result = await runOpsSmoke({
    controlUrl: "https://control.example",
    runtimeUrl: "https://runtime.example",
    collectorUrl: "https://collector.example",
    requireRustForward: true,
    workerHost: "hello.example.dev",
    fetch: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/__runtime/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/__runtime/readyz") {
        return jsonResponse(200, {
          ok: true,
          status: "active",
          checks: { snapshot: { loaded: 1 } },
        });
      }
      if (parsed.hostname === "collector.example" && parsed.pathname === "/") {
        return jsonResponse(200, { ok: true });
      }
      if (parsed.pathname === "/autoscaling/signals") {
        return jsonResponse(200, { signals: [] });
      }
      if (parsed.pathname === "/snapshots/routes") {
        return jsonResponse(200, { schemaVersion: 1, routes: [] });
      }
      if (parsed.pathname === "/ops/config") {
        return jsonResponse(200, {
          schemaVersion: 1,
          database: { kind: "postgres", external: true },
          artifactStore: { kind: "s3", external: true },
        });
      }
      if (parsed.pathname === "/__runtime/metrics") {
        return jsonResponse(200, {
          requests: {},
          invocations: {},
          snapshots: {},
          hostDaemon: { ok: true, preparedRoutes: 2 },
        });
      }
      if (parsed.hostname === "runtime.example" && parsed.pathname === "/") {
        return new Response("ok", {
          status: 200,
          headers: { "x-wasmplane-host-daemon-route": "1" },
        });
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "runtime rust-forward daemon routes")?.ok, true);
  assert.equal(result.checks.find((check) => check.name === "runtime rust-forward worker proxy")?.ok, true);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}
