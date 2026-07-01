import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RouteSnapshot } from "../src/control-plane/contracts.ts";
import { createJsonlAuditSink } from "../src/control-plane/audit.ts";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createHttpApp } from "../src/http/app.ts";
import { verifyRuntimeIdentityHeaders } from "../src/runtime/identity.ts";

test("HTTP API creates deployment and exposes compact route snapshot", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const signature = { algorithm: "sha256-hmac", keyId: "ci", value: "1".repeat(64) };
    const provenance = {
      builder: "github-actions",
      source: "github.com/mizchi/wasmplane",
      revision: "abc123",
      buildId: "run-1",
    };
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("hello"),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
      signature,
      provenance,
    });
    assert.deepEqual(artifact.signature, signature);
    assert.deepEqual(artifact.provenance, provenance);
    const deployment = await postJson(baseUrl, "/deployments", {
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
        kv: [],
        secrets: [],
      },
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });

    const snapshotResponse = await fetch(`${baseUrl}/snapshots/routes`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.routes.length, 1);
    assert.equal(snapshot.routes[0].host, "hello.example.dev");
    assert.equal(snapshot.routes[0].deploymentId, deployment.id);
    assert.equal(snapshot.routes[0].runtime.backend, "wasmtime");
    assert.deepEqual(snapshot.routes[0].artifact.signature, signature);
    assert.deepEqual(snapshot.routes[0].artifact.provenance, provenance);
  } finally {
    await app.close();
  }
});

test("HTTP API awaits async control-plane methods", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: {
      ...control,
      async createProject(input: any) {
        return control.createProject(input);
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "async-control" });
    assert.deepEqual(project, {
      id: "prj_1",
      name: "async-control",
      createdAt: fixedNow(),
    });
  } finally {
    await app.close();
  }
});

test("HTTP API exposes project quota usage", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { project } = await createHelloRoute(baseUrl);
    await postJson(baseUrl, "/secrets", {
      id: "sec_usage",
      projectId: project.id,
      name: "usage",
      value: "secret",
    });
    await postJson(baseUrl, "/kv-namespaces", {
      id: "kv_usage",
      projectId: project.id,
      name: "usage",
    });

    const response = await fetch(`${baseUrl}/projects/${project.id}/quota-usage`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      artifacts: 1,
      deployments: 1,
      routes: 1,
      secrets: 1,
      kvNamespaces: 1,
    });
  } finally {
    await app.close();
  }
});

test("HTTP admin UI renders routes, deployments, canaries, runtime nodes, and metrics", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { project, artifact, deployment } = await createHelloRoute(baseUrl);
    const candidate = await postJson(baseUrl, "/deployments", {
      projectId: project.id,
      artifactId: artifact.id,
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
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
    });
    await postJsonOk(baseUrl, "/routes/canary", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: candidate.id,
      weight: 10,
    });
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_admin",
      url: "http://runtime.local",
      region: "nrt",
      labels: { pool: "default" },
    });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_admin/heartbeat", {
      status: "active",
      capacity: { concurrentRequests: 16, memoryMb: 2048 },
      load: { activeRequests: 4 },
      host: {
        backend: "wasmtime",
        wasi: "wasip3",
        runtimeVersion: "wasmplane-runtime/0.1.0",
        hostVersion: "wasmtime-43.0.0",
        engineVariant: "engine-current",
      },
    });

    const response = await fetch(`${baseUrl}/admin`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await response.text();
    assert.match(html, /wasmplane admin/);
    assert.match(html, /hello\.example\.dev/);
    assert.match(html, new RegExp(deployment.id));
    assert.match(html, new RegExp(candidate.id));
    assert.match(html, /rt_admin/);
    assert.match(html, /wasmtime/);
    assert.match(html, /engine-current/);
    assert.match(html, /Autoscaling signals/);
    assert.match(html, /action="\/admin\/routes\/canary"/);
    assert.match(html, /action="\/admin\/routes\/rollback"/);
    assert.match(html, /action="\/admin\/runtime-nodes\/status"/);
    assert.match(html, /action="\/admin\/runtime-nodes\/gc"/);
    assert.match(html, /name="runtimeNodeId"/);
  } finally {
    await app.close();
  }
});

test("HTTP admin UI keeps read and write auth scopes separate", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [
      { token: "reader", scopes: ["read"], principal: "reader" },
      { token: "writer", scopes: ["write"], principal: "writer" },
    ],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/admin`);
    assert.equal(unauthorized.status, 401);

    const readable = await fetch(`${baseUrl}/admin`, {
      headers: { authorization: "Bearer reader" },
    });
    assert.equal(readable.status, 200);

    const denied = await fetch(`${baseUrl}/admin/routes/rollback`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        projectId: "prj_1",
        host: "hello.example.dev",
        pathPrefix: "/",
      }),
    });
    assert.equal(denied.status, 403);

    const project = control.createProject({ name: "hello" });
    const artifact = control.createArtifact({
      projectId: project.id,
      digest: digest(`hello-${project.id}`),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
    });
    const deployment = control.createDeployment({
      projectId: project.id,
      artifactId: artifact.id,
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
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
    });
    control.pointRoute({
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });
    const redirected = await fetch(`${baseUrl}/admin/routes/rollback`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Bearer writer",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        projectId: project.id,
        host: "hello.example.dev",
        pathPrefix: "/",
        deploymentId: deployment.id,
      }),
    });
    assert.equal(redirected.status, 303);
    assert.equal(redirected.headers.get("location"), "/admin?notice=rollback");

    control.registerRuntimeNode({ id: "rt_admin", url: "http://runtime.local" });
    const deniedStatus = await fetch(`${baseUrl}/admin/runtime-nodes/status`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        runtimeNodeId: "rt_admin",
        status: "draining",
      }),
    });
    assert.equal(deniedStatus.status, 403);

    const redirectedStatus = await fetch(`${baseUrl}/admin/runtime-nodes/status`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Bearer writer",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        runtimeNodeId: "rt_admin",
        status: "draining",
      }),
    });
    assert.equal(redirectedStatus.status, 303);
    assert.equal(redirectedStatus.headers.get("location"), "/admin?notice=runtime-node-status");
    assert.equal(control.listRuntimeNodes()[0]?.status, "draining");

    const deniedGc = await fetch(`${baseUrl}/admin/runtime-nodes/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        olderThanMs: "86400000",
        statuses: "offline",
      }),
    });
    assert.equal(deniedGc.status, 403);

    const redirectedGc = await fetch(`${baseUrl}/admin/runtime-nodes/gc`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Bearer writer",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        olderThanMs: "86400000",
        statuses: "offline",
      }),
    });
    assert.equal(redirectedGc.status, 303);
    assert.equal(redirectedGc.headers.get("location"), "/admin?notice=runtime-node-gc");
  } finally {
    await app.close();
  }
});

test("HTTP API requires bearer token when API auth is configured", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control, apiToken: "control-secret" });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const missing = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hello" }),
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), {
      error: { code: "unauthorized", message: "missing or invalid bearer token" },
    });

    const wrong = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ name: "hello" }),
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer control-secret",
      },
      body: JSON.stringify({ name: "hello" }),
    });
    if (ok.status !== 201) {
      assert.fail(await ok.text());
    }
    assert.equal((await ok.json()).name, "hello");
  } finally {
    await app.close();
  }
});

test("HTTP API enforces scoped bearer tokens", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [
      { token: "read-token", scopes: ["read"], principal: "reader" },
      { token: "write-token", scopes: ["write"], principal: "writer" },
    ],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const denied = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer read-token",
      },
      body: JSON.stringify({ name: "hello" }),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer write-token",
      },
      body: JSON.stringify({ name: "hello" }),
    });
    assert.equal(created.status, 201, await created.text());
  } finally {
    await app.close();
  }
});

test("HTTP API writes audit events for authenticated mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-audit-"));
  const auditPath = join(dir, "audit.jsonl");
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [{ token: "write-token", scopes: ["write"], principal: "writer" }],
    auditSink: createJsonlAuditSink({ path: auditPath }),
    now: fixedNow,
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer write-token",
      },
      body: JSON.stringify({ name: "hello" }),
    });
    assert.equal(response.status, 201, await response.text());
    await eventually(async () => {
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), {
        timestamp: fixedNow(),
        principal: "writer",
        scope: "write",
        method: "POST",
        path: "/projects",
        status: 201,
      });
    });
  } finally {
    await app.close();
  }
});

test("HTTP API manages secrets without exposing values", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const secret = await postJson(baseUrl, "/secrets", {
      id: "sec_api_key",
      projectId: project.id,
      name: "API key",
      value: "super-secret",
    });

    assert.deepEqual(secret, {
      id: "sec_api_key",
      projectId: project.id,
      name: "API key",
      createdAt: fixedNow(),
      updatedAt: fixedNow(),
    });
    assert.equal("value" in secret, false);

    const getResponse = await fetch(`${baseUrl}/secrets/sec_api_key`);
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), secret);

    const listResponse = await fetch(`${baseUrl}/projects/${project.id}/secrets`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [secret]);

    const updated = await putJson(baseUrl, "/secrets/sec_api_key", {
      value: "rotated-secret",
    });
    assert.deepEqual(updated, secret);
    assert.equal("value" in updated, false);

    const deleteResponse = await fetch(`${baseUrl}/secrets/sec_api_key`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    const deletedResponse = await fetch(`${baseUrl}/secrets/sec_api_key`);
    assert.equal(deletedResponse.status, 404);
  } finally {
    await app.close();
  }
});

test("HTTP API rejects deployments that reference unknown secrets", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("hello"),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
    });
    const response = await fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_missing" }],
        },
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /secret sec_missing/);
  } finally {
    await app.close();
  }
});

test("HTTP API manages KV namespaces", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const namespace = await postJson(baseUrl, "/kv-namespaces", {
      id: "kv_main",
      projectId: project.id,
      name: "Main KV",
    });

    assert.deepEqual(namespace, {
      id: "kv_main",
      projectId: project.id,
      name: "Main KV",
      createdAt: fixedNow(),
      updatedAt: fixedNow(),
    });

    const getResponse = await fetch(`${baseUrl}/kv-namespaces/kv_main`);
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), namespace);

    const listResponse = await fetch(`${baseUrl}/projects/${project.id}/kv-namespaces`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [namespace]);

    const deleteResponse = await fetch(`${baseUrl}/kv-namespaces/kv_main`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    const deletedResponse = await fetch(`${baseUrl}/kv-namespaces/kv_main`);
    assert.equal(deletedResponse.status, 404);
  } finally {
    await app.close();
  }
});

test("HTTP API rejects deployments that reference unknown KV namespaces", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("hello"),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
    });
    const response = await fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_missing" }],
          secrets: [],
        },
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /kv namespace kv_missing/);
  } finally {
    await app.close();
  }
});

test("HTTP API starts canary and rolls back routes", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const stableArtifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("stable"),
      location: "oci://registry.example.com/mizchi/hello:stable",
      sizeBytes: 42,
    });
    const candidateArtifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("candidate"),
      location: "oci://registry.example.com/mizchi/hello:candidate",
      sizeBytes: 43,
    });
    const stable = await postJson(baseUrl, "/deployments", {
      projectId: project.id,
      artifactId: stableArtifact.id,
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
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
    });
    const candidate = await postJson(baseUrl, "/deployments", {
      projectId: project.id,
      artifactId: candidateArtifact.id,
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
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
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: stable.id,
    });

    const canary = await postJsonOk(baseUrl, "/routes/canary", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: candidate.id,
      weight: 10,
    });
    assert.deepEqual(canary.targets, [
      { deploymentId: stable.id, weight: 90 },
      { deploymentId: candidate.id, weight: 10 },
    ]);

    const analysis = await postJsonOk(baseUrl, "/routes/canary/analyze", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      candidateDeploymentId: candidate.id,
      thresholds: { minRequests: 2, p95Ms: 250, errorRate: 0.25, rejectCount: 0 },
      events: [
        { deploymentId: candidate.id, status: 200, durationMs: 100 },
        { deploymentId: candidate.id, status: 503, durationMs: 300, errorCode: "overloaded" },
      ],
    });
    assert.equal(analysis.decision.action, "rollback");
    assert.equal(analysis.decision.reason, "reject_count");
    assert.deepEqual(analysis.route.targets, [{ deploymentId: stable.id, weight: 100 }]);

    const decisionsResponse = await fetch(`${baseUrl}/canary-decisions`);
    assert.equal(decisionsResponse.status, 200);
    const decisions = await decisionsResponse.json();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].candidateDeploymentId, candidate.id);

    const rollback = await postJsonOk(baseUrl, "/routes/rollback", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
    });
    assert.deepEqual(rollback.targets, [{ deploymentId: stable.id, weight: 100 }]);
  } finally {
    await app.close();
  }
});

test("HTTP API publishes route snapshot to configured runtime nodes", async () => {
  const receivedSnapshots: RouteSnapshot[] = [];
  const runtime = await listenRuntimeSnapshotSink(receivedSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimeNodes: [{ id: "local-runtime", url: runtime.baseUrl }],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("hello"),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
    });
    const deployment = await postJson(baseUrl, "/deployments", {
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
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [],
      },
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });

    const response = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const publish = await response.json();

    assert.equal(publish.ok, true);
    assert.match(publish.snapshot.id, /^snap_[a-f0-9]{16}$/);
    assert.equal(publish.snapshot.routes, 1);
    assert.equal(publish.snapshot.generatedAt, fixedNow());
    assert.equal(publish.targets.length, 1);
    const { attempts, elapsedMs, ...target } = publish.targets[0];
    assert.equal(attempts, 1);
    assert.equal(typeof elapsedMs, "number");
    assert.deepEqual(target, {
      id: "local-runtime",
      url: runtime.baseUrl,
      ok: true,
      status: 200,
      routes: 1,
      generatedAt: fixedNow(),
      snapshotId: publish.snapshot.id,
    });

    assert.equal(receivedSnapshots.length, 1);
    assert.equal(receivedSnapshots[0]?.id, publish.snapshot.id);
    assert.equal(receivedSnapshots[0]?.routes[0]?.host, "hello.example.dev");
    assert.equal(receivedSnapshots[0]?.routes[0]?.deploymentId, deployment.id);
  } finally {
    await app.close();
    await runtime.close();
  }
});

test("HTTP API signs runtime snapshot publishes with configured runtime token", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimeNodes: [{ id: "local-runtime", url: "http://runtime.local" }],
    runtimeNodeToken: "runtime-secret",
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, routes: 1, generatedAt: fixedNow() };
        },
        async text() {
          return "ok";
        },
      };
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await createHelloRoute(baseUrl);
    const response = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(calls, [
      {
        url: "http://runtime.local/__runtime/snapshots/routes",
        authorization: "Bearer runtime-secret",
      },
    ]);
  } finally {
    await app.close();
  }
});

test("HTTP API signs runtime snapshot publishes with runtime node identity", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimeIdentityKeys: { "rt-key": "runtime-identity-secret" },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, routes: 1, generatedAt: fixedNow() };
        },
        async text() {
          return "ok";
        },
      };
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_identity",
      url: "http://runtime.local",
      identity: { keyId: "rt-key" },
    });
    await createHelloRoute(baseUrl);

    const response = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    assert.equal(response.status, 200, await response.text());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers["x-wasmplane-runtime-identity-key-id"], "rt-key");
    assert.equal(
      verifyRuntimeIdentityHeaders({
        method: "PUT",
        path: "/__runtime/snapshots/routes",
        body: calls[0]?.body ?? "",
        headers: calls[0]?.headers ?? {},
        keys: { "rt-key": "runtime-identity-secret" },
      }).ok,
      true,
    );
  } finally {
    await app.close();
  }
});

test("HTTP API proxies runtime worker logs with read scope", async () => {
  const calls: Array<{ url: string; method?: string; authorization?: string }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  control.registerRuntimeNode({ id: "rt_local", url: "http://runtime.local/" });
  const app = createHttpApp({
    controlPlane: control,
    runtimeNodeToken: "runtime-secret",
    apiTokens: [{ token: "read-token", scopes: ["read"], principal: "reader" }],
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.authorization });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            logs: [
              {
                timestamp: fixedNow(),
                requestId: "req_log_1",
                host: "hello.example.dev",
                path: "/",
                projectId: "prj_hello",
                deploymentId: "dep_hello",
                level: "info",
                message: "ok",
              },
            ],
          };
        },
        async text() {
          return "ok";
        },
      };
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/runtime-nodes/rt_local/logs?projectId=prj_hello`, {
      headers: { authorization: "Bearer read-token" },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, {
      runtimeNodeId: "rt_local",
      url: "http://runtime.local",
      logs: [
        {
          timestamp: fixedNow(),
          requestId: "req_log_1",
          host: "hello.example.dev",
          path: "/",
          projectId: "prj_hello",
          deploymentId: "dep_hello",
          level: "info",
          message: "ok",
        },
      ],
    });
    assert.deepEqual(calls, [
      {
        url: "http://runtime.local/__runtime/logs?projectId=prj_hello",
        method: "GET",
        authorization: "Bearer runtime-secret",
      },
    ]);
  } finally {
    await app.close();
  }
});

test("HTTP API registers runtime nodes and publishes snapshots through the registry", async () => {
  const receivedSnapshots: RouteSnapshot[] = [];
  const runtime = await listenRuntimeSnapshotSink(receivedSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const runtimeNode = await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_local",
      url: `${runtime.baseUrl}/`,
    });
    assert.deepEqual(runtimeNode, {
      id: "rt_local",
      url: runtime.baseUrl,
      status: "active",
      registeredAt: fixedNow(),
    });

    const runtimeNodesResponse = await fetch(`${baseUrl}/runtime-nodes`);
    assert.equal(runtimeNodesResponse.status, 200);
    assert.deepEqual(await runtimeNodesResponse.json(), [runtimeNode]);

    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("hello"),
      location: "oci://registry.example.com/mizchi/hello:v1",
      sizeBytes: 42,
    });
    const deployment = await postJson(baseUrl, "/deployments", {
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
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [],
      },
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    const publish = await publishResponse.json();
    assert.equal(publish.ok, true);
    const { attempts, elapsedMs, ...target } = publish.targets[0];
    assert.equal(attempts, 1);
    assert.equal(typeof elapsedMs, "number");
    assert.deepEqual(target, {
      id: "rt_local",
      url: runtime.baseUrl,
      ok: true,
      status: 200,
      routes: 1,
      generatedAt: fixedNow(),
      snapshotId: publish.snapshot.id,
    });
    assert.equal(receivedSnapshots.length, 1);
  } finally {
    await app.close();
    await runtime.close();
  }
});

test("HTTP API updates runtime node lifecycle status and skips draining nodes", async () => {
  const receivedSnapshots: RouteSnapshot[] = [];
  const runtime = await listenRuntimeSnapshotSink(receivedSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_maint", url: runtime.baseUrl });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_maint/heartbeat", {
      version: "wasmplane-runtime/0.1.0",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 2 },
    });

    const drainingResponse = await fetch(`${baseUrl}/runtime-nodes/rt_maint/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "draining" }),
    });
    if (drainingResponse.status !== 200) {
      assert.fail(await drainingResponse.text());
    }
    const draining = await drainingResponse.json();
    assert.equal(draining.status, "draining");
    assert.equal(draining.version, "wasmplane-runtime/0.1.0");
    assert.deepEqual(draining.load, { activeRequests: 2 });

    await createHelloRoute(baseUrl);
    const blockedPublish = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    assert.equal(blockedPublish.status, 400);
    assert.match(await blockedPublish.text(), /no runtime nodes are configured/);
    assert.equal(receivedSnapshots.length, 0);

    const activeResponse = await fetch(`${baseUrl}/runtime-nodes/rt_maint/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    if (activeResponse.status !== 200) {
      assert.fail(await activeResponse.text());
    }

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    assert.equal(receivedSnapshots.length, 1);

    const missingResponse = await fetch(`${baseUrl}/runtime-nodes/rt_missing/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    await app.close();
    await runtime.close();
  }
});

test("HTTP API cleans up old runtime nodes with write scope", async () => {
  let currentNow = "2026-06-26T10:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: () => currentNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [
      { token: "reader", scopes: ["read"], principal: "reader" },
      { token: "writer", scopes: ["write"], principal: "writer" },
    ],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_offline_old", url: "http://runtime-old.local" }, "writer");
    await postJsonOk(baseUrl, "/runtime-nodes/rt_offline_old/heartbeat", { status: "offline" }, "writer");
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_active_old", url: "http://runtime-active.local" }, "writer");
    await postJsonOk(baseUrl, "/runtime-nodes/rt_active_old/heartbeat", { status: "active" }, "writer");

    currentNow = "2026-06-26T11:50:00.000Z";
    await postJson(
      baseUrl,
      "/runtime-nodes",
      { id: "rt_offline_fresh", url: "http://runtime-fresh.local", status: "offline" },
      "writer",
    );

    currentNow = "2026-06-26T12:00:00.000Z";
    const denied = await fetch(`${baseUrl}/runtime-nodes/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader",
        "content-type": "application/json",
      },
      body: JSON.stringify({ olderThanMs: 60 * 60 * 1000 }),
    });
    assert.equal(denied.status, 403);

    const response = await fetch(`${baseUrl}/runtime-nodes/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer writer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ olderThanMs: 60 * 60 * 1000 }),
    });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const cleanup = await response.json();
    assert.equal(cleanup.cutoff, "2026-06-26T11:00:00.000Z");
    assert.deepEqual(cleanup.removed.map((node: any) => node.id), ["rt_offline_old"]);

    const nodesResponse = await fetch(`${baseUrl}/runtime-nodes`, {
      headers: { authorization: "Bearer reader" },
    });
    assert.equal(nodesResponse.status, 200);
    assert.deepEqual(
      (await nodesResponse.json()).map((node: any) => node.id),
      ["rt_active_old", "rt_offline_fresh"],
    );

    const activeCleanupResponse = await fetch(`${baseUrl}/runtime-nodes/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer writer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ olderThanMs: 60 * 60 * 1000, statuses: ["active"] }),
    });
    if (activeCleanupResponse.status !== 200) {
      assert.fail(await activeCleanupResponse.text());
    }
    const activeCleanup = await activeCleanupResponse.json();
    assert.deepEqual(activeCleanup.removed.map((node: any) => node.id), ["rt_active_old"]);
  } finally {
    await app.close();
  }
});

test("HTTP API applies project placement policy to snapshot publish targets", async () => {
  const nrtSnapshots: RouteSnapshot[] = [];
  const iadSnapshots: RouteSnapshot[] = [];
  const nrtRuntime = await listenRuntimeSnapshotSink(nrtSnapshots);
  const iadRuntime = await listenRuntimeSnapshotSink(iadSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimePlacement: {
      projects: {
        prj_place: { regions: ["nrt"], labels: { pool: "default" } },
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_nrt",
      url: nrtRuntime.baseUrl,
      region: "nrt",
      labels: { pool: "default" },
    });
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_iad",
      url: iadRuntime.baseUrl,
      region: "iad",
      labels: { pool: "default" },
    });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_nrt/heartbeat", {
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 1 },
    });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_iad/heartbeat", {
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 1 },
    });

    const project = await postJson(baseUrl, "/projects", { id: "prj_place", name: "placed" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("placed"),
      location: "oci://registry.example.com/mizchi/placed:v1",
      sizeBytes: 42,
    });
    const deployment = await postJson(baseUrl, "/deployments", {
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
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [],
      },
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "placed.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    const publish = await publishResponse.json();
    assert.deepEqual(publish.targets.map((target: any) => target.id), ["rt_nrt"]);
    assert.equal(nrtSnapshots.length, 1);
    assert.equal(iadSnapshots.length, 0);
  } finally {
    await app.close();
    await nrtRuntime.close();
    await iadRuntime.close();
  }
});

test("HTTP API fails over placement targets to fallback regions", async () => {
  const nrtSnapshots: RouteSnapshot[] = [];
  const iadSnapshots: RouteSnapshot[] = [];
  const nrtRuntime = await listenRuntimeSnapshotSink(nrtSnapshots);
  const iadRuntime = await listenRuntimeSnapshotSink(iadSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimePlacement: {
      projects: {
        prj_failover: {
          regions: ["nrt"],
          labels: { pool: "default" },
          failover: [
            { regions: ["iad"], labels: { pool: "default" } },
          ],
        },
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_nrt",
      url: nrtRuntime.baseUrl,
      region: "nrt",
      labels: { pool: "default" },
    });
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_iad",
      url: iadRuntime.baseUrl,
      region: "iad",
      labels: { pool: "default" },
    });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_nrt/heartbeat", {
      status: "offline",
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 0 },
    });
    await postJsonOk(baseUrl, "/runtime-nodes/rt_iad/heartbeat", {
      capacity: { concurrentRequests: 128, memoryMb: 4096 },
      load: { activeRequests: 1 },
    });

    const project = await postJson(baseUrl, "/projects", { id: "prj_failover", name: "failover" });
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("failover"),
      location: "oci://registry.example.com/mizchi/failover:v1",
      sizeBytes: 42,
    });
    const deployment = await postJson(baseUrl, "/deployments", {
      projectId: project.id,
      artifactId: artifact.id,
      world: "myedge:runtime/worker@0.1.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
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
    });
    await putJson(baseUrl, "/routes", {
      projectId: project.id,
      host: "failover.example.dev",
      pathPrefix: "/",
      deploymentId: deployment.id,
    });

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    const publish = await publishResponse.json();

    assert.deepEqual(publish.targets.map((target: any) => target.id), ["rt_iad"]);
    assert.equal(nrtSnapshots.length, 0);
    assert.equal(iadSnapshots.length, 1);
  } finally {
    await app.close();
    await nrtRuntime.close();
    await iadRuntime.close();
  }
});

test("HTTP API records runtime node heartbeat and skips inactive nodes when publishing", async () => {
  const activeSnapshots: RouteSnapshot[] = [];
  const offlineSnapshots: RouteSnapshot[] = [];
  const activeRuntime = await listenRuntimeSnapshotSink(activeSnapshots);
  const offlineRuntime = await listenRuntimeSnapshotSink(offlineSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_active", url: activeRuntime.baseUrl });
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_offline", url: offlineRuntime.baseUrl });
    const heartbeatResponse = await fetch(`${baseUrl}/runtime-nodes/rt_active/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "wasmplane-runtime/0.1.0",
        capacity: { concurrentRequests: 128, memoryMb: 4096 },
      }),
    });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeat = await heartbeatResponse.json();
    const offlineHeartbeatResponse = await fetch(`${baseUrl}/runtime-nodes/rt_offline/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    assert.equal(offlineHeartbeatResponse.status, 200);

    assert.equal(heartbeat.status, "active");
    assert.equal(heartbeat.lastSeenAt, fixedNow());
    assert.equal(heartbeat.version, "wasmplane-runtime/0.1.0");

    await createHelloRoute(baseUrl);

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    assert.equal(publishResponse.status, 200);
    const publish = await publishResponse.json();

    assert.equal(publish.ok, true);
    assert.equal(publish.targets.length, 1);
    assert.equal(publish.targets[0].id, "rt_active");
    assert.equal(activeSnapshots.length, 1);
    assert.equal(offlineSnapshots.length, 0);
  } finally {
    await app.close();
    await activeRuntime.close();
    await offlineRuntime.close();
  }
});

test("HTTP API exposes runtime saturation signals for autoscalers", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  control.registerRuntimeNode({ id: "rt_busy", url: "http://runtime-busy.local" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_busy",
    capacity: { concurrentRequests: 100, memoryMb: 512 },
    load: { activeRequests: 90 },
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [{ token: "read-token", scopes: ["read"], principal: "reader" }],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/autoscaling/signals`, {
      headers: { authorization: "Bearer read-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      signals: [
        {
          id: "rt_busy",
          url: "http://runtime-busy.local",
          status: "active",
          activeRequests: 90,
          concurrentRequests: 100,
          loadRatio: 0.9,
          saturated: false,
        },
      ],
    });
  } finally {
    await app.close();
  }
});

test("HTTP API stores local artifact bytes and creates a file artifact", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "wasmplane-artifacts-"));
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control, artifactStoreDir: artifactDir });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const bytes = Buffer.from("component bytes");
    const artifact = await postJson(baseUrl, "/artifacts/local", {
      projectId: project.id,
      bytesBase64: bytes.toString("base64"),
    });

    assert.equal(artifact.projectId, project.id);
    assert.equal(artifact.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.equal(artifact.sizeBytes, bytes.byteLength);
    assert.equal(new URL(artifact.location).protocol, "file:");
    assert.deepEqual(await readFile(fileURLToPath(artifact.location)), bytes);
  } finally {
    await app.close();
  }
});

test("HTTP API local artifact upload is idempotent for the same project and digest", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "wasmplane-artifacts-"));
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control, artifactStoreDir: artifactDir });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const bytes = Buffer.from("component bytes");
    const first = await postJson(baseUrl, "/artifacts/local", {
      id: "art_first",
      projectId: project.id,
      bytesBase64: bytes.toString("base64"),
    });
    const secondResponse = await fetch(`${baseUrl}/artifacts/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "art_second",
        projectId: project.id,
        bytesBase64: bytes.toString("base64"),
      }),
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();

    assert.equal(second.id, first.id);
    assert.equal(second.digest, first.digest);
    assert.equal(second.location, first.location);
    assert.deepEqual(await readFile(fileURLToPath(second.location)), bytes);
  } finally {
    await app.close();
  }
});

test("HTTP API can expose local artifact bytes through an HTTP artifact URL", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "wasmplane-artifacts-"));
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    artifactStoreDir: artifactDir,
    artifactPublicBaseUrl: "auto",
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const bytes = Buffer.from("component bytes");
    const artifact = await postJson(baseUrl, "/artifacts/local", {
      projectId: project.id,
      bytesBase64: bytes.toString("base64"),
    });

    assert.equal(artifact.location.startsWith(`${baseUrl}/artifacts/local/`), true);
    const artifactResponse = await fetch(artifact.location);
    assert.equal(artifactResponse.status, 200);
    assert.equal(artifactResponse.headers.get("content-type"), "application/wasm");
    assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), bytes);
  } finally {
    await app.close();
  }
});

test("HTTP API validates local artifact bytes before creating artifacts", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "wasmplane-artifacts-"));
  const validatorCalls: string[] = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    artifactStoreDir: artifactDir,
    artifactValidator: {
      async validate(input) {
        validatorCalls.push(input.path);
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const artifact = await postJson(baseUrl, "/artifacts/local", {
      projectId: project.id,
      bytesBase64: Buffer.from("component bytes").toString("base64"),
    });

    assert.equal(validatorCalls.length, 1);
    assert.equal(validatorCalls[0], fileURLToPath(artifact.location));
  } finally {
    await app.close();
  }
});

test("HTTP API rejects local artifacts that fail validation", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "wasmplane-artifacts-"));
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    artifactStoreDir: artifactDir,
    artifactValidator: {
      async validate() {
        throw new Error("not a component");
      },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { name: "hello" });
    const response = await fetch(`${baseUrl}/artifacts/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        bytesBase64: Buffer.from("bad component").toString("base64"),
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /not a component/);
  } finally {
    await app.close();
  }
});

test("HTTP API exposes route snapshot publication history", async () => {
  const receivedSnapshots: RouteSnapshot[] = [];
  const runtime = await listenRuntimeSnapshotSink(receivedSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await postJson(baseUrl, "/runtime-nodes", { id: "rt_local", url: runtime.baseUrl });
    await createHelloRoute(baseUrl);

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    assert.equal(publishResponse.status, 200);
    const publish = await publishResponse.json();

    const historyResponse = await fetch(`${baseUrl}/snapshots/routes/publishes`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();

    assert.equal(publish.publicationId, "pub_5");
    assert.equal(history.length, 1);
    assert.equal(history[0].id, publish.publicationId);
    assert.equal(history[0].snapshotId, publish.snapshot.id);
    assert.equal(history[0].ok, true);
    assert.equal(history[0].routes, 1);
    assert.equal(history[0].targets[0].id, "rt_local");
  } finally {
    await app.close();
    await runtime.close();
  }
});

test("HTTP API retries snapshot publishes and records attempt counts", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimeNodes: [{ id: "rt_retry", url: "http://runtime.local" }],
    snapshotPublish: {
      maxAttempts: 3,
      retryDelayMs: 0,
      nowMs: () => calls.length * 10,
    },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
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
          return { routes: 1, generatedAt: fixedNow(), snapshotId: "snap_retry" };
        },
        async text() {
          return "ok";
        },
      };
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await createHelloRoute(baseUrl);
    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    const publish = await publishResponse.json();
    const history = await (await fetch(`${baseUrl}/snapshots/routes/publishes`)).json();

    assert.equal(calls.length, 2);
    assert.equal(publish.ok, true);
    assert.equal(publish.targets[0].attempts, 2);
    assert.equal(history[0].targets[0].attempts, 2);
    assert.equal(history[0].targets[0].status, 200);
  } finally {
    await app.close();
  }
});

async function postJson(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    assert.fail(await response.text());
  }
  return await response.json();
}

async function postJsonOk(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return await response.json();
}

function jsonHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function putJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return await response.json();
}

async function createHelloRoute(baseUrl: string) {
  const project = await postJson(baseUrl, "/projects", { name: "hello" });
  const artifact = await postJson(baseUrl, "/artifacts", {
    projectId: project.id,
    digest: digest(`hello-${project.id}`),
    location: "oci://registry.example.com/mizchi/hello:v1",
    sizeBytes: 42,
  });
  const deployment = await postJson(baseUrl, "/deployments", {
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
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
    },
  });
  await putJson(baseUrl, "/routes", {
    projectId: project.id,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  return { project, artifact, deployment };
}

function sequenceIds() {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}

function fixedNow() {
  return "2026-06-26T10:00:00.000Z";
}

async function listenRuntimeSnapshotSink(receivedSnapshots: RouteSnapshot[]) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://runtime.local");
    if (request.method !== "PUT" || url.pathname !== "/__runtime/snapshots/routes") {
      response.writeHead(404).end();
      return;
    }
    const snapshot = await readJson<RouteSnapshot>(request);
    receivedSnapshots.push(snapshot);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        ok: true,
        routes: snapshot.routes.length,
        generatedAt: snapshot.generatedAt,
      }),
    );
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

async function readJson<T>(request: any): Promise<T> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
