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
import { createInMemoryRouteSnapshotReplicaStore } from "../src/control-plane/snapshot-replication.ts";
import { createMemoryRepository } from "../src/control-plane/repository.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createConfiguredDurableObjectAlarmDispatcherJobs } from "../src/control-plane/durable-object-alarm-runtime.ts";
import { createVolumeSqliteRegistry } from "../src/control-plane/volume-sqlite.ts";
import { createHttpApp, publishCurrentRouteSnapshot } from "../src/http/app.ts";
import { verifyRuntimeIdentityHeaders } from "../src/runtime/identity.ts";

test("HTTP API updates organization billing profile", async () => {
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
    const organization = await postJson(baseUrl, "/organizations", {
      id: "org_http_billing_profile",
      name: "HTTP Billing Profile",
      billingEmail: "OWNER@example.com",
    });
    assert.equal(organization.billingProvider, "none");
    assert.equal(organization.paymentStatus, "payment_pending");
    assert.equal(organization.billingEmail, "owner@example.com");

    const updated = await putJson(baseUrl, `/organizations/${organization.id}/billing`, {
      billingProvider: "stripe",
      billingCustomerId: "cus_http",
      paymentStatus: "active",
    });
    assert.equal(updated.billingProvider, "stripe");
    assert.equal(updated.billingCustomerId, "cus_http");
    assert.equal(updated.paymentStatus, "active");
  } finally {
    await app.close();
  }
});

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

test("HTTP API accepts and serves replicated route snapshots", async () => {
  const store = createInMemoryRouteSnapshotReplicaStore();
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    routeSnapshotReplicaStore: store,
    now: () => "2026-07-01T00:00:11.000Z",
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const snapshot: RouteSnapshot = {
    id: "snap_replicated",
    schemaVersion: 1,
    generatedAt: "2026-07-01T00:00:10.000Z",
    routes: [],
  };

  try {
    const applyResponse = await fetch(`${baseUrl}/replication/snapshots/routes`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-wasmplane-source-region": "nrt",
      },
      body: JSON.stringify(snapshot),
    });
    assert.equal(applyResponse.status, 200);
    assert.deepEqual(await applyResponse.json(), {
      accepted: true,
      stale: false,
      snapshotId: "snap_replicated",
      generatedAt: "2026-07-01T00:00:10.000Z",
      receivedAt: "2026-07-01T00:00:11.000Z",
    });

    const readResponse = await fetch(`${baseUrl}/replication/snapshots/routes`);
    assert.equal(readResponse.status, 200);
    assert.deepEqual(await readResponse.json(), {
      sourceRegion: "nrt",
      receivedAt: "2026-07-01T00:00:11.000Z",
      snapshot,
    });
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

test("HTTP API creates beta onboarding bundles", async () => {
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
    const onboarding = await postJson(baseUrl, "/beta/onboardings", {
      organizationId: "org_acme",
      organizationName: "Acme",
      userEmail: "owner@acme.example",
      projectId: "prj_acme",
      projectName: "Acme API",
      defaultHost: "api.acme.example",
    });

    assert.equal(onboarding.organization.id, "org_acme");
    assert.equal(onboarding.user.email, "owner@acme.example");
    assert.equal(onboarding.project.id, "prj_acme");
    assert.equal(onboarding.membership.role, "owner");
    assert.deepEqual(onboarding.deployKey.apiKey.scopes, ["read", "write", "publish"]);
    assert.match(onboarding.deployKey.token, /^wmp_[a-z0-9]{32}$/);
    assert.match(onboarding.next.deployCommand, /pnpm wasmplane deploy/);
    assert.match(onboarding.next.usageUrl, /\/projects\/prj_acme\/usage$/);
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
    await postJson(baseUrl, "/durable-object-namespaces", {
      id: "do_usage",
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
      durableObjectNamespaces: 1,
    });
  } finally {
    await app.close();
  }
});

test("HTTP API records and reads project usage metering", async () => {
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
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-07-01T01:00:00.000Z";

  try {
    const organization = await postJson(baseUrl, "/organizations", { id: "org_http_usage", name: "HTTP Usage" });
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_usage",
      name: "http usage",
      organizationId: organization.id,
    });
    const event = await postJson(baseUrl, "/usage/events", {
      id: "use_http_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 2,
      dimensions: { deploymentId: "dep_http", status: 200 },
      recordedAt: from,
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_egress",
      projectId: project.id,
      metric: "egress_bytes",
      quantity: 128,
      recordedAt: from,
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_old",
      projectId: project.id,
      metric: "egress_bytes",
      quantity: 999,
      recordedAt: "2026-06-30T23:59:59.000Z",
    });

    assert.deepEqual(event, {
      id: "use_http_invocation",
      organizationId: organization.id,
      projectId: project.id,
      metric: "invocation",
      quantity: 2,
      dimensions: { deploymentId: "dep_http", status: 200 },
      recordedAt: from,
    });
    const response = await fetch(
      `${baseUrl}/projects/${project.id}/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      projectId: project.id,
      organizationId: organization.id,
      from,
      to,
      totals: {
        invocations: 2,
        cpuMs: 0,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 128,
        storageBytes: 0,
        sqliteUnits: 0,
      },
    });
  } finally {
    await app.close();
  }
});

test("HTTP API records usage events idempotently by event id", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectUsageQuotas: {
      prj_http_usage_idempotent: {
        period: "calendar_month",
        invocations: 1,
      },
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_usage_idempotent",
      name: "http usage idempotent",
    });
    const event = {
      id: "use_http_idempotent",
      projectId: project.id,
      metric: "invocation",
      quantity: 1,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    assert.deepEqual(
      await postJson(baseUrl, "/usage/events", event),
      await postJson(baseUrl, "/usage/events", event),
    );
    const summaryResponse = await fetch(`${baseUrl}/projects/${project.id}/usage`);
    assert.equal(summaryResponse.status, 200);
    assert.equal((await summaryResponse.json()).totals.invocations, 1);

    const conflict = await fetch(`${baseUrl}/usage/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, quantity: 2 }),
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error.message, /already exists with different payload/);
  } finally {
    await app.close();
  }
});

test("HTTP API exposes project enforcement report", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectEnforcementPolicies: {
      prj_http_enforce: {
        cpuMs: 100,
        memoryMbMs: 4096,
        storageBytes: 1024,
        concurrency: 8,
        rate: { requestsPerSecond: 50 },
      },
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-07-01T01:00:00.000Z";

  try {
    const organization = await postJson(baseUrl, "/organizations", {
      id: "org_http_enforce",
      name: "HTTP Enforce",
    });
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_enforce",
      name: "http enforce",
      organizationId: organization.id,
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_enforce_cpu",
      projectId: project.id,
      metric: "cpu_ms",
      quantity: 25,
      recordedAt: from,
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_enforce_storage",
      projectId: project.id,
      metric: "storage_bytes",
      quantity: 2048,
      recordedAt: from,
    });

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/enforcement-report?from=${encodeURIComponent(from)}&to=${
        encodeURIComponent(to)
      }`,
    );
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.projectId, project.id);
    assert.deepEqual(report.enforcement.cpu, { used: 25, limit: 100, remaining: 75, status: "ok" });
    assert.deepEqual(report.enforcement.storage, { used: 2048, limit: 1024, remaining: 0, status: "exceeded" });
    assert.deepEqual(report.enforcement.concurrency, { limit: 8, status: "configured" });
    assert.deepEqual(report.enforcement.rate, { requestsPerSecond: 50, status: "configured" });
  } finally {
    await app.close();
  }
});

test("HTTP API enforces and reports billing usage quotas", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectUsageQuotas: {
      prj_http_billing_quota: {
        period: "calendar_month",
        invocations: 1,
      },
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_billing_quota",
      name: "http billing quota",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_billing_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 1,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const over = await fetch(`${baseUrl}/usage/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "use_http_billing_invocation_over",
        projectId: project.id,
        metric: "invocation",
        quantity: 1,
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    });
    assert.equal(over.status, 400);
    assert.match((await over.json()).error.message, /usage quota exceeded.*invocations 2\/1.*2026-07/);

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/usage-quota?at=${encodeURIComponent("2026-07-15T00:00:00.000Z")}`,
    );
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.projectId, project.id);
    assert.deepEqual(report.enforcement.invocations, {
      used: 1,
      limit: 1,
      remaining: 0,
      status: "ok",
    });
  } finally {
    await app.close();
  }
});

test("HTTP API exposes project billing statements", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 0.4,
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_billing_statement",
      name: "http billing statement",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_billing_statement_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 1_000_000,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/billing-statement?at=${
        encodeURIComponent("2026-07-15T00:00:00.000Z")
      }`,
    );
    assert.equal(response.status, 200);
    const statement = await response.json();
    assert.equal(statement.projectId, project.id);
    assert.equal(statement.period.key, "2026-07");
    assert.deepEqual(statement.lineItems, [
      {
        metric: "invocations",
        quantity: 1,
        unit: "million invocations",
        unitPriceUsd: 0.4,
        amountUsd: 0.4,
      },
    ]);
    assert.equal(statement.totalUsd, 0.4);
  } finally {
    await app.close();
  }
});

test("HTTP API exposes organization billing statements", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 0.4,
      sqliteUnitUsd: 2.5,
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const organization = await postJson(baseUrl, "/organizations", {
      id: "org_http_billing_statement",
      name: "HTTP Billing Statement Org",
    });
    const projectA = await postJson(baseUrl, "/projects", {
      id: "prj_http_billing_statement_a",
      organizationId: organization.id,
      name: "http billing statement a",
    });
    const projectB = await postJson(baseUrl, "/projects", {
      id: "prj_http_billing_statement_b",
      organizationId: organization.id,
      name: "http billing statement b",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_org_billing_invocation",
      projectId: projectA.id,
      metric: "invocation",
      quantity: 1_000_000,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_org_billing_sqlite",
      projectId: projectB.id,
      metric: "sqlite_unit",
      quantity: 2,
      recordedAt: "2026-07-02T00:00:00.000Z",
    });

    const response = await fetch(
      `${baseUrl}/organizations/${organization.id}/billing-statement?at=${
        encodeURIComponent("2026-07-15T00:00:00.000Z")
      }`,
    );
    assert.equal(response.status, 200);
    const statement = await response.json();
    assert.equal(statement.organizationId, organization.id);
    assert.equal(statement.period.key, "2026-07");
    assert.deepEqual(statement.projects.map((project: any) => [project.projectId, project.totalUsd]), [
      [projectA.id, 0.4],
      [projectB.id, 5],
    ]);
    assert.equal(statement.totalUsd, 5.4);
  } finally {
    await app.close();
  }
});

test("HTTP API issues and reads organization billing invoices", async () => {
  let currentNow = fixedNow();
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: () => currentNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
    billingRateCardVersion: "2026-07-v1",
    billingInvoiceExportSigner: { keyId: "billing", key: "secret-key" },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const organization = await postJson(baseUrl, "/organizations", {
      id: "org_http_invoice",
      name: "HTTP Invoice Org",
    });
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_invoice",
      organizationId: organization.id,
      name: "http invoice",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_invoice_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 1_000_000,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });

    const invoice = await postJson(baseUrl, `/organizations/${organization.id}/billing-invoices`, {
      id: "inv_http_invoice_july",
      at: "2026-07-15T00:00:00.000Z",
    });
    assert.equal(invoice.id, "inv_http_invoice_july");
    assert.equal(invoice.organizationId, organization.id);
    assert.equal(invoice.periodKey, "2026-07");
    assert.equal(invoice.rateCardVersion, "2026-07-v1");
    assert.equal(invoice.totalUsd, 1);

    const response = await fetch(`${baseUrl}/billing-invoices/${invoice.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), invoice);

    await postJson(baseUrl, "/usage/events", {
      id: "use_http_invoice_august_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 2_000_000,
      recordedAt: "2026-08-01T00:00:00.000Z",
    });
    currentNow = "2026-08-10T00:00:00.000Z";
    const august = await postJson(baseUrl, `/organizations/${organization.id}/billing-invoices`, {
      id: "inv_http_invoice_august",
      at: "2026-08-15T00:00:00.000Z",
    });

    const listResponse = await fetch(`${baseUrl}/organizations/${organization.id}/billing-invoices`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [august, invoice]);

    const exportResponse = await fetch(`${baseUrl}/billing-invoices/${invoice.id}/export`);
    assert.equal(exportResponse.status, 200);
    const exportBundle = await exportResponse.json();
    assert.equal(exportBundle.invoice.id, invoice.id);
    assert.equal(exportBundle.signature.keyId, "billing");
    assert.match(exportBundle.contentDigest, /^sha256:[a-f0-9]{64}$/);

    const policy = await putJson(baseUrl, `/billing-invoices/${invoice.id}/retention-policy`, {
      retainUntil: "2026-09-01T00:00:00.000Z",
      legalHold: true,
      legalHoldReason: "tax audit",
    });
    assert.equal(policy.invoiceId, invoice.id);
    assert.equal(policy.organizationId, organization.id);
    assert.equal(policy.legalHold, true);
    assert.equal(policy.legalHoldReason, "tax audit");

    const policyResponse = await fetch(`${baseUrl}/billing-invoices/${invoice.id}/retention-policy`);
    assert.equal(policyResponse.status, 200);
    assert.deepEqual(await policyResponse.json(), policy);

    await putJson(baseUrl, `/billing-invoices/${august.id}/retention-policy`, {
      retainUntil: "2026-12-01T00:00:00.000Z",
    });

    const heldPrune = await postJsonOk(baseUrl, "/billing-invoices/retention/prune", {
      organizationId: organization.id,
      at: "2026-09-15T00:00:00.000Z",
    });
    assert.deepEqual(heldPrune.deleted, []);
    assert.deepEqual(heldPrune.retained.map((item: any) => [item.invoiceId, item.reason]), [
      [invoice.id, "legal_hold"],
      [august.id, "retention_active"],
    ]);

    await putJson(baseUrl, `/billing-invoices/${invoice.id}/retention-policy`, {
      retainUntil: "2026-09-01T00:00:00.000Z",
      legalHold: false,
    });
    const pruned = await postJsonOk(baseUrl, "/billing-invoices/retention/prune", {
      organizationId: organization.id,
      at: "2026-09-15T00:00:00.000Z",
    });
    assert.deepEqual(pruned.deleted.map((deleted: any) => deleted.id), [invoice.id]);
    const missing = await fetch(`${baseUrl}/billing-invoices/${invoice.id}`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test("HTTP API enforces and reports monthly billing budgets", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
    projectBillingBudgets: {
      prj_http_billing_budget: {
        period: "calendar_month",
        maxUsd: 1,
      },
    },
  });
  const app = createHttpApp({ controlPlane: control });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", {
      id: "prj_http_billing_budget",
      name: "http billing budget",
    });
    await postJson(baseUrl, "/usage/events", {
      id: "use_http_billing_budget_invocation",
      projectId: project.id,
      metric: "invocation",
      quantity: 1_000_000,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const over = await fetch(`${baseUrl}/usage/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "use_http_billing_budget_over",
        projectId: project.id,
        metric: "invocation",
        quantity: 1_000_000,
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    });
    assert.equal(over.status, 400);
    assert.match((await over.json()).error.message, /billing budget exceeded.*\$2\/\$1.*2026-07/);

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/billing-budget?at=${
        encodeURIComponent("2026-07-15T00:00:00.000Z")
      }`,
    );
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.projectId, project.id);
    assert.equal(report.usedUsd, 1);
    assert.equal(report.limitUsd, 1);
    assert.equal(report.remainingUsd, 0);
    assert.equal(report.status, "ok");
  } finally {
    await app.close();
  }
});

test("HTTP API manages custom domain verification and TLS hooks", async () => {
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
    const project = await postJson(baseUrl, "/projects", { id: "prj_http_domain", name: "http domain" });
    const domain = await postJson(baseUrl, "/custom-domains", {
      id: "dom_http",
      projectId: project.id,
      host: "Http.Example.Dev",
    });
    assert.equal(domain.host, "http.example.dev");
    assert.equal(domain.status, "pending_verification");

    const list = await fetch(`${baseUrl}/projects/${project.id}/custom-domains`);
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).domains, [domain]);

    const verified = await postJsonOk(baseUrl, "/custom-domains/dom_http/verify", {
      txtRecords: [domain.verificationRecordValue],
    });
    assert.equal(verified.status, "verified");
    const pending = await postJsonOk(baseUrl, "/custom-domains/dom_http/tls", {
      provider: "fly",
      requestId: "cert_http",
    });
    assert.equal(pending.tlsStatus, "pending");
    const active = await postJsonOk(baseUrl, "/custom-domains/dom_http/tls/complete", {
      ok: true,
      provider: "fly",
      requestId: "cert_http",
    });
    assert.equal(active.status, "active");
    assert.equal(active.tlsStatus, "provisioned");
  } finally {
    await app.close();
  }
});

test("HTTP API provisions project volume sqlite database units", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-http-volume-sqlite-"));
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const registry = createVolumeSqliteRegistry({
    rootDir: dir,
    maxOpenDatabases: 1,
    now: fixedNow,
  });
  const app = createHttpApp({ controlPlane: control, volumeSqliteRegistry: registry });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const project = await postJson(baseUrl, "/projects", { id: "prj_state", name: "stateful" });
    const created = await postJson(baseUrl, `/projects/${project.id}/sqlite-databases`, {
      schemaVersion: 2,
    });

    assert.deepEqual(created, {
      id: "prj_state",
      path: join(dir, "dbs", "prj_state.sqlite"),
      kind: "project",
      ownerId: "prj_state",
      schemaVersion: 2,
      createdAt: fixedNow(),
      lastUsedAt: fixedNow(),
    });

    const projectList = await (await fetch(`${baseUrl}/projects/${project.id}/sqlite-databases`)).json();
    assert.deepEqual(projectList.databases.map((database: any) => database.id), ["prj_state"]);

    const direct = await (await fetch(`${baseUrl}/sqlite-databases/prj_state`)).json();
    assert.equal(direct.ownerId, "prj_state");

    const all = await (await fetch(`${baseUrl}/sqlite-databases`)).json();
    assert.deepEqual(all.databases.map((database: any) => database.id), ["prj_state"]);
    assert.deepEqual(all.stats.pool, { maxOpen: 1, open: 1, openIds: ["prj_state"] });

    registry.withDatabase("prj_state", (db) => {
      db.exec("create table events (id text primary key); insert into events (id) values ('before')");
    });
    const backup = await postJson(baseUrl, "/sqlite-databases/prj_state/backups", { backupId: "http_backup" });
    assert.equal(backup.id, "http_backup");
    assert.equal(backup.databaseId, "prj_state");

    registry.withDatabase("prj_state", (db) => {
      db.exec("insert into events (id) values ('after')");
    });
    const restore = await postJsonOk(baseUrl, "/sqlite-databases/prj_state/restores", { backupId: "http_backup" });
    assert.equal(restore.id, "prj_state");
    registry.withDatabase("prj_state", (db) => {
      assert.deepEqual(
        db.prepare("select id from events order by id asc").all().map((row: any) => row.id),
        ["before"],
      );
    });
    await postJson(baseUrl, "/sqlite-databases/prj_state/backups", { backupId: "http_backup_2" });
    const gc = await postJsonOk(baseUrl, "/sqlite-databases/prj_state/backups/gc", { keepLatest: 1 });
    assert.deepEqual(gc.deleted.map((deleted: any) => deleted.id), ["http_backup"]);
    const backupsAfterGc = await (await fetch(`${baseUrl}/sqlite-databases/prj_state/backups`)).json();
    assert.deepEqual(backupsAfterGc.backups.map((item: any) => item.id), ["http_backup_2"]);

    const missing = await fetch(`${baseUrl}/sqlite-databases/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    registry.close();
  }
});

test("HTTP alarm demo schedules durable object alarms and handles dispatcher webhooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-http-alarm-demo-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  let nowMs = Date.parse("2026-07-03T00:00:00.000Z");
  const app = createHttpApp({
    controlPlane: control,
    volumeSqliteRegistry: registry,
    apiTokens: [{ token: "control-token", scopes: ["*"], principal: "test" }],
    alarmDemoWebhookToken: "alarm-webhook-token",
    now: () => new Date(nowMs).toISOString(),
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const scheduled = await postJson(baseUrl, "/alarm-demo/schedules", {
      objectName: "heartbeat",
      message: "wake up",
      delayMs: 0,
      repeatMs: 1000,
      repeatLimit: 1,
    }, "control-token");
    assert.equal(scheduled.namespace, "alarm-demo");
    assert.equal(scheduled.objectName, "heartbeat");
    assert.equal(scheduled.alarmCount, 0);
    assert.equal(scheduled.alarmAt, "2026-07-03T00:00:00.000Z");
    assert.equal(scheduled.remainingRepeats, 1);

    const jobs = createConfiguredDurableObjectAlarmDispatcherJobs({
      registry,
      env: {
        WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS: "1000",
        WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES: "alarm-demo",
        WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL: `${baseUrl}/alarm-demo/webhook`,
        WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN: "alarm-webhook-token",
      },
      now: () => nowMs,
      fetchFn: fetch,
    });
    assert.equal(jobs.length, 1);

    nowMs += 1;
    assert.equal(await jobs[0].tick(), true);
    const afterFirst = await getJson(baseUrl, "/alarm-demo/objects/heartbeat", "control-token");
    assert.equal(afterFirst.alarmCount, 1);
    assert.equal(afterFirst.lastScheduledTime, "2026-07-03T00:00:00.000Z");
    assert.equal(afterFirst.alarmAt, "2026-07-03T00:00:01.000Z");
    assert.equal(afterFirst.remainingRepeats, 0);

    nowMs += 1000;
    assert.equal(await jobs[0].tick(), true);
    const afterSecond = await getJson(baseUrl, "/alarm-demo/objects/heartbeat", "control-token");
    assert.equal(afterSecond.alarmCount, 2);
    assert.equal(afterSecond.lastScheduledTime, "2026-07-03T00:00:01.000Z");
    assert.equal(afterSecond.alarmAt, null);
    assert.equal(afterSecond.remainingRepeats, 0);
  } finally {
    await app.close();
    registry.close();
  }
});

test("HTTP alarm demo handles duplicate dispatcher webhooks idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-http-alarm-demo-idempotency-"));
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    volumeSqliteRegistry: registry,
    apiTokens: [{ token: "control-token", scopes: ["*"], principal: "test" }],
    alarmDemoWebhookToken: "alarm-webhook-token",
    now: () => "2026-07-03T00:00:05.000Z",
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const scheduled = await postJson(baseUrl, "/alarm-demo/schedules", {
      objectName: "heartbeat",
      delayMs: 0,
    }, "control-token");
    const delivery = {
      namespace: "alarm-demo",
      objectId: scheduled.objectId,
      scheduledTime: scheduled.alarmAt,
    };

    const first = await postJsonOk(baseUrl, "/alarm-demo/webhook", delivery, "alarm-webhook-token");
    assert.equal(first.alarmCount, 1);
    assert.equal(first.lastScheduledTime, scheduled.alarmAt);

    const duplicate = await postJsonOk(baseUrl, "/alarm-demo/webhook", delivery, "alarm-webhook-token");
    assert.equal(duplicate.alarmCount, 1);
    assert.equal(duplicate.lastScheduledTime, scheduled.alarmAt);
  } finally {
    await app.close();
    registry.close();
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

test("HTTP API accepts DB-backed scoped API keys", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const organization = control.createOrganization({ id: "org_api", name: "API Org" });
  const project = control.createProject({ id: "prj_api_key", name: "api-keyed", organizationId: organization.id });
  const key = control.createApiKey({
    id: "key_reader",
    projectId: project.id,
    name: "Reader",
    scopes: ["read"],
  });
  const app = createHttpApp({ controlPlane: control, apiToken: "bootstrap-admin" });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const read = await fetch(`${baseUrl}/projects/${project.id}/quota-usage`, {
      headers: { authorization: `Bearer ${key.token}` },
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), {
      artifacts: 0,
      deployments: 0,
      routes: 0,
      secrets: 0,
      kvNamespaces: 0,
      durableObjectNamespaces: 0,
    });

    const write = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: jsonHeaders(key.token),
      body: JSON.stringify({ name: "should fail" }),
    });
    assert.equal(write.status, 403);
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

test("HTTP API exposes non-secret operational config with read scope", async () => {
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
    operationalConfig: {
      schemaVersion: 1,
      database: { kind: "postgres", external: true },
      artifactStore: { kind: "s3", external: true },
      volumeSqlite: { enabled: true },
      runtimeNodes: { staticTargets: 0 },
      routeSnapshotReplicas: { configured: 1 },
      durableObjectAlarms: { enabled: true, namespaces: ["alarm-demo"] },
    },
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const denied = await fetch(`${baseUrl}/ops/config`);
    assert.equal(denied.status, 401);

    const forbidden = await fetch(`${baseUrl}/ops/config`, {
      headers: { authorization: "Bearer writer" },
    });
    assert.equal(forbidden.status, 403);

    const response = await fetch(`${baseUrl}/ops/config`, {
      headers: { authorization: "Bearer reader" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      database: { kind: "postgres", external: true },
      artifactStore: { kind: "s3", external: true },
      volumeSqlite: { enabled: true },
      runtimeNodes: { staticTargets: 0 },
      routeSnapshotReplicas: { configured: 1 },
      durableObjectAlarms: { enabled: true, namespaces: ["alarm-demo"] },
    });
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

test("HTTP API gates live edge worker deploys behind publish scope and audits them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-edge-audit-"));
  const auditPath = join(dir, "audit.jsonl");
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    edgeWorkerDeployer: {
      deploy(input: any) {
        return {
          provider: "cloudflare-workers",
          mode: "api",
          scriptName: input.scriptName,
          scriptDigest: digest(input.scriptModule),
          scriptModule: input.scriptModule,
          versionId: "version_live",
          externalDeploymentId: "deployment_live",
          url: `https://${input.scriptName}.example.workers.dev`,
        };
      },
    },
  });
  const { project, deployment } = await createHelloRouteInControlPlane(control);
  const app = createHttpApp({
    controlPlane: control,
    apiTokens: [
      { token: "write-token", scopes: ["write"], principal: "writer" },
      { token: "publish-token", scopes: ["publish"], principal: "publisher" },
    ],
    auditSink: createJsonlAuditSink({ path: auditPath }),
    now: fixedNow,
  });
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const body = {
    projectId: project.id,
    deploymentId: deployment.id,
    scriptName: "wasmplane-live-edge",
    mode: "api",
  };

  try {
    const denied = await fetch(`${baseUrl}/edge-workers/releases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer write-token",
      },
      body: JSON.stringify(body),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${baseUrl}/edge-workers/releases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer publish-token",
      },
      body: JSON.stringify(body),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const release = JSON.parse(createdText);
    assert.equal(release.mode, "api");
    assert.equal(release.versionId, "version_live");

    await eventually(async () => {
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), {
        timestamp: fixedNow(),
        principal: "publisher",
        scope: "publish",
        method: "POST",
        path: "/edge-workers/releases",
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

test("HTTP API manages durable object namespaces", async () => {
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
    const namespace = await postJson(baseUrl, "/durable-object-namespaces", {
      id: "do_rooms",
      projectId: project.id,
      name: "Rooms",
    });

    assert.deepEqual(namespace, {
      id: "do_rooms",
      projectId: project.id,
      name: "Rooms",
      createdAt: fixedNow(),
      updatedAt: fixedNow(),
    });

    const getResponse = await fetch(`${baseUrl}/durable-object-namespaces/do_rooms`);
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), namespace);

    const listResponse = await fetch(`${baseUrl}/projects/${project.id}/durable-object-namespaces`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [namespace]);

    const deleteResponse = await fetch(`${baseUrl}/durable-object-namespaces/do_rooms`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    const deletedResponse = await fetch(`${baseUrl}/durable-object-namespaces/do_rooms`);
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

test("HTTP API rejects deployments that reference unknown durable object namespaces", async () => {
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
          durableObjects: [{ binding: "ROOMS", namespaceId: "do_missing" }],
          secrets: [],
        },
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /durable object namespace do_missing/);
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

test("HTTP API creates deploy previews and rolls them back", async () => {
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
    const { project, deployment: stable } = await createHelloRoute(baseUrl);
    const artifact = await postJson(baseUrl, "/artifacts", {
      projectId: project.id,
      digest: digest("preview-candidate"),
      location: "oci://registry.example.com/mizchi/hello:preview",
      sizeBytes: 43,
    });
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

    const preview = await postJson(baseUrl, "/deploy-previews", {
      projectId: project.id,
      deploymentId: candidate.id,
      host: "hello.example.dev",
      pathPrefix: "/",
      environment: { FEATURE_FLAG: "on" },
    });

    assert.match(preview.id, /^prv_/);
    assert.equal(preview.url, "https://hello.example.dev/");
    assert.equal(preview.previousRoute.deploymentId, stable.id);
    assert.deepEqual(preview.environment, { FEATURE_FLAG: "on" });

    const previewsResponse = await fetch(`${baseUrl}/projects/${project.id}/deploy-previews`);
    assert.equal(previewsResponse.status, 200);
    const { previews } = await previewsResponse.json();
    assert.equal(previews.length, 1);
    assert.equal(previews[0].deploymentId, candidate.id);

    const snapshotBeforeRollback = await (await fetch(`${baseUrl}/snapshots/routes`)).json();
    assert.equal(snapshotBeforeRollback.routes[0].deploymentId, candidate.id);

    const rollback = await postJsonOk(baseUrl, `/deploy-previews/${preview.id}/rollback`, {});
    assert.equal(rollback.status, "rolled_back");

    const snapshotAfterRollback = await (await fetch(`${baseUrl}/snapshots/routes`)).json();
    assert.equal(snapshotAfterRollback.routes[0].deploymentId, stable.id);
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

test("HTTP API replicates published route snapshots to regional control planes", async () => {
  const calls: Array<{ url: string; authorization?: string; body: RouteSnapshot }> = [];
  let now = 0;
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimeNodes: [{ id: "local-runtime", url: "https://runtime.internal" }],
    routeSnapshotReplicas: [{
      id: "replica-iad",
      region: "iad",
      url: "https://iad-control.internal",
      token: "replica-token",
    }],
    snapshotReplication: {
      sourceRegion: "nrt",
      retryDelayMs: 0,
      nowMs: () => {
        now += 5;
        return now;
      },
    },
    fetch: async (url, init) => {
      const snapshot = JSON.parse(init.body) as RouteSnapshot;
      calls.push({ url, authorization: init.headers.authorization, body: snapshot });
      if (url.endsWith("/replication/snapshots/routes")) {
        assert.equal(init.headers["x-wasmplane-source-region"], "nrt");
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              accepted: true,
              snapshotId: snapshot.id,
              generatedAt: snapshot.generatedAt,
            };
          },
          async text() {
            return "ok";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            routes: snapshot.routes.length,
            generatedAt: snapshot.generatedAt,
            snapshotId: snapshot.id,
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
    await createHelloRoute(baseUrl);
    const response = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const publish = await response.json();

    assert.equal(publish.ok, true);
    assert.equal(publish.replication.ok, true);
    assert.equal(publish.replication.consistent, true);
    assert.deepEqual(publish.replication.replicas[0], {
      id: "replica-iad",
      region: "iad",
      url: "https://iad-control.internal",
      ok: true,
      consistent: true,
      status: 200,
      snapshotId: publish.snapshot.id,
      generatedAt: fixedNow(),
      attempts: 1,
      elapsedMs: 5,
    });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://runtime.internal/__runtime/snapshots/routes",
      "https://iad-control.internal/replication/snapshots/routes",
    ]);
    assert.equal(calls[1]?.authorization, "Bearer replica-token");
    assert.equal(calls[1]?.body.id, publish.snapshot.id);
  } finally {
    await app.close();
  }
});

test("route snapshot publish is unsuccessful when replica consistency fails", async () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  await createHelloRouteInControlPlane(control);

  const report = await publishCurrentRouteSnapshot({
    controlPlane: control,
    runtimeNodes: [{ id: "local-runtime", url: "https://runtime.internal" }],
    routeSnapshotReplicas: [{ id: "replica-iad", region: "iad", url: "https://iad-control.internal" }],
    snapshotReplication: { retryDelayMs: 0, nowMs: () => 0 },
    fetch: async (url, init) => {
      const snapshot = JSON.parse(init.body) as RouteSnapshot;
      if (url.endsWith("/replication/snapshots/routes")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              accepted: true,
              snapshotId: "snap_stale",
              generatedAt: snapshot.generatedAt,
            };
          },
          async text() {
            return "ok";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            routes: snapshot.routes.length,
            generatedAt: snapshot.generatedAt,
            snapshotId: snapshot.id,
          };
        },
        async text() {
          return "ok";
        },
      };
    },
  });

  assert.equal(report.ok, false);
  assert.equal((report as any).replication.ok, false);
  assert.equal((report as any).replication.replicas[0].error, "replica acknowledged a different snapshot");
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

test("HTTP API publishes isolated tenant snapshots only to isolation pool nodes", async () => {
  const defaultSnapshots: RouteSnapshot[] = [];
  const isolatedSnapshots: RouteSnapshot[] = [];
  const defaultRuntime = await listenRuntimeSnapshotSink(defaultSnapshots);
  const isolatedRuntime = await listenRuntimeSnapshotSink(isolatedSnapshots);
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const app = createHttpApp({
    controlPlane: control,
    runtimePlacement: {
      default: { labels: { pool: "default" } },
      isolation: {
        projects: {
          prj_noisy: { labels: { pool: "isolation" } },
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
      id: "rt_default",
      url: defaultRuntime.baseUrl,
      region: "nrt",
      labels: { pool: "default" },
    });
    await postJson(baseUrl, "/runtime-nodes", {
      id: "rt_isolated",
      url: isolatedRuntime.baseUrl,
      region: "nrt",
      labels: { pool: "isolation" },
    });
    await createProjectRoute(baseUrl, {
      projectId: "prj_normal",
      projectName: "normal",
      host: "normal.example.dev",
    });
    await createProjectRoute(baseUrl, {
      projectId: "prj_noisy",
      projectName: "noisy",
      host: "noisy.example.dev",
    });

    const publishResponse = await fetch(`${baseUrl}/snapshots/routes/publish`, { method: "POST" });
    if (publishResponse.status !== 200) {
      assert.fail(await publishResponse.text());
    }
    const publish = await publishResponse.json();

    assert.deepEqual(
      publish.targets.map((target: any) => ({ id: target.id, routes: target.routes })),
      [
        { id: "rt_default", routes: 1 },
        { id: "rt_isolated", routes: 1 },
      ],
    );
    assert.deepEqual(defaultSnapshots[0]?.routes.map((route) => route.projectId), ["prj_normal"]);
    assert.deepEqual(isolatedSnapshots[0]?.routes.map((route) => route.projectId), ["prj_noisy"]);
    assert.notEqual(defaultSnapshots[0]?.id, isolatedSnapshots[0]?.id);
  } finally {
    await app.close();
    await defaultRuntime.close();
    await isolatedRuntime.close();
  }
});

test("route snapshot publish keeps registered node snapshot when static target shares its URL", async () => {
  const sent: Array<{ url: string; routes: string[] }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  control.registerRuntimeNode({
    id: "rt_isolated",
    url: "http://runtime.local",
    labels: { pool: "isolation" },
  });
  control.recordRuntimeNodeHeartbeat({ id: "rt_isolated" });
  await createProjectRouteInControlPlane(control, {
    projectId: "prj_noisy",
    projectName: "noisy",
    host: "noisy.example.dev",
  });

  const report = await publishCurrentRouteSnapshot({
    controlPlane: control,
    runtimeNodes: [{ id: "static-runtime", url: "http://runtime.local" }],
    runtimePlacement: {
      default: { labels: { pool: "default" } },
      isolation: {
        projects: {
          prj_noisy: { labels: { pool: "isolation" } },
        },
      },
    },
    fetch: async (url, init) => {
      const snapshot = JSON.parse(init.body) as RouteSnapshot;
      sent.push({ url, routes: snapshot.routes.map((route) => route.projectId) });
      return snapshotPublishOk(snapshot);
    },
  });

  assert.deepEqual(report.targets.map((target) => ({ id: target.id, routes: target.routes })), [
    { id: "rt_isolated", routes: 1 },
  ]);
  assert.deepEqual(sent, [
    {
      url: "http://runtime.local/__runtime/snapshots/routes",
      routes: ["prj_noisy"],
    },
  ]);
});

test("route snapshot publish filters static targets through placement policy", async () => {
  const sent: Array<{ url: string; routes: string[] }> = [];
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  control.registerRuntimeNode({
    id: "rt_nrt",
    url: "http://nrt.runtime.local",
    region: "nrt",
    labels: { pool: "default" },
  });
  control.recordRuntimeNodeHeartbeat({ id: "rt_nrt" });
  await createProjectRouteInControlPlane(control, {
    projectId: "prj_place",
    projectName: "placed",
    host: "placed.example.dev",
  });

  const report = await publishCurrentRouteSnapshot({
    controlPlane: control,
    runtimeNodes: [{ id: "static-iad", url: "http://iad.runtime.local" }],
    runtimePlacement: {
      projects: {
        prj_place: { regions: ["nrt"], labels: { pool: "default" } },
      },
    },
    fetch: async (url, init) => {
      const snapshot = JSON.parse(init.body) as RouteSnapshot;
      sent.push({ url, routes: snapshot.routes.map((route) => route.projectId) });
      return snapshotPublishOk(snapshot);
    },
  });

  assert.deepEqual(report.targets.map((target) => ({ id: target.id, routes: target.routes })), [
    { id: "rt_nrt", routes: 1 },
    { id: "static-iad", routes: 0 },
  ]);
  assert.deepEqual(sent, [
    {
      url: "http://nrt.runtime.local/__runtime/snapshots/routes",
      routes: ["prj_place"],
    },
    {
      url: "http://iad.runtime.local/__runtime/snapshots/routes",
      routes: [],
    },
  ]);
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

async function getJson(baseUrl: string, path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (response.status !== 200) {
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

async function createProjectRoute(
  baseUrl: string,
  input: { projectId: string; projectName: string; host: string },
) {
  const project = await postJson(baseUrl, "/projects", {
    id: input.projectId,
    name: input.projectName,
  });
  const artifact = await postJson(baseUrl, "/artifacts", {
    projectId: project.id,
    digest: digest(`route-${project.id}`),
    location: `oci://registry.example.com/mizchi/${project.id}:v1`,
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
    host: input.host,
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  return { project, artifact, deployment };
}

async function createHelloRouteInControlPlane(control: any) {
  const project = await control.createProject({ name: "hello" });
  const artifact = await control.createArtifact({
    projectId: project.id,
    digest: digest(`hello-${project.id}`),
    location: "oci://registry.example.com/mizchi/hello:v1",
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
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  return { project, artifact, deployment };
}

async function createProjectRouteInControlPlane(
  control: any,
  input: { projectId: string; projectName: string; host: string },
) {
  const project = await control.createProject({ id: input.projectId, name: input.projectName });
  const artifact = await control.createArtifact({
    projectId: project.id,
    digest: digest(`route-${project.id}`),
    location: `oci://registry.example.com/mizchi/${project.id}:v1`,
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
    host: input.host,
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

function snapshotPublishOk(snapshot: RouteSnapshot) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        routes: snapshot.routes.length,
        generatedAt: snapshot.generatedAt,
        snapshotId: snapshot.id,
      };
    },
    async text() {
      return "ok";
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
