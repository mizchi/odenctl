import { normalizeUsageTimestamp } from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export interface BillingInvoiceRetentionPolicy {
  invoiceId: string;
  organizationId: string;
  retainUntil: string;
  legalHold: boolean;
  legalHoldReason?: string;
  updatedAt: string;
}

export interface BillingInvoiceRetentionPolicyInput {
  retainUntil: string;
  legalHold?: boolean;
  legalHoldReason?: string;
}

export type BillingInvoiceRetentionRetainedReason = "legal_hold" | "retention_active" | "no_policy";

export interface BillingInvoiceRetentionRetained {
  invoiceId: string;
  organizationId: string;
  reason: BillingInvoiceRetentionRetainedReason;
  retainUntil?: string;
  legalHoldReason?: string;
}

export interface BillingInvoiceRetentionSubject {
  id: string;
  organizationId: string;
}

export type BillingInvoiceRetentionDecision =
  | {
    action: "delete";
  }
  | {
    action: "retain";
    retained: BillingInvoiceRetentionRetained;
  };

export function createBillingInvoiceRetentionPolicyRecord(input: {
  invoiceId: string;
  organizationId: string;
  retainUntil: string;
  legalHold?: boolean;
  legalHoldReason?: string;
  updatedAt: string;
}): BillingInvoiceRetentionPolicy {
  const normalized = normalizeBillingInvoiceRetentionPolicyInput(input);
  return {
    invoiceId: input.invoiceId,
    organizationId: input.organizationId,
    updatedAt: input.updatedAt,
    ...normalized,
  };
}

export function decideBillingInvoiceRetention(input: {
  invoice: BillingInvoiceRetentionSubject;
  policy?: BillingInvoiceRetentionPolicy;
  at: string;
}): BillingInvoiceRetentionDecision {
  if (!input.policy) {
    return {
      action: "retain",
      retained: {
        invoiceId: input.invoice.id,
        organizationId: input.invoice.organizationId,
        reason: "no_policy",
      },
    };
  }
  if (input.policy.legalHold) {
    return {
      action: "retain",
      retained: {
        invoiceId: input.invoice.id,
        organizationId: input.invoice.organizationId,
        reason: "legal_hold",
        retainUntil: input.policy.retainUntil,
        ...(input.policy.legalHoldReason ? { legalHoldReason: input.policy.legalHoldReason } : {}),
      },
    };
  }
  if (input.policy.retainUntil > input.at) {
    return {
      action: "retain",
      retained: {
        invoiceId: input.invoice.id,
        organizationId: input.invoice.organizationId,
        reason: "retention_active",
        retainUntil: input.policy.retainUntil,
      },
    };
  }
  return { action: "delete" };
}

export function normalizeBillingInvoiceRetentionPolicyInput(
  input: BillingInvoiceRetentionPolicyInput,
): Required<Pick<BillingInvoiceRetentionPolicyInput, "retainUntil" | "legalHold">> &
  Pick<BillingInvoiceRetentionPolicyInput, "legalHoldReason"> {
  const retainUntil = normalizeUsageTimestamp(input.retainUntil, "billing invoice retention retainUntil");
  if (!retainUntil) {
    throw new ControlPlaneError("validation", "billing invoice retention retainUntil is required");
  }
  const legalHold = input.legalHold ?? false;
  const legalHoldReason = normalizeLegalHoldReason(input.legalHoldReason, legalHold);
  return {
    retainUntil,
    legalHold,
    ...(legalHoldReason ? { legalHoldReason } : {}),
  };
}

function normalizeLegalHoldReason(reason: string | undefined, legalHold: boolean): string | undefined {
  if (!legalHold) {
    return undefined;
  }
  const normalized = reason?.trim() ?? "";
  if (normalized.length === 0 || normalized.length > 500) {
    throw new ControlPlaneError(
      "validation",
      "billing invoice retention legalHoldReason must be between 1 and 500 characters",
    );
  }
  return normalized;
}
