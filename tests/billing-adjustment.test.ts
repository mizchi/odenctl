import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBillingInvoiceAdjustmentRecord,
  normalizeBillingInvoiceAdjustmentInput,
} from "../crates/odenctl/src/control-plane/billing-adjustment.ts";

test("billing invoice adjustment records are normalized separately from invoices", () => {
  const adjustment = createBillingInvoiceAdjustmentRecord({
    id: "adj_credit",
    invoiceId: "inv_credit",
    organizationId: "org_credit",
    type: "credit_note",
    amountUsd: 12.3456,
    reason: "service credit",
    createdAt: "2026-08-01T00:00:00.000Z",
  });

  assert.deepEqual(adjustment, {
    id: "adj_credit",
    invoiceId: "inv_credit",
    organizationId: "org_credit",
    type: "credit_note",
    currency: "USD",
    amountUsd: 12.35,
    reason: "service credit",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  assert.throws(
    () =>
      normalizeBillingInvoiceAdjustmentInput({
        type: "credit_note",
        amountUsd: -1,
        reason: "negative",
      }),
    /amountUsd must be a positive finite number/,
  );
});
