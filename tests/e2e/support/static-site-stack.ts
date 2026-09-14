import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { createMemoryRepository } from "../../../src/control-plane/repository.ts";
import { createControlPlane } from "../../../src/control-plane/service.ts";
import { createWasip3HostArtifactValidator } from "../../../src/control-plane/artifact-validation.ts";
import { createHttpApp } from "../../../src/http/app.ts";
import { createRuntimeNodeApp } from "../../../src/runtime/node-app.ts";
import { createRuntimeArtifactStore } from "../../../src/runtime/artifacts.ts";
import { createRuntimeSupervisor } from "../../../src/runtime/supervisor.ts";
import {
  createWasip3HostBackend,
  createWasip3HostDaemonInvoker,
} from "../../../src/runtime/wasip3-host.ts";
import { startServiceProcess } from "../../../src/service-process.ts";

const exec = promisify(execFile);
type RequestOptions = Parameters<APIRequestContext["fetch"]>[1];
interface Release {
  artifactId: string;
  deploymentId: string;
  routeId: string;
  published: boolean;
}

export async function startStaticSiteStack() {
  const directory = await mkdtemp(join(tmpdir(), "odenctl-static-site-"));
  const cleanups: Array<() => Promise<unknown>> = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "static site stack cleanup failed");
    }
  }
  try {
    const hostBin = resolve(
      process.env.ODEN_WASIP3_HOST_BIN ??
        "target/debug/oden-host",
    );
    const api = await playwrightRequest.newContext();
    cleanups.push(() => api.dispose());
    const adminToken = randomUUID();
    const controlToken = randomUUID();
    const control = createHttpApp({
      controlPlane: createControlPlane({
        repository: createMemoryRepository(),
      }),
      apiToken: controlToken,
      runtimeNodeToken: adminToken,
      artifactStoreDir: join(directory, "uploaded"),
      artifactPublicBaseUrl: "auto",
      artifactValidator: createWasip3HostArtifactValidator({ hostBin }),
      snapshotPublish: { maxAttempts: 1, timeoutMs: 30_000 },
    });
    const controlServer = await control.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => control.close());
    const controlAddress = controlServer.address();
    assert(controlAddress && typeof controlAddress === "object");
    const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
    const controlRequest = (
      path: string,
      data: unknown,
      authenticated = true,
    ) =>
      api.post(controlUrl + path, {
        data,
        headers: authenticated
          ? { authorization: `Bearer ${controlToken}` }
          : {},
      });
    async function post(path: string, data: unknown) {
      const response = await controlRequest(path, data);
      assert(
        response.ok(),
        `${path}: ${response.status()} ${await response.text()}`,
      );
      return response.json();
    }
    const project = await post("/projects", { name: "static-site-e2e" });
    const daemon = await startServiceProcess(hostBin, [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    cleanups.push(async () => {
      const result = await daemon.stop();
      assert(
        !result.forced && !result.pidAlive,
        "host daemon failed to stop cleanly",
      );
    });
    const supervisor = createRuntimeSupervisor({
      snapshot: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        routes: [],
      },
      artifactStore: createRuntimeArtifactStore({
        cacheDir: join(directory, "downloaded"),
      }),
      backend: createWasip3HostBackend({
        hostBin,
        cacheDir: join(directory, "compiled"),
      }),
    });
    const runtime = createRuntimeNodeApp({
      supervisor,
      managementToken: adminToken,
      warmupOnSnapshot: true,
      invoker: createWasip3HostDaemonInvoker({ url: daemon.url }),
      responseCache: {
        maxBytes: 8 * 1024 * 1024,
        maxEntryBytes: 1024 * 1024,
        maxEntries: 128,
        maxPending: 32,
        rules: [{
          projectId: project.id,
          host: "static.example.local",
          pathPrefix: "/",
          maxTtlSeconds: 300,
          varyHeaders: [],
        }],
      },
    });
    const runtimeServer = await runtime.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => runtime.close());
    const address = runtimeServer.address();
    assert(address && typeof address === "object");
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    await post("/runtime-nodes", {
      id: "static-site-runtime",
      url: runtimeUrl,
    });
    const siteHeaders = { "x-forwarded-host": "static.example.local" };
    const runtimeRequest = (path: string, options: RequestOptions = {}) =>
      api.fetch(runtimeUrl + path, options);
    const get = (path: string, options: RequestOptions = {}) =>
      runtimeRequest(path, {
        ...options,
        headers: { ...siteHeaders, ...options?.headers },
      });
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    return {
      projectId: project.id as string,
      runtimeUrl,
      siteHeaders,
      get,
      controlRequest,
      runtimeRequest,
      close,
      async deploy(version: "v1" | "v2"): Promise<Release> {
        // Exercise the real CLI, upload endpoint, artifact validation, deployment,
        // route update and authenticated publication. No service methods are mocked.
        const result = await exec(process.execPath, [
          "--experimental-strip-types",
          resolve("src/cli.ts"),
          "deploy",
          "--project-id",
          project.id,
          "--component",
          resolve(`examples/static-site/target/site-${version}.wasm`),
          "--host",
          "static.example.local",
          "--runtime-version",
          "wasmtime-48.0.2",
          "--limit",
          "cpuMs=5000",
          "--limit",
          "wallMs=10000",
        ], {
          env: {
            ...process.env,
            ODENCTL_CONTROL_PLANE_URL: controlUrl,
            ODENCTL_CONTROL_PLANE_TOKEN: controlToken,
          },
          timeout: 45_000,
        });
        const release: Release = JSON.parse(result.stdout);
        assert.equal(release.published, true, result.stdout);
        const snapshot =
          await (await api.get(controlUrl + "/snapshots/routes", {
            headers: { authorization: `Bearer ${controlToken}` },
          })).json();
        // This verifies delivery through the artifact HTTP endpoint, not a shared input file.
        assert(
          snapshot.routes[0].artifact.location.startsWith(
            controlUrl + "/artifacts/local/",
          ),
        );
        return release;
      },
      async rollback(deploymentId: string) {
        await post("/routes/rollback", {
          projectId: project.id,
          host: "static.example.local",
          pathPrefix: "/",
          deploymentId,
        });
        const report = await post("/snapshots/routes/publish", {});
        assert.equal(report.ok, true);
        assert.equal(report.targets.length, 1);
        assert.equal(report.targets[0].ok, true);
      },
      async metrics() {
        return (await runtimeRequest("/__runtime/metrics", {
          headers: adminHeaders,
        })).json();
      },
      async purge() {
        const response = await runtimeRequest(
          "/__runtime/response-cache/purge",
          {
            method: "POST",
            headers: adminHeaders,
            data: { projectId: project.id },
          },
        );
        assert(response.ok(), await response.text());
        return response.json();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
