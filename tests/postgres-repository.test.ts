import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAsyncControlPlane } from "../src/control-plane/async-service.ts";
import { createPostgresRepository } from "../src/control-plane/postgres-repository.ts";

test("Postgres repository module loads with the pg runtime dependency", async () => {
  assert.equal(typeof createPostgresRepository, "function");
});

test(
  "Postgres repository persists the core control-plane flow",
  { skip: process.env.WASMPLANE_POSTGRES_TEST_URL ? false : "set WASMPLANE_POSTGRES_TEST_URL to run" },
  async () => {
    const repository = await createPostgresRepository({
      connectionString: process.env.WASMPLANE_POSTGRES_TEST_URL as string,
      ssl: process.env.WASMPLANE_POSTGRES_SSL === "1",
    });
    const suffix = randomUUID().replaceAll("-", "");
    const control = createAsyncControlPlane({
      repository,
      idGenerator: sequenceIds(suffix),
      now: fixedNow,
    });

    try {
      const project = await control.createProject({ name: `pg-${suffix}` });
      const artifact = await control.createArtifact({
        projectId: project.id,
        digest: digest(`pg-${suffix}`),
        location: `oci://registry.example.com/mizchi/pg:${suffix}`,
        sizeBytes: 42,
      });
      const deployment = await control.createDeployment({
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
      await control.pointRoute({
        projectId: project.id,
        host: `${suffix}.example.dev`,
        pathPrefix: "/",
        deploymentId: deployment.id,
      });

      const snapshot = await control.createRouteSnapshot();
      assert.equal(snapshot.routes.some((route) => route.deploymentId === deployment.id), true);
    } finally {
      await repository.close();
    }
  },
);

function sequenceIds(suffix: string) {
  let next = 1;
  return (prefix: string) => `${prefix}_${suffix}_${next++}`;
}

function fixedNow() {
  return "2026-06-30T10:00:00.000Z";
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
