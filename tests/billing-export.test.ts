import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingInvoiceExportSignerFromEnv,
  createBillingInvoiceExportBundle,
  verifyBillingInvoiceExportBundle,
} from "../crates/odenctl/src/control-plane/billing-export.ts";
import { createOrganizationBillingInvoice } from "../crates/odenctl/src/control-plane/billing-invoice.ts";

test("billing invoice export bundle signs invoice payload digests", () => {
  const invoice = createOrganizationBillingInvoice({
    id: "inv_export",
    organizationId: "org_export",
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    statement: {
      organizationId: "org_export",
      period: {
        kind: "calendar_month",
        key: "2026-07",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      },
      projects: [],
      usage: {
        invocations: 0,
        cpuMs: 0,
        wallMs: 0,
        memoryMbMs: 0,
        egressBytes: 0,
        storageBytes: 0,
        sqliteUnits: 0,
      },
      lineItems: [],
      totalUsd: 0,
      generatedAt: "2026-07-31T00:00:00.000Z",
    },
    rateCardVersion: "2026-07-v1",
    issuedAt: "2026-07-31T00:00:00.000Z",
  });

  const bundle = createBillingInvoiceExportBundle({
    invoice,
    generatedAt: "2026-08-01T00:00:00.000Z",
    signer: { keyId: "billing", key: "secret-key" },
  });

  assert.equal(bundle.kind, "wasmplane.billing.invoice.export");
  assert.equal(bundle.version, "1");
  assert.equal(bundle.invoice.id, invoice.id);
  assert.match(bundle.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(bundle.signature, {
    algorithm: "sha256-hmac",
    keyId: "billing",
    value: bundle.signature.value,
  });
  assert.match(bundle.signature.value, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => verifyBillingInvoiceExportBundle(bundle, { billing: "secret-key" }));

  assert.throws(
    () =>
      verifyBillingInvoiceExportBundle(
        {
          ...bundle,
          invoice: { ...bundle.invoice, totalUsd: 1 },
        },
        { billing: "secret-key" },
      ),
    /content digest mismatch/,
  );
});

test("billing invoice export signer parses environment keys", () => {
  const signer = billingInvoiceExportSignerFromEnv({
    ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_ID: "acct",
    ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_BASE64: Buffer.from("accounting-secret").toString("base64"),
  });

  assert.equal(signer?.keyId, "acct");
  assert.equal(Buffer.from(signer?.key ?? "").toString(), "accounting-secret");
  assert.equal(billingInvoiceExportSignerFromEnv({}), undefined);
  assert.throws(
    () =>
      billingInvoiceExportSignerFromEnv({
        ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_BASE64: Buffer.from("missing id").toString("base64"),
      }),
    /ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_ID/,
  );
});
