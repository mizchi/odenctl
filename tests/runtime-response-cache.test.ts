import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  createRuntimeNodeApp,
  type RuntimeNodeAppOptions,
} from "../crates/odenctl/src/runtime/node-app.ts";
import { signRuntimeIdentityHeaders } from "../crates/odenctl/src/runtime/identity.ts";
import type { CompiledComponent } from "../crates/odenctl/src/runtime/types.ts";
import { createRuntimeSupervisor } from "../crates/odenctl/src/runtime/supervisor.ts";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshot,
} from "../crates/odenctl/src/control-plane/contracts.ts";

const policy = {
  maxBytes: 16384,
  maxEntryBytes: 4096,
  maxEntries: 10,
  maxPending: 8,
  rules: [{
    projectId: "p1",
    host: "public.example",
    pathPrefix: "/",
    maxTtlSeconds: 60,
    varyHeaders: [],
  }],
};
const component: CompiledComponent = {
  deploymentId: "d1",
  projectId: "p1",
  backend: "wasmtime",
  componentPath: "/d1.wasm",
  precompiledPath: "/d1.cwasm",
  cached: true,
  limits: {
    cpuMs: 1000,
    wallMs: 1000,
    memoryMb: 64,
    requestBytes: 1024,
    responseBytes: 1024,
    subrequests: 1,
  },
  capabilities: {
    outboundHttp: { enabled: false, allow: [] },
    secrets: [],
    kv: [],
    durableObjects: [],
    services: [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  },
};
const publicResponse = () => ({
  status: 200,
  headers: [
    { name: "cache-control", value: "public, max-age=30" },
    { name: "content-type", value: "application/octet-stream" },
    { name: "X-Odenctl-Request-Id", value: "forged" },
    { name: "X-Odenctl-Cache", value: "forged" },
  ],
  body: Uint8Array.of(0, 128, 255),
  logs: [{ message: "guest executed" }],
});

async function fixture(
  t: TestContext,
  overrides: Partial<RuntimeNodeAppOptions> = {},
) {
  let calls = 0;
  let ids = 0;
  const app = createRuntimeNodeApp({
    responseCache: policy,
    managementToken: "admin",
    requestIdGenerator: () => `request-${++ids}`,
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        return component;
      },
    },
    invoker: {
      async invoke() {
        calls++;
        return publicResponse();
      },
    },
    ...overrides,
  });
  const server = await app.listen({ port: 0 });
  t.after(() => app.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path = "/asset", init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { "x-forwarded-host": "public.example", ...init.headers },
    });
  const purge = (
    body = {},
    headers: Record<string, string> = { authorization: "Bearer admin" },
  ) =>
    get("/__runtime/response-cache/purge", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return { app, get, purge, calls: () => calls };
}

test("gateway serves binary hits with fresh request IDs and without replaying guest logs", async (t) => {
  const f = await fixture(t);
  const miss = await f.get();
  assert.equal(miss.headers.get("x-oden-cache"), "MISS");
  assert.equal(miss.headers.get("x-oden-request-id"), "request-1");
  assert.deepEqual([...new Uint8Array(await miss.arrayBuffer())], [
    0,
    128,
    255,
  ]);
  const hit = await f.get();
  assert.equal(hit.headers.get("x-oden-cache"), "HIT");
  assert.equal(hit.headers.get("x-oden-request-id"), "request-2");
  assert.deepEqual([...new Uint8Array(await hit.arrayBuffer())], [0, 128, 255]);
  const head = await f.get("/asset", { method: "HEAD" });
  assert.equal(head.headers.get("x-oden-cache"), "HIT");
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal(await head.text(), "");
  assert.equal(f.calls(), 1);
  assert.equal(f.app.metrics().requests.total, 3);
  assert.equal(f.app.metrics().invocations.total, 1);
  assert.equal(f.app.logs().logs.length, 1);
  const events = await (await f.get("/__runtime/events", {
    headers: { authorization: "Bearer admin" },
  })).json();
  assert.equal(events.events.length, 3);
});

test("cache hits still enforce project request rate limits and draining", async (t) => {
  const f = await fixture(t, {
    requestRateLimitsByProject: { p1: { requestsPerSecond: 1, burst: 2 } },
    monotonicNowMs: () => 0,
  });
  assert.equal((await f.get()).status, 200);
  assert.equal((await f.get()).headers.get("x-oden-cache"), "HIT");
  assert.equal((await f.get()).status, 429);
  await f.get("/__runtime/drain", {
    method: "POST",
    headers: { authorization: "Bearer admin" },
  });
  assert.equal((await f.get()).status, 503);
  assert.equal(f.calls(), 1);
});

test("cached hits need no invocation slot and cacheable concurrent misses share one invocation", async (t) => {
  const pending = Promise.withResolvers<ReturnType<typeof publicResponse>>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, {
    maxConcurrentInvocations: 1,
    invoker: {
      async invoke(input) {
        calls++;
        if (input.uri.endsWith("/slow")) {
          started.resolve();
          return pending.promise;
        }
        return publicResponse();
      },
    },
  });
  await f.get();
  const slow = f.get("/slow");
  await started.promise;
  const shared = f.get("/slow");
  const hit = await f.get();
  assert.equal(hit.headers.get("x-oden-cache"), "HIT");
  // Waiting for the same-key request is observable without timing sleeps.
  for (let i = 0; f.app.responseCacheStats()?.coalesced !== 1 && i < 100; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(f.app.responseCacheStats()?.coalesced, 1);
  pending.resolve(publicResponse());
  assert.equal((await slow).status, 200);
  assert.equal((await shared).headers.get("x-oden-cache"), "HIT");
  assert.equal(calls, 2);
  assert.equal(f.app.metrics().invocations.rejected, 0);
});

test("management purge requires a configured token, validates scope, and leaves other deployments cached", async (t) => {
  let deployment = "d1";
  const f = await fixture(t, {
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        return { ...component, deploymentId: deployment };
      },
    },
  });
  await f.get();
  deployment = "d2";
  await f.get();
  assert.equal((await f.purge({}, {})).status, 401);
  assert.equal((await f.purge({ typo: true })).status, 400);
  assert.equal(
    (await f.purge({ projectId: "p1", deploymentId: "d1" })).status,
    200,
  );
  assert.equal((await f.get()).headers.get("x-oden-cache"), "HIT");
  deployment = "d1";
  assert.equal((await f.get()).headers.get("x-oden-cache"), "MISS");
  assert.equal(f.calls(), 3);
  const stats = await (await f.get("/__runtime/response-cache", {
    headers: { authorization: "Bearer admin" },
  })).json();
  assert.equal(stats.entries, 2);
  const noToken = await fixture(t, { managementToken: undefined });
  assert.equal((await noToken.purge()).status, 401);
});

test("purge identity signatures cover the exact request body", async (t) => {
  const f = await fixture(t, {
    managementIdentityKeys: { control: "signing-secret" },
  });
  const body = JSON.stringify({ projectId: "p1" });
  const signed = signRuntimeIdentityHeaders({
    method: "POST",
    path: "/__runtime/response-cache/purge",
    body,
    keyId: "control",
    secret: "signing-secret",
  });
  assert.equal((await f.purge({ projectId: "p1" })).status, 401);
  assert.equal(
    (await f.purge({ projectId: "p1" }, {
      authorization: "Bearer admin",
      ...signed,
    })).status,
    200,
  );
  assert.equal(
    (await f.purge({ projectId: "p2" }, {
      authorization: "Bearer admin",
      ...signed,
    })).status,
    401,
  );
});

test("snapshot changes fence responses from already selected old routes", async (t) => {
  const pending = Promise.withResolvers<ReturnType<typeof publicResponse>>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, {
    invoker: {
      async invoke() {
        if (++calls === 1) {
          started.resolve();
          return pending.promise;
        }
        return publicResponse();
      },
    },
  });
  const old = f.get();
  await started.promise;
  const update = await f.get("/__runtime/snapshots/routes", {
    method: "PUT",
    headers: { authorization: "Bearer admin" },
    body: JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      routes: [],
    }),
  });
  assert.equal(update.status, 200, await update.text());
  pending.resolve(publicResponse());
  assert.equal((await old).status, 200);
  assert.equal((await f.get()).headers.get("x-oden-cache"), "MISS");
  assert.equal((await f.get()).headers.get("x-oden-cache"), "HIT");
  assert.equal(calls, 2);
});

test("response cache uses the selected component invoker instead of re-routing in the daemon proxy", async (t) => {
  const f = await fixture(t, {
    hostDaemonWorkerProxy: {
      url: "http://unused",
      fetch: async () =>
        assert.fail("proxy would independently select a canary deployment"),
    },
  });
  assert.equal((await f.get()).status, 200);
  assert.equal((await f.get()).headers.get("x-oden-cache"), "HIT");
  assert.equal(f.calls(), 1);
});

test("real supervisor routes new releases, rollbacks and weighted targets before cache lookup", async (t) => {
  function snapshot(deploymentId: string, canary?: string): RouteSnapshot {
    const target = (id: string, weight: number) => ({
      deploymentId: id,
      weight,
      world: MVP_WORKER_WORLD,
      worldVersion: MVP_WORKER_WORLD_VERSION,
      runtime: {
        backend: "wasmtime" as const,
        version: "48.0.2",
        wasi: MVP_WASI_PROFILE,
      },
      limits: component.limits!,
      capabilities: component.capabilities!,
      artifact: {
        id: `art_${id}`,
        digest: "sha256:" + createHash("sha256").update(id).digest("hex"),
        location: `file:///tmp/${id}.wasm`,
      },
    });
    const primary = target(deploymentId, canary ? 50 : 100);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      routes: [{
        ...primary,
        projectId: "p1",
        host: "public.example",
        pathPrefix: "/",
        targets: canary ? [primary, target(canary, 50)] : [primary],
      }],
    };
  }
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot("d1"),
    artifactStore: {
      async materialize(artifact) {
        return { ...artifact, path: artifact.location, verified: true };
      },
    },
    backend: {
      async compileComponent(input) {
        return {
          ...component,
          deploymentId: input.deploymentId,
          precompiledPath: `/cache/${input.deploymentId}.cwasm`,
        };
      },
    },
  });
  const called: string[] = [];
  const f = await fixture(t, {
    supervisor,
    invoker: {
      async invoke(input) {
        called.push(input.deploymentId);
        return { ...publicResponse(), body: Buffer.from(input.deploymentId) };
      },
    },
  });
  const publish = async (deploymentId: string, canary?: string) => {
    const response = await f.get("/__runtime/snapshots/routes", {
      method: "PUT",
      headers: { authorization: "Bearer admin" },
      body: JSON.stringify(snapshot(deploymentId, canary)),
    });
    assert.equal(response.status, 200, await response.text());
  };
  for (const id of ["d1", "d2", "d1"]) {
    if (called.length) await publish(id);
    const miss = await f.get();
    assert.equal(miss.headers.get("x-oden-cache"), "MISS");
    assert.equal(await miss.text(), id);
    const hit = await f.get();
    assert.equal(hit.headers.get("x-oden-cache"), "HIT");
    assert.equal(await hit.text(), id);
  }
  assert.deepEqual(called, ["d1", "d2", "d1"]);
  await publish("d1", "d2");
  const selected = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const miss = await f.get(`/canary/${i}`);
    const id = await miss.text();
    selected.add(id);
    assert.equal(miss.headers.get("x-oden-deployment"), id);
    const hit = await f.get(`/canary/${i}`);
    assert.equal(hit.headers.get("x-oden-cache"), "HIT");
    assert.equal(await hit.text(), id);
  }
  assert.deepEqual([...selected].sort(), ["d1", "d2"]);
  assert.equal(called.length, 23);
});

test("proxy-only gateways bypass the response cache", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    invoker: undefined,
    hostDaemonWorkerProxy: {
      url: "http://unused",
      fetch: async () => {
        calls++;
        return new Response("proxy", {
          headers: { "cache-control": "public, max-age=30" },
        });
      },
    },
  });
  assert.equal((await f.get()).headers.get("x-oden-cache"), "BYPASS");
  assert.equal((await f.get()).headers.get("x-oden-cache"), "BYPASS");
  assert.equal(calls, 2);
  assert.equal(f.app.responseCacheStats()?.entries, 0);
});

test("disconnected callers cannot publish late cache fills", async (t) => {
  const pending = Promise.withResolvers<ReturnType<typeof publicResponse>>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, {
    invoker: {
      async invoke() {
        if (++calls === 1) {
          started.resolve();
          return pending.promise;
        }
        return publicResponse();
      },
    },
  });
  t.after(() => pending.resolve(publicResponse()));
  const controller = new AbortController();
  const first = f.get("/asset", { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  for (let i = 0; f.app.responseCacheStats()?.pending !== 0 && i < 100; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(f.app.responseCacheStats()?.pending, 0);
  pending.resolve(publicResponse());
  assert.equal((await f.get()).headers.get("x-oden-cache"), "MISS");
  assert.equal((await f.get()).headers.get("x-oden-cache"), "HIT");
  assert.equal(calls, 2);
});

test("a failed snapshot warmup suspends caching until completion and still invalidates", async (t) => {
  const warmup = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const f = await fixture(t, {
    warmupOnSnapshot: true,
    supervisor: {
      loadSnapshot() {},
      async prepareRoute() {
        return component;
      },
      async warmupSnapshot() {
        started.resolve();
        await warmup.promise;
        throw new Error("failed warmup");
      },
    },
  });
  await f.get();
  const update = f.get("/__runtime/snapshots/routes", {
    method: "PUT",
    headers: { authorization: "Bearer admin" },
    body: JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      routes: [],
    }),
  });
  await started.promise;
  assert.equal((await f.get()).headers.get("x-oden-cache"), "BYPASS");
  warmup.resolve();
  assert.equal((await update).status, 500);
  assert.equal((await f.get()).headers.get("x-oden-cache"), "MISS");
});
