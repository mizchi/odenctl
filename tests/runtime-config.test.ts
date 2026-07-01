import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseProjectConcurrencyLimits,
  parseProjectRateLimits,
  parseRuntimeCacheGcIntervalMs,
  parseRuntimeCacheRetentionPolicy,
  parseRuntimeIdentityKeys,
  parseRuntimeLabels,
  parseRuntimeLogDrains,
  parseRuntimePackingPolicy,
  parseRuntimeShutdownDrainTimeoutMs,
  resolveRuntimeRouteSnapshotFile,
  resolveRuntimeIdentity,
  resolveRuntimeMemoryMb,
  resolveRuntimeNodeId,
  resolveRuntimePublicUrl,
  resolveRuntimeRegion,
} from "../src/runtime/config.ts";

test("runtime config uses Fly machine identity for scaled runtime nodes", () => {
  const env = {
    FLY_APP_NAME: "wasmplane-runtime",
    FLY_MACHINE_ID: "d8953eda04d9e8",
    FLY_VM_MEMORY_MB: "2048",
    RUNTIME_PUBLIC_URL: "auto",
  };

  assert.equal(resolveRuntimeNodeId(env, "0.0.0.0", 8080), "rt_d8953eda04d9e8");
  assert.equal(
    resolveRuntimePublicUrl(env, "0.0.0.0", 8080),
    "http://d8953eda04d9e8.vm.wasmplane-runtime.internal:8080",
  );
  assert.equal(resolveRuntimeMemoryMb(env, 4096), 2048);
  assert.equal(resolveRuntimeRegion(env), undefined);
});

test("runtime config keeps explicit non-auto public url override", () => {
  const env = {
    FLY_APP_NAME: "wasmplane-runtime",
    FLY_MACHINE_ID: "d8953eda04d9e8",
    RUNTIME_NODE_ID: "rt_manual",
    RUNTIME_PUBLIC_URL: "https://runtime.example.dev",
    RUNTIME_MEMORY_MB: "1024",
  };

  assert.equal(resolveRuntimeNodeId(env, "0.0.0.0", 8080), "rt_manual");
  assert.equal(resolveRuntimePublicUrl(env, "0.0.0.0", 8080), "https://runtime.example.dev");
  assert.equal(resolveRuntimeMemoryMb(env, 4096), 1024);
});

test("runtime config parses runtime identity keyring and advertised key id", () => {
  const env = {
    WASMPLANE_RUNTIME_IDENTITY_KEY_ID: "rt-key",
    WASMPLANE_RUNTIME_IDENTITY_KEYS: "rt-key=secret,old-key=old-secret,broken",
    WASMPLANE_RUNTIME_IDENTITY_CERT_SHA256: "a".repeat(64),
  };

  assert.deepEqual(parseRuntimeIdentityKeys(env), {
    "old-key": "old-secret",
    "rt-key": "secret",
  });
  assert.deepEqual(resolveRuntimeIdentity(env), {
    keyId: "rt-key",
    certificateSha256: "a".repeat(64),
  });
});

test("runtime config resolves region and labels for placement", () => {
  assert.equal(resolveRuntimeRegion({ FLY_REGION: "NRT" }), "nrt");
  assert.equal(resolveRuntimeRegion({ RUNTIME_REGION: "iad", FLY_REGION: "nrt" }), "iad");
  assert.deepEqual(parseRuntimeLabels({ RUNTIME_LABELS: "pool=default, gpu=false, invalid" }), {
    gpu: "false",
    pool: "default",
  });
  assert.equal(parseRuntimeLabels({}), undefined);
});

test("runtime config parses per-project concurrency limits", () => {
  assert.deepEqual(
    parseProjectConcurrencyLimits({
      RUNTIME_PROJECT_CONCURRENCY_LIMITS: "prj_a=16, prj_b = 0, invalid, prj_c=-1, prj_d=bad",
    }),
    { prj_a: 16, prj_b: 0 },
  );
  assert.equal(parseProjectConcurrencyLimits({}), undefined);
});

test("runtime config parses per-project request rate limits", () => {
  assert.deepEqual(
    parseProjectRateLimits({
      RUNTIME_PROJECT_RATE_LIMITS: "prj_a=10:20, prj_b=0, prj_c=0.5:1, invalid, prj_d=10:bad",
    }),
    {
      prj_a: { requestsPerSecond: 10, burst: 20 },
      prj_b: { requestsPerSecond: 0 },
      prj_c: { requestsPerSecond: 0.5, burst: 1 },
    },
  );
  assert.equal(parseProjectRateLimits({}), undefined);
});

test("runtime config parses log drain targets", () => {
  assert.deepEqual(
    parseRuntimeLogDrains({
      RUNTIME_LOG_DRAINS: "https://logs.example.dev/ingest, https://backup.example.dev/logs , invalid",
      RUNTIME_LOG_DRAIN_HEADERS: "authorization=Bearer token,x-scope=runtime,broken",
    }),
    [
      {
        url: "https://logs.example.dev/ingest",
        headers: { authorization: "Bearer token", "x-scope": "runtime" },
      },
      {
        url: "https://backup.example.dev/logs",
        headers: { authorization: "Bearer token", "x-scope": "runtime" },
      },
    ],
  );
  assert.equal(parseRuntimeLogDrains({}), undefined);
});

test("runtime config parses warm deployment packing policy", () => {
  assert.deepEqual(
    parseRuntimePackingPolicy({
      RUNTIME_PACKING_MAX_WARM_DEPLOYMENTS: "256",
      RUNTIME_PACKING_MAX_WARM_DEPLOYMENTS_PER_PROJECT: "8",
      RUNTIME_PACKING_MAX_IDLE_DEPLOYMENT_AGE_MS: "300000",
    }),
    {
      maxWarmDeployments: 256,
      maxWarmDeploymentsPerProject: 8,
      maxIdleDeploymentAgeMs: 300000,
    },
  );
  assert.equal(parseRuntimePackingPolicy({}), undefined);
});

test("runtime config parses cache retention policy", () => {
  assert.deepEqual(
    parseRuntimeCacheRetentionPolicy({
      WASMPLANE_RUNTIME_CACHE_MAX_BYTES: "1048576",
      WASMPLANE_RUNTIME_CACHE_MAX_AGE_MS: "3600000",
    }),
    {
      maxBytes: 1048576,
      maxAgeMs: 3600000,
    },
  );
  assert.equal(parseRuntimeCacheRetentionPolicy({}), undefined);
  assert.equal(
    parseRuntimeCacheRetentionPolicy({
      WASMPLANE_RUNTIME_CACHE_MAX_BYTES: "bad",
      WASMPLANE_RUNTIME_CACHE_MAX_AGE_MS: "0",
    }),
    undefined,
  );
  assert.equal(
    parseRuntimeCacheGcIntervalMs({ WASMPLANE_RUNTIME_CACHE_GC_INTERVAL_MS: "60000" }),
    60000,
  );
  assert.equal(
    parseRuntimeCacheGcIntervalMs({ WASMPLANE_RUNTIME_CACHE_GC_INTERVAL_MS: "0" }),
    undefined,
  );
});

test("runtime config parses shutdown drain timeout", () => {
  assert.equal(parseRuntimeShutdownDrainTimeoutMs({}, 30000), 30000);
  assert.equal(
    parseRuntimeShutdownDrainTimeoutMs({ RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS: "5000" }, 30000),
    5000,
  );
  assert.equal(
    parseRuntimeShutdownDrainTimeoutMs({ RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS: "0" }, 30000),
    30000,
  );
  assert.equal(
    parseRuntimeShutdownDrainTimeoutMs({ RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS: "bad" }, 30000),
    30000,
  );
});

test("runtime config resolves route snapshot file", () => {
  assert.equal(resolveRuntimeRouteSnapshotFile({}), undefined);
  assert.equal(
    resolveRuntimeRouteSnapshotFile({ RUNTIME_ROUTE_SNAPSHOT_FILE: "  .wasmplane/runtime-snapshot.json  " }),
    ".wasmplane/runtime-snapshot.json",
  );
  assert.equal(resolveRuntimeRouteSnapshotFile({ RUNTIME_ROUTE_SNAPSHOT_FILE: "   " }), undefined);
});
