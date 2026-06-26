import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MVP_WASI_PROFILE } from "../src/control-plane/contracts.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createMemoryRepository } from "../src/control-plane/repository.ts";

test("creates immutable wasmtime deployments with denied-by-default host capabilities", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const project = control.createProject({ name: "hello" });
  const artifact = control.createArtifact({
    projectId: project.id,
    digest: digest("hello"),
    location: "oci://registry.example.com/mizchi/hello:v1",
    sizeBytes: 42,
  });

  const deployment = control.createDeployment({
    id: "dep_hello_v1",
    projectId: project.id,
    artifactId: artifact.id,
    world: "myedge:runtime/worker@0.1.0",
    runtime: {
      backend: "wasmtime",
      version: "wasmtime-43",
      wasi: "wasip3",
    },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      subrequests: 20,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: true, allow: ["https://api.example.com"] },
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    },
  });

  assert.equal(deployment.id, "dep_hello_v1");
  assert.equal(deployment.runtime.backend, "wasmtime");
  assert.equal(deployment.runtime.wasi, MVP_WASI_PROFILE);
  assert.equal(deployment.capabilities.arbitraryFilesystem, false);
  assert.equal(deployment.capabilities.arbitrarySockets, false);
  assert.equal(deployment.capabilities.processSpawn, false);

  assert.throws(
    () =>
      control.createDeployment({
        id: "dep_hello_v1",
        projectId: project.id,
        artifactId: artifact.id,
        world: "myedge:runtime/worker@0.1.0",
        runtime: {
          backend: "wasmtime",
          version: "wasmtime-43",
          wasi: "wasip3",
        },
        limits: {
          cpuMs: 50,
          memoryMb: 64,
          wallMs: 1000,
          subrequests: 20,
          responseBytes: 1048576,
        },
        capabilities: { outboundHttp: { enabled: false, allow: [] }, kv: [], secrets: [] },
      }),
    /already exists/,
  );
});

test("route pointers can roll forward and back without mutating deployments", () => {
  const control = createSeededControlPlane();

  const v1 = control.createDeployment(seedDeployment("dep_v1", "art_v1"));
  const v2 = control.createDeployment(seedDeployment("dep_v2", "art_v2"));

  control.pointRoute({
    projectId: v1.projectId,
    host: "Hello.Example.Dev",
    pathPrefix: "/",
    deploymentId: v1.id,
  });
  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: v2.id,
  });

  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, "dep_v2");

  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: v1.id,
  });

  const snapshot = control.createRouteSnapshot();
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0]?.host, "hello.example.dev");
  assert.equal(snapshot.routes[0]?.deploymentId, "dep_v1");
  assert.equal(snapshot.routes[0]?.artifact.digest, digest("v1"));
  assert.equal(snapshot.routes[0]?.runtime.backend, "wasmtime");
});

test("deployment contract rejects runtimes and worlds outside the MVP contract", () => {
  const control = createSeededControlPlane();

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_backend", "art_v1"),
        runtime: { backend: "wasmedge", version: "wasmedge-1", wasi: "wasip3" },
      }),
    /wasmtime/,
  );

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_world", "art_v1"),
        world: "wasi:http/proxy@0.2.0",
      }),
    /world/,
  );
});

test("registers runtime nodes for route snapshot publication", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const node = control.registerRuntimeNode({
    id: "rt_local",
    url: "http://127.0.0.1:8788/",
  });

  assert.equal(node.id, "rt_local");
  assert.equal(node.url, "http://127.0.0.1:8788");
  assert.equal(node.status, "active");
  assert.equal(node.registeredAt, fixedNow());
  assert.deepEqual(control.listRuntimeNodes(), [node]);

  assert.throws(
    () =>
      control.registerRuntimeNode({
        id: "rt_bad",
        url: "file:///tmp/runtime.sock",
      }),
    /runtime node url/,
  );
});

test("tracks runtime node heartbeat and excludes inactive nodes from publish targets", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_active", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_offline", url: "http://127.0.0.1:8789" });

  const heartbeat = control.recordRuntimeNodeHeartbeat({
    id: "rt_active",
    version: "wasmplane-runtime/0.1.0",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
  });
  control.recordRuntimeNodeHeartbeat({ id: "rt_offline", status: "offline" });

  assert.equal(heartbeat.status, "active");
  assert.equal(heartbeat.lastSeenAt, fixedNow());
  assert.equal(heartbeat.version, "wasmplane-runtime/0.1.0");
  assert.deepEqual(heartbeat.capacity, { concurrentRequests: 128, memoryMb: 4096 });
  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_active"],
  );
});

test("records route snapshot publication history", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const publication = control.recordRouteSnapshotPublication({
    snapshotGeneratedAt: "2026-06-26T09:59:00.000Z",
    routes: 2,
    ok: false,
    targets: [
      { id: "rt_active", url: "http://127.0.0.1:8788", ok: true, status: 200, routes: 2 },
      { id: "rt_offline", url: "http://127.0.0.1:8789", ok: false, error: "offline" },
    ],
  });

  assert.equal(publication.id, "pub_1");
  assert.equal(publication.createdAt, fixedNow());
  assert.deepEqual(control.listRouteSnapshotPublications(), [publication]);
});

test("route snapshots can carry weighted rollout targets", () => {
  const control = createSeededControlPlane();
  const v1 = control.createDeployment(seedDeployment("dep_v1", "art_v1"));
  const v2 = control.createDeployment(seedDeployment("dep_v2", "art_v2"));

  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    targets: [
      { deploymentId: v1.id, weight: 90 },
      { deploymentId: v2.id, weight: 10 },
    ],
  });

  const route = control.createRouteSnapshot().routes[0];
  assert.equal(route?.deploymentId, "dep_v1");
  assert.deepEqual(
    route?.targets.map((target) => ({
      deploymentId: target.deploymentId,
      weight: target.weight,
      digest: target.artifact.digest,
    })),
    [
      { deploymentId: "dep_v1", weight: 90, digest: digest("v1") },
      { deploymentId: "dep_v2", weight: 10, digest: digest("v2") },
    ],
  );
});

function createSeededControlPlane() {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_hello", name: "hello" });
  control.createArtifact({
    id: "art_v1",
    projectId: project.id,
    digest: digest("v1"),
    location: "oci://registry.example.com/mizchi/hello:v1",
    sizeBytes: 1,
  });
  control.createArtifact({
    id: "art_v2",
    projectId: project.id,
    digest: digest("v2"),
    location: "oci://registry.example.com/mizchi/hello:v2",
    sizeBytes: 2,
  });
  return control;
}

function seedDeployment(id: string, artifactId = "art_v1") {
  return {
    id,
    projectId: "prj_hello",
    artifactId,
    world: "myedge:runtime/worker@0.1.0",
    runtime: {
      backend: "wasmtime",
      version: "wasmtime-43",
      wasi: "wasip3",
    },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      subrequests: 20,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
    },
  };
}

function sequenceIds() {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}

function fixedNow() {
  return "2026-06-26T10:00:00.000Z";
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
