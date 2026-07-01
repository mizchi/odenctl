import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MVP_WASI_PROFILE, MVP_WORKER_WORLD_VERSION } from "../src/control-plane/contracts.ts";
import { createAsyncControlPlane } from "../src/control-plane/async-service.ts";
import { createHmacArtifactSignatureVerifier, signArtifactDigest } from "../src/control-plane/artifact-signing.ts";
import { createAesGcmSecretCipher, isEncryptedSecretValue } from "../src/control-plane/secret-encryption.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createMemoryRepository, createSqliteRepository } from "../src/control-plane/repository.ts";

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
  control.createSecret({
    id: "sec_api_key",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });
  control.createKvNamespace({
    id: "kv_main",
    projectId: project.id,
    name: "Main KV",
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
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: true, allow: ["https://api.example.com"] },
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    },
  });

  assert.equal(deployment.id, "dep_hello_v1");
  assert.equal(deployment.worldVersion, MVP_WORKER_WORLD_VERSION);
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
          requestBytes: 1048576,
          subrequests: 20,
          hostCalls: 100,
          responseBytes: 1048576,
        },
        capabilities: { outboundHttp: { enabled: false, allow: [] }, kv: [], secrets: [] },
      }),
    /already exists/,
  );
});

test("async control plane preserves deployment validation", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const project = await control.createProject({ id: "prj_async", name: "async" });
  await control.createArtifact({
    id: "art_async",
    projectId: project.id,
    digest: digest("async"),
    location: "oci://registry.example.com/mizchi/async:v1",
    sizeBytes: 42,
  });

  await assert.rejects(
    () =>
      control.createDeployment({
        id: "dep_missing_secret",
        projectId: project.id,
        artifactId: "art_async",
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
          requestBytes: 1048576,
          subrequests: 20,
          hostCalls: 100,
          responseBytes: 1048576,
        },
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_missing" }],
        },
      }),
    /secret sec_missing/,
  );
});

test("accepts remote HTTP artifact locations for runtime materialization", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_remote", name: "remote artifacts" });

  const artifact = control.createArtifact({
    id: "art_remote",
    projectId: project.id,
    digest: digest("remote"),
    location: "https://artifacts.example.dev/workers/hello.component.wasm",
    sizeBytes: 1024,
  });

  assert.equal(artifact.location, "https://artifacts.example.dev/workers/hello.component.wasm");
});

test("artifact signatures are verified before deployment and provenance is surfaced in snapshots", () => {
  const verifier = createHmacArtifactSignatureVerifier({ keys: { ci: "secret-key" } });
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    artifactSignatureVerifier: verifier,
  });
  const project = control.createProject({ id: "prj_signed", name: "signed" });
  const digestValue = digest("signed");
  const signature = signArtifactDigest(digestValue, { algorithm: "sha256-hmac", keyId: "ci" }, "secret-key");
  const artifact = control.createArtifact({
    id: "art_signed",
    projectId: project.id,
    digest: digestValue,
    location: "oci://registry.example.com/mizchi/signed:v1",
    sizeBytes: 42,
    signature,
    provenance: {
      builder: "github-actions",
      source: "github.com/mizchi/wasmplane",
      revision: "abc123",
      buildId: "run-1",
    },
  });

  const deployment = control.createDeployment({
    ...seedDeployment("dep_signed", artifact.id),
    projectId: project.id,
  });
  control.pointRoute({
    projectId: project.id,
    host: "signed.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  const snapshotArtifact = control.createRouteSnapshot().routes[0]?.artifact;
  assert.deepEqual(snapshotArtifact?.signature, signature);
  assert.deepEqual(snapshotArtifact?.provenance, artifact.provenance);

  const badArtifact = control.createArtifact({
    id: "art_bad_signature",
    projectId: project.id,
    digest: digest("bad-signature"),
    location: "oci://registry.example.com/mizchi/bad:v1",
    sizeBytes: 42,
    signature: { ...signature, value: "0".repeat(64) },
  });
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_signature", badArtifact.id),
        projectId: project.id,
      }),
    /signature verification failed/,
  );
});

test("registers project secrets and validates deployment secret bindings", () => {
  const control = createSeededControlPlane();
  const secret = control.createSecret({
    id: "sec_api_key",
    projectId: "prj_hello",
    name: "API key",
    value: "super-secret",
  });

  assert.deepEqual(secret, {
    id: "sec_api_key",
    projectId: "prj_hello",
    name: "API key",
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
  });
  assert.deepEqual(control.getSecret({ id: "sec_api_key" }), secret);
  assert.deepEqual(control.listProjectSecrets({ projectId: "prj_hello" }), [secret]);

  const updated = control.updateSecretValue({ id: "sec_api_key", value: "rotated-secret" });
  assert.deepEqual(updated, secret);

  const deployment = control.createDeployment({
    ...seedDeployment("dep_secret", "art_v1"),
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    },
  });
  control.pointRoute({
    projectId: "prj_hello",
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  const snapshotSecret = control.createRouteSnapshot().routes[0]?.capabilities.secrets[0];
  assert.deepEqual(snapshotSecret, { binding: "API_KEY", secretId: "sec_api_key" });
  assert.equal("value" in (snapshotSecret as any), false);

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_missing_secret", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_missing" }],
        },
      }),
    /secret sec_missing/,
  );
});

test("control plane encrypts secret values before repository persistence", () => {
  const repository = createMemoryRepository();
  const secretCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 4),
    keyId: "test-key",
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    },
  });
  const control = createControlPlane({
    repository,
    secretCipher,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_secure", name: "secure" });

  control.createSecret({
    id: "sec_secure",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });

  const stored = repository.getSecretValue("sec_secure");
  assert.equal(typeof stored, "string");
  assert.equal(isEncryptedSecretValue(stored as string), true);
  assert.equal((stored as string).includes("super-secret"), false);
  assert.equal(secretCipher.decrypt(stored as string), "super-secret");

  control.updateSecretValue({ id: "sec_secure", value: "rotated-secret" });
  const rotated = repository.getSecretValue("sec_secure") as string;
  assert.equal(isEncryptedSecretValue(rotated), true);
  assert.equal(secretCipher.decrypt(rotated), "rotated-secret");
});

test("async control plane encrypts secret values before repository persistence", async () => {
  const repository = createMemoryRepository();
  const secretCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 6),
    keyId: "async-test-key",
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    },
  });
  const control = createAsyncControlPlane({
    repository: asyncRepository(repository),
    secretCipher,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = await control.createProject({ id: "prj_secure_async", name: "secure async" });

  await control.createSecret({
    id: "sec_secure_async",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });

  const stored = repository.getSecretValue("sec_secure_async") as string;
  assert.equal(isEncryptedSecretValue(stored), true);
  assert.equal(stored.includes("super-secret"), false);
  assert.equal(secretCipher.decrypt(stored), "super-secret");
});

test("deployment secret bindings cannot reference another project", () => {
  const control = createSeededControlPlane();
  const other = control.createProject({ id: "prj_other", name: "other" });
  control.createSecret({
    id: "sec_other",
    projectId: other.id,
    name: "other-api-key",
    value: "secret",
  });

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_cross_project_secret", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_other" }],
        },
      }),
    /same project/,
  );
});

test("project quotas reject resources beyond configured limits", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectQuotas: {
      maxArtifacts: 1,
      maxDeployments: 1,
      maxRoutes: 1,
      maxSecrets: 1,
      maxKvNamespaces: 1,
    },
  });
  const project = control.createProject({ id: "prj_quota", name: "quota" });
  const artifact = control.createArtifact({
    id: "art_one",
    projectId: project.id,
    digest: digest("one"),
    location: "oci://registry.example.com/mizchi/one:v1",
    sizeBytes: 1,
  });
  control.createSecret({
    id: "sec_one",
    projectId: project.id,
    name: "one",
    value: "secret",
  });
  control.createKvNamespace({
    id: "kv_one",
    projectId: project.id,
    name: "one",
  });
  const deployment = control.createDeployment({
    ...seedDeployment("dep_one", artifact.id),
    projectId: project.id,
  });
  control.pointRoute({
    projectId: project.id,
    host: "quota.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });

  assert.throws(
    () =>
      control.createArtifact({
        id: "art_two",
        projectId: project.id,
        digest: digest("two"),
        location: "oci://registry.example.com/mizchi/two:v1",
        sizeBytes: 1,
      }),
    /artifact quota exceeded/,
  );
  assert.throws(
    () =>
      control.createSecret({
        id: "sec_two",
        projectId: project.id,
        name: "two",
        value: "secret",
      }),
    /secret quota exceeded/,
  );
  assert.throws(
    () =>
      control.createKvNamespace({
        id: "kv_two",
        projectId: project.id,
        name: "two",
      }),
    /kv namespace quota exceeded/,
  );
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_two", artifact.id),
        projectId: project.id,
      }),
    /deployment quota exceeded/,
  );
  assert.throws(
    () =>
      control.pointRoute({
        projectId: project.id,
        host: "quota.example.dev",
        pathPrefix: "/two",
        deploymentId: deployment.id,
      }),
    /route quota exceeded/,
  );

  const updated = control.pointRoute({
    projectId: project.id,
    host: "quota.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  assert.equal(updated.deploymentId, deployment.id);
});

test("control plane exposes project resource usage", () => {
  const control = createSeededControlPlane();
  control.createSecret({
    id: "sec_usage",
    projectId: "prj_hello",
    name: "usage",
    value: "secret",
  });
  control.createKvNamespace({
    id: "kv_usage",
    projectId: "prj_hello",
    name: "usage",
  });
  const deployment = control.createDeployment(seedDeployment("dep_usage"));
  control.pointRoute({
    projectId: "prj_hello",
    host: "usage.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });

  assert.deepEqual(control.getProjectUsage({ projectId: "prj_hello" }), {
    artifacts: 2,
    deployments: 1,
    routes: 1,
    secrets: 1,
    kvNamespaces: 1,
  });
});

test("registers project KV namespaces and validates deployment bindings", () => {
  const control = createSeededControlPlane();
  const namespace = control.createKvNamespace({
    id: "kv_main",
    projectId: "prj_hello",
    name: "Main KV",
  });

  assert.deepEqual(namespace, {
    id: "kv_main",
    projectId: "prj_hello",
    name: "Main KV",
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
  });
  assert.deepEqual(control.getKvNamespace({ id: "kv_main" }), namespace);
  assert.deepEqual(control.listProjectKvNamespaces({ projectId: "prj_hello" }), [namespace]);

  const deployment = control.createDeployment({
    ...seedDeployment("dep_kv", "art_v1"),
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [],
    },
  });
  control.pointRoute({
    projectId: "prj_hello",
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  assert.deepEqual(control.createRouteSnapshot().routes[0]?.capabilities.kv, [
    { binding: "MAIN", namespaceId: "kv_main" },
  ]);

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_missing_kv", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_missing" }],
          secrets: [],
        },
      }),
    /kv namespace kv_missing/,
  );
});

test("deployment KV bindings cannot reference another project", () => {
  const control = createSeededControlPlane();
  const other = control.createProject({ id: "prj_other", name: "other" });
  control.createKvNamespace({
    id: "kv_other",
    projectId: other.id,
    name: "Other KV",
  });

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_cross_project_kv", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_other" }],
          secrets: [],
        },
      }),
    /same project/,
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
  assert.match(snapshot.id ?? "", /^snap_[a-f0-9]{16}$/);
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
    region: "NRT",
    labels: { tier: "edge", pool: "default" },
    host: {
      backend: "wasmtime",
      wasi: "wasip3",
      runtimeVersion: "wasmplane-runtime/0.1.0",
      hostVersion: "wasmtime-43.0.0",
      engineVariant: "engine-abcd1234",
    },
  });

  assert.equal(node.id, "rt_local");
  assert.equal(node.url, "http://127.0.0.1:8788");
  assert.equal(node.status, "active");
  assert.equal(node.registeredAt, fixedNow());
  assert.equal(node.region, "nrt");
  assert.deepEqual(node.labels, { pool: "default", tier: "edge" });
  assert.deepEqual(node.host, {
    backend: "wasmtime",
    wasi: "wasip3",
    runtimeVersion: "wasmplane-runtime/0.1.0",
    hostVersion: "wasmtime-43.0.0",
    engineVariant: "engine-abcd1234",
  });
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
    load: { activeRequests: 64 },
    host: {
      backend: "wasmtime",
      wasi: "wasip3",
      runtimeVersion: "wasmplane-runtime/0.1.0",
      hostVersion: "wasmtime-43.0.0",
      engineVariant: "engine-hot",
    },
  });
  control.recordRuntimeNodeHeartbeat({ id: "rt_offline", status: "offline" });

  assert.equal(heartbeat.status, "active");
  assert.equal(heartbeat.lastSeenAt, fixedNow());
  assert.equal(heartbeat.version, "wasmplane-runtime/0.1.0");
  assert.deepEqual(heartbeat.capacity, { concurrentRequests: 128, memoryMb: 4096 });
  assert.deepEqual(heartbeat.load, { activeRequests: 64 });
  assert.deepEqual(heartbeat.host, {
    backend: "wasmtime",
    wasi: "wasip3",
    runtimeVersion: "wasmplane-runtime/0.1.0",
    hostVersion: "wasmtime-43.0.0",
    engineVariant: "engine-hot",
  });
  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_active"],
  );
});

test("updates runtime node lifecycle status without rewriting heartbeat data", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_maint", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_maint",
    version: "wasmplane-runtime/0.1.0",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 3 },
  });

  const draining = control.updateRuntimeNodeStatus({ id: "rt_maint", status: "draining" });

  assert.equal(draining.status, "draining");
  assert.equal(draining.lastSeenAt, fixedNow());
  assert.equal(draining.version, "wasmplane-runtime/0.1.0");
  assert.deepEqual(draining.capacity, { concurrentRequests: 128, memoryMb: 4096 });
  assert.deepEqual(draining.load, { activeRequests: 3 });
  assert.deepEqual(control.listActiveRuntimeNodes(), []);

  const active = control.updateRuntimeNodeStatus({ id: "rt_maint", status: "active" });
  assert.equal(active.status, "active");
  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_maint"],
  );

  assert.throws(
    () => control.updateRuntimeNodeStatus({ id: "rt_missing", status: "offline" }),
    /runtime node rt_missing was not found/,
  );
});

test("cleans up old runtime nodes by lifecycle status", () => {
  let currentNow = "2026-06-26T10:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: () => currentNow,
  });

  control.registerRuntimeNode({ id: "rt_offline_old", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_offline_old", status: "offline" });
  control.registerRuntimeNode({ id: "rt_active_old", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_active_old", status: "active" });

  currentNow = "2026-06-26T11:50:00.000Z";
  control.registerRuntimeNode({ id: "rt_offline_fresh", url: "http://127.0.0.1:8790", status: "offline" });

  currentNow = "2026-06-26T12:00:00.000Z";
  const offlineCleanup = control.cleanupRuntimeNodes({ olderThanMs: 60 * 60 * 1000 });

  assert.equal(offlineCleanup.cutoff, "2026-06-26T11:00:00.000Z");
  assert.deepEqual(
    offlineCleanup.removed.map((node) => node.id),
    ["rt_offline_old"],
  );
  assert.deepEqual(
    control.listRuntimeNodes().map((node) => node.id),
    ["rt_active_old", "rt_offline_fresh"],
  );

  const activeCleanup = control.cleanupRuntimeNodes({
    olderThanMs: 60 * 60 * 1000,
    statuses: ["active"],
  });
  assert.deepEqual(
    activeCleanup.removed.map((node) => node.id),
    ["rt_active_old"],
  );
  assert.deepEqual(
    control.listRuntimeNodes().map((node) => node.id),
    ["rt_offline_fresh"],
  );

  assert.throws(
    () => control.cleanupRuntimeNodes({ olderThanMs: 0 }),
    /olderThanMs/,
  );
});

test("excludes saturated runtime nodes from active publish targets", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_room", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_full", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_room",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 127 },
  });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_full",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 128 },
  });

  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_room"],
  );
});

test("excludes runtime nodes with stale heartbeat timestamps", () => {
  let currentNow = "2026-06-26T10:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    runtimeNodeActiveTtlMs: 60_000,
    now: () => currentNow,
  });

  control.registerRuntimeNode({ id: "rt_fresh", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_stale", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_fresh" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_stale" });

  currentNow = "2026-06-26T10:01:01.000Z";
  control.recordRuntimeNodeHeartbeat({ id: "rt_fresh" });

  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_fresh"],
  );
});

test("records route snapshot publication history", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const publication = control.recordRouteSnapshotPublication({
    snapshotId: "snap_test",
    snapshotGeneratedAt: "2026-06-26T09:59:00.000Z",
    routes: 2,
    ok: false,
    targets: [
      { id: "rt_active", url: "http://127.0.0.1:8788", ok: true, status: 200, routes: 2 },
      { id: "rt_offline", url: "http://127.0.0.1:8789", ok: false, error: "offline" },
    ],
  });

  assert.equal(publication.id, "pub_1");
  assert.equal(publication.snapshotId, "snap_test");
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
  assert.equal(route?.worldVersion, MVP_WORKER_WORLD_VERSION);
  assert.deepEqual(
    route?.targets.map((target) => ({
      deploymentId: target.deploymentId,
      weight: target.weight,
      worldVersion: target.worldVersion,
      digest: target.artifact.digest,
    })),
    [
      { deploymentId: "dep_v1", weight: 90, worldVersion: MVP_WORKER_WORLD_VERSION, digest: digest("v1") },
      { deploymentId: "dep_v2", weight: 10, worldVersion: MVP_WORKER_WORLD_VERSION, digest: digest("v2") },
    ],
  );
});

test("route canary controller starts canary and rolls back to stable deployment", () => {
  const control = createSeededControlPlane();
  const stable = control.createDeployment(seedDeployment("dep_stable", "art_v1"));
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));
  control.pointRoute({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: stable.id,
  });

  const canary = control.startRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: candidate.id,
    weight: 5,
  });

  assert.deepEqual(canary.targets, [
    { deploymentId: stable.id, weight: 95 },
    { deploymentId: candidate.id, weight: 5 },
  ]);

  const rollback = control.rollbackRoute({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
  });

  assert.deepEqual(rollback.targets, [{ deploymentId: stable.id, weight: 100 }]);
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, stable.id);
});

test("route canary analysis rolls back failed candidates and records decisions", () => {
  const control = createSeededControlPlane();
  const stable = control.createDeployment(seedDeployment("dep_stable", "art_v1"));
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));
  control.pointRoute({
    id: "rte_canary",
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: stable.id,
  });
  control.startRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: candidate.id,
    weight: 10,
  });

  const result = control.analyzeRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    candidateDeploymentId: candidate.id,
    thresholds: { minRequests: 3, errorRate: 0.25, p95Ms: 250, rejectCount: 0 },
    events: [
      { deploymentId: stable.id, status: 200, durationMs: 50 },
      { deploymentId: candidate.id, status: 200, durationMs: 100 },
      { deploymentId: candidate.id, status: 200, durationMs: 200 },
      { deploymentId: candidate.id, status: 500, durationMs: 300 },
    ],
  });

  assert.equal(result.decision.id, "can_1");
  assert.equal(result.decision.action, "rollback");
  assert.equal(result.decision.reason, "error_rate");
  assert.deepEqual(result.decision.metrics, {
    requests: 3,
    errors: 1,
    rejects: 0,
    errorRate: 1 / 3,
    p95Ms: 300,
  });
  assert.deepEqual(result.route.targets, [{ deploymentId: stable.id, weight: 100 }]);
  assert.deepEqual(control.listCanaryDecisions(), [result.decision]);
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, stable.id);
});

test("sqlite repository records schema migrations and upgrades existing databases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-migrations-"));
  const dbPath = join(dir, "control.sqlite");
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(oldSchema);
  oldDb.close();

  const repository = createSqliteRepository(dbPath);
  const control = createControlPlane({
    repository,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_local", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_local",
    capacity: { concurrentRequests: 16, memoryMb: 1024 },
  });
  control.recordRouteSnapshotPublication({
    snapshotGeneratedAt: fixedNow(),
    routes: 0,
    ok: true,
    targets: [],
  });

  const db = new DatabaseSync(dbPath);
  const migrationIds = db
    .prepare("select id from schema_migrations order by id asc")
    .all()
    .map((row: any) => row.id);
  const routeColumns = db
    .prepare("pragma table_info(routes)")
    .all()
    .map((row: any) => row.name);
  const runtimeNodeColumns = db
    .prepare("pragma table_info(runtime_nodes)")
    .all()
    .map((row: any) => row.name);
  const secretColumns = db
    .prepare("pragma table_info(secrets)")
    .all()
    .map((row: any) => row.name);
  const kvNamespaceColumns = db
    .prepare("pragma table_info(kv_namespaces)")
    .all()
    .map((row: any) => row.name);

  assert.deepEqual(migrationIds, [
    "202606260001_wasip3_alias",
    "202606260002_route_targets",
    "202606260003_runtime_node_health",
    "202606260004_route_snapshot_publications",
    "202606270001_secret_registry",
    "202606270002_kv_namespace_registry",
    "202606300002_route_snapshot_id",
    "202606300003_runtime_node_placement",
    "202606300004_canary_decisions",
    "202606300005_worker_world_version",
    "202606300006_artifact_metadata",
    "202607010001_runtime_node_identity",
    "202607010002_runtime_node_host_info",
    "202607010003_fly_autoscaler_coordination",
  ]);
  assert.ok(routeColumns.includes("targets_json"));
  const artifactColumns = db
    .prepare("pragma table_info(artifacts)")
    .all()
    .map((row: any) => row.name);
  assert.ok(artifactColumns.includes("signature_json"));
  assert.ok(artifactColumns.includes("provenance_json"));
  const deploymentColumns = db
    .prepare("pragma table_info(deployments)")
    .all()
    .map((row: any) => row.name);
  assert.ok(deploymentColumns.includes("world_version"));
  assert.ok(runtimeNodeColumns.includes("status"));
  assert.ok(runtimeNodeColumns.includes("region"));
  assert.ok(runtimeNodeColumns.includes("labels_json"));
  assert.ok(runtimeNodeColumns.includes("load_json"));
  assert.ok(runtimeNodeColumns.includes("identity_json"));
  assert.ok(runtimeNodeColumns.includes("host_json"));
  assert.ok(secretColumns.includes("value"));
  assert.ok(kvNamespaceColumns.includes("project_id"));
  assert.equal(db.prepare("select count(*) as count from route_snapshot_publications").get().count, 1);
  const publicationColumns = db
    .prepare("pragma table_info(route_snapshot_publications)")
    .all()
    .map((row: any) => row.name);
  assert.ok(publicationColumns.includes("snapshot_id"));
  const canaryDecisionColumns = db
    .prepare("pragma table_info(canary_decisions)")
    .all()
    .map((row: any) => row.name);
  assert.ok(canaryDecisionColumns.includes("candidate_deployment_id"));
  db.close();
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

function asyncRepository(repository: ReturnType<typeof createMemoryRepository>) {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: any[]) => Promise.resolve(value.apply(target, args));
    },
  }) as any;
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
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
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

const oldSchema = `
pragma foreign_keys = on;

create table projects (
  id text primary key,
  name text not null unique,
  created_at text not null
);

create table artifacts (
  id text primary key,
  project_id text not null,
  digest text not null unique,
  location text not null,
  size_bytes integer not null,
  created_at text not null,
  foreign key (project_id) references projects(id)
);

create table deployments (
  id text primary key,
  project_id text not null,
  artifact_id text not null,
  world text not null,
  runtime_backend text not null,
  runtime_version text not null,
  wasi_version text not null,
  limits_json text not null,
  capabilities_json text not null,
  created_at text not null,
  foreign key (project_id) references projects(id),
  foreign key (artifact_id) references artifacts(id)
);

create table routes (
  id text primary key,
  project_id text not null,
  host text not null,
  path_prefix text not null,
  deployment_id text not null,
  updated_at text not null,
  unique (project_id, host, path_prefix),
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);

create table runtime_nodes (
  id text primary key,
  url text not null unique,
  registered_at text not null
);
`;
