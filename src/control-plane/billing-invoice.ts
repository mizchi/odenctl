import type {
  OrganizationBillingStatement,
  ProjectBillingRates,
} from "./billing-statement.ts";
import type { UsageQuotaPeriod } from "./usage-quota.ts";

export interface OrganizationBillingInvoice {
  id: string;
  organizationId: string;
  periodKey: string;
  period: UsageQuotaPeriod;
  currency: "USD";
  totalUsd: number;
  rates: ProjectBillingRates;
  rateCardVersion: string;
  statement: OrganizationBillingStatement;
  issuedAt: string;
}

export function createOrganizationBillingInvoice(input: {
  id: string;
  organizationId: string;
  period: UsageQuotaPeriod;
  statement: OrganizationBillingStatement;
  rates?: ProjectBillingRates;
  rateCardVersion: string;
  issuedAt: string;
}): OrganizationBillingInvoice {
  return {
    id: input.id,
    organizationId: input.organizationId,
    periodKey: input.period.key,
    period: input.period,
    currency: "USD",
    totalUsd: input.statement.totalUsd,
    rates: input.rates ?? {},
    rateCardVersion: input.rateCardVersion,
    statement: input.statement,
    issuedAt: input.issuedAt,
  };
}
