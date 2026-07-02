import type { OrganizationBillingInvoice } from "./billing-invoice.ts";
import { ControlPlaneError } from "./errors.ts";

export type BillingWebhookEventType = "billing.invoice.issued";
export type BillingWebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface BillingInvoiceIssuedWebhookPayload {
  eventType: BillingWebhookEventType;
  idempotencyKey: string;
  invoice: OrganizationBillingInvoice;
  occurredAt: string;
}

export type BillingWebhookPayload = BillingInvoiceIssuedWebhookPayload;

export interface BillingWebhookDelivery {
  id: string;
  eventType: BillingWebhookEventType;
  targetUrl: string;
  idempotencyKey: string;
  status: BillingWebhookDeliveryStatus;
  payload: BillingWebhookPayload;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastStatus?: number;
  lastError?: string;
  deliveredAt?: string;
}

export type BillingWebhookFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface BillingWebhookAttemptOptions {
  now?: () => string;
  maxAttempts?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
}

export function createBillingInvoiceIssuedWebhookDelivery(input: {
  id: string;
  invoice: OrganizationBillingInvoice;
  targetUrl: string;
  createdAt: string;
}): BillingWebhookDelivery {
  const targetUrl = normalizeWebhookTargetUrl(input.targetUrl);
  const idempotencyKey = billingInvoiceIssuedIdempotencyKey(input.invoice);
  return {
    id: input.id,
    eventType: "billing.invoice.issued",
    targetUrl,
    idempotencyKey,
    status: "pending",
    payload: {
      eventType: "billing.invoice.issued",
      idempotencyKey,
      invoice: input.invoice,
      occurredAt: input.createdAt,
    },
    attempts: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export async function attemptBillingWebhookDelivery(
  delivery: BillingWebhookDelivery,
  fetchImpl: BillingWebhookFetchLike = fetch,
  options: BillingWebhookAttemptOptions = {},
): Promise<BillingWebhookDelivery> {
  if (delivery.status !== "pending") {
    return delivery;
  }
  const attemptOptions = normalizeAttemptOptions(options);
  const attemptedAt = attemptOptions.now();
  const attempts = delivery.attempts + 1;
  try {
    const body = JSON.stringify(delivery.payload);
    const response = await fetchImpl(delivery.targetUrl, {
      method: "POST",
      headers: billingWebhookHeaders(delivery),
      body,
    });
    if (response.ok) {
      return {
        ...delivery,
        status: "delivered",
        attempts,
        updatedAt: attemptedAt,
        lastAttemptAt: attemptedAt,
        lastStatus: response.status,
        lastError: undefined,
        nextAttemptAt: undefined,
        deliveredAt: attemptedAt,
      };
    }
    const error = await response.text();
    return failedOrPendingDelivery({
      delivery,
      attempts,
      attemptedAt,
      status: response.status,
      error,
      retryable: attemptOptions.retryOnStatuses.has(response.status) || response.status >= 500,
      maxAttempts: attemptOptions.maxAttempts,
      retryDelayMs: attemptOptions.retryDelayMs,
    });
  } catch (error) {
    return failedOrPendingDelivery({
      delivery,
      attempts,
      attemptedAt,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
      maxAttempts: attemptOptions.maxAttempts,
      retryDelayMs: attemptOptions.retryDelayMs,
    });
  }
}

export function billingInvoiceIssuedIdempotencyKey(invoice: OrganizationBillingInvoice): string {
  return `billing.invoice.issued:${invoice.id}:${invoice.contentDigest}`;
}

function billingWebhookHeaders(delivery: BillingWebhookDelivery): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": delivery.idempotencyKey,
    "x-wasmplane-delivery-id": delivery.id,
    "x-wasmplane-event-type": delivery.eventType,
  };
}

function failedOrPendingDelivery(input: {
  delivery: BillingWebhookDelivery;
  attempts: number;
  attemptedAt: string;
  status?: number;
  error: string;
  retryable: boolean;
  maxAttempts: number;
  retryDelayMs: number;
}): BillingWebhookDelivery {
  const canRetry = input.retryable && input.attempts < input.maxAttempts;
  return {
    ...input.delivery,
    status: canRetry ? "pending" : "failed",
    attempts: input.attempts,
    updatedAt: input.attemptedAt,
    lastAttemptAt: input.attemptedAt,
    ...(input.status === undefined ? {} : { lastStatus: input.status }),
    lastError: input.error,
    nextAttemptAt: canRetry ? addMilliseconds(input.attemptedAt, input.retryDelayMs) : undefined,
    deliveredAt: undefined,
  };
}

function normalizeWebhookTargetUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ControlPlaneError("validation", "billing webhook target URL must not be empty");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ControlPlaneError("validation", "billing webhook target URL must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ControlPlaneError("validation", "billing webhook target URL must use http or https");
  }
  return url.toString();
}

function normalizeAttemptOptions(options: BillingWebhookAttemptOptions) {
  return {
    now: options.now ?? (() => new Date().toISOString()),
    maxAttempts: positiveInteger(options.maxAttempts, 3),
    retryDelayMs: nonnegativeInteger(options.retryDelayMs, 1_000),
    retryOnStatuses: new Set(options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504]),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlPlaneError("validation", "billing webhook maxAttempts must be a positive integer");
  }
  return value;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ControlPlaneError("validation", "billing webhook retryDelayMs must be a non-negative integer");
  }
  return value;
}

function addMilliseconds(value: string, ms: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ControlPlaneError("validation", "billing webhook timestamp must be an ISO timestamp");
  }
  return new Date(timestamp + ms).toISOString();
}
