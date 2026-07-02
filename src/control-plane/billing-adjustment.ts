import { ControlPlaneError } from "./errors.ts";

export type BillingInvoiceAdjustmentType = "credit_note" | "debit_adjustment";

export interface BillingInvoiceAdjustment {
  id: string;
  invoiceId: string;
  organizationId: string;
  type: BillingInvoiceAdjustmentType;
  currency: "USD";
  amountUsd: number;
  reason: string;
  createdAt: string;
}

export interface BillingInvoiceAdjustmentInput {
  type: BillingInvoiceAdjustmentType;
  amountUsd: number;
  reason: string;
}

export function createBillingInvoiceAdjustmentRecord(input: {
  id: string;
  invoiceId: string;
  organizationId: string;
  type: BillingInvoiceAdjustmentType;
  amountUsd: number;
  reason: string;
  createdAt: string;
}): BillingInvoiceAdjustment {
  const normalized = normalizeBillingInvoiceAdjustmentInput(input);
  return {
    id: input.id,
    invoiceId: input.invoiceId,
    organizationId: input.organizationId,
    currency: "USD",
    createdAt: input.createdAt,
    ...normalized,
  };
}

export function normalizeBillingInvoiceAdjustmentInput(
  input: BillingInvoiceAdjustmentInput,
): BillingInvoiceAdjustmentInput {
  if (input.type !== "credit_note" && input.type !== "debit_adjustment") {
    throw new ControlPlaneError("validation", "billing invoice adjustment type must be credit_note or debit_adjustment");
  }
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new ControlPlaneError("validation", "billing invoice adjustment amountUsd must be a positive finite number");
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new ControlPlaneError("validation", "billing invoice adjustment reason must be between 1 and 500 characters");
  }
  return {
    type: input.type,
    amountUsd: roundMoney(input.amountUsd),
    reason,
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
