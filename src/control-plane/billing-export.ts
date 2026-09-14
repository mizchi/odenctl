import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { OrganizationBillingInvoice } from "./billing-invoice.ts";
import { ControlPlaneError } from "./errors.ts";

export interface BillingInvoiceExportSignature {
  algorithm: "sha256-hmac";
  keyId: string;
  value: string;
}

export interface BillingInvoiceExportSigner {
  keyId: string;
  key: string | Buffer | Uint8Array;
}

export interface BillingInvoiceExportBundle {
  kind: "wasmplane.billing.invoice.export";
  version: "1";
  invoice: OrganizationBillingInvoice;
  generatedAt: string;
  contentDigest: string;
  signature: BillingInvoiceExportSignature;
}

interface BillingInvoiceExportContent {
  kind: BillingInvoiceExportBundle["kind"];
  version: BillingInvoiceExportBundle["version"];
  invoice: OrganizationBillingInvoice;
  generatedAt: string;
}

export function createBillingInvoiceExportBundle(input: {
  invoice: OrganizationBillingInvoice;
  generatedAt: string;
  signer: BillingInvoiceExportSigner;
}): BillingInvoiceExportBundle {
  const content: BillingInvoiceExportContent = {
    kind: "wasmplane.billing.invoice.export",
    version: "1",
    invoice: input.invoice,
    generatedAt: input.generatedAt,
  };
  const contentDigest = billingInvoiceExportContentDigest(content);
  return {
    ...content,
    contentDigest,
    signature: signBillingInvoiceExportDigest(contentDigest, input.signer),
  };
}

export function verifyBillingInvoiceExportBundle(
  bundle: BillingInvoiceExportBundle,
  keys: Record<string, string | Buffer | Uint8Array>,
): void {
  const contentDigest = billingInvoiceExportContentDigest(bundle);
  if (bundle.contentDigest !== contentDigest) {
    throw new ControlPlaneError("validation", "billing invoice export content digest mismatch");
  }
  if (bundle.signature.algorithm !== "sha256-hmac") {
    throw new ControlPlaneError("validation", "unsupported billing invoice export signature algorithm");
  }
  const key = keys[bundle.signature.keyId];
  if (!key) {
    throw new ControlPlaneError("validation", "billing invoice export signature key is not configured");
  }
  const expected = signBillingInvoiceExportDigest(bundle.contentDigest, {
    keyId: bundle.signature.keyId,
    key,
  });
  if (!constantTimeHexEqual(bundle.signature.value, expected.value)) {
    throw new ControlPlaneError("validation", "billing invoice export signature verification failed");
  }
}

export function billingInvoiceExportSignerFromEnv(
  env: Record<string, string | undefined>,
): BillingInvoiceExportSigner | undefined {
  const keyId = firstNonEmpty(env.ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_ID);
  const keyBase64 = firstNonEmpty(env.ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_BASE64);
  const keyText = firstNonEmpty(env.ODENCTL_BILLING_EXPORT_SIGNATURE_KEY);
  if (!keyId && !keyBase64 && !keyText) {
    return undefined;
  }
  if (!keyId) {
    throw new ControlPlaneError("validation", "ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_ID is required");
  }
  if (!keyBase64 && !keyText) {
    throw new ControlPlaneError(
      "validation",
      "ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_BASE64 or ODENCTL_BILLING_EXPORT_SIGNATURE_KEY is required",
    );
  }
  const key = keyBase64 ? Buffer.from(keyBase64, "base64") : Buffer.from(keyText ?? "");
  if (key.byteLength === 0) {
    throw new ControlPlaneError("validation", "billing invoice export signature key must not be empty");
  }
  return { keyId, key };
}

function billingInvoiceExportContentDigest(content: BillingInvoiceExportContent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    kind: content.kind,
    version: content.version,
    invoice: content.invoice,
    generatedAt: content.generatedAt,
  })).digest("hex")}`;
}

function signBillingInvoiceExportDigest(
  digest: string,
  signer: BillingInvoiceExportSigner,
): BillingInvoiceExportSignature {
  return {
    algorithm: "sha256-hmac",
    keyId: signer.keyId,
    value: createHmac("sha256", signer.key).update(digest).digest("hex"),
  };
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
