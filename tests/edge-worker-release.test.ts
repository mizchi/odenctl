import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createCloudflareWorkersApiDeployer,
  renderCloudflareWasmWorkerModule,
} from "../src/control-plane/edge-worker-deployer.ts";
import { edgeWorkerDeployerFromEnv } from "../src/control-plane/database.ts";
import { createMemoryRepository, createSqliteRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createHttpApp } from "../src/http/app.ts";

test("control plane records a mock Cloudflare Workers release for a wasm deployment", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const { project, artifact, deployment } = seedDeployment(control);

  const release = await control.createEdgeWorkerRelease({
    projectId: project.id,
    deploymentId: deployment.id,
    scriptName: "wasmplane-prj-edge",
  });

  assert.equal(release.id, "ewr_1");
  assert.equal(release.projectId, project.id);
  assert.equal(release.deploymentId, deployment.id);
  assert.equal(release.provider, "cloudflare-workers");
  assert.equal(release.mode, "mock");
  assert.equal(release.status, "active");
  assert.equal(release.scriptName, "wasmplane-prj-edge");
  assert.equal(release.versionId, "mock-ver-ewr_1");
  assert.equal(release.externalDeploymentId, "mock-dep-ewr_1");
  assert.equal(release.url, "https://wasmplane-prj-edge.workers.dev");
  assert.equal(release.artifact.digest, artifact.digest);
  assert.match(release.scriptModule, /__wasmplane\/manifest/);
  assert.match(release.scriptModule, new RegExp(artifact.digest));
  assert.equal(release.scriptDigest, digest(release.scriptModule));
  assert.deepEqual(control.listProjectEdgeWorkerReleases({ projectId: project.id }), [release]);
});

test("control plane reads and soft-deletes edge worker releases with provider cleanup", async () => {
  const deleted: any[] = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    edgeWorkerDeployer: {
      deploy(input: any) {
        return {
          provider: "cloudflare-workers",
          mode: "mock",
          scriptName: input.scriptName,
          scriptDigest: digest(input.scriptModule),
          scriptModule: input.scriptModule,
          versionId: "mock-version",
        };
      },
      delete(input: any) {
        deleted.push(input);
        return {
          provider: "cloudflare-workers",
          mode: "mock",
          scriptName: input.scriptName,
          deleted: true,
        };
      },
    },
  });
  const { project, deployment } = seedDeployment(control);
  const release = await control.createEdgeWorkerRelease({
    projectId: project.id,
    deploymentId: deployment.id,
    scriptName: "wasmplane-delete-edge",
  });

  assert.deepEqual(control.getEdgeWorkerRelease({ id: release.id }), release);
  const deletedRelease = await control.deleteEdgeWorkerRelease({
    id: release.id,
    deleteProvider: true,
    forceProviderDelete: true,
  });

  assert.deepEqual(deleted, [
    { releaseId: release.id, scriptName: "wasmplane-delete-edge", force: true },
  ]);
  assert.equal(deletedRelease.status, "deleted");
  assert.equal(deletedRelease.deletedAt, fixedNow());
  assert.equal(control.getEdgeWorkerRelease({ id: release.id }).status, "deleted");
  assert.deepEqual(control.listProjectEdgeWorkerReleases({ projectId: project.id }), [deletedRelease]);
});

test("edge worker release rejects deployments from another project", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const { deployment } = seedDeployment(control);
  const other = control.createProject({ id: "prj_other", name: "other" });

  await assert.rejects(
    async () =>
      control.createEdgeWorkerRelease({
        projectId: other.id,
        deploymentId: deployment.id,
        scriptName: "wasmplane-other",
      }),
    /edge worker release deployment must belong to the same project/,
  );
});

test("HTTP API creates and lists edge worker releases", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const { project, deployment } = seedDeployment(control);
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${baseUrl}/edge-workers/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        deploymentId: deployment.id,
        scriptName: "wasmplane-http-edge",
      }),
    });
    assert.equal(createResponse.status, 201);
    const release = await createResponse.json();
    assert.equal(release.scriptName, "wasmplane-http-edge");
    assert.equal(release.mode, "mock");

    const listResponse = await fetch(`${baseUrl}/projects/${project.id}/edge-worker-releases`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [release]);
  } finally {
    await app.close();
  }
});

test("HTTP API reads and deletes edge worker releases with publish scope", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const { project, deployment } = seedDeployment(control);
  const release = await control.createEdgeWorkerRelease({
    projectId: project.id,
    deploymentId: deployment.id,
    scriptName: "wasmplane-http-delete-edge",
  });
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [
      { token: "read-token", scopes: ["read"], principal: "reader" },
      { token: "write-token", scopes: ["write"], principal: "writer" },
      { token: "publish-token", scopes: ["publish"], principal: "publisher" },
    ],
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const detailResponse = await fetch(`${baseUrl}/edge-workers/releases/${release.id}`, {
      headers: { authorization: "Bearer read-token" },
    });
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(await detailResponse.json(), release);

    const denied = await fetch(`${baseUrl}/edge-workers/releases/${release.id}?provider=1`, {
      method: "DELETE",
      headers: { authorization: "Bearer write-token" },
    });
    assert.equal(denied.status, 403);

    const deletedResponse = await fetch(`${baseUrl}/edge-workers/releases/${release.id}?provider=1`, {
      method: "DELETE",
      headers: { authorization: "Bearer publish-token" },
    });
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.deletedAt, fixedNow());
  } finally {
    await app.close();
  }
});

test("SQLite repository persists edge worker releases across control-plane instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-edge-worker-release-"));
  const dbPath = join(dir, "control.sqlite");
  const control = createControlPlane({
    repository: createSqliteRepository(dbPath),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const { project, deployment } = seedDeployment(control);

  const release = await control.createEdgeWorkerRelease({
    projectId: project.id,
    deploymentId: deployment.id,
    scriptName: "wasmplane-sqlite-edge",
  });

  const reopened = createControlPlane({
    repository: createSqliteRepository(dbPath),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  assert.deepEqual(reopened.listProjectEdgeWorkerReleases({ projectId: project.id }), [release]);
});

test("Cloudflare API deployer uploads the generated worker through the script upload API", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deployer = createCloudflareWorkersApiDeployer({
    accountId: "acc_123",
    apiToken: "token_123",
    workersDevSubdomain: "example",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        success: true,
        result: {
          id: "script_upload_123",
          version_id: "version_123",
          deployment_id: "deployment_123",
        },
      });
    },
  });
  const scriptModule = renderCloudflareWasmWorkerModule({
    releaseId: "ewr_api",
    scriptName: "wasmplane-api-edge",
    projectId: "prj_api",
    deploymentId: "dep_api",
    artifact: {
      id: "art_api",
      digest: digest("artifact"),
      location: "https://artifacts.example.com/worker.wasm",
    },
    createdAt: fixedNow(),
  });

  const result = await deployer.deploy({
    releaseId: "ewr_api",
    scriptName: "wasmplane-api-edge",
    projectId: "prj_api",
    deploymentId: "dep_api",
    artifact: {
      id: "art_api",
      digest: digest("artifact"),
      location: "https://artifacts.example.com/worker.wasm",
    },
    createdAt: fixedNow(),
    scriptModule,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/acc_123/workers/scripts/wasmplane-api-edge",
  );
  assert.equal(calls[0].init.method, "PUT");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer token_123");
  assert.ok(calls[0].init.body instanceof FormData);
  const form = calls[0].init.body as FormData;
  const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
  assert.deepEqual(metadata, {
    main_module: "wasmplane-api-edge.mjs",
    compatibility_date: "2026-07-03",
    bindings: [
      { type: "plain_text", name: "WASMPLANE_RELEASE_ID", text: "ewr_api" },
      { type: "plain_text", name: "WASMPLANE_PROJECT_ID", text: "prj_api" },
      { type: "plain_text", name: "WASMPLANE_DEPLOYMENT_ID", text: "dep_api" },
      { type: "plain_text", name: "WASMPLANE_ARTIFACT_DIGEST", text: digest("artifact") },
    ],
  });
  assert.equal(result.mode, "api");
  assert.equal(result.versionId, "version_123");
  assert.equal(result.externalDeploymentId, "deployment_123");
  assert.equal(result.url, "https://wasmplane-api-edge.example.workers.dev");
});

test("Cloudflare API deployer deletes generated workers through the script API", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deployer = createCloudflareWorkersApiDeployer({
    accountId: "acc_123",
    apiToken: "token_123",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ success: true, result: {} });
    },
  });

  const result = await deployer.delete?.({
    releaseId: "ewr_api",
    scriptName: "wasmplane-api-edge",
    force: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/acc_123/workers/scripts/wasmplane-api-edge?force=true",
  );
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer token_123");
  assert.deepEqual(result, {
    provider: "cloudflare-workers",
    mode: "api",
    scriptName: "wasmplane-api-edge",
    deleted: true,
  });
});

test("configured edge worker deployer supports mock mode and validates Cloudflare API credentials", async () => {
  const deployer = edgeWorkerDeployerFromEnv({
    WASMPLANE_EDGE_WORKER_DEPLOYER: "mock",
    WASMPLANE_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: "preview",
  });
  assert.ok(deployer);
  const scriptModule = renderCloudflareWasmWorkerModule({
    releaseId: "ewr_mock",
    scriptName: "wasmplane-env-edge",
    projectId: "prj_env",
    deploymentId: "dep_env",
    artifact: {
      id: "art_env",
      digest: digest("env"),
      location: "https://artifacts.example.com/env.component.wasm",
    },
    createdAt: fixedNow(),
  });
  const result = await deployer.deploy({
    releaseId: "ewr_mock",
    scriptName: "wasmplane-env-edge",
    projectId: "prj_env",
    deploymentId: "dep_env",
    artifact: {
      id: "art_env",
      digest: digest("env"),
      location: "https://artifacts.example.com/env.component.wasm",
    },
    createdAt: fixedNow(),
    scriptModule,
  });
  assert.equal(result.mode, "mock");
  assert.equal(result.url, "https://wasmplane-env-edge.preview.workers.dev");

  assert.throws(
    () => edgeWorkerDeployerFromEnv({ WASMPLANE_EDGE_WORKER_DEPLOYER: "cloudflare-api" }),
    /Cloudflare edge worker deployer requires/,
  );
});

function seedDeployment(control: any) {
  const project = control.createProject({ id: "prj_edge", name: "edge" });
  const artifact = control.createArtifact({
    id: "art_edge",
    projectId: project.id,
    digest: digest("edge"),
    location: "https://artifacts.example.com/edge.component.wasm",
    sizeBytes: 128,
  });
  const deployment = control.createDeployment({
    id: "dep_edge",
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
      durableObjects: [],
      secrets: [],
      services: [],
    },
  });
  return { project, artifact, deployment };
}

function sequenceIds() {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}

function fixedNow() {
  return "2026-07-03T00:00:00.000Z";
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
