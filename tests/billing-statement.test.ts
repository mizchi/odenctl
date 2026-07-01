import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOrganizationBillingStatement,
  createProjectBillingStatement,
  projectBillingRatesFromEnv,
} from "../src/control-plane/billing-statement.ts";

test("project billing rates parse invoice price card from environment", () => {
  assert.deepEqual(projectBillingRatesFromEnv({
    WASMPLANE_BILLING_INVOCATION_PER_MILLION_USD: "0.40",
    WASMPLANE_BILLING_CPU_MS_PER_MILLION_USD: "0.20",
    WASMPLANE_BILLING_WALL_MS_PER_MILLION_USD: "0.10",
    WASMPLANE_BILLING_MEMORY_MB_MS_PER_MILLION_USD: "0.05",
    WASMPLANE_BILLING_EGRESS_GB_USD: "0.09",
    WASMPLANE_BILLING_STORAGE_GB_MONTH_USD: "0.03",
    WASMPLANE_BILLING_SQLITE_UNIT_USD: "2.50",
  }), {
    invocationsPerMillionUsd: 0.4,
    cpuMsPerMillionUsd: 0.2,
    wallMsPerMillionUsd: 0.1,
    memoryMbMsPerMillionUsd: 0.05,
    egressGbUsd: 0.09,
    storageGbMonthUsd: 0.03,
    sqliteUnitUsd: 2.5,
  });
  assert.equal(projectBillingRatesFromEnv({}), undefined);
});

test("project billing statement creates invoice-ready usage line items", () => {
  const statement = createProjectBillingStatement({
    summary: {
      projectId: "prj_bill",
      organizationId: "org_bill",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      totals: {
        invocations: 2_000_000,
        cpuMs: 500_000,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 2 * 1024 ** 3,
        storageBytes: 10 * 1024 ** 3,
        sqliteUnits: 3,
      },
    },
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    rates: {
      invocationsPerMillionUsd: 0.4,
      cpuMsPerMillionUsd: 0.2,
      egressGbUsd: 0.09,
      storageGbMonthUsd: 0.03,
      sqliteUnitUsd: 2.5,
    },
    generatedAt: "2026-07-15T00:00:00.000Z",
  });

  assert.deepEqual(statement, {
    projectId: "prj_bill",
    organizationId: "org_bill",
    generatedAt: "2026-07-15T00:00:00.000Z",
    currency: "USD",
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    usage: {
      invocations: 2_000_000,
      cpuMs: 500_000,
      wallMs: 0,
      memoryMbMs: 0,
      egressBytes: 2 * 1024 ** 3,
      storageBytes: 10 * 1024 ** 3,
      sqliteUnits: 3,
    },
    lineItems: [
      {
        metric: "invocations",
        quantity: 2,
        unit: "million invocations",
        unitPriceUsd: 0.4,
        amountUsd: 0.8,
      },
      {
        metric: "cpuMs",
        quantity: 0.5,
        unit: "million cpu ms",
        unitPriceUsd: 0.2,
        amountUsd: 0.1,
      },
      {
        metric: "egressBytes",
        quantity: 2,
        unit: "GB",
        unitPriceUsd: 0.09,
        amountUsd: 0.18,
      },
      {
        metric: "storageBytes",
        quantity: 10,
        unit: "GB-month",
        unitPriceUsd: 0.03,
        amountUsd: 0.3,
      },
      {
        metric: "sqliteUnits",
        quantity: 3,
        unit: "unit-month",
        unitPriceUsd: 2.5,
        amountUsd: 7.5,
      },
    ],
    totalUsd: 8.88,
  });
});

test("organization billing statement aggregates project usage and totals", () => {
  const statement = createOrganizationBillingStatement({
    organizationId: "org_bill",
    summaries: [
      {
        projectId: "prj_a",
        organizationId: "org_bill",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        totals: {
          invocations: 1_000_000,
          cpuMs: 0,
          wallMs: 0,
          memoryMbMs: 0,
          egressBytes: 0,
          storageBytes: 0,
          sqliteUnits: 1,
        },
      },
      {
        projectId: "prj_b",
        organizationId: "org_bill",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        totals: {
          invocations: 2_000_000,
          cpuMs: 0,
          wallMs: 0,
          memoryMbMs: 0,
          egressBytes: 0,
          storageBytes: 0,
          sqliteUnits: 2,
        },
      },
    ],
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    rates: {
      invocationsPerMillionUsd: 0.4,
      sqliteUnitUsd: 2.5,
    },
    generatedAt: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(statement.organizationId, "org_bill");
  assert.deepEqual(statement.usage, {
    invocations: 3_000_000,
    cpuMs: 0,
    wallMs: 0,
    memoryMbMs: 0,
    egressBytes: 0,
    storageBytes: 0,
    sqliteUnits: 3,
  });
  assert.deepEqual(statement.projects.map((project) => [project.projectId, project.totalUsd]), [
    ["prj_a", 2.9],
    ["prj_b", 5.8],
  ]);
  assert.equal(statement.totalUsd, 8.7);
});
