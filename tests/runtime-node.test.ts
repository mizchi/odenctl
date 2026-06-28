import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type RouteSnapshot,
} from "../src/control-plane/contracts.ts";
import { createRuntimeNodeApp } from "../src/runtime/node-app.ts";
import { registerRuntimeNode, sendRuntimeHeartbeat } from "../src/runtime/heartbeat.ts";
import { createEnvSecretStore, createRepositorySecretStore } from "../src/runtime/secrets.ts";
import { createRuntimeSupervisor } from "../src/runtime/supervisor.ts";

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

test("runtime heartbeat client registers node and reports capacity", async () => {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const control = await listenControlPlaneSink(requests);

  try {
    await registerRuntimeNode({
      controlPlaneUrl: control.baseUrl,
      runtimeNodeId: "rt_local",
      publicUrl: "http://127.0.0.1:8788",
    });
    await sendRuntimeHeartbeat({
      controlPlaneUrl: control.baseUrl,
      runtimeNodeId: "rt_local",
      version: "wasmplane-runtime/0.1.0",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/runtime-nodes",
        body: {
          id: "rt_local",
          url: "http://127.0.0.1:8788",
        },
      },
      {
        method: "POST",
        path: "/runtime-nodes/rt_local/heartbeat",
        body: {
          status: "active",
          version: "wasmplane-runtime/0.1.0",
          capacity: { concurrentRequests: 128, memoryMb: 4096 },
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
    runtime,
    limits,
    capabilities,
    artifact,
    targets: [{ deploymentId, weight: 100, world: MVP_WORKER_WORLD, runtime, limits, capabilities, artifact }],
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
