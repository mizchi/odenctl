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

function snapshot(routes: RouteSnapshot["routes"]): RouteSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes,
  };
}

function route(
  deploymentId: string,
  host: string,
  pathPrefix: string,
  artifactDigest: string,
): RouteSnapshot["routes"][number] {
  return {
    host,
    pathPrefix,
    projectId: "prj_hello",
    deploymentId,
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
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
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      id: `art_${deploymentId}`,
      digest: artifactDigest,
      location: "file:///tmp/worker.component.wasm",
    },
  };
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
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
