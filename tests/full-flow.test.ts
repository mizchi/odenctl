import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createHttpApp } from "../src/http/app.ts";
import { createFileArtifactStore } from "../src/runtime/artifacts.ts";
import { createRuntimeNodeApp } from "../src/runtime/node-app.ts";
import { createMemorySecretStore } from "../src/runtime/secrets.ts";
import { createRuntimeSupervisor } from "../src/runtime/supervisor.ts";
import { createWasip3HostBackend, createWasip3HostInvoker } from "../src/runtime/wasip3-host.ts";

const componentPath = process.env.WASMPLANE_E2E_COMPONENT;

test(
  "control plane publishes a real component route and runtime invokes it through wasmtime",
  { skip: componentPath ? false : "set WASMPLANE_E2E_COMPONENT to run the real Wasm E2E" },
  async () => {
    const absoluteComponentPath = resolve(requiredEnv("WASMPLANE_E2E_COMPONENT"));
    const hostBin = process.env.WASMPLANE_E2E_HOST_BIN ?? "target/debug/wasmplane-wasip3-host";
    const cacheDir = await mkdtemp(join(tmpdir(), "wasmplane-e2e-cache-"));
    const digest = await sha256File(absoluteComponentPath);
    const upstream = await listenUpstream();

    const runtimeApp = createRuntimeNodeApp({
      supervisor: createRuntimeSupervisor({
        snapshot: {
          schemaVersion: 1,
          generatedAt: fixedNow(),
          routes: [],
        },
        artifactStore: createFileArtifactStore(),
        backend: createWasip3HostBackend({ cacheDir, hostBin }),
      }),
      invoker: createWasip3HostInvoker({ hostBin }),
      secretStore: createMemorySecretStore({ sec_api_key: "super-secret" }),
    });
    const runtimeServer = await runtimeApp.listen({ port: 0, host: "127.0.0.1" });
    const runtimeAddress = runtimeServer.address();
    assert.equal(typeof runtimeAddress, "object");
    assert.ok(runtimeAddress && "port" in runtimeAddress);
    const runtimeBaseUrl = `http://127.0.0.1:${runtimeAddress.port}`;

    const control = createControlPlane({
      repository: createMemoryRepository(),
      idGenerator: sequenceIds(),
      now: fixedNow,
    });
    const controlApp = createHttpApp({ controlPlane: control });
    const controlServer = await controlApp.listen({ port: 0, host: "127.0.0.1" });
    const controlAddress = controlServer.address();
    assert.equal(typeof controlAddress, "object");
    assert.ok(controlAddress && "port" in controlAddress);
    const controlBaseUrl = `http://127.0.0.1:${controlAddress.port}`;

    try {
      await postJson(controlBaseUrl, "/runtime-nodes", {
        id: "local-runtime",
        url: runtimeBaseUrl,
      });
      const project = await postJson(controlBaseUrl, "/projects", { name: "hello" });
      const artifact = await postJson(controlBaseUrl, "/artifacts", {
        projectId: project.id,
        digest,
        location: pathToFileURL(absoluteComponentPath).href,
        sizeBytes: (await readFile(absoluteComponentPath)).byteLength,
      });
      await postJson(controlBaseUrl, "/secrets", {
        id: "sec_api_key",
        projectId: project.id,
        name: "API key",
        value: "super-secret",
      });
      await postJson(controlBaseUrl, "/kv-namespaces", {
        id: "kv_main",
        projectId: project.id,
        name: "Main KV",
      });
      await postJson(controlBaseUrl, "/durable-object-namespaces", {
        id: "do_rooms",
        projectId: project.id,
        name: "Rooms",
      });
      const deployment = await postJson(controlBaseUrl, "/deployments", {
        projectId: project.id,
        artifactId: artifact.id,
        world: "myedge:runtime/worker@0.1.0",
        runtime: {
          backend: "wasmtime",
          version: "wasmtime-42",
          wasi: "wasip3",
        },
        limits: {
          cpuMs: 1000,
          memoryMb: 64,
          wallMs: 10000,
          requestBytes: 1048576,
          subrequests: 20,
          hostCalls: 100,
          responseBytes: 1048576,
        },
        capabilities: {
          outboundHttp: { enabled: true, allow: [`${upstream.baseUrl}/`] },
          kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
          durableObjects: [{ binding: "ROOMS", namespaceId: "do_rooms" }],
          secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
        },
      });
      await putJson(controlBaseUrl, "/routes", {
        projectId: project.id,
        host: "hello.example.dev",
        pathPrefix: "/",
        deploymentId: deployment.id,
      });

      const publish = await postJson(controlBaseUrl, "/snapshots/routes/publish", {});
      assert.equal(publish.ok, true);
      assert.equal(publish.targets[0]?.ok, true);
      assert.equal(publish.targets[0]?.routes, 1);

      const response = await fetch(`${runtimeBaseUrl}/`, {
        headers: { "x-forwarded-host": "hello.example.dev" },
      });
      if (response.status !== 200) {
        assert.fail(await response.text());
      }
      assert.equal(response.headers.get("x-wasmplane-deployment"), deployment.id);
      assert.equal(await response.text(), "hello from wasmplane: GET http://hello.example.dev/");

      const capabilityResponse = await fetch(`${runtimeBaseUrl}/capabilities`, {
        headers: {
          "x-forwarded-host": "hello.example.dev",
          "x-upstream-url": `${upstream.baseUrl}/probe`,
        },
      });
      if (capabilityResponse.status !== 200) {
        assert.fail(await capabilityResponse.text());
      }
      assert.equal(
        await capabilityResponse.text(),
        "capabilities: kv=checked durable=checked/deleted=false secret-len=12 outbound=upstream-ok",
      );
    } finally {
      await controlApp.close();
      await runtimeApp.close();
      await upstream.close();
    }
  },
);

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) {
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
  if (response.status < 200 || response.status >= 300) {
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function sha256File(path: string): Promise<string> {
  const body = await readFile(path);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

async function listenUpstream() {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/probe") {
      response.writeHead(404, { "content-type": "text/plain", "content-length": "9" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "content-length": "11" });
    response.end("upstream-ok");
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
