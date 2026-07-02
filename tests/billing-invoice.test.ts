import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrganizationBillingInvoice } from "../src/control-plane/billing-invoice.ts";

test("organization billing invoice snapshots statement and rate card", () => {
  const invoice = createOrganizationBillingInvoice({
    id: "inv_july",
    organizationId: "org_bill",
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    statement: {
      organizationId: "org_bill",
      generatedAt: "2026-07-31T00:00:00.000Z",
      currency: "USD",
      period: {
        kind: "calendar_month",
        key: "2026-07",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      },
      usage: {
        invocations: 1_000_000,
        cpuMs: 0,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 0,
        storageBytes: 0,
        sqliteUnits: 0,
      },
      projects: [],
      totalUsd: 0.4,
    },
    rates: {
      invocationsPerMillionUsd: 0.4,
    },
    rateCardVersion: "2026-07-v1",
    issuedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.deepEqual(invoice, {
    id: "inv_july",
    organizationId: "org_bill",
    periodKey: "2026-07",
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    currency: "USD",
    totalUsd: 0.4,
    rates: {
      invocationsPerMillionUsd: 0.4,
    },
    rateCardVersion: "2026-07-v1",
    statement: {
      organizationId: "org_bill",
      generatedAt: "2026-07-31T00:00:00.000Z",
      currency: "USD",
      period: {
        kind: "calendar_month",
        key: "2026-07",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      },
      usage: {
        invocations: 1_000_000,
        cpuMs: 0,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 0,
        storageBytes: 0,
        sqliteUnits: 0,
      },
      projects: [],
      totalUsd: 0.4,
    },
    issuedAt: "2026-08-01T00:00:00.000Z",
  });
});
