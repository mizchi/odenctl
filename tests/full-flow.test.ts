import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createHttpApp } from "../src/http/app.ts";
import { createFileArtifactStore } from "../src/runtime/artifacts.ts";
import { createRuntimeNodeApp } from "../src/runtime/node-app.ts";
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
          cpuMs: 50,
          memoryMb: 64,
          wallMs: 10000,
          subrequests: 20,
          responseBytes: 1048576,
        },
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [],
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
    } finally {
      await controlApp.close();
      await runtimeApp.close();
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
