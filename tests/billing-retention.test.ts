import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBillingInvoiceRetentionPolicyRecord,
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
