import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshot,
} from "../src/control-plane/contracts.ts";
import { createAesGcmSecretCipher } from "../src/control-plane/secret-encryption.ts";
import { createRuntimeNodeApp, runtimeNodeHttpListenOptions } from "../src/runtime/node-app.ts";
import { RuntimeError } from "../src/runtime/errors.ts";
import { registerRuntimeNode, sendRuntimeHeartbeat } from "../src/runtime/heartbeat.ts";
import { signRuntimeIdentityHeaders } from "../src/runtime/identity.ts";
import { createEnvSecretStore, createRepositorySecretStore } from "../src/runtime/secrets.ts";
import { createRuntimeSupervisor } from "../src/runtime/supervisor.ts";

test("runtime node binds IPv6 wildcard as dual-stack for Fly private networking", () => {
  assert.deepEqual(runtimeNodeHttpListenOptions({ port: 8080, host: "::" }), {
    port: 8080,
    host: "::",
    ipv6Only: false,
  });
  assert.deepEqual(runtimeNodeHttpListenOptions({ port: 8080, host: "0.0.0.0" }), {
    port: 8080,
    host: "0.0.0.0",
  });
});

test("runtime node accepts route snapshots and invokes matched deployments", async () => {
  const preparedDeployments: string[] = [];
  const invokedComponents: string[] = [];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: "/tmp/worker.component.wasm",
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        preparedDeployments.push(request.deploymentId);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke(request) {
        invokedComponents.push(request.component.componentPath);
        assert.equal(request.deploymentId, "dep_api");
        assert.equal(request.method, "GET");
        assert.equal(request.uri, "http://hello.example.dev/api/users");
        return {
          status: 200,
          headers: [{ name: "content-type", value: "text/plain" }],
          body: Buffer.from("hello from wasm"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/__runtime/healthz`);
    assert.equal(health.status, 200);

    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        snapshot([
          route("dep_root", "hello.example.dev", "/", digest("root")),
          route("dep_api", "hello.example.dev", "/api", digest("api")),
        ]),
      ),
    });
    assert.equal(update.status, 200, await update.text());

    const miss = await fetch(`${baseUrl}/api/users`, {
      headers: { "x-forwarded-host": "other.example.dev" },
    });
    assert.equal(miss.status, 404);

    const hit = await fetch(`${baseUrl}/api/users`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-wasmplane-deployment"), "dep_api");
    assert.equal(hit.headers.get("x-wasmplane-precompiled"), "/cache/dep_api.cwasm");
    assert.equal(hit.headers.get("content-type"), "text/plain");
    assert.equal(await hit.text(), "hello from wasm");
    assert.deepEqual(preparedDeployments, ["dep_api"]);
    assert.deepEqual(invokedComponents, ["/tmp/worker.component.wasm"]);
  } finally {
    await app.close();
  }
});

test("runtime node exposes readiness and local drain controls", async () => {
  const loadedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    managementToken: "runtime-secret",
    now: fixedNow,
    supervisor: {
      loadSnapshot(routeSnapshot) {
        loadedSnapshots.push(routeSnapshot);
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routeSnapshot = snapshot([route("dep_ready", "hello.example.dev", "/", digest("ready"))]);

  try {
    const initial = await fetch(`${baseUrl}/__runtime/readyz`);
    assert.equal(initial.status, 503);
    assert.deepEqual(await initial.json(), {
      ok: false,
      status: "active",
      checks: {
        lifecycle: { ok: true, status: "active" },
        snapshot: { ok: false, loaded: 0 },
        hostDaemon: { ok: true },
      },
    });

    const unauthorizedDrain = await fetch(`${baseUrl}/__runtime/drain`, { method: "POST" });
    assert.equal(unauthorizedDrain.status, 401);

    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer runtime-secret" },
      body: JSON.stringify(routeSnapshot),
    });
    assert.equal(update.status, 200, await update.text());
    assert.equal(loadedSnapshots.length, 1);

    const ready = await fetch(`${baseUrl}/__runtime/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      status: "active",
      checks: {
        lifecycle: { ok: true, status: "active" },
        snapshot: {
          ok: true,
          loaded: 1,
          routes: 1,
          generatedAt: "2026-06-26T10:00:00.000Z",
        },
        hostDaemon: { ok: true },
      },
    });

    const drain = await fetch(`${baseUrl}/__runtime/drain`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-secret" },
    });
    assert.equal(drain.status, 200);
    assert.deepEqual(await drain.json(), { ok: true, status: "draining" });
    assert.equal(app.lifecycleStatus(), "draining");

    const drainedReady = await fetch(`${baseUrl}/__runtime/readyz`);
    assert.equal(drainedReady.status, 503);
    assert.deepEqual(await drainedReady.json(), {
      ok: false,
      status: "draining",
      checks: {
        lifecycle: { ok: false, status: "draining" },
        snapshot: {
          ok: true,
          loaded: 1,
          routes: 1,
          generatedAt: "2026-06-26T10:00:00.000Z",
        },
        hostDaemon: { ok: true },
      },
    });

    const activate = await fetch(`${baseUrl}/__runtime/activate`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-secret" },
    });
    assert.equal(activate.status, 200);
    assert.deepEqual(await activate.json(), { ok: true, status: "active" });
    assert.equal(app.lifecycleStatus(), "active");
  } finally {
    await app.close();
  }
});

test("runtime node close drains active invocation and rejects new worker requests", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_drain", "hello.example.dev", "/", digest("drain"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let releaseInvocation: (() => void) | undefined;
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    invocationStarted = resolve;
  });
  const app = createRuntimeNodeApp({
    supervisor,
    now: fixedNow,
    invoker: {
      async invoke() {
        invocationStarted();
        await new Promise<void>((resolve) => {
          releaseInvocation = resolve;
        });
        return { status: 200, headers: [], body: Buffer.from("drained") };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closeSettled = false;
  let closePromise: Promise<void> | undefined;

  try {
    const active = fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    await started;

    closePromise = app.close({ drainTimeoutMs: 1000 }).then(() => {
      closeSettled = true;
    });
    assert.equal(app.lifecycleStatus(), "draining");

    const rejected = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, "draining");
    assert.equal(closeSettled, false);

    releaseInvocation?.();
    const activeResponse = await active;
    assert.equal(activeResponse.status, 200);
    assert.equal(await activeResponse.text(), "drained");
    await closePromise;
    assert.equal(closeSettled, true);
  } finally {
    releaseInvocation?.();
    if (closePromise) {
      await closePromise.catch(() => undefined);
    } else {
      await app.close().catch(() => undefined);
    }
  }
});

test("runtime node saves accepted route snapshots before acknowledging publish", async () => {
  const savedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        throw new Error("not used");
      },
    },
    snapshotStore: {
      async save(routeSnapshot) {
        savedSnapshots.push(routeSnapshot);
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routeSnapshot = snapshot([route("dep_persist", "hello.example.dev", "/", digest("persist"))]);

  try {
    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routeSnapshot),
    });
    assert.equal(update.status, 200, await update.text());
    assert.deepEqual(savedSnapshots, [routeSnapshot]);
  } finally {
    await app.close();
  }
});

test("runtime readiness treats restored initial route snapshot as loaded", async () => {
  const restored = snapshot([route("dep_restored", "hello.example.dev", "/", digest("restored"))]);
  const app = createRuntimeNodeApp({
    supervisor: createRuntimeSupervisor({
      snapshot: restored,
      artifactStore: materializedArtifactStore(),
      backend: compiledBackend(),
    }),
    initialRouteSnapshot: restored,
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const ready = await fetch(`${baseUrl}/__runtime/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      status: "active",
      checks: {
        lifecycle: { ok: true, status: "active" },
        snapshot: {
          ok: true,
          loaded: 1,
          routes: 1,
          generatedAt: "2026-06-26T10:00:00.000Z",
        },
        hostDaemon: { ok: true },
      },
    });
  } finally {
    await app.close();
  }
});

test("runtime node can warm snapshot deployments before acknowledging publish", async () => {
  const preparedDeployments: string[] = [];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([]),
    artifactStore: materializedArtifactStore(),
    backend: {
      async compileComponent(request) {
        preparedDeployments.push(request.deploymentId);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });
  const app = createRuntimeNodeApp({ supervisor, warmupOnSnapshot: true });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        snapshot([
          route("dep_root", "hello.example.dev", "/", digest("root")),
          route("dep_api", "hello.example.dev", "/api", digest("api")),
        ]),
      ),
    });
    const body = await update.json();
    assert.equal(update.status, 200);
    assert.deepEqual(body, {
      ok: true,
      warmed: true,
      routes: 2,
      generatedAt: "2026-06-26T10:00:00.000Z",
    });
    assert.deepEqual(new Set(preparedDeployments), new Set(["dep_root", "dep_api"]));
  } finally {
    await app.close();
  }
});

test("runtime node requires management bearer token for runtime endpoints when configured", async () => {
  const loadedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    managementToken: "runtime-secret",
    supervisor: {
      loadSnapshot(snapshot) {
        loadedSnapshots.push(snapshot);
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routeSnapshot = snapshot([route("dep_auth", "hello.example.dev", "/", digest("auth"))]);

  try {
    const health = await fetch(`${baseUrl}/__runtime/healthz`);
    assert.equal(health.status, 200);

    const metrics = await fetch(`${baseUrl}/__runtime/metrics`);
    assert.equal(metrics.status, 401);

    const missing = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routeSnapshot),
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), {
      error: { code: "unauthorized", message: "missing or invalid runtime bearer token" },
    });

    const wrong = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(routeSnapshot),
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer runtime-secret" },
      body: JSON.stringify(routeSnapshot),
    });
    assert.equal(ok.status, 200, await ok.text());
    assert.equal(loadedSnapshots.length, 1);
  } finally {
    await app.close();
  }
});

test("runtime node verifies signed snapshot publishes with identity keys", async () => {
  const loadedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    managementIdentityKeys: { "rt-key": "runtime-identity-secret" },
    supervisor: {
      loadSnapshot(snapshot) {
        loadedSnapshots.push(snapshot);
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routeSnapshot = snapshot([route("dep_identity", "hello.example.dev", "/", digest("identity"))]);
  const body = JSON.stringify(routeSnapshot);

  try {
    const unsigned = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), {
      error: { code: "unauthorized", message: "missing or invalid runtime identity signature" },
    });

    const signed = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...signRuntimeIdentityHeaders({
          method: "PUT",
          path: "/__runtime/snapshots/routes",
          body,
          keyId: "rt-key",
          secret: "runtime-identity-secret",
        }),
      },
      body,
    });
    assert.equal(signed.status, 200, await signed.text());
    assert.equal(loadedSnapshots.length, 1);
  } finally {
    await app.close();
  }
});

test("runtime node cache GC endpoint keeps prepared component files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-cache-gc-"));
  const artifactDir = join(dir, "artifacts");
  const cwasmDir = join(dir, "cwasm");
  const activeArtifact = join(artifactDir, "active.wasm");
  const staleArtifact = join(artifactDir, "stale.wasm");
  const activeCwasm = join(cwasmDir, "active.cwasm");
  const staleCwasm = join(cwasmDir, "stale.cwasm");
  await writeRuntimeCacheFile(activeArtifact, "active artifact", "2026-06-26T11:55:00.000Z");
  await writeRuntimeCacheFile(staleArtifact, "stale artifact", "2026-06-26T08:00:00.000Z");
  await writeRuntimeCacheFile(activeCwasm, "active cwasm", "2026-06-26T11:55:00.000Z");
  await writeRuntimeCacheFile(staleCwasm, "stale cwasm", "2026-06-26T08:00:00.000Z");
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_gc", "hello.example.dev", "/", digest("gc"))]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: activeArtifact,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: activeCwasm,
          cached: false,
        };
      },
    },
  });
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        return { status: 200, headers: [], body: Buffer.from("ok") };
      },
    },
    cacheRetention: {
      artifactCacheDir: artifactDir,
      precompiledCacheDir: cwasmDir,
      maxAgeMs: 60 * 60 * 1000,
      nowMs: () => Date.parse("2026-06-26T12:00:00.000Z"),
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const hit = await fetch(`${baseUrl}/`, { headers: { "x-forwarded-host": "hello.example.dev" } });
    assert.equal(hit.status, 200);
    const gc = await fetch(`${baseUrl}/__runtime/cache/gc`, { method: "POST" });
    if (gc.status !== 200) {
      assert.fail(await gc.text());
    }
    const report = await gc.json();
    assert.equal(report.removed, 2);
    assert.equal(await runtimeFileExists(activeArtifact), true);
    assert.equal(await runtimeFileExists(activeCwasm), true);
    assert.equal(await runtimeFileExists(staleArtifact), false);
    assert.equal(await runtimeFileExists(staleCwasm), false);
  } finally {
    await app.close();
  }
});

test("runtime node invalidates precompiled cache variants while keeping active components", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-cwasm-invalidate-"));
  const cwasmDir = join(dir, "cwasm");
  const artifactDigest = createHash("sha256").update("api").digest("hex");
  const currentCwasm = join(cwasmDir, `dep_api-${artifactDigest}-engine-current.cwasm`);
  const oldCwasm = join(cwasmDir, `dep_api-${artifactDigest}-engine-old.cwasm`);
  const activeOldCwasm = join(cwasmDir, `dep_active-${artifactDigest}-engine-old.cwasm`);
  await writeRuntimeCacheFile(currentCwasm, "current cwasm", "2026-06-26T11:55:00.000Z");
  await writeRuntimeCacheFile(oldCwasm, "old cwasm", "2026-06-26T11:54:00.000Z");
  await writeRuntimeCacheFile(activeOldCwasm, "active old cwasm", "2026-06-26T11:53:00.000Z");

  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot() {},
      preparedComponents() {
        return [{
          deploymentId: "dep_active",
          backend: "wasmtime" as const,
          componentPath: join(dir, "active.wasm"),
          precompiledPath: activeOldCwasm,
          cached: true,
        }];
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
    cacheRetention: {
      precompiledCacheDir: cwasmDir,
    },
    precompiledCacheEngineVariant: "engine-current",
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/__runtime/cache/invalidate-cwasm`, { method: "POST" });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const report = await response.json();
    assert.deepEqual(report.removed.map((file: any) => file.name), [`dep_api-${artifactDigest}-engine-old.cwasm`]);
    assert.equal(await runtimeFileExists(currentCwasm), true);
    assert.equal(await runtimeFileExists(oldCwasm), false);
    assert.equal(await runtimeFileExists(activeOldCwasm), true);
  } finally {
    await app.close();
  }
});

test("runtime node runs cache GC on a configured interval and stops it on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-cache-gc-interval-"));
  const artifactDir = join(dir, "artifacts");
  const staleArtifact = join(artifactDir, "stale.wasm");
  await writeRuntimeCacheFile(staleArtifact, "stale artifact", "2026-06-26T08:00:00.000Z");
  let scheduled: { callback: () => void | Promise<void>; intervalMs: number } | undefined;
  let cleared: unknown;
  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        throw new Error("not used");
      },
    },
    cacheRetention: {
      artifactCacheDir: artifactDir,
      maxAgeMs: 60 * 60 * 1000,
      nowMs: () => Date.parse("2026-06-26T12:00:00.000Z"),
    },
    cacheRetentionIntervalMs: 30_000,
    cacheRetentionSetInterval(callback, intervalMs) {
      scheduled = { callback, intervalMs };
      return "cache-timer";
    },
    cacheRetentionClearInterval(timer) {
      cleared = timer;
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  assert.ok(server.listening);

  try {
    assert.equal(scheduled?.intervalMs, 30_000);
    await scheduled?.callback();
    assert.equal(await runtimeFileExists(staleArtifact), false);
  } finally {
    await app.close();
  }
  assert.equal(cleared, "cache-timer");
});

test("runtime node rejects invalid route snapshots before loading them", async () => {
  const loadedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot(snapshot) {
        loadedSnapshots.push(snapshot);
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const cases: Array<{ name: string; snapshot: any; message: RegExp }> = [
    {
      name: "runtime backend",
      snapshot: snapshot([
        {
          ...route("dep_bad_runtime", "hello.example.dev", "/", digest("runtime")),
          runtime: { backend: "wasmedge", version: "wasmedge-1", wasi: MVP_WASI_PROFILE },
        },
      ]),
      message: /runtime.backend/,
    },
    {
      name: "artifact digest",
      snapshot: snapshot([
        {
          ...route("dep_bad_digest", "hello.example.dev", "/", digest("digest")),
          artifact: {
            id: "art_bad",
            digest: "sha256:not-hex",
            location: "file:///tmp/worker.component.wasm",
          },
        },
      ]),
      message: /artifact.digest/,
    },
    {
      name: "worker world version",
      snapshot: snapshot([
        {
          ...route("dep_bad_world_version", "hello.example.dev", "/", digest("world-version")),
          worldVersion: "0.2.0",
        },
      ]),
      message: /worldVersion/,
    },
    {
      name: "privileged capabilities",
      snapshot: snapshot([
        {
          ...route("dep_privileged_snapshot", "hello.example.dev", "/", digest("privileged")),
          capabilities: {
            ...route("dep_privileged_snapshot", "hello.example.dev", "/", digest("privileged"))
              .capabilities,
            arbitraryFilesystem: true,
          },
        },
      ]),
      message: /arbitraryFilesystem/,
    },
    {
      name: "route target mismatch",
      snapshot: snapshot([
        {
          ...route("dep_route", "hello.example.dev", "/", digest("route")),
          targets: [
            {
              ...route("dep_target", "hello.example.dev", "/", digest("target")),
              deploymentId: "dep_target",
              weight: 100,
            },
          ],
        },
      ]),
      message: /deploymentId/,
    },
  ];

  try {
    for (const item of cases) {
      const response = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.snapshot),
      });
      assert.equal(response.status, 400, item.name);
      const body = await response.json();
      assert.equal(body.error.code, "validation");
      assert.match(body.error.message, item.message);
    }
    assert.deepEqual(loadedSnapshots, []);
  } finally {
    await app.close();
  }
});

test("runtime node accepts remote artifact locations in route snapshots", async () => {
  const loadedSnapshots: RouteSnapshot[] = [];
  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot(snapshot) {
        loadedSnapshots.push(snapshot);
      },
      async prepareRoute() {
        throw new Error("not used");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const withRemoteArtifact = route("dep_remote", "hello.example.dev", "/", digest("remote"));
  withRemoteArtifact.artifact.location = "https://artifacts.example.dev/workers/hello.component.wasm";
  withRemoteArtifact.targets[0].artifact.location = "https://artifacts.example.dev/workers/hello.component.wasm";

  try {
    const response = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot([withRemoteArtifact])),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(loadedSnapshots.length, 1);
  } finally {
    await app.close();
  }
});

test("runtime node enforces response byte limits", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_small", "hello.example.dev", "/", digest("small"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        return {
          status: 200,
          headers: [],
          body: Buffer.from("too large"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "limits");
    assert.match(body.error.message, /responseBytes/);
  } finally {
    await app.close();
  }
});

test("runtime node rejects request bodies over the configured byte limit before invocation", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_tiny_request", "hello.example.dev", "/", digest("tiny-request"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let invoked = false;
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        invoked = true;
        return {
          status: 200,
          headers: [],
          body: Buffer.from("should not run"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "x-forwarded-host": "hello.example.dev" },
      body: "too large",
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, "limits");
    assert.match(body.error.message, /requestBytes/);
    assert.equal(invoked, false);
  } finally {
    await app.close();
  }
});

test("runtime node maps wall clock limit timeouts to 504", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_timeout", "hello.example.dev", "/", digest("timeout"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: 200,
          headers: [],
          body: Buffer.from("late"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.code, "timeout");
  } finally {
    await app.close();
  }
});

test("runtime node reports CPU limits distinctly from wall timeouts", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_cpu", "hello.example.dev", "/", digest("cpu"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        throw new RuntimeError("cpu_limit", "cpuMs limit exceeded after 1ms");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "cpu_limit");
  } finally {
    await app.close();
  }
});

test("runtime node rejects privileged capabilities from route snapshots before invocation", async () => {
  const privileged = route("dep_privileged", "hello.example.dev", "/", digest("privileged"));
  privileged.capabilities.arbitrarySockets = true as false;
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([privileged]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let invoked = false;
  const app = createRuntimeNodeApp({
    supervisor,
    invoker: {
      async invoke() {
        invoked = true;
        return {
          status: 200,
          headers: [],
          body: Buffer.from("should not run"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "policy");
    assert.match(body.error.message, /arbitrarySockets/);
    assert.equal(invoked, false);
  } finally {
    await app.close();
  }
});

test("runtime node resolves secret values from a host-only secret store before invocation", async () => {
  const withSecret = route("dep_secret", "hello.example.dev", "/", digest("secret"));
  withSecret.capabilities.secrets = [{ binding: "API_KEY", secretId: "sec_api_key" }];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([withSecret]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    secretStore: {
      async getSecret(secretId) {
        assert.equal(secretId, "sec_api_key");
        return "super-secret";
      },
    },
    invoker: {
      async invoke(request) {
        assert.deepEqual(request.component.capabilities?.secrets, [
          { binding: "API_KEY", secretId: "sec_api_key", value: "super-secret" },
        ]);
        assert.deepEqual(withSecret.capabilities.secrets, [
          { binding: "API_KEY", secretId: "sec_api_key" },
        ]);
        return {
          status: 200,
          headers: [],
          body: Buffer.from("ok"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await app.close();
  }
});

test("runtime node exposes worker request metrics", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_metrics", "hello.example.dev", "/", digest("metrics"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    now: fixedNow,
    invoker: {
      async invoke() {
        return {
          status: 201,
          headers: [],
          body: Buffer.from("created"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const initialMetricsResponse = await fetch(`${baseUrl}/__runtime/metrics`);
    assert.equal(initialMetricsResponse.status, 200);
    assert.deepEqual(await initialMetricsResponse.json(), {
      startedAt: fixedNow(),
      requests: { total: 0, matched: 0, missed: 0 },
      invocations: { total: 0, succeeded: 0, failed: 0, active: 0, rejected: 0 },
      responses: { byStatus: {} },
      errors: {},
      snapshots: { loaded: 0 },
    });

    const hit = await fetch(`${baseUrl}/created`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(hit.status, 201);
    assert.equal(await hit.text(), "created");

    const miss = await fetch(`${baseUrl}/missing`, {
      headers: { "x-forwarded-host": "other.example.dev" },
    });
    assert.equal(miss.status, 404);

    const snapshotUpdate = snapshot([]);
    snapshotUpdate.generatedAt = "2026-06-26T10:01:00.000Z";
    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshotUpdate),
    });
    assert.equal(update.status, 200);

    const metricsResponse = await fetch(`${baseUrl}/__runtime/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.deepEqual(await metricsResponse.json(), {
      startedAt: fixedNow(),
      requests: { total: 2, matched: 1, missed: 1 },
      invocations: { total: 1, succeeded: 1, failed: 0, active: 0, rejected: 0 },
      responses: { byStatus: { "201": 1, "404": 1 } },
      errors: { not_found: 1 },
      snapshots: {
        loaded: 1,
        routes: 0,
        generatedAt: "2026-06-26T10:01:00.000Z",
      },
    });
  } finally {
    await app.close();
  }
});

test("runtime node includes host daemon stats in metrics when configured", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_metrics", "hello.example.dev", "/", digest("metrics"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const fetched: string[] = [];
  const app = createRuntimeNodeApp({
    supervisor,
    now: fixedNow,
    hostDaemonMetrics: {
      url: "http://127.0.0.1:8790",
      fetch: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify({
          ok: true,
          preparedComponents: 3,
          reusableInstances: 2,
          activeInvocations: 1,
          maxConcurrentInvocations: 64,
          totalInvocations: 10,
          failedInvocations: 2,
          rejectedInvocations: 1,
          avgInvokeMs: 0.42,
        }), { status: 200 });
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const metricsResponse = await fetch(`${baseUrl}/__runtime/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.equal(fetched[0], "http://127.0.0.1:8790/stats");
    const metrics = await metricsResponse.json();
    assert.deepEqual(metrics.hostDaemon, {
      ok: true,
      preparedComponents: 3,
      reusableInstances: 2,
      activeInvocations: 1,
      maxConcurrentInvocations: 64,
      totalInvocations: 10,
      failedInvocations: 2,
      rejectedInvocations: 1,
      avgInvokeMs: 0.42,
    });
  } finally {
    await app.close();
  }
});

test("runtime node keeps metrics available when host daemon stats fail", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_metrics", "hello.example.dev", "/", digest("metrics"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  const app = createRuntimeNodeApp({
    supervisor,
    now: fixedNow,
    hostDaemonMetrics: {
      url: "http://127.0.0.1:8790",
      fetch: async () => {
        throw new Error("daemon unavailable");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const metricsResponse = await fetch(`${baseUrl}/__runtime/metrics`);
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.json();
    assert.deepEqual(metrics.hostDaemon, {
      ok: false,
      error: "daemon unavailable",
    });
  } finally {
    await app.close();
  }
});

test("runtime readiness fails when configured host daemon stats are unavailable", async () => {
  const app = createRuntimeNodeApp({
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        throw new Error("not used");
      },
    },
    hostDaemonMetrics: {
      url: "http://127.0.0.1:8790",
      fetch: async () => {
        throw new Error("daemon unavailable");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const update = await fetch(`${baseUrl}/__runtime/snapshots/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot([route("dep_daemon_ready", "hello.example.dev", "/", digest("daemon-ready"))])),
    });
    assert.equal(update.status, 200, await update.text());

    const ready = await fetch(`${baseUrl}/__runtime/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), {
      ok: false,
      status: "active",
      checks: {
        lifecycle: { ok: true, status: "active" },
        snapshot: {
          ok: true,
          loaded: 1,
          routes: 1,
          generatedAt: "2026-06-26T10:00:00.000Z",
        },
        hostDaemon: { ok: false, error: "daemon unavailable" },
      },
    });
  } finally {
    await app.close();
  }
});

test("runtime node exposes structured worker request events", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_events", "hello.example.dev", "/", digest("events"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let nextMs = 100;
  const app = createRuntimeNodeApp({
    supervisor,
    now: fixedNow,
    monotonicNowMs() {
      const value = nextMs;
      nextMs += 7;
      return value;
    },
    requestIdGenerator() {
      return "req_structured_1";
    },
    invoker: {
      async invoke() {
        return { status: 202, headers: [], body: Buffer.from("accepted") };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const hit = await fetch(`${baseUrl}/events`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(hit.status, 202);
    assert.equal(hit.headers.get("x-wasmplane-request-id"), "req_structured_1");

    const eventsResponse = await fetch(`${baseUrl}/__runtime/events`);
    assert.equal(eventsResponse.status, 200);
    assert.deepEqual(await eventsResponse.json(), {
      events: [
        {
          timestamp: fixedNow(),
          requestId: "req_structured_1",
          host: "hello.example.dev",
          path: "/events",
          projectId: "prj_hello",
          deploymentId: "dep_events",
          status: 202,
          durationMs: 7,
        },
      ],
    });
  } finally {
    await app.close();
  }
});

test("runtime node stores bounded redacted worker logs", async () => {
  const withSecret = route("dep_logs", "hello.example.dev", "/", digest("logs"));
  withSecret.capabilities.secrets = [{ binding: "API_KEY", secretId: "sec_api_key" }];
  let requestIndex = 0;
  const app = createRuntimeNodeApp({
    supervisor: createRuntimeSupervisor({
      snapshot: snapshot([withSecret]),
      artifactStore: materializedArtifactStore(),
      backend: compiledBackend(),
    }),
    logBufferSize: 2,
    now: fixedNow,
    requestIdGenerator() {
      requestIndex += 1;
      return `req_log_${requestIndex}`;
    },
    secretStore: {
      async getSecret() {
        return "super-secret";
      },
    },
    invoker: {
      async invoke() {
        if (requestIndex === 1) {
          return {
            status: 200,
            headers: [],
            body: Buffer.from("old"),
            logs: [{ level: "info", message: "old secret=super-secret" }],
          };
        }
        return {
          status: 200,
          headers: [],
          body: Buffer.from("new"),
          logs: [
            { level: "warn", message: "authorization: Bearer runtime-token" },
            { message: "new secret=super-secret" },
          ],
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fetch(`${baseUrl}/first`, { headers: { "x-forwarded-host": "hello.example.dev" } });
    await fetch(`${baseUrl}/second`, { headers: { "x-forwarded-host": "hello.example.dev" } });

    const logsResponse = await fetch(`${baseUrl}/__runtime/logs?deploymentId=dep_logs`);
    assert.equal(logsResponse.status, 200);
    assert.deepEqual(await logsResponse.json(), {
      logs: [
        {
          timestamp: fixedNow(),
          requestId: "req_log_2",
          host: "hello.example.dev",
          path: "/second",
          projectId: "prj_hello",
          deploymentId: "dep_logs",
          level: "warn",
          message: "authorization: [REDACTED]",
        },
        {
          timestamp: fixedNow(),
          requestId: "req_log_2",
          host: "hello.example.dev",
          path: "/second",
          projectId: "prj_hello",
          deploymentId: "dep_logs",
          level: "info",
          message: "new secret=[REDACTED]",
        },
      ],
    });

    const filtered = await fetch(`${baseUrl}/__runtime/logs?deploymentId=dep_missing`);
    assert.deepEqual(await filtered.json(), { logs: [] });
  } finally {
    await app.close();
  }
});

test("runtime node rejects worker invocations over the configured concurrency limit", async () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([route("dep_limited", "hello.example.dev", "/", digest("limited"))]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let releaseInvocation!: () => void;
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    invocationStarted = resolve;
  });
  const app = createRuntimeNodeApp({
    supervisor,
    maxConcurrentInvocations: 1,
    now: fixedNow,
    invoker: {
      async invoke() {
        invocationStarted();
        await new Promise<void>((resolve) => {
          releaseInvocation = resolve;
        });
        return { status: 200, headers: [], body: Buffer.from("ok") };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    await started;
    const rejected = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(rejected.status, 503);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.error.code, "overloaded");

    releaseInvocation();
    const accepted = await first;
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), "ok");

    const metrics = await (await fetch(`${baseUrl}/__runtime/metrics`)).json();
    assert.deepEqual(metrics.invocations, {
      total: 1,
      succeeded: 1,
      failed: 0,
      active: 0,
      rejected: 1,
      maxConcurrent: 1,
    });
    assert.deepEqual(metrics.responses.byStatus, { "200": 1, "503": 1 });
    assert.equal(metrics.errors.overloaded, 1);
  } finally {
    await app.close();
  }
});

test("runtime node enforces per-project concurrency budgets", async () => {
  const firstRoute = route("dep_limited", "hello.example.dev", "/", digest("limited"));
  firstRoute.projectId = "prj_limited";
  const otherRoute = route("dep_other", "other.example.dev", "/", digest("other"));
  otherRoute.projectId = "prj_other";
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([firstRoute, otherRoute]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let releaseInvocation!: () => void;
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    invocationStarted = resolve;
  });
  const app = createRuntimeNodeApp({
    supervisor,
    maxConcurrentInvocationsByProject: {
      prj_limited: 1,
    },
    now: fixedNow,
    invoker: {
      async invoke(request) {
        if (request.component.projectId === "prj_limited") {
          invocationStarted();
          await new Promise<void>((resolve) => {
            releaseInvocation = resolve;
          });
        }
        return { status: 200, headers: [], body: Buffer.from("ok") };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    await started;
    const rejected = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, "overloaded");

    const otherProject = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "other.example.dev" },
    });
    assert.equal(otherProject.status, 200);

    releaseInvocation();
    const accepted = await first;
    assert.equal(accepted.status, 200);
  } finally {
    await app.close();
  }
});

test("runtime node enforces per-project request rate limits", async () => {
  const firstRoute = route("dep_limited", "hello.example.dev", "/", digest("rate-limited"));
  firstRoute.projectId = "prj_limited";
  const otherRoute = route("dep_other", "other.example.dev", "/", digest("rate-other"));
  otherRoute.projectId = "prj_other";
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([firstRoute, otherRoute]),
    artifactStore: materializedArtifactStore(),
    backend: compiledBackend(),
  });
  let nowMs = 0;
  const app = createRuntimeNodeApp({
    supervisor,
    requestRateLimitsByProject: {
      prj_limited: { requestsPerSecond: 1, burst: 1 },
    },
    monotonicNowMs() {
      return nowMs;
    },
    now: fixedNow,
    invoker: {
      async invoke() {
        return { status: 200, headers: [], body: Buffer.from("ok") };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(first.status, 200);

    const rejected = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).error.code, "rate_limited");

    const otherProject = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "other.example.dev" },
    });
    assert.equal(otherProject.status, 200);

    nowMs = 1000;
    const refilled = await fetch(`${baseUrl}/`, {
      headers: { "x-forwarded-host": "hello.example.dev" },
    });
    assert.equal(refilled.status, 200);

    const metrics = await (await fetch(`${baseUrl}/__runtime/metrics`)).json();
    assert.equal(metrics.responses.byStatus["429"], 1);
    assert.equal(metrics.errors.rate_limited, 1);
  } finally {
    await app.close();
  }
});

test("runtime heartbeat client registers node and reports capacity", async () => {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const control = await listenControlPlaneSink(requests);

  try {
    await registerRuntimeNode({
      controlPlaneUrl: control.baseUrl,
      runtimeNodeId: "rt_local",
      publicUrl: "http://127.0.0.1:8788",
      region: "nrt",
      labels: { pool: "default" },
      identity: { keyId: "rt-key", certificateSha256: "a".repeat(64) },
      host: {
        backend: "wasmtime",
        wasi: "wasip3",
        runtimeVersion: "wasmplane-runtime/0.1.0",
        hostVersion: "wasmtime-43.0.0",
        engineVariant: "engine-current",
      },
    });
    await sendRuntimeHeartbeat({
      controlPlaneUrl: control.baseUrl,
      runtimeNodeId: "rt_local",
      version: "wasmplane-runtime/0.1.0",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 12 },
      host: {
        backend: "wasmtime",
        wasi: "wasip3",
        runtimeVersion: "wasmplane-runtime/0.1.0",
        hostVersion: "wasmtime-43.0.0",
        engineVariant: "engine-current",
      },
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/runtime-nodes",
        body: {
          id: "rt_local",
          url: "http://127.0.0.1:8788",
          region: "nrt",
          labels: { pool: "default" },
          identity: { keyId: "rt-key", certificateSha256: "a".repeat(64) },
          host: {
            backend: "wasmtime",
            wasi: "wasip3",
            runtimeVersion: "wasmplane-runtime/0.1.0",
            hostVersion: "wasmtime-43.0.0",
            engineVariant: "engine-current",
          },
        },
      },
      {
        method: "POST",
        path: "/runtime-nodes/rt_local/heartbeat",
        body: {
          status: "active",
          version: "wasmplane-runtime/0.1.0",
          capacity: { concurrentRequests: 128, memoryMb: 4096 },
          load: { activeRequests: 12 },
          host: {
            backend: "wasmtime",
            wasi: "wasip3",
            runtimeVersion: "wasmplane-runtime/0.1.0",
            hostVersion: "wasmtime-43.0.0",
            engineVariant: "engine-current",
          },
        },
      },
    ]);
  } finally {
    await control.close();
  }
});

test("runtime heartbeat client sends bearer token when configured", async () => {
  const requests: Array<{ method: string; path: string; authorization?: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://control.local");
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      authorization: request.headers.authorization,
      body: await readJson(request),
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await registerRuntimeNode({
      controlPlaneUrl: baseUrl,
      runtimeNodeId: "rt_local",
      publicUrl: "http://127.0.0.1:8788",
      token: "control-secret",
    });
    await sendRuntimeHeartbeat({
      controlPlaneUrl: baseUrl,
      runtimeNodeId: "rt_local",
      version: "wasmplane-runtime/0.1.0",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      token: "control-secret",
    });

    assert.deepEqual(
      requests.map((request) => request.authorization),
      ["Bearer control-secret", "Bearer control-secret"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("runtime heartbeat client can report non-active lifecycle status", async () => {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const control = await listenControlPlaneSink(requests);

  try {
    await sendRuntimeHeartbeat({
      controlPlaneUrl: control.baseUrl,
      runtimeNodeId: "rt_draining",
      version: "wasmplane-runtime/0.1.0",
      status: "draining",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 1 },
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/runtime-nodes/rt_draining/heartbeat",
        body: {
          status: "draining",
          version: "wasmplane-runtime/0.1.0",
          capacity: { concurrentRequests: 128, memoryMb: 4096 },
          load: { activeRequests: 1 },
        },
      },
    ]);
  } finally {
    await control.close();
  }
});

test("runtime env secret store resolves exact and normalized secret ids", async () => {
  const store = createEnvSecretStore({
    WASMPLANE_SECRET_sec_api_key: "exact",
    WASMPLANE_SECRET_SEC_OTHER: "normalized",
  });

  assert.equal(await store.getSecret("sec_api_key"), "exact");
  assert.equal(await store.getSecret("sec-other"), "normalized");
});

test("runtime repository secret store resolves values by secret id", async () => {
  const store = createRepositorySecretStore({
    getSecretValue(secretId) {
      return secretId === "sec_api_key" ? "super-secret" : undefined;
    },
  });

  assert.equal(await store.getSecret("sec_api_key"), "super-secret");
  assert.equal(await store.getSecret("sec_missing"), undefined);
});

test("runtime repository secret store decrypts encrypted repository values", async () => {
  const secretCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 5),
    keyId: "runtime-test",
    randomBytes(size) {
      return Buffer.alloc(size, 2);
    },
  });
  const store = createRepositorySecretStore(
    {
      getSecretValue(secretId) {
        return secretId === "sec_api_key" ? secretCipher.encrypt("super-secret") : undefined;
      },
    },
    { secretCipher },
  );

  assert.equal(await store.getSecret("sec_api_key"), "super-secret");
  assert.equal(await store.getSecret("sec_missing"), undefined);
});

test("runtime node records worker request telemetry", async () => {
  const telemetryCalls: any[] = [];
  let tick = 1000;
  const app = createRuntimeNodeApp({
    requestIdGenerator: () => "req_otel",
    monotonicNowMs: () => {
      tick += 25;
      return tick;
    },
    telemetry: {
      async recordWorkerRequest(input) {
        telemetryCalls.push(input);
      },
    },
    supervisor: createRuntimeSupervisor({
      snapshot: snapshot([route("dep_otel", "hello.example.dev", "/", digest("otel"))]),
      artifactStore: materializedArtifactStore(),
      backend: compiledBackend(),
    }),
    invoker: {
      async invoke() {
        return {
          status: 201,
          headers: [{ name: "content-type", value: "text/plain" }],
          body: Buffer.from("created"),
        };
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: {
        "x-forwarded-host": "hello.example.dev",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
    });
    assert.equal(response.status, 201);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(telemetryCalls, [
      {
        requestId: "req_otel",
        method: "GET",
        host: "hello.example.dev",
        path: "/",
        projectId: "prj_hello",
        deploymentId: "dep_otel",
        status: 201,
        durationMs: 25,
        errorCode: undefined,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
    ]);
  } finally {
    await app.close();
  }
});

function snapshot(routes: RouteSnapshot["routes"]): RouteSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes,
  };
}

function materializedArtifactStore() {
  return {
    async materialize(artifact: any) {
      return {
        path: "/tmp/worker.component.wasm",
        digest: artifact.digest,
        location: artifact.location,
        verified: true,
      };
    },
  };
}

function compiledBackend() {
  return {
    async compileComponent(request: any) {
      return {
        deploymentId: request.deploymentId,
        backend: "wasmtime" as const,
        componentPath: request.artifact.path,
        precompiledPath: `/cache/${request.deploymentId}.cwasm`,
        cached: false,
      };
    },
  };
}

async function writeRuntimeCacheFile(path: string, content: string, mtime: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "w" });
  const date = new Date(mtime);
  await utimes(path, date, date);
}

async function runtimeFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function route(
  deploymentId: string,
  host: string,
  pathPrefix: string,
  artifactDigest: string,
): RouteSnapshot["routes"][number] {
  const runtime = { backend: "wasmtime" as const, version: "wasmtime-42", wasi: MVP_WASI_PROFILE };
  const limits = {
    cpuMs: 50,
    memoryMb: 64,
    wallMs: deploymentId.includes("timeout") ? 10 : 1000,
    requestBytes: deploymentId.includes("tiny_request") ? 4 : 1048576,
    subrequests: 20,
    hostCalls: 100,
    responseBytes: deploymentId.includes("small") ? 4 : 1048576,
  };
  const capabilities = {
    outboundHttp: { enabled: false, allow: [] },
    kv: [],
    secrets: [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
  const artifact = {
    id: `art_${deploymentId}`,
    digest: artifactDigest,
    location: "file:///tmp/worker.component.wasm",
  };
  return {
    host,
    pathPrefix,
    projectId: "prj_hello",
    deploymentId,
    world: MVP_WORKER_WORLD,
    worldVersion: MVP_WORKER_WORLD_VERSION,
    runtime,
    limits,
    capabilities,
    artifact,
    targets: [{
      deploymentId,
      weight: 100,
      world: MVP_WORKER_WORLD,
      worldVersion: MVP_WORKER_WORLD_VERSION,
      runtime,
      limits,
      capabilities,
      artifact,
    }],
  };
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function fixedNow() {
  return "2026-06-26T10:00:00.000Z";
}

async function listenControlPlaneSink(requests: Array<{ method: string; path: string; body: any }>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://control.local");
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: await readJson(request),
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function readJson(request: any): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.trim().length > 0 ? JSON.parse(body) : {};
}
