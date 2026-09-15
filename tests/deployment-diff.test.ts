import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeploymentDiff } from "../crates/odenctl/src/deployment-diff.ts";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshotEntry,
} from "../crates/odenctl/src/control-plane/contracts.ts";

test("deployment diff reports route, runtime limit, and capability changes", () => {
  const before = routeEntry({
    deploymentId: "dep_old",
    runtimeVersion: "wasmtime-41",
    limits: { wallMs: 1000 },
    outboundAllow: ["https://old.example.dev/"],
    kv: [{ binding: "MAIN", namespaceId: "kv_old" }],
    secrets: [{ binding: "API_KEY", secretId: "sec_old" }],
    services: [{ binding: "AUTH", targetProjectId: "prj_auth_old", url: "https://auth-old.internal/" }],
  });
  const after = routeEntry({
    deploymentId: "dep_new",
    runtimeVersion: "wasmtime-42",
    limits: { wallMs: 2500 },
    outboundAllow: ["https://api.example.dev/v1/"],
    kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
    secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    services: [{ binding: "AUTH", targetProjectId: "prj_auth", url: "https://auth.internal/" }],
  });

  const diff = createDeploymentDiff({ before: { schemaVersion: 1, generatedAt: "now", routes: [before] }, after });

  assert.equal(diff.route.action, "update");
  assert.equal(diff.route.beforeDeploymentId, "dep_old");
  assert.equal(diff.route.afterDeploymentId, "dep_new");
  assert.deepEqual(diff.changes.map((change) => change.path), [
    "route.deploymentId",
    "route.targets",
    "runtime.version",
    "limits.wallMs",
    "capabilities.outboundHttp.allow",
    "capabilities.kv",
    "capabilities.secrets",
    "capabilities.services",
  ]);
});

test("deployment diff marks a new route as create", () => {
  const after = routeEntry({ deploymentId: "dep_new" });

  const diff = createDeploymentDiff({ before: { schemaVersion: 1, generatedAt: "now", routes: [] }, after });

  assert.equal(diff.route.action, "create");
  assert.equal(diff.route.beforeDeploymentId, undefined);
  assert.equal(diff.route.afterDeploymentId, "dep_new");
  assert.ok(diff.changes.some((change) => change.path === "limits.cpuMs"));
  assert.ok(diff.changes.some((change) => change.path === "capabilities.kv"));
});

function routeEntry(input: {
  deploymentId: string;
  runtimeVersion?: string;
  limits?: Partial<RouteSnapshotEntry["limits"]>;
  outboundAllow?: string[];
  kv?: RouteSnapshotEntry["capabilities"]["kv"];
  durableObjects?: RouteSnapshotEntry["capabilities"]["durableObjects"];
  secrets?: RouteSnapshotEntry["capabilities"]["secrets"];
  services?: RouteSnapshotEntry["capabilities"]["services"];
}): RouteSnapshotEntry {
  const limits = {
    cpuMs: 50,
    memoryMb: 64,
    wallMs: 1000,
    requestBytes: 1048576,
    responseBytes: 1048576,
    subrequests: 20,
    ...input.limits,
  };
  const capabilities = {
    outboundHttp: {
      enabled: (input.outboundAllow ?? []).length > 0,
      allow: input.outboundAllow ?? [],
    },
    kv: input.kv ?? [],
    durableObjects: input.durableObjects ?? [],
    secrets: input.secrets ?? [],
    services: input.services ?? [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
  const runtime = {
    backend: MVP_RUNTIME_BACKEND,
    version: input.runtimeVersion ?? "wasmtime-42",
    wasi: MVP_WASI_PROFILE,
  };
  const artifact = {
    id: `art_${input.deploymentId}`,
    digest: `sha256:${input.deploymentId}`,
    location: `file:///tmp/${input.deploymentId}.wasm`,
  };
  return {
    host: "hello.example.dev",
    pathPrefix: "/api",
    projectId: "prj_hello",
    deploymentId: input.deploymentId,
    targets: [{
      deploymentId: input.deploymentId,
      weight: 100,
      world: MVP_WORKER_WORLD,
      worldVersion: MVP_WORKER_WORLD_VERSION,
      runtime,
      limits,
      capabilities,
      artifact,
    }],
    world: MVP_WORKER_WORLD,
    worldVersion: MVP_WORKER_WORLD_VERSION,
    runtime,
    limits,
    capabilities,
    artifact,
  };
}
