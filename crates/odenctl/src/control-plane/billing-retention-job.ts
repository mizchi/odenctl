import type { PruneBillingInvoicesReport } from "./service.ts";

export interface BillingInvoiceRetentionPruneControlPlane {
  pruneBillingInvoices(input: {
    organizationId: string;
    at?: string;
  }): PruneBillingInvoicesReport | Promise<PruneBillingInvoicesReport>;
}

export interface BillingInvoiceRetentionPruneOrganizationReport {
  organizationId: string;
  report: PruneBillingInvoicesReport;
}

export interface BillingInvoiceRetentionPruneJobError {
  organizationId: string;
  message: string;
}

export interface BillingInvoiceRetentionPruneJobReport {
  ok: boolean;
  organizations: number;
  scanned: number;
  deleted: number;
  retained: number;
  reports: BillingInvoiceRetentionPruneOrganizationReport[];
  errors: BillingInvoiceRetentionPruneJobError[];
}

export function billingInvoiceRetentionOrganizationsFromEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  const organizations: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    organizations.push(id);
  }
  return organizations;
}

export async function pruneBillingInvoicesForOrganizations(input: {
  controlPlane: BillingInvoiceRetentionPruneControlPlane;
  organizationIds: string[];
  at?: string;
}): Promise<BillingInvoiceRetentionPruneJobReport> {
  const reports: BillingInvoiceRetentionPruneOrganizationReport[] = [];
  const errors: BillingInvoiceRetentionPruneJobError[] = [];
  for (const organizationId of input.organizationIds) {
    try {
      const report = await input.controlPlane.pruneBillingInvoices({
        organizationId,
        at: input.at,
      });
      reports.push({ organizationId, report });
    } catch (error) {
      errors.push({
        organizationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: errors.length === 0,
    organizations: input.organizationIds.length,
    scanned: reports.reduce((sum, item) => sum + item.report.scanned, 0),
    deleted: reports.reduce((sum, item) => sum + item.report.deleted.length, 0),
    retained: reports.reduce((sum, item) => sum + item.report.retained.length, 0),
    reports,
    errors,
  };
}
