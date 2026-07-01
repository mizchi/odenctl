import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProjectBillingBudgetReport,
  projectBillingBudgetsFromEnv,
} from "../src/control-plane/billing-budget.ts";

test("project billing budgets parse monthly USD limits from environment", () => {
  assert.deepEqual(projectBillingBudgetsFromEnv({
    WASMPLANE_BILLING_MONTHLY_USD_LIMITS: "prj_a=10.50,prj_b=0",
  }), {
    prj_a: { period: "calendar_month", maxUsd: 10.5 },
    prj_b: { period: "calendar_month", maxUsd: 0 },
  });
  assert.equal(projectBillingBudgetsFromEnv({}), undefined);
});

test("project billing budget report summarizes spend against limit", () => {
  const report = createProjectBillingBudgetReport({
    summary: {
      projectId: "prj_budget",
      organizationId: "org_budget",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      totals: {
        invocations: 2_000_000,
        cpuMs: 0,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 0,
        storageBytes: 0,
        sqliteUnits: 0,
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
    },
    policy: {
      period: "calendar_month",
      maxUsd: 1,
    },
    generatedAt: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(report.projectId, "prj_budget");
  assert.equal(report.organizationId, "org_budget");
  assert.equal(report.usedUsd, 0.8);
  assert.equal(report.limitUsd, 1);
  assert.equal(report.remainingUsd, 0.2);
  assert.equal(report.status, "ok");
  assert.equal(report.statement.totalUsd, 0.8);
});
