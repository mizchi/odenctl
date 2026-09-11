import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAsyncControlPlane } from "../src/control-plane/async-service.ts";
import {
  createPostgresPoolConfig,
  createPostgresRepository,
} from "../src/control-plane/postgres-repository.ts";

test("Postgres repository module loads with the pg runtime dependency", async () => {
  assert.equal(typeof createPostgresRepository, "function");
});

test("Postgres pool config lets explicit ssl options override URL sslmode", () => {
  assert.deepEqual(
    createPostgresPoolConfig({
      connectionString: "postgres://user:secret@db.example/wasmplane?application_name=wasmplane&sslmode=require",
      ssl: true,
      max: 3,
    }),
    {
      connectionString: "postgres://user:secret@db.example/wasmplane?application_name=wasmplane",
      max: 3,
      ssl: { rejectUnauthorized: false },
    },
  );
  assert.deepEqual(
    createPostgresPoolConfig({
      connectionString: "postgres://user:secret@db.example/wasmplane?sslmode=require",
      ssl: false,
    }),
    {
      connectionString: "postgres://user:secret@db.example/wasmplane",
      max: 10,
      ssl: false,
    },
  );
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
      const organization = await control.createOrganization({
        id: `org_${suffix}`,
        name: `pg-org-${suffix}`,
      });
      const project = await control.createProject({
        name: `pg-${suffix}`,
        organizationId: organization.id,
      });
      const key = await control.createApiKey({
        id: `key_${suffix}`,
        projectId: project.id,
        name: "pg key",
        scopes: ["read", "write"],
      });
      const artifact = await control.createArtifact({
        projectId: project.id,
        digest: digest(`pg-${suffix}`),
        location: `oci://registry.example.com/mizchi/pg:${suffix}`,
        sizeBytes: 42,
      });
      const deployment = await control.createDeployment({
        projectId: project.id,
        artifactId: artifact.id,
        world: "wasi:http/service@0.3.0",
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
          responseBytes: 1048576,
        },
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [],
        },
      });
      const edgeRelease = await control.createEdgeWorkerRelease({
        id: `ewr_${suffix}`,
        projectId: project.id,
        deploymentId: deployment.id,
        provider: "cloudflare-workers",
        mode: "mock",
        scriptName: `wasmplane-pg-${suffix}`,
      });
      await control.pointRoute({
        projectId: project.id,
        host: `${suffix}.example.dev`,
        pathPrefix: "/",
        deploymentId: deployment.id,
      });
      const preview = await control.createDeployPreview({
        id: `prv_${suffix}`,
        projectId: project.id,
        deploymentId: deployment.id,
        host: `${suffix}.preview.example.dev`,
        environment: { FEATURE_FLAG: "on" },
      });
      const customDomain = await control.createCustomDomain({
        id: `dom_${suffix}`,
        projectId: project.id,
        host: `${suffix}.custom.example.dev`,
      });
      await control.verifyCustomDomainOwnership({
        id: customDomain.id,
        txtRecords: [customDomain.verificationRecordValue],
      });
      await control.requestCustomDomainTlsProvisioning({
        id: customDomain.id,
        provider: "test",
        requestId: `cert_${suffix}`,
      });
      await control.completeCustomDomainTlsProvisioning({
        id: customDomain.id,
        ok: true,
        provider: "test",
        requestId: `cert_${suffix}`,
      });
      await control.recordUsageEvent({
        id: `use_${suffix}`,
        projectId: project.id,
        metric: "invocation",
        quantity: 1,
      });

      const snapshot = await control.createRouteSnapshot();
      assert.equal(snapshot.routes.some((route) => route.deploymentId === deployment.id), true);
      assert.equal((await control.authenticateApiToken({ token: key.token }))?.apiKeyId, key.apiKey.id);
      assert.equal(
        (await control.getProjectUsageSummary({ projectId: project.id })).totals.invocations,
        1,
      );
      assert.equal(
        (await control.listProjectCustomDomains({ projectId: project.id }))[0]?.status,
        "active",
      );
      assert.equal(
        (await control.listProjectDeployPreviews({ projectId: project.id }))[0]?.id,
        preview.id,
      );
      assert.equal(
        (await control.getEdgeWorkerRelease({ id: edgeRelease.id })).status,
        "active",
      );
      const deletedEdgeRelease = await control.deleteEdgeWorkerRelease({
        id: edgeRelease.id,
        deleteProvider: true,
      });
      assert.equal(deletedEdgeRelease.status, "deleted");
      assert.equal(deletedEdgeRelease.deletedAt, fixedNow());
      assert.equal(
        (await control.listProjectEdgeWorkerReleases({ projectId: project.id }))[0]?.status,
        "deleted",
      );
      assert.equal((await control.rollbackDeployPreview({ id: preview.id })).status, "rolled_back");
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
