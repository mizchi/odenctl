import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MVP_WASI_PROFILE, MVP_WORKER_WORLD_VERSION } from "../src/control-plane/contracts.ts";
import { createAsyncControlPlane } from "../src/control-plane/async-service.ts";
import { createHmacArtifactSignatureVerifier, signArtifactDigest } from "../src/control-plane/artifact-signing.ts";
import { createAesGcmSecretCipher, isEncryptedSecretValue } from "../src/control-plane/secret-encryption.ts";
import { createControlPlane } from "../src/control-plane/service.ts";
import { createMemoryRepository, createSqliteRepository } from "../src/control-plane/repository.ts";

test("creates immutable wasmtime deployments with denied-by-default host capabilities", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const project = control.createProject({ name: "hello" });
  const artifact = control.createArtifact({
    projectId: project.id,
    digest: digest("hello"),
    location: "oci://registry.example.com/mizchi/hello:v1",
    sizeBytes: 42,
  });
  control.createSecret({
    id: "sec_api_key",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });
  control.createKvNamespace({
    id: "kv_main",
    projectId: project.id,
    name: "Main KV",
  });

  const deployment = control.createDeployment({
    id: "dep_hello_v1",
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
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    },
  });

  assert.equal(deployment.id, "dep_hello_v1");
  assert.equal(deployment.worldVersion, MVP_WORKER_WORLD_VERSION);
  assert.equal(deployment.runtime.backend, "wasmtime");
  assert.equal(deployment.runtime.wasi, MVP_WASI_PROFILE);
  assert.equal(deployment.capabilities.arbitraryFilesystem, false);
  assert.equal(deployment.capabilities.arbitrarySockets, false);
  assert.equal(deployment.capabilities.processSpawn, false);

  assert.throws(
    () =>
      control.createDeployment({
        id: "dep_hello_v1",
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
        capabilities: { outboundHttp: { enabled: false, allow: [] }, kv: [], secrets: [] },
      }),
    /already exists/,
  );
});

test("manages tenant memberships and project scoped API keys", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const organization = control.createOrganization({ id: "org_acme", name: "Acme" });
  const user = control.createUser({ id: "usr_alice", email: "ALICE@example.com", name: "Alice" });
  const project = control.createProject({
    id: "prj_acme",
    name: "edge-app",
    organizationId: organization.id,
  });
  const membership = control.addProjectMembership({
    projectId: project.id,
    userId: user.id,
    role: "owner",
  });
  const createdKey = control.createApiKey({
    id: "key_read",
    projectId: project.id,
    name: "Read key",
    scopes: ["read"],
  });

  assert.equal(project.organizationId, "org_acme");
  assert.deepEqual(membership, {
    projectId: "prj_acme",
    userId: "usr_alice",
    role: "owner",
    createdAt: fixedNow(),
  });
  assert.deepEqual(control.listProjectMemberships({ projectId: project.id }), [membership]);
  assert.match(createdKey.token, /^wmp_[a-z0-9]{32}$/);
  assert.deepEqual(createdKey.apiKey, {
    id: "key_read",
    organizationId: "org_acme",
    projectId: "prj_acme",
    name: "Read key",
    scopes: ["read"],
    createdAt: fixedNow(),
  });

  const authenticated = control.authenticateApiToken({ token: createdKey.token });
  assert.deepEqual(authenticated, {
    token: createdKey.token,
    scopes: ["read"],
    principal: "api-key:key_read",
    apiKeyId: "key_read",
    organizationId: "org_acme",
    projectId: "prj_acme",
  });
  assert.equal(control.authenticateApiToken({ token: "wmp_missing" }), undefined);
});

test("control plane records project usage metering events", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const organization = control.createOrganization({ id: "org_metered", name: "Metered" });
  const project = control.createProject({
    id: "prj_metered",
    name: "metered",
    organizationId: organization.id,
  });
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-07-01T01:00:00.000Z";

  const invocation = control.recordUsageEvent({
    id: "use_invocation",
    projectId: project.id,
    metric: "invocation",
    quantity: 1,
    dimensions: { deploymentId: "dep_1", status: 200, cached: false },
    recordedAt: from,
  });
  control.recordUsageEvent({ id: "use_cpu", projectId: project.id, metric: "cpu_ms", quantity: 12.5, recordedAt: from });
  control.recordUsageEvent({ id: "use_wall", projectId: project.id, metric: "wall_ms", quantity: 30, recordedAt: from });
  control.recordUsageEvent({ id: "use_mem", projectId: project.id, metric: "memory_mb_ms", quantity: 2048, recordedAt: from });
  control.recordUsageEvent({ id: "use_egress", projectId: project.id, metric: "egress_bytes", quantity: 512, recordedAt: from });
  control.recordUsageEvent({ id: "use_storage", projectId: project.id, metric: "storage_bytes", quantity: 4096, recordedAt: from });
  control.recordUsageEvent({ id: "use_sqlite", projectId: project.id, metric: "sqlite_unit", quantity: 2, recordedAt: from });
  control.recordUsageEvent({
    id: "use_old",
    projectId: project.id,
    metric: "invocation",
    quantity: 99,
    recordedAt: "2026-06-30T23:59:59.000Z",
  });

  assert.deepEqual(invocation, {
    id: "use_invocation",
    organizationId: organization.id,
    projectId: project.id,
    metric: "invocation",
    quantity: 1,
    dimensions: { cached: false, deploymentId: "dep_1", status: 200 },
    recordedAt: from,
  });
  assert.deepEqual(control.getProjectUsageSummary({ projectId: project.id, from, to }), {
    projectId: project.id,
    organizationId: organization.id,
    from,
    to,
    totals: {
      invocations: 1,
      cpuMs: 12.5,
      wallMs: 30,
      memoryMbMs: 2048,
      egressBytes: 512,
      storageBytes: 4096,
      sqliteUnits: 2,
    },
  });
  assert.throws(
    () => control.recordUsageEvent({ projectId: project.id, metric: "requests", quantity: 1 }),
    /usage metric/,
  );
});

test("control plane records usage events idempotently by event id", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectUsageQuotas: {
      prj_usage_idempotent: {
        period: "calendar_month",
        invocations: 1,
      },
    },
  });
  const project = control.createProject({ id: "prj_usage_idempotent", name: "usage idempotent" });
  const event = {
    id: "use_idempotent",
    projectId: project.id,
    metric: "invocation" as const,
    quantity: 1,
    dimensions: { deploymentId: "dep_idempotent", status: 200 },
    recordedAt: "2026-07-01T00:00:00.000Z",
  };

  assert.deepEqual(control.recordUsageEvent(event), control.recordUsageEvent(event));
  assert.deepEqual(control.getProjectUsageSummary({ projectId: project.id }).totals, {
    invocations: 1,
    cpuMs: 0,
    wallMs: 0,
    memoryMbMs: 0,
    egressBytes: 0,
    storageBytes: 0,
    sqliteUnits: 0,
  });
  assert.throws(
    () => control.recordUsageEvent({ ...event, quantity: 2 }),
    /usage event use_idempotent already exists with different payload/,
  );
});

test("control plane reports per-tenant enforcement status", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectEnforcementPolicies: {
      prj_enforce: {
        cpuMs: 10,
        memoryMbMs: 4096,
        storageBytes: 8192,
        concurrency: 4,
        rate: { requestsPerSecond: 100, burst: 200 },
      },
    },
  });
  const organization = control.createOrganization({ id: "org_enforce", name: "Enforce Org" });
  const project = control.createProject({
    id: "prj_enforce",
    name: "enforce",
    organizationId: organization.id,
  });
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-07-01T01:00:00.000Z";
  control.recordUsageEvent({
    id: "use_enforce_cpu",
    projectId: project.id,
    metric: "cpu_ms",
    quantity: 12,
    recordedAt: from,
  });
  control.recordUsageEvent({
    id: "use_enforce_mem",
    projectId: project.id,
    metric: "memory_mb_ms",
    quantity: 1024,
    recordedAt: from,
  });
  control.recordUsageEvent({
    id: "use_enforce_storage",
    projectId: project.id,
    metric: "storage_bytes",
    quantity: 2048,
    recordedAt: from,
  });

  assert.deepEqual(control.getProjectEnforcementReport({ projectId: project.id, from, to }), {
    projectId: project.id,
    organizationId: organization.id,
    generatedAt: fixedNow(),
    from,
    to,
    policy: {
      cpuMs: 10,
      memoryMbMs: 4096,
      storageBytes: 8192,
      concurrency: 4,
      rate: { requestsPerSecond: 100, burst: 200 },
    },
    usage: {
      cpuMs: 12,
      memoryMbMs: 1024,
      storageBytes: 2048,
    },
    resources: {
      artifacts: 0,
      deployments: 0,
      routes: 0,
      secrets: 0,
      kvNamespaces: 0,
    },
    enforcement: {
      cpu: { used: 12, limit: 10, remaining: 0, status: "exceeded" },
      memory: { used: 1024, limit: 4096, remaining: 3072, status: "ok" },
      storage: { used: 2048, limit: 8192, remaining: 6144, status: "ok" },
      concurrency: { limit: 4, status: "configured" },
      rate: { requestsPerSecond: 100, burst: 200, status: "configured" },
    },
  });
});

test("control plane enforces billing usage quotas from usage ledgers", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectUsageQuotas: {
      prj_billing_quota: {
        period: "calendar_month",
        invocations: 2,
        cpuMs: 100,
      },
    },
  });
  const organization = control.createOrganization({ id: "org_billing_quota", name: "Billing Quota Org" });
  const project = control.createProject({
    id: "prj_billing_quota",
    name: "billing quota",
    organizationId: organization.id,
  });

  control.recordUsageEvent({
    id: "use_billing_old",
    projectId: project.id,
    metric: "cpu_ms",
    quantity: 100,
    recordedAt: "2026-06-30T23:59:59.000Z",
  });
  control.recordUsageEvent({
    id: "use_billing_cpu",
    projectId: project.id,
    metric: "cpu_ms",
    quantity: 80,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_billing_invocation_1",
    projectId: project.id,
    metric: "invocation",
    quantity: 1,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_billing_invocation_2",
    projectId: project.id,
    metric: "invocation",
    quantity: 1,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });

  assert.throws(
    () =>
      control.recordUsageEvent({
        id: "use_billing_cpu_over",
        projectId: project.id,
        metric: "cpu_ms",
        quantity: 21,
        recordedAt: "2026-07-03T00:00:00.000Z",
      }),
    /usage quota exceeded.*cpuMs 101\/100.*2026-07/,
  );
  assert.throws(
    () =>
      control.recordUsageEvent({
        id: "use_billing_invocation_over",
        projectId: project.id,
        metric: "invocation",
        quantity: 1,
        recordedAt: "2026-07-03T00:00:00.000Z",
      }),
    /usage quota exceeded.*invocations 3\/2.*2026-07/,
  );

  assert.deepEqual(control.getProjectUsageQuotaReport({
    projectId: project.id,
    at: "2026-07-15T12:00:00.000Z",
  }), {
    projectId: project.id,
    organizationId: organization.id,
    generatedAt: fixedNow(),
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    limits: {
      period: "calendar_month",
      invocations: 2,
      cpuMs: 100,
    },
    usage: {
      invocations: 2,
      cpuMs: 80,
      wallMs: 0,
      memoryMbMs: 0,
      egressBytes: 0,
      storageBytes: 0,
      sqliteUnits: 0,
    },
    enforcement: {
      invocations: { used: 2, limit: 2, remaining: 0, status: "ok" },
      cpuMs: { used: 80, limit: 100, remaining: 20, status: "ok" },
      wallMs: { used: 0, status: "unlimited" },
      memoryMbMs: { used: 0, status: "unlimited" },
      egressBytes: { used: 0, status: "unlimited" },
      storageBytes: { used: 0, status: "unlimited" },
      sqliteUnits: { used: 0, status: "unlimited" },
    },
  });
});

test("control plane reports project billing statements from usage ledgers", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 0.4,
      cpuMsPerMillionUsd: 0.2,
    },
  });
  const organization = control.createOrganization({ id: "org_statement", name: "Statement Org" });
  const project = control.createProject({
    id: "prj_statement",
    name: "statement",
    organizationId: organization.id,
  });
  control.recordUsageEvent({
    id: "use_statement_invocation",
    projectId: project.id,
    metric: "invocation",
    quantity: 2_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_statement_cpu",
    projectId: project.id,
    metric: "cpu_ms",
    quantity: 500_000,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });

  const statement = control.getProjectBillingStatement({
    projectId: project.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(statement.projectId, project.id);
  assert.equal(statement.organizationId, organization.id);
  assert.equal(statement.generatedAt, fixedNow());
  assert.equal(statement.period.key, "2026-07");
  assert.deepEqual(statement.lineItems.map((item) => [item.metric, item.amountUsd]), [
    ["invocations", 0.8],
    ["cpuMs", 0.1],
  ]);
  assert.equal(statement.totalUsd, 0.9);
});

test("control plane reports organization billing statements across projects", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 0.4,
      sqliteUnitUsd: 2.5,
    },
  });
  const organization = control.createOrganization({ id: "org_billing_statement", name: "Billing Statement Org" });
  const projectA = control.createProject({
    id: "prj_statement_a",
    name: "statement-a",
    organizationId: organization.id,
  });
  const projectB = control.createProject({
    id: "prj_statement_b",
    name: "statement-b",
    organizationId: organization.id,
  });
  const otherOrganization = control.createOrganization({ id: "org_other_statement", name: "Other Statement Org" });
  const otherProject = control.createProject({
    id: "prj_statement_other",
    name: "statement-other",
    organizationId: otherOrganization.id,
  });
  control.recordUsageEvent({
    id: "use_statement_a_invocation",
    projectId: projectA.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_statement_b_sqlite",
    projectId: projectB.id,
    metric: "sqlite_unit",
    quantity: 2,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_statement_other_invocation",
    projectId: otherProject.id,
    metric: "invocation",
    quantity: 9_000_000,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });

  const statement = control.getOrganizationBillingStatement({
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(statement.organizationId, organization.id);
  assert.equal(statement.generatedAt, fixedNow());
  assert.equal(statement.period.key, "2026-07");
  assert.deepEqual(statement.projects.map((project) => [project.projectId, project.totalUsd]), [
    [projectA.id, 0.4],
    [projectB.id, 5],
  ]);
  assert.deepEqual(statement.usage, {
    invocations: 1_000_000,
    cpuMs: 0,
    wallMs: 0,
    memoryMbMs: 0,
    egressBytes: 0,
    storageBytes: 0,
    sqliteUnits: 2,
  });
  assert.equal(statement.totalUsd, 5.4);
});

test("control plane issues immutable organization billing invoices", () => {
  const repository = createMemoryRepository();
  const control = createControlPlane({
    repository,
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
    billingRateCardVersion: "2026-07-v1",
  });
  const organization = control.createOrganization({ id: "org_invoice", name: "Invoice Org" });
  const project = control.createProject({
    id: "prj_invoice",
    name: "invoice",
    organizationId: organization.id,
  });
  control.recordUsageEvent({
    id: "use_invoice_invocation",
    projectId: project.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });

  const invoice = control.issueOrganizationBillingInvoice({
    id: "inv_invoice_july",
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(invoice.id, "inv_invoice_july");
  assert.equal(invoice.organizationId, organization.id);
  assert.equal(invoice.periodKey, "2026-07");
  assert.equal(invoice.rateCardVersion, "2026-07-v1");
  assert.deepEqual(invoice.rates, { invocationsPerMillionUsd: 1 });
  assert.equal(invoice.statement.totalUsd, 1);
  assert.equal(invoice.totalUsd, 1);
  assert.match(invoice.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(invoice.issuedAt, fixedNow());

  const changedRateControl = createControlPlane({
    repository,
    idGenerator: sequenceIds(),
    now: () => "2026-08-01T00:00:00.000Z",
    projectBillingRates: {
      invocationsPerMillionUsd: 99,
    },
    billingRateCardVersion: "2026-07-v2",
  });
  const replayed = changedRateControl.issueOrganizationBillingInvoice({
    id: "inv_invoice_july_v2",
    organizationId: organization.id,
    at: "2026-07-20T00:00:00.000Z",
  });

  assert.equal(replayed.id, invoice.id);
  assert.equal(replayed.rateCardVersion, "2026-07-v1");
  assert.deepEqual(replayed.rates, { invocationsPerMillionUsd: 1 });
  assert.equal(replayed.statement.totalUsd, 1);
  assert.equal(replayed.contentDigest, invoice.contentDigest);
  assert.deepEqual(changedRateControl.getBillingInvoice({ id: invoice.id }), replayed);
  assert.deepEqual(
    changedRateControl.listOrganizationBillingInvoices({ organizationId: organization.id }),
    [invoice],
  );
});

test("control plane lists organization billing invoices newest first", () => {
  let currentNow = "2026-07-10T00:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: () => currentNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
  });
  const organization = control.createOrganization({ id: "org_invoice_list", name: "Invoice List Org" });
  const other = control.createOrganization({ id: "org_invoice_list_other", name: "Invoice List Other Org" });
  const project = control.createProject({
    id: "prj_invoice_list",
    name: "invoice list",
    organizationId: organization.id,
  });
  const otherProject = control.createProject({
    id: "prj_invoice_list_other",
    name: "invoice list other",
    organizationId: other.id,
  });
  control.recordUsageEvent({
    id: "use_invoice_list_july",
    projectId: project.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_invoice_list_august",
    projectId: project.id,
    metric: "invocation",
    quantity: 2_000_000,
    recordedAt: "2026-08-01T00:00:00.000Z",
  });
  control.recordUsageEvent({
    id: "use_invoice_list_other",
    projectId: otherProject.id,
    metric: "invocation",
    quantity: 3_000_000,
    recordedAt: "2026-08-01T00:00:00.000Z",
  });

  const july = control.issueOrganizationBillingInvoice({
    id: "inv_invoice_list_july",
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });
  currentNow = "2026-08-10T00:00:00.000Z";
  const august = control.issueOrganizationBillingInvoice({
    id: "inv_invoice_list_august",
    organizationId: organization.id,
    at: "2026-08-15T00:00:00.000Z",
  });
  control.issueOrganizationBillingInvoice({
    id: "inv_invoice_list_other",
    organizationId: other.id,
    at: "2026-08-15T00:00:00.000Z",
  });

  assert.deepEqual(
    control.listOrganizationBillingInvoices({ organizationId: organization.id }).map((invoice) => invoice.id),
    [august.id, july.id],
  );
  assert.throws(
    () => control.listOrganizationBillingInvoices({ organizationId: "org_missing" }),
    /organization org_missing was not found/,
  );
});

test("control plane enforces monthly billing budgets from usage ledgers", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
    projectBillingBudgets: {
      prj_billing_budget: {
        period: "calendar_month",
        maxUsd: 1,
      },
    },
  });
  const organization = control.createOrganization({ id: "org_billing_budget", name: "Billing Budget Org" });
  const project = control.createProject({
    id: "prj_billing_budget",
    name: "billing budget",
    organizationId: organization.id,
  });
  control.recordUsageEvent({
    id: "use_billing_budget_invocation",
    projectId: project.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });

  assert.throws(
    () =>
      control.recordUsageEvent({
        id: "use_billing_budget_over",
        projectId: project.id,
        metric: "invocation",
        quantity: 1_000_000,
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    /billing budget exceeded.*\$2\/\$1.*2026-07/,
  );

  const report = control.getProjectBillingBudgetReport({
    projectId: project.id,
    at: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(report.projectId, project.id);
  assert.equal(report.organizationId, organization.id);
  assert.equal(report.usedUsd, 1);
  assert.equal(report.limitUsd, 1);
  assert.equal(report.remainingUsd, 0);
  assert.equal(report.status, "ok");
});

test("async control plane reports per-tenant enforcement status", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectEnforcementPolicies: {
      prj_async_enforce: {
        cpuMs: 100,
        memoryMbMs: 4096,
        storageBytes: 1024,
        concurrency: 8,
        rate: { requestsPerSecond: 50 },
      },
    },
  });
  const organization = await control.createOrganization({
    id: "org_async_enforce",
    name: "Async Enforce Org",
  });
  const project = await control.createProject({
    id: "prj_async_enforce",
    name: "async enforce",
    organizationId: organization.id,
  });
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-07-01T01:00:00.000Z";
  await control.recordUsageEvent({
    id: "use_async_enforce_cpu",
    projectId: project.id,
    metric: "cpu_ms",
    quantity: 25,
    recordedAt: from,
  });
  await control.recordUsageEvent({
    id: "use_async_enforce_storage",
    projectId: project.id,
    metric: "storage_bytes",
    quantity: 2048,
    recordedAt: from,
  });

  const report = await control.getProjectEnforcementReport({ projectId: project.id, from, to });
  assert.equal(report.projectId, project.id);
  assert.equal(report.organizationId, organization.id);
  assert.equal(report.generatedAt, fixedNow());
  assert.deepEqual(report.enforcement.cpu, { used: 25, limit: 100, remaining: 75, status: "ok" });
  assert.deepEqual(report.enforcement.storage, { used: 2048, limit: 1024, remaining: 0, status: "exceeded" });
  assert.deepEqual(report.enforcement.concurrency, { limit: 8, status: "configured" });
  assert.deepEqual(report.enforcement.rate, { requestsPerSecond: 50, status: "configured" });
});

test("async control plane enforces billing usage quotas from usage ledgers", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectUsageQuotas: {
      prj_async_billing_quota: {
        period: "calendar_month",
        storageBytes: 1024,
      },
    },
  });
  const project = await control.createProject({
    id: "prj_async_billing_quota",
    name: "async billing quota",
  });

  await control.recordUsageEvent({
    id: "use_async_billing_storage",
    projectId: project.id,
    metric: "storage_bytes",
    quantity: 1024,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });

  await assert.rejects(
    () =>
      control.recordUsageEvent({
        id: "use_async_billing_storage_over",
        projectId: project.id,
        metric: "storage_bytes",
        quantity: 1,
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    /usage quota exceeded.*storageBytes 1025\/1024.*2026-07/,
  );
  const report = await control.getProjectUsageQuotaReport({
    projectId: project.id,
    at: "2026-07-15T00:00:00.000Z",
  });
  assert.deepEqual(report.enforcement.storageBytes, {
    used: 1024,
    limit: 1024,
    remaining: 0,
    status: "ok",
  });
});

test("async control plane reports project billing statements from usage ledgers", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      storageGbMonthUsd: 0.03,
    },
  });
  const project = await control.createProject({
    id: "prj_async_statement",
    name: "async statement",
  });
  await control.recordUsageEvent({
    id: "use_async_statement_storage",
    projectId: project.id,
    metric: "storage_bytes",
    quantity: 2 * 1024 ** 3,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });

  const statement = await control.getProjectBillingStatement({
    projectId: project.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(statement.projectId, project.id);
  assert.equal(statement.period.key, "2026-07");
  assert.deepEqual(statement.lineItems.map((item) => [item.metric, item.quantity, item.amountUsd]), [
    ["storageBytes", 2, 0.06],
  ]);
  assert.equal(statement.totalUsd, 0.06);
});

test("async control plane reports organization billing statements across projects", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 0.4,
    },
  });
  const organization = await control.createOrganization({
    id: "org_async_statement",
    name: "Async Statement Org",
  });
  const projectA = await control.createProject({
    id: "prj_async_statement_a",
    name: "async statement a",
    organizationId: organization.id,
  });
  const projectB = await control.createProject({
    id: "prj_async_statement_b",
    name: "async statement b",
    organizationId: organization.id,
  });
  await control.recordUsageEvent({
    id: "use_async_statement_a_invocation",
    projectId: projectA.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  await control.recordUsageEvent({
    id: "use_async_statement_b_invocation",
    projectId: projectB.id,
    metric: "invocation",
    quantity: 2_000_000,
    recordedAt: "2026-07-03T00:00:00.000Z",
  });

  const statement = await control.getOrganizationBillingStatement({
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(statement.organizationId, organization.id);
  assert.deepEqual(statement.projects.map((project) => [project.projectId, project.totalUsd]), [
    [projectA.id, 0.4],
    [projectB.id, 0.8],
  ]);
  assert.equal(statement.usage.invocations, 3_000_000);
  assert.equal(statement.totalUsd, 1.2);
});

test("async control plane issues immutable organization billing invoices", async () => {
  const repository = asyncRepository(createMemoryRepository());
  const control = createAsyncControlPlane({
    repository,
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
    billingRateCardVersion: "2026-07-v1",
  });
  const organization = await control.createOrganization({
    id: "org_async_invoice",
    name: "Async Invoice Org",
  });
  const project = await control.createProject({
    id: "prj_async_invoice",
    name: "async invoice",
    organizationId: organization.id,
  });
  await control.recordUsageEvent({
    id: "use_async_invoice_invocation",
    projectId: project.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });

  const invoice = await control.issueOrganizationBillingInvoice({
    id: "inv_async_invoice_july",
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(invoice.id, "inv_async_invoice_july");
  assert.equal(invoice.rateCardVersion, "2026-07-v1");
  assert.equal(invoice.statement.totalUsd, 1);
  assert.deepEqual(await control.getBillingInvoice({ id: invoice.id }), invoice);
  assert.deepEqual(
    await control.listOrganizationBillingInvoices({ organizationId: organization.id }),
    [invoice],
  );
});

test("async control plane lists organization billing invoices newest first", async () => {
  let currentNow = "2026-07-10T00:00:00.000Z";
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: () => currentNow,
    projectBillingRates: {
      invocationsPerMillionUsd: 1,
    },
  });
  const organization = await control.createOrganization({
    id: "org_async_invoice_list",
    name: "Async Invoice List Org",
  });
  const project = await control.createProject({
    id: "prj_async_invoice_list",
    name: "async invoice list",
    organizationId: organization.id,
  });
  await control.recordUsageEvent({
    id: "use_async_invoice_list_july",
    projectId: project.id,
    metric: "invocation",
    quantity: 1_000_000,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  await control.recordUsageEvent({
    id: "use_async_invoice_list_august",
    projectId: project.id,
    metric: "invocation",
    quantity: 2_000_000,
    recordedAt: "2026-08-01T00:00:00.000Z",
  });

  const july = await control.issueOrganizationBillingInvoice({
    id: "inv_async_invoice_list_july",
    organizationId: organization.id,
    at: "2026-07-15T00:00:00.000Z",
  });
  currentNow = "2026-08-10T00:00:00.000Z";
  const august = await control.issueOrganizationBillingInvoice({
    id: "inv_async_invoice_list_august",
    organizationId: organization.id,
    at: "2026-08-15T00:00:00.000Z",
  });

  assert.deepEqual(
    (await control.listOrganizationBillingInvoices({ organizationId: organization.id })).map((invoice) => invoice.id),
    [august.id, july.id],
  );
});

test("async control plane enforces monthly billing budgets from usage ledgers", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectBillingRates: {
      storageGbMonthUsd: 1,
    },
    projectBillingBudgets: {
      prj_async_billing_budget: {
        period: "calendar_month",
        maxUsd: 1,
      },
    },
  });
  const project = await control.createProject({
    id: "prj_async_billing_budget",
    name: "async billing budget",
  });
  await control.recordUsageEvent({
    id: "use_async_billing_budget_storage",
    projectId: project.id,
    metric: "storage_bytes",
    quantity: 1024 ** 3,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });

  await assert.rejects(
    () =>
      control.recordUsageEvent({
        id: "use_async_billing_budget_over",
        projectId: project.id,
        metric: "storage_bytes",
        quantity: 1024 ** 3,
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    /billing budget exceeded.*\$2\/\$1.*2026-07/,
  );

  const report = await control.getProjectBillingBudgetReport({
    projectId: project.id,
    at: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(report.projectId, project.id);
  assert.equal(report.usedUsd, 1);
  assert.equal(report.status, "ok");
});

test("async control plane manages tenant API keys and usage meters", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const organization = await control.createOrganization({ id: "org_async", name: "Async Org" });
  const user = await control.createUser({ id: "usr_async", email: "async@example.com" });
  const project = await control.createProject({
    id: "prj_async_tenant",
    name: "async tenant",
    organizationId: organization.id,
  });
  await control.addProjectMembership({ projectId: project.id, userId: user.id, role: "developer" });
  const key = await control.createApiKey({
    id: "key_async",
    projectId: project.id,
    name: "Async key",
    scopes: ["read", "write"],
  });
  await control.recordUsageEvent({
    id: "use_async",
    projectId: project.id,
    metric: "sqlite_unit",
    quantity: 3,
  });
  await control.recordUsageEvent({
    id: "use_async",
    projectId: project.id,
    metric: "sqlite_unit",
    quantity: 3,
  });

  assert.equal((await control.authenticateApiToken({ token: key.token }))?.apiKeyId, "key_async");
  assert.deepEqual(await control.listProjectMemberships({ projectId: project.id }), [{
    projectId: project.id,
    userId: user.id,
    role: "developer",
    createdAt: fixedNow(),
  }]);
  assert.deepEqual(await control.getProjectUsageSummary({ projectId: project.id }), {
    projectId: project.id,
    organizationId: organization.id,
    totals: {
      invocations: 0,
      cpuMs: 0,
      wallMs: 0,
      memoryMbMs: 0,
      egressBytes: 0,
      storageBytes: 0,
      sqliteUnits: 3,
    },
  });
});

test("async control plane preserves deployment validation", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const project = await control.createProject({ id: "prj_async", name: "async" });
  await control.createArtifact({
    id: "art_async",
    projectId: project.id,
    digest: digest("async"),
    location: "oci://registry.example.com/mizchi/async:v1",
    sizeBytes: 42,
  });

  await assert.rejects(
    () =>
      control.createDeployment({
        id: "dep_missing_secret",
        projectId: project.id,
        artifactId: "art_async",
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
    /secret sec_missing/,
  );
});

test("accepts remote HTTP artifact locations for runtime materialization", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_remote", name: "remote artifacts" });

  const artifact = control.createArtifact({
    id: "art_remote",
    projectId: project.id,
    digest: digest("remote"),
    location: "https://artifacts.example.dev/workers/hello.component.wasm",
    sizeBytes: 1024,
  });

  assert.equal(artifact.location, "https://artifacts.example.dev/workers/hello.component.wasm");
});

test("artifact signatures are verified before deployment and provenance is surfaced in snapshots", () => {
  const verifier = createHmacArtifactSignatureVerifier({ keys: { ci: "secret-key" } });
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    artifactSignatureVerifier: verifier,
  });
  const project = control.createProject({ id: "prj_signed", name: "signed" });
  const digestValue = digest("signed");
  const signature = signArtifactDigest(digestValue, { algorithm: "sha256-hmac", keyId: "ci" }, "secret-key");
  const artifact = control.createArtifact({
    id: "art_signed",
    projectId: project.id,
    digest: digestValue,
    location: "oci://registry.example.com/mizchi/signed:v1",
    sizeBytes: 42,
    signature,
    provenance: {
      builder: "github-actions",
      source: "github.com/mizchi/wasmplane",
      revision: "abc123",
      buildId: "run-1",
    },
  });

  const deployment = control.createDeployment({
    ...seedDeployment("dep_signed", artifact.id),
    projectId: project.id,
  });
  control.pointRoute({
    projectId: project.id,
    host: "signed.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  const snapshotArtifact = control.createRouteSnapshot().routes[0]?.artifact;
  assert.deepEqual(snapshotArtifact?.signature, signature);
  assert.deepEqual(snapshotArtifact?.provenance, artifact.provenance);

  const badArtifact = control.createArtifact({
    id: "art_bad_signature",
    projectId: project.id,
    digest: digest("bad-signature"),
    location: "oci://registry.example.com/mizchi/bad:v1",
    sizeBytes: 42,
    signature: { ...signature, value: "0".repeat(64) },
  });
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_signature", badArtifact.id),
        projectId: project.id,
      }),
    /signature verification failed/,
  );
});

test("control plane admission policy gates artifacts and deployment capabilities", () => {
  const signature = signArtifactDigest(digest("admission"), { algorithm: "sha256-hmac", keyId: "ci" }, "secret-key");
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    admissionPolicy: {
      requireArtifactSignature: true,
      allowedArtifactSignatureKeyIds: ["ci"],
      maxArtifactSizeBytes: 128,
      allowedWorlds: ["myedge:runtime/worker@0.1.0"],
      allowedWorldVersions: ["0.1.0"],
      allowedOutboundHttpPrefixes: ["https://api.example.com/v1"],
      allowedKvNamespaceIds: ["kv_allowed"],
      allowedSecretIds: ["sec_allowed"],
    },
  });
  const project = control.createProject({ id: "prj_admission", name: "admission" });
  control.createKvNamespace({ id: "kv_allowed", projectId: project.id, name: "Allowed KV" });
  control.createKvNamespace({ id: "kv_blocked", projectId: project.id, name: "Blocked KV" });
  control.createSecret({ id: "sec_allowed", projectId: project.id, name: "Allowed secret", value: "ok" });
  control.createSecret({ id: "sec_blocked", projectId: project.id, name: "Blocked secret", value: "no" });

  assert.throws(
    () =>
      control.createArtifact({
        id: "art_unsigned",
        projectId: project.id,
        digest: digest("unsigned-admission"),
        location: "oci://registry.example.com/mizchi/unsigned:v1",
        sizeBytes: 42,
      }),
    /signature is required/,
  );
  assert.throws(
    () =>
      control.createArtifact({
        id: "art_large",
        projectId: project.id,
        digest: digest("large-admission"),
        location: "oci://registry.example.com/mizchi/large:v1",
        sizeBytes: 129,
        signature: signArtifactDigest(digest("large-admission"), { algorithm: "sha256-hmac", keyId: "ci" }, "secret-key"),
      }),
    /artifact size/,
  );
  assert.throws(
    () =>
      control.createArtifact({
        id: "art_wrong_key",
        projectId: project.id,
        digest: digest("wrong-key-admission"),
        location: "oci://registry.example.com/mizchi/wrong-key:v1",
        sizeBytes: 42,
        signature: { ...signature, keyId: "dev" },
      }),
    /signature key/,
  );

  const artifact = control.createArtifact({
    id: "art_admission",
    projectId: project.id,
    digest: digest("admission"),
    location: "oci://registry.example.com/mizchi/admission:v1",
    sizeBytes: 42,
    signature,
  });
  const deployment = control.createDeployment({
    ...seedDeployment("dep_admission", artifact.id),
    projectId: project.id,
    capabilities: {
      outboundHttp: { enabled: true, allow: ["https://api.example.com/v1/users"] },
      kv: [{ binding: "MAIN", namespaceId: "kv_allowed" }],
      secrets: [{ binding: "API_KEY", secretId: "sec_allowed" }],
    },
  });
  assert.equal(deployment.id, "dep_admission");

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_blocked_outbound", artifact.id),
        projectId: project.id,
        capabilities: {
          outboundHttp: { enabled: true, allow: ["https://api.example.com/v2/users"] },
          kv: [{ binding: "MAIN", namespaceId: "kv_allowed" }],
          secrets: [{ binding: "API_KEY", secretId: "sec_allowed" }],
        },
      }),
    /outbound HTTP/,
  );
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_blocked_kv", artifact.id),
        projectId: project.id,
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_blocked" }],
          secrets: [{ binding: "API_KEY", secretId: "sec_allowed" }],
        },
      }),
    /kv namespace/,
  );
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_blocked_secret", artifact.id),
        projectId: project.id,
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_allowed" }],
          secrets: [{ binding: "API_KEY", secretId: "sec_blocked" }],
        },
      }),
    /secret/,
  );
});

test("async control plane admission policy enforces WIT world constraints", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
    admissionPolicy: {
      allowedWorldVersions: ["0.2.0"],
    },
  });
  const project = await control.createProject({ id: "prj_async_admission", name: "async admission" });
  const artifact = await control.createArtifact({
    id: "art_async_admission",
    projectId: project.id,
    digest: digest("async-admission"),
    location: "oci://registry.example.com/mizchi/async-admission:v1",
    sizeBytes: 42,
  });

  await assert.rejects(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_async_admission", artifact.id),
        projectId: project.id,
      }),
    /worldVersion/,
  );
});

test("control plane manages custom domain verification and TLS hooks", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_domain", name: "domain" });
  const domain = control.createCustomDomain({
    id: "dom_app",
    projectId: project.id,
    host: "App.Example.Dev",
  });

  assert.equal(domain.host, "app.example.dev");
  assert.equal(domain.status, "pending_verification");
  assert.equal(domain.tlsStatus, "none");
  assert.equal(domain.verificationRecordName, "_wasmplane-challenge.app.example.dev");
  assert.match(domain.verificationRecordValue, /^wasmplane-domain-verification=wmpdv_[a-f0-9]{32}$/);
  assert.deepEqual(control.listProjectCustomDomains({ projectId: project.id }), [domain]);

  const artifact = control.createArtifact({
    id: "art_domain",
    projectId: project.id,
    digest: digest("domain"),
    location: "oci://registry.example.com/mizchi/domain:v1",
    sizeBytes: 42,
  });
  const deployment = control.createDeployment({
    ...seedDeployment("dep_domain", artifact.id),
    projectId: project.id,
  });
  assert.throws(
    () =>
      control.pointRoute({
        projectId: project.id,
        host: domain.host,
        pathPrefix: "/",
        deploymentId: deployment.id,
      }),
    /custom domain .* is not active/,
  );

  const verified = control.verifyCustomDomainOwnership({
    id: domain.id,
    txtRecords: ["ignored", domain.verificationRecordValue],
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.verifiedAt, fixedNow());

  const pendingTls = control.requestCustomDomainTlsProvisioning({
    id: domain.id,
    provider: "fly",
    requestId: "cert_1",
  });
  assert.equal(pendingTls.status, "tls_pending");
  assert.equal(pendingTls.tlsStatus, "pending");
  assert.equal(pendingTls.tlsProvider, "fly");
  assert.equal(pendingTls.tlsRequestId, "cert_1");

  const active = control.completeCustomDomainTlsProvisioning({
    id: domain.id,
    ok: true,
    provider: "fly",
    requestId: "cert_1",
  });
  assert.equal(active.status, "active");
  assert.equal(active.tlsStatus, "provisioned");
  assert.equal(active.tlsProvisionedAt, fixedNow());

  const route = control.pointRoute({
    projectId: project.id,
    host: domain.host,
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  assert.equal(route.host, domain.host);

  const other = control.createProject({ id: "prj_other_domain", name: "other domain" });
  const otherArtifact = control.createArtifact({
    id: "art_other_domain",
    projectId: other.id,
    digest: digest("other-domain"),
    location: "oci://registry.example.com/mizchi/other-domain:v1",
    sizeBytes: 42,
  });
  const otherDeployment = control.createDeployment({
    ...seedDeployment("dep_other_domain", otherArtifact.id),
    projectId: other.id,
  });
  assert.throws(
    () =>
      control.pointRoute({
        projectId: other.id,
        host: domain.host,
        pathPrefix: "/",
        deploymentId: otherDeployment.id,
      }),
    /owned by another project/,
  );
});

test("async control plane manages custom domain hooks", async () => {
  const control = createAsyncControlPlane({
    repository: asyncRepository(createMemoryRepository()),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = await control.createProject({ id: "prj_async_domain", name: "async domain" });
  const domain = await control.createCustomDomain({
    id: "dom_async",
    projectId: project.id,
    host: "async.example.dev",
  });
  await control.verifyCustomDomainOwnership({
    id: domain.id,
    txtRecords: [domain.verificationRecordValue],
  });
  const failed = await control.completeCustomDomainTlsProvisioning({
    id: domain.id,
    ok: false,
    provider: "fly",
    requestId: "cert_async",
    error: "dns not ready",
  });

  assert.equal(failed.status, "tls_failed");
  assert.equal(failed.tlsStatus, "failed");
  assert.equal(failed.tlsError, "dns not ready");
});

test("registers project secrets and validates deployment secret bindings", () => {
  const control = createSeededControlPlane();
  const secret = control.createSecret({
    id: "sec_api_key",
    projectId: "prj_hello",
    name: "API key",
    value: "super-secret",
  });

  assert.deepEqual(secret, {
    id: "sec_api_key",
    projectId: "prj_hello",
    name: "API key",
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
  });
  assert.deepEqual(control.getSecret({ id: "sec_api_key" }), secret);
  assert.deepEqual(control.listProjectSecrets({ projectId: "prj_hello" }), [secret]);

  const updated = control.updateSecretValue({ id: "sec_api_key", value: "rotated-secret" });
  assert.deepEqual(updated, secret);

  const deployment = control.createDeployment({
    ...seedDeployment("dep_secret", "art_v1"),
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    },
  });
  control.pointRoute({
    projectId: "prj_hello",
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  const snapshotSecret = control.createRouteSnapshot().routes[0]?.capabilities.secrets[0];
  assert.deepEqual(snapshotSecret, { binding: "API_KEY", secretId: "sec_api_key" });
  assert.equal("value" in (snapshotSecret as any), false);

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_missing_secret", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_missing" }],
        },
      }),
    /secret sec_missing/,
  );
});

test("control plane encrypts secret values before repository persistence", () => {
  const repository = createMemoryRepository();
  const secretCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 4),
    keyId: "test-key",
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    },
  });
  const control = createControlPlane({
    repository,
    secretCipher,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_secure", name: "secure" });

  control.createSecret({
    id: "sec_secure",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });

  const stored = repository.getSecretValue("sec_secure");
  assert.equal(typeof stored, "string");
  assert.equal(isEncryptedSecretValue(stored as string), true);
  assert.equal((stored as string).includes("super-secret"), false);
  assert.equal(secretCipher.decrypt(stored as string), "super-secret");

  control.updateSecretValue({ id: "sec_secure", value: "rotated-secret" });
  const rotated = repository.getSecretValue("sec_secure") as string;
  assert.equal(isEncryptedSecretValue(rotated), true);
  assert.equal(secretCipher.decrypt(rotated), "rotated-secret");
});

test("async control plane encrypts secret values before repository persistence", async () => {
  const repository = createMemoryRepository();
  const secretCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 6),
    keyId: "async-test-key",
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    },
  });
  const control = createAsyncControlPlane({
    repository: asyncRepository(repository),
    secretCipher,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = await control.createProject({ id: "prj_secure_async", name: "secure async" });

  await control.createSecret({
    id: "sec_secure_async",
    projectId: project.id,
    name: "API key",
    value: "super-secret",
  });

  const stored = repository.getSecretValue("sec_secure_async") as string;
  assert.equal(isEncryptedSecretValue(stored), true);
  assert.equal(stored.includes("super-secret"), false);
  assert.equal(secretCipher.decrypt(stored), "super-secret");
});

test("deployment secret bindings cannot reference another project", () => {
  const control = createSeededControlPlane();
  const other = control.createProject({ id: "prj_other", name: "other" });
  control.createSecret({
    id: "sec_other",
    projectId: other.id,
    name: "other-api-key",
    value: "secret",
  });

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_cross_project_secret", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [],
          secrets: [{ binding: "API_KEY", secretId: "sec_other" }],
        },
      }),
    /same project/,
  );
});

test("project quotas reject resources beyond configured limits", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
    projectQuotas: {
      maxArtifacts: 1,
      maxDeployments: 1,
      maxRoutes: 1,
      maxSecrets: 1,
      maxKvNamespaces: 1,
    },
  });
  const project = control.createProject({ id: "prj_quota", name: "quota" });
  const artifact = control.createArtifact({
    id: "art_one",
    projectId: project.id,
    digest: digest("one"),
    location: "oci://registry.example.com/mizchi/one:v1",
    sizeBytes: 1,
  });
  control.createSecret({
    id: "sec_one",
    projectId: project.id,
    name: "one",
    value: "secret",
  });
  control.createKvNamespace({
    id: "kv_one",
    projectId: project.id,
    name: "one",
  });
  const deployment = control.createDeployment({
    ...seedDeployment("dep_one", artifact.id),
    projectId: project.id,
  });
  control.pointRoute({
    projectId: project.id,
    host: "quota.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });

  assert.throws(
    () =>
      control.createArtifact({
        id: "art_two",
        projectId: project.id,
        digest: digest("two"),
        location: "oci://registry.example.com/mizchi/two:v1",
        sizeBytes: 1,
      }),
    /artifact quota exceeded/,
  );
  assert.throws(
    () =>
      control.createSecret({
        id: "sec_two",
        projectId: project.id,
        name: "two",
        value: "secret",
      }),
    /secret quota exceeded/,
  );
  assert.throws(
    () =>
      control.createKvNamespace({
        id: "kv_two",
        projectId: project.id,
        name: "two",
      }),
    /kv namespace quota exceeded/,
  );
  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_two", artifact.id),
        projectId: project.id,
      }),
    /deployment quota exceeded/,
  );
  assert.throws(
    () =>
      control.pointRoute({
        projectId: project.id,
        host: "quota.example.dev",
        pathPrefix: "/two",
        deploymentId: deployment.id,
      }),
    /route quota exceeded/,
  );

  const updated = control.pointRoute({
    projectId: project.id,
    host: "quota.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  assert.equal(updated.deploymentId, deployment.id);
});

test("control plane exposes project resource usage", () => {
  const control = createSeededControlPlane();
  control.createSecret({
    id: "sec_usage",
    projectId: "prj_hello",
    name: "usage",
    value: "secret",
  });
  control.createKvNamespace({
    id: "kv_usage",
    projectId: "prj_hello",
    name: "usage",
  });
  const deployment = control.createDeployment(seedDeployment("dep_usage"));
  control.pointRoute({
    projectId: "prj_hello",
    host: "usage.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });

  assert.deepEqual(control.getProjectUsage({ projectId: "prj_hello" }), {
    artifacts: 2,
    deployments: 1,
    routes: 1,
    secrets: 1,
    kvNamespaces: 1,
  });
});

test("registers project KV namespaces and validates deployment bindings", () => {
  const control = createSeededControlPlane();
  const namespace = control.createKvNamespace({
    id: "kv_main",
    projectId: "prj_hello",
    name: "Main KV",
  });

  assert.deepEqual(namespace, {
    id: "kv_main",
    projectId: "prj_hello",
    name: "Main KV",
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
  });
  assert.deepEqual(control.getKvNamespace({ id: "kv_main" }), namespace);
  assert.deepEqual(control.listProjectKvNamespaces({ projectId: "prj_hello" }), [namespace]);

  const deployment = control.createDeployment({
    ...seedDeployment("dep_kv", "art_v1"),
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [],
    },
  });
  control.pointRoute({
    projectId: "prj_hello",
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: deployment.id,
  });
  assert.deepEqual(control.createRouteSnapshot().routes[0]?.capabilities.kv, [
    { binding: "MAIN", namespaceId: "kv_main" },
  ]);

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_missing_kv", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_missing" }],
          secrets: [],
        },
      }),
    /kv namespace kv_missing/,
  );
});

test("deployment KV bindings cannot reference another project", () => {
  const control = createSeededControlPlane();
  const other = control.createProject({ id: "prj_other", name: "other" });
  control.createKvNamespace({
    id: "kv_other",
    projectId: other.id,
    name: "Other KV",
  });

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_cross_project_kv", "art_v1"),
        capabilities: {
          outboundHttp: { enabled: false, allow: [] },
          kv: [{ binding: "MAIN", namespaceId: "kv_other" }],
          secrets: [],
        },
      }),
    /same project/,
  );
});

test("route pointers can roll forward and back without mutating deployments", () => {
  const control = createSeededControlPlane();

  const v1 = control.createDeployment(seedDeployment("dep_v1", "art_v1"));
  const v2 = control.createDeployment(seedDeployment("dep_v2", "art_v2"));

  control.pointRoute({
    projectId: v1.projectId,
    host: "Hello.Example.Dev",
    pathPrefix: "/",
    deploymentId: v1.id,
  });
  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: v2.id,
  });

  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, "dep_v2");

  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: v1.id,
  });

  const snapshot = control.createRouteSnapshot();
  assert.match(snapshot.id ?? "", /^snap_[a-f0-9]{16}$/);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0]?.host, "hello.example.dev");
  assert.equal(snapshot.routes[0]?.deploymentId, "dep_v1");
  assert.equal(snapshot.routes[0]?.artifact.digest, digest("v1"));
  assert.equal(snapshot.routes[0]?.runtime.backend, "wasmtime");
});

test("deploy previews expose preview URLs with environment bindings and one-command rollback", () => {
  const control = createSeededControlPlane();
  const stable = control.createDeployment(seedDeployment("dep_stable", "art_v1"));
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));
  control.pointRoute({
    id: "rte_preview",
    projectId: stable.projectId,
    host: "preview.example.dev",
    pathPrefix: "/preview",
    deploymentId: stable.id,
  });

  const preview = control.createDeployPreview({
    id: "prv_candidate",
    projectId: stable.projectId,
    deploymentId: candidate.id,
    host: "Preview.Example.Dev",
    pathPrefix: "/preview",
    environment: {
      FEATURE_FLAG: "on",
      API_BASE_URL: "https://api.example.dev",
    },
  });

  assert.equal(preview.url, "https://preview.example.dev/preview");
  assert.equal(preview.status, "active");
  assert.deepEqual(preview.environment, {
    API_BASE_URL: "https://api.example.dev",
    FEATURE_FLAG: "on",
  });
  assert.deepEqual(preview.previousRoute, {
    id: "rte_preview",
    deploymentId: stable.id,
    targets: [{ deploymentId: stable.id, weight: 100 }],
    updatedAt: fixedNow(),
  });
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, candidate.id);
  assert.deepEqual(control.listProjectDeployPreviews({ projectId: stable.projectId }), [preview]);

  const rolledBack = control.rollbackDeployPreview({ id: preview.id });

  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.rolledBackAt, fixedNow());
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, stable.id);
});

test("deploy preview rollback removes preview routes that had no previous route", () => {
  const control = createSeededControlPlane();
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));

  const preview = control.createDeployPreview({
    projectId: candidate.projectId,
    deploymentId: candidate.id,
    host: "ephemeral.example.dev",
    pathPrefix: "/",
  });
  assert.equal(preview.id, "prv_1");
  assert.equal(preview.url, "https://ephemeral.example.dev/");
  assert.equal(control.createRouteSnapshot().routes.length, 1);

  control.rollbackDeployPreview({ id: preview.id });

  assert.equal(control.createRouteSnapshot().routes.length, 0);
});

test("deploy preview environment bindings reject invalid keys", () => {
  const control = createSeededControlPlane();
  const deployment = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));

  assert.throws(
    () =>
      control.createDeployPreview({
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        host: "preview.example.dev",
        environment: { "bad-name": "1" },
      }),
    /environment binding keys/,
  );
});

test("deployment contract rejects runtimes and worlds outside the MVP contract", () => {
  const control = createSeededControlPlane();

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_backend", "art_v1"),
        runtime: { backend: "wasmedge", version: "wasmedge-1", wasi: "wasip3" },
      }),
    /wasmtime/,
  );

  assert.throws(
    () =>
      control.createDeployment({
        ...seedDeployment("dep_bad_world", "art_v1"),
        world: "wasi:http/proxy@0.2.0",
      }),
    /world/,
  );
});

test("registers runtime nodes for route snapshot publication", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const node = control.registerRuntimeNode({
    id: "rt_local",
    url: "http://127.0.0.1:8788/",
    region: "NRT",
    labels: { tier: "edge", pool: "default" },
    host: {
      backend: "wasmtime",
      wasi: "wasip3",
      runtimeVersion: "wasmplane-runtime/0.1.0",
      hostVersion: "wasmtime-43.0.0",
      engineVariant: "engine-abcd1234",
    },
  });

  assert.equal(node.id, "rt_local");
  assert.equal(node.url, "http://127.0.0.1:8788");
  assert.equal(node.status, "active");
  assert.equal(node.registeredAt, fixedNow());
  assert.equal(node.region, "nrt");
  assert.deepEqual(node.labels, { pool: "default", tier: "edge" });
  assert.deepEqual(node.host, {
    backend: "wasmtime",
    wasi: "wasip3",
    runtimeVersion: "wasmplane-runtime/0.1.0",
    hostVersion: "wasmtime-43.0.0",
    engineVariant: "engine-abcd1234",
  });
  assert.deepEqual(control.listRuntimeNodes(), [node]);

  assert.throws(
    () =>
      control.registerRuntimeNode({
        id: "rt_bad",
        url: "file:///tmp/runtime.sock",
      }),
    /runtime node url/,
  );
});

test("tracks runtime node heartbeat and excludes inactive nodes from publish targets", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_active", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_offline", url: "http://127.0.0.1:8789" });

  const heartbeat = control.recordRuntimeNodeHeartbeat({
    id: "rt_active",
    version: "wasmplane-runtime/0.1.0",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 64 },
    identity: { keyId: "rt-key", certificateSha256: "a".repeat(64) },
    host: {
      backend: "wasmtime",
      wasi: "wasip3",
      runtimeVersion: "wasmplane-runtime/0.1.0",
      hostVersion: "wasmtime-43.0.0",
      engineVariant: "engine-hot",
    },
  });
  control.recordRuntimeNodeHeartbeat({ id: "rt_offline", status: "offline" });

  assert.equal(heartbeat.status, "active");
  assert.equal(heartbeat.lastSeenAt, fixedNow());
  assert.equal(heartbeat.version, "wasmplane-runtime/0.1.0");
  assert.deepEqual(heartbeat.capacity, { concurrentRequests: 128, memoryMb: 4096 });
  assert.deepEqual(heartbeat.load, { activeRequests: 64 });
  assert.deepEqual(heartbeat.identity, { keyId: "rt-key", certificateSha256: "a".repeat(64) });
  assert.deepEqual(heartbeat.host, {
    backend: "wasmtime",
    wasi: "wasip3",
    runtimeVersion: "wasmplane-runtime/0.1.0",
    hostVersion: "wasmtime-43.0.0",
    engineVariant: "engine-hot",
  });
  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_active"],
  );
});

test("updates runtime node lifecycle status without rewriting heartbeat data", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_maint", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_maint",
    version: "wasmplane-runtime/0.1.0",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 3 },
  });

  const draining = control.updateRuntimeNodeStatus({ id: "rt_maint", status: "draining" });

  assert.equal(draining.status, "draining");
  assert.equal(draining.lastSeenAt, fixedNow());
  assert.equal(draining.version, "wasmplane-runtime/0.1.0");
  assert.deepEqual(draining.capacity, { concurrentRequests: 128, memoryMb: 4096 });
  assert.deepEqual(draining.load, { activeRequests: 3 });
  assert.deepEqual(control.listActiveRuntimeNodes(), []);

  const active = control.updateRuntimeNodeStatus({ id: "rt_maint", status: "active" });
  assert.equal(active.status, "active");
  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_maint"],
  );

  assert.throws(
    () => control.updateRuntimeNodeStatus({ id: "rt_missing", status: "offline" }),
    /runtime node rt_missing was not found/,
  );
});

test("cleans up old runtime nodes by lifecycle status", () => {
  let currentNow = "2026-06-26T10:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: () => currentNow,
  });

  control.registerRuntimeNode({ id: "rt_offline_old", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_offline_old", status: "offline" });
  control.registerRuntimeNode({ id: "rt_active_old", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_active_old", status: "active" });

  currentNow = "2026-06-26T11:50:00.000Z";
  control.registerRuntimeNode({ id: "rt_offline_fresh", url: "http://127.0.0.1:8790", status: "offline" });

  currentNow = "2026-06-26T12:00:00.000Z";
  const offlineCleanup = control.cleanupRuntimeNodes({ olderThanMs: 60 * 60 * 1000 });

  assert.equal(offlineCleanup.cutoff, "2026-06-26T11:00:00.000Z");
  assert.deepEqual(
    offlineCleanup.removed.map((node) => node.id),
    ["rt_offline_old"],
  );
  assert.deepEqual(
    control.listRuntimeNodes().map((node) => node.id),
    ["rt_active_old", "rt_offline_fresh"],
  );

  const activeCleanup = control.cleanupRuntimeNodes({
    olderThanMs: 60 * 60 * 1000,
    statuses: ["active"],
  });
  assert.deepEqual(
    activeCleanup.removed.map((node) => node.id),
    ["rt_active_old"],
  );
  assert.deepEqual(
    control.listRuntimeNodes().map((node) => node.id),
    ["rt_offline_fresh"],
  );

  assert.throws(
    () => control.cleanupRuntimeNodes({ olderThanMs: 0 }),
    /olderThanMs/,
  );
});

test("excludes saturated runtime nodes from active publish targets", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_room", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_full", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_room",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 127 },
  });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_full",
    capacity: { concurrentRequests: 128, memoryMb: 4096 },
    load: { activeRequests: 128 },
  });

  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_room"],
  );
});

test("excludes runtime nodes with stale heartbeat timestamps", () => {
  let currentNow = "2026-06-26T10:00:00.000Z";
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    runtimeNodeActiveTtlMs: 60_000,
    now: () => currentNow,
  });

  control.registerRuntimeNode({ id: "rt_fresh", url: "http://127.0.0.1:8788" });
  control.registerRuntimeNode({ id: "rt_stale", url: "http://127.0.0.1:8789" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_fresh" });
  control.recordRuntimeNodeHeartbeat({ id: "rt_stale" });

  currentNow = "2026-06-26T10:01:01.000Z";
  control.recordRuntimeNodeHeartbeat({ id: "rt_fresh" });

  assert.deepEqual(
    control.listActiveRuntimeNodes().map((node) => node.id),
    ["rt_fresh"],
  );
});

test("records route snapshot publication history", () => {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  const publication = control.recordRouteSnapshotPublication({
    snapshotId: "snap_test",
    snapshotGeneratedAt: "2026-06-26T09:59:00.000Z",
    routes: 2,
    ok: false,
    targets: [
      { id: "rt_active", url: "http://127.0.0.1:8788", ok: true, status: 200, routes: 2 },
      { id: "rt_offline", url: "http://127.0.0.1:8789", ok: false, error: "offline" },
    ],
  });

  assert.equal(publication.id, "pub_1");
  assert.equal(publication.snapshotId, "snap_test");
  assert.equal(publication.createdAt, fixedNow());
  assert.deepEqual(control.listRouteSnapshotPublications(), [publication]);
});

test("route snapshots can carry weighted rollout targets", () => {
  const control = createSeededControlPlane();
  const v1 = control.createDeployment(seedDeployment("dep_v1", "art_v1"));
  const v2 = control.createDeployment(seedDeployment("dep_v2", "art_v2"));

  control.pointRoute({
    projectId: v1.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    targets: [
      { deploymentId: v1.id, weight: 90 },
      { deploymentId: v2.id, weight: 10 },
    ],
  });

  const route = control.createRouteSnapshot().routes[0];
  assert.equal(route?.deploymentId, "dep_v1");
  assert.equal(route?.worldVersion, MVP_WORKER_WORLD_VERSION);
  assert.deepEqual(
    route?.targets.map((target) => ({
      deploymentId: target.deploymentId,
      weight: target.weight,
      worldVersion: target.worldVersion,
      digest: target.artifact.digest,
    })),
    [
      { deploymentId: "dep_v1", weight: 90, worldVersion: MVP_WORKER_WORLD_VERSION, digest: digest("v1") },
      { deploymentId: "dep_v2", weight: 10, worldVersion: MVP_WORKER_WORLD_VERSION, digest: digest("v2") },
    ],
  );
});

test("route canary controller starts canary and rolls back to stable deployment", () => {
  const control = createSeededControlPlane();
  const stable = control.createDeployment(seedDeployment("dep_stable", "art_v1"));
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));
  control.pointRoute({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: stable.id,
  });

  const canary = control.startRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: candidate.id,
    weight: 5,
  });

  assert.deepEqual(canary.targets, [
    { deploymentId: stable.id, weight: 95 },
    { deploymentId: candidate.id, weight: 5 },
  ]);

  const rollback = control.rollbackRoute({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
  });

  assert.deepEqual(rollback.targets, [{ deploymentId: stable.id, weight: 100 }]);
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, stable.id);
});

test("route canary analysis rolls back failed candidates and records decisions", () => {
  const control = createSeededControlPlane();
  const stable = control.createDeployment(seedDeployment("dep_stable", "art_v1"));
  const candidate = control.createDeployment(seedDeployment("dep_candidate", "art_v2"));
  control.pointRoute({
    id: "rte_canary",
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: stable.id,
  });
  control.startRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    deploymentId: candidate.id,
    weight: 10,
  });

  const result = control.analyzeRouteCanary({
    projectId: stable.projectId,
    host: "hello.example.dev",
    pathPrefix: "/",
    candidateDeploymentId: candidate.id,
    thresholds: { minRequests: 3, errorRate: 0.25, p95Ms: 250, rejectCount: 0 },
    events: [
      { deploymentId: stable.id, status: 200, durationMs: 50 },
      { deploymentId: candidate.id, status: 200, durationMs: 100 },
      { deploymentId: candidate.id, status: 200, durationMs: 200 },
      { deploymentId: candidate.id, status: 500, durationMs: 300 },
    ],
  });

  assert.equal(result.decision.id, "can_1");
  assert.equal(result.decision.action, "rollback");
  assert.equal(result.decision.reason, "error_rate");
  assert.deepEqual(result.decision.metrics, {
    requests: 3,
    errors: 1,
    rejects: 0,
    errorRate: 1 / 3,
    p95Ms: 300,
  });
  assert.deepEqual(result.route.targets, [{ deploymentId: stable.id, weight: 100 }]);
  assert.deepEqual(control.listCanaryDecisions(), [result.decision]);
  assert.equal(control.createRouteSnapshot().routes[0]?.deploymentId, stable.id);
});

test("sqlite repository records schema migrations and upgrades existing databases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-migrations-"));
  const dbPath = join(dir, "control.sqlite");
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(oldSchema);
  oldDb.close();

  const repository = createSqliteRepository(dbPath);
  const control = createControlPlane({
    repository,
    idGenerator: sequenceIds(),
    now: fixedNow,
  });

  control.registerRuntimeNode({ id: "rt_local", url: "http://127.0.0.1:8788" });
  control.recordRuntimeNodeHeartbeat({
    id: "rt_local",
    capacity: { concurrentRequests: 16, memoryMb: 1024 },
  });
  control.recordRouteSnapshotPublication({
    snapshotGeneratedAt: fixedNow(),
    routes: 0,
    ok: true,
    targets: [],
  });

  const db = new DatabaseSync(dbPath);
  const migrationIds = db
    .prepare("select id from schema_migrations order by id asc")
    .all()
    .map((row: any) => row.id);
  const routeColumns = db
    .prepare("pragma table_info(routes)")
    .all()
    .map((row: any) => row.name);
  const runtimeNodeColumns = db
    .prepare("pragma table_info(runtime_nodes)")
    .all()
    .map((row: any) => row.name);
  const secretColumns = db
    .prepare("pragma table_info(secrets)")
    .all()
    .map((row: any) => row.name);
  const kvNamespaceColumns = db
    .prepare("pragma table_info(kv_namespaces)")
    .all()
    .map((row: any) => row.name);

  assert.deepEqual(migrationIds, [
    "202606260001_wasip3_alias",
    "202606260002_route_targets",
    "202606260003_runtime_node_health",
    "202606260004_route_snapshot_publications",
    "202606270001_secret_registry",
    "202606270002_kv_namespace_registry",
    "202606300002_route_snapshot_id",
    "202606300003_runtime_node_placement",
    "202606300004_canary_decisions",
    "202606300005_worker_world_version",
    "202606300006_artifact_metadata",
    "202607010001_runtime_node_identity",
    "202607010002_runtime_node_host_info",
    "202607010003_fly_autoscaler_coordination",
    "202607010004_tenant_identity",
    "202607010005_usage_metering",
    "202607010006_custom_domains",
    "202607010007_deploy_previews",
    "202607020001_billing_invoices",
    "202607020002_billing_invoice_digest",
  ]);
  assert.ok(routeColumns.includes("targets_json"));
  const artifactColumns = db
    .prepare("pragma table_info(artifacts)")
    .all()
    .map((row: any) => row.name);
  assert.ok(artifactColumns.includes("signature_json"));
  assert.ok(artifactColumns.includes("provenance_json"));
  const deploymentColumns = db
    .prepare("pragma table_info(deployments)")
    .all()
    .map((row: any) => row.name);
  assert.ok(deploymentColumns.includes("world_version"));
  assert.ok(runtimeNodeColumns.includes("status"));
  assert.ok(runtimeNodeColumns.includes("region"));
  assert.ok(runtimeNodeColumns.includes("labels_json"));
  assert.ok(runtimeNodeColumns.includes("load_json"));
  assert.ok(runtimeNodeColumns.includes("identity_json"));
  assert.ok(runtimeNodeColumns.includes("host_json"));
  assert.ok(secretColumns.includes("value"));
  assert.ok(kvNamespaceColumns.includes("project_id"));
  const projectColumns = db
    .prepare("pragma table_info(projects)")
    .all()
    .map((row: any) => row.name);
  assert.ok(projectColumns.includes("organization_id"));
  assert.equal(db.prepare("select count(*) as count from organizations").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from users").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from project_memberships").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from api_keys").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from usage_events").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from custom_domains").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from deploy_previews").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from billing_invoices").get().count, 0);
  const billingInvoiceColumns = db
    .prepare("pragma table_info(billing_invoices)")
    .all()
    .map((row: any) => row.name);
  assert.ok(billingInvoiceColumns.includes("content_digest"));
  assert.equal(db.prepare("select count(*) as count from route_snapshot_publications").get().count, 1);
  const publicationColumns = db
    .prepare("pragma table_info(route_snapshot_publications)")
    .all()
    .map((row: any) => row.name);
  assert.ok(publicationColumns.includes("snapshot_id"));
  const canaryDecisionColumns = db
    .prepare("pragma table_info(canary_decisions)")
    .all()
    .map((row: any) => row.name);
  assert.ok(canaryDecisionColumns.includes("candidate_deployment_id"));
  db.close();
});

function createSeededControlPlane() {
  const control = createControlPlane({
    repository: createMemoryRepository(),
    idGenerator: sequenceIds(),
    now: fixedNow,
  });
  const project = control.createProject({ id: "prj_hello", name: "hello" });
  control.createArtifact({
    id: "art_v1",
    projectId: project.id,
    digest: digest("v1"),
    location: "oci://registry.example.com/mizchi/hello:v1",
    sizeBytes: 1,
  });
  control.createArtifact({
    id: "art_v2",
    projectId: project.id,
    digest: digest("v2"),
    location: "oci://registry.example.com/mizchi/hello:v2",
    sizeBytes: 2,
  });
  return control;
}

function asyncRepository(repository: ReturnType<typeof createMemoryRepository>) {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: any[]) => Promise.resolve(value.apply(target, args));
    },
  }) as any;
}

function seedDeployment(id: string, artifactId = "art_v1") {
  return {
    id,
    projectId: "prj_hello",
    artifactId,
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
  };
}

function sequenceIds() {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}

function fixedNow() {
  return "2026-06-26T10:00:00.000Z";
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

const oldSchema = `
pragma foreign_keys = on;

create table projects (
  id text primary key,
  name text not null unique,
  created_at text not null
);

create table artifacts (
  id text primary key,
  project_id text not null,
  digest text not null unique,
  location text not null,
  size_bytes integer not null,
  created_at text not null,
  foreign key (project_id) references projects(id)
);

create table deployments (
  id text primary key,
  project_id text not null,
  artifact_id text not null,
  world text not null,
  runtime_backend text not null,
  runtime_version text not null,
  wasi_version text not null,
  limits_json text not null,
  capabilities_json text not null,
  created_at text not null,
  foreign key (project_id) references projects(id),
  foreign key (artifact_id) references artifacts(id)
);

create table routes (
  id text primary key,
  project_id text not null,
  host text not null,
  path_prefix text not null,
  deployment_id text not null,
  updated_at text not null,
  unique (project_id, host, path_prefix),
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);

create table runtime_nodes (
  id text primary key,
  url text not null unique,
  registered_at text not null
);
`;
