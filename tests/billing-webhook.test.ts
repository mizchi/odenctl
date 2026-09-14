import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attemptBillingWebhookDelivery,
  createBillingInvoiceIssuedWebhookDelivery,
} from "../src/control-plane/billing-webhook.ts";
import { createOrganizationBillingInvoice } from "../src/control-plane/billing-invoice.ts";

test("billing webhook delivery attempts include idempotency headers and schedule retry", async () => {
  const invoice = createOrganizationBillingInvoice({
    id: "inv_webhook",
    organizationId: "org_webhook",
    period: {
      kind: "calendar_month",
      key: "2026-07",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    statement: {
      organizationId: "org_webhook",
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
  const delivery = createBillingInvoiceIssuedWebhookDelivery({
    id: "bwh_invoice",
    invoice,
    targetUrl: "https://accounting.example/webhooks/odenctl",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

  const retried = await attemptBillingWebhookDelivery(
    delivery,
    async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 503,
        text: async () => "temporarily unavailable",
      };
    },
    {
      now: () => "2026-08-01T00:00:00.000Z",
      retryDelayMs: 1_000,
      maxAttempts: 3,
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://accounting.example/webhooks/odenctl");
  assert.equal(requests[0].headers["idempotency-key"], delivery.idempotencyKey);
  assert.equal(requests[0].headers["x-oden-event-type"], "billing.invoice.issued");
  assert.equal(requests[0].body.invoice.id, invoice.id);
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.nextAttemptAt, "2026-08-01T00:00:01.000Z");

  const delivered = await attemptBillingWebhookDelivery(
    retried,
    async () => ({
      ok: true,
      status: 202,
      text: async () => "",
    }),
    {
      now: () => "2026-08-01T00:00:01.000Z",
      retryDelayMs: 1_000,
      maxAttempts: 3,
    },
  );

  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.attempts, 2);
  assert.equal(delivered.lastStatus, 202);
  assert.equal(delivered.deliveredAt, "2026-08-01T00:00:01.000Z");
  assert.equal(delivered.nextAttemptAt, undefined);
});
