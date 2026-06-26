import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
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
