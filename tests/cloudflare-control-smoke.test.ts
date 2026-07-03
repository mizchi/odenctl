import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCloudflareControlSmokeArgs,
  runCloudflareControlSmoke,
} from "../src/cloudflare-control-smoke.ts";

test("Cloudflare control smoke args default to the container POC URL and local SQLite check", () => {
  const parsed = parseCloudflareControlSmokeArgs([
    "--wake-delay-ms",
    "1000",
    "--max-container-health-ms",
    "30000",
  ], {
    WASMPLANE_CLOUDFLARE_CONTROL_URL: "https://wasmplane-control.example.workers.dev",
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
  });

  assert.equal(parsed.controlUrl, "https://wasmplane-control.example.workers.dev");
  assert.equal(parsed.token, "control-token");
  assert.equal(parsed.requireLocalSqlite, true);
  assert.equal(parsed.wakeDelayMs, 1000);
  assert.equal(parsed.maxContainerHealthMs, 30000);
  assert.match(parsed.projectId, /^prj_cf_smoke_/);
  assert.match(parsed.scriptName, /^wasmplane-cf-smoke-/);
});

test("Cloudflare control smoke verifies health, local SQLite, release creation, and wakeup persistence", async () => {
  let now = 0;
  const sleepCalls: number[] = [];
  const calls: Array<{ method: string; path: string; authorization?: string }> = [];
  let release: any;

  const result = await runCloudflareControlSmoke({
    controlUrl: "https://wasmplane-control.example.workers.dev",
    token: "control-token",
    projectId: "prj_cf_smoke_test",
    artifactId: "art_cf_smoke_test",
    deploymentId: "dep_cf_smoke_test",
    scriptName: "wasmplane-cf-smoke-test",
    requireLocalSqlite: true,
    wakeDelayMs: 10,
    maxContainerHealthMs: 500,
    nowMs: () => now,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      now += ms;
    },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      calls.push({
        method,
        path: parsed.pathname,
        authorization: (init.headers as Record<string, string> | undefined)?.authorization,
      });
      if (parsed.pathname === "/healthz") {
        now += 125;
      }
      if (method === "GET" && parsed.pathname === "/__poc/edge-health") {
        return jsonResponse(200, { ok: true, target: "cloudflare-containers-control" });
      }
      if (method === "GET" && parsed.pathname === "/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (method === "GET" && parsed.pathname === "/ops/config") {
        return jsonResponse(200, {
          schemaVersion: 1,
          database: { kind: "sqlite", external: false },
          artifactStore: { kind: "local", external: false },
        });
      }
      if (method === "POST" && parsed.pathname === "/projects") {
        return jsonResponse(201, await requestJson(init));
      }
      if (method === "POST" && parsed.pathname === "/artifacts") {
        return jsonResponse(201, await requestJson(init));
      }
      if (method === "POST" && parsed.pathname === "/deployments") {
        return jsonResponse(201, await requestJson(init));
      }
      if (method === "POST" && parsed.pathname === "/edge-workers/releases") {
        const body = await requestJson(init);
        release = {
          id: "ewr_cf_smoke_test",
          ...body,
          mode: "mock",
          provider: "cloudflare-workers",
          scriptModule: "export default { async fetch() { return Response.json({ path: '/__wasmplane/manifest' }) } }",
        };
        return jsonResponse(201, release);
      }
      if (method === "GET" && parsed.pathname === "/projects/prj_cf_smoke_test/edge-worker-releases") {
        return jsonResponse(200, [release]);
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.every((check) => check.ok), true);
  assert.equal(result.checks.find((check) => check.name === "container health")?.elapsedMs, 125);
  assert.equal(result.checks.find((check) => check.name === "local SQLite fallback")?.ok, true);
  assert.equal(result.checks.find((check) => check.name === "post-wakeup release persistence")?.ok, true);
  assert.deepEqual(sleepCalls, [10]);
  assert.deepEqual(
    calls.map((call) => [call.method, call.path, call.authorization]),
    [
      ["GET", "/__poc/edge-health", undefined],
      ["GET", "/healthz", undefined],
      ["GET", "/ops/config", "Bearer control-token"],
      ["POST", "/projects", "Bearer control-token"],
      ["POST", "/artifacts", "Bearer control-token"],
      ["POST", "/deployments", "Bearer control-token"],
      ["POST", "/edge-workers/releases", "Bearer control-token"],
      ["GET", "/projects/prj_cf_smoke_test/edge-worker-releases", "Bearer control-token"],
      ["GET", "/healthz", undefined],
      ["GET", "/projects/prj_cf_smoke_test/edge-worker-releases", "Bearer control-token"],
    ],
  );
});

test("Cloudflare control smoke reports slow container cold start", async () => {
  let now = 0;
  const result = await runCloudflareControlSmoke({
    controlUrl: "https://wasmplane-control.example.workers.dev",
    token: "control-token",
    projectId: "prj_cf_slow",
    artifactId: "art_cf_slow",
    deploymentId: "dep_cf_slow",
    scriptName: "wasmplane-cf-slow",
    requireLocalSqlite: false,
    maxContainerHealthMs: 100,
    nowMs: () => now,
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      if (parsed.pathname === "/healthz") {
        now += 250;
      }
      if (method === "GET" && parsed.pathname === "/__poc/edge-health") {
        return jsonResponse(200, { ok: true, target: "cloudflare-containers-control" });
      }
      if (method === "GET" && parsed.pathname === "/healthz") {
        return jsonResponse(200, { ok: true });
      }
      if (method === "GET" && parsed.pathname === "/ops/config") {
        return jsonResponse(200, {
          schemaVersion: 1,
          database: { kind: "postgres", external: true },
          artifactStore: { kind: "s3", external: true },
        });
      }
      if (method === "POST") {
        return jsonResponse(201, await requestJson(init));
      }
      if (method === "GET" && parsed.pathname === "/projects/prj_cf_slow/edge-worker-releases") {
        return jsonResponse(200, [{ id: "ewr_slow", scriptModule: "/__wasmplane/manifest" }]);
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.equal(result.ok, false);
  const health = result.checks.find((check) => check.name === "container health");
  assert.equal(health?.ok, false);
  assert.equal(health?.elapsedMs, 250);
});

async function requestJson(init: RequestInit): Promise<any> {
  return JSON.parse(String(init.body ?? "{}"));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
