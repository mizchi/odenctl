import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RouteSnapshot } from "../src/control-plane/contracts.ts";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createHttpApp } from "../src/http/app.ts";

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
        subrequests: 20,
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
        subrequests: 20,
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
    assert.equal(publish.snapshot.routes, 1);
    assert.equal(publish.snapshot.generatedAt, fixedNow());
    assert.equal(publish.targets.length, 1);
    assert.deepEqual(publish.targets[0], {
      id: "local-runtime",
      url: runtime.baseUrl,
      ok: true,
      status: 200,
      routes: 1,
      generatedAt: fixedNow(),
    });

    assert.equal(receivedSnapshots.length, 1);
    assert.equal(receivedSnapshots[0]?.routes[0]?.host, "hello.example.dev");
    assert.equal(receivedSnapshots[0]?.routes[0]?.deploymentId, deployment.id);
  } finally {
    await app.close();
    await runtime.close();
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
        subrequests: 20,
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
    assert.deepEqual(publish.targets[0], {
      id: "rt_local",
      url: runtime.baseUrl,
      ok: true,
      status: 200,
      routes: 1,
      generatedAt: fixedNow(),
    });
    assert.equal(receivedSnapshots.length, 1);
  } finally {
    await app.close();
    await runtime.close();
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
    assert.equal(history[0].ok, true);
    assert.equal(history[0].routes, 1);
    assert.equal(history[0].targets[0].id, "rt_local");
  } finally {
    await app.close();
    await runtime.close();
  }
});

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    assert.fail(await response.text());
  }
  return await response.json();
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
      subrequests: 20,
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

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
