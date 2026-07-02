import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBillingInvoiceRetentionPolicyRecord,
  decideBillingInvoiceRetention,
  normalizeBillingInvoiceRetentionPolicyInput,
} from "../src/control-plane/billing-retention.ts";

test("billing invoice retention policies are normalized separately from invoices", () => {
  const policy = createBillingInvoiceRetentionPolicyRecord({
    invoiceId: "inv_hold",
    organizationId: "org_hold",
    retainUntil: "2026-10-01T00:00:00.000Z",
    legalHold: true,
    legalHoldReason: "  dispute review  ",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.deepEqual(policy, {
    invoiceId: "inv_hold",
    organizationId: "org_hold",
    retainUntil: "2026-10-01T00:00:00.000Z",
    legalHold: true,
    legalHoldReason: "dispute review",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
});

test("billing invoice retention policies reject empty legal hold reasons", () => {
  assert.throws(
    () =>
      normalizeBillingInvoiceRetentionPolicyInput({
        retainUntil: "2026-10-01T00:00:00.000Z",
        legalHold: true,
        legalHoldReason: " ",
      }),
    /legalHoldReason must be between 1 and 500 characters/,
  );
});

test("billing invoice retention decisions classify policy state", () => {
  const invoice = { id: "inv_retention", organizationId: "org_retention" };
  const policy = createBillingInvoiceRetentionPolicyRecord({
    invoiceId: invoice.id,
    organizationId: invoice.organizationId,
    retainUntil: "2026-09-01T00:00:00.000Z",
    legalHold: true,
    legalHoldReason: "audit",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.deepEqual(decideBillingInvoiceRetention({ invoice, at: "2026-09-15T00:00:00.000Z" }), {
    action: "retain",
    retained: {
      invoiceId: invoice.id,
      organizationId: invoice.organizationId,
      reason: "no_policy",
    },
  });
  assert.deepEqual(decideBillingInvoiceRetention({ invoice, policy, at: "2026-09-15T00:00:00.000Z" }), {
    action: "retain",
    retained: {
      invoiceId: invoice.id,
      organizationId: invoice.organizationId,
      reason: "legal_hold",
      retainUntil: "2026-09-01T00:00:00.000Z",
      legalHoldReason: "audit",
    },
  });
  assert.deepEqual(
    decideBillingInvoiceRetention({
      invoice,
      policy: { ...policy, legalHold: false, legalHoldReason: undefined, retainUntil: "2026-12-01T00:00:00.000Z" },
      at: "2026-09-15T00:00:00.000Z",
    }),
    {
      action: "retain",
      retained: {
        invoiceId: invoice.id,
        organizationId: invoice.organizationId,
        reason: "retention_active",
        retainUntil: "2026-12-01T00:00:00.000Z",
      },
    },
  );
  assert.deepEqual(
    decideBillingInvoiceRetention({
      invoice,
      policy: { ...policy, legalHold: false, legalHoldReason: undefined },
      at: "2026-09-15T00:00:00.000Z",
    }),
    { action: "delete" },
  );
});
