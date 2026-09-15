import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingInvoiceRetentionOrganizationsFromEnv,
  pruneBillingInvoicesForOrganizations,
} from "../crates/odenctl/src/control-plane/billing-retention-job.ts";

test("billing invoice retention job parses organization ids from environment", () => {
  assert.deepEqual(
    billingInvoiceRetentionOrganizationsFromEnv(" org_a,org_b,, org_a "),
    ["org_a", "org_b"],
  );
  assert.deepEqual(billingInvoiceRetentionOrganizationsFromEnv(undefined), []);
});

test("billing invoice retention job aggregates prune reports and errors", async () => {
  const calls: any[] = [];
  const report = await pruneBillingInvoicesForOrganizations({
    organizationIds: ["org_a", "org_b"],
    at: "2026-10-01T00:00:00.000Z",
    controlPlane: {
      async pruneBillingInvoices(input: any) {
        calls.push(input);
        if (input.organizationId === "org_b") {
          throw new Error("database unavailable");
        }
        return {
          scanned: 2,
          deleted: [{ id: "inv_old" }],
          retained: [{ invoiceId: "inv_new", organizationId: "org_a", reason: "retention_active" }],
        };
      },
    },
  });

  assert.deepEqual(calls, [
    { organizationId: "org_a", at: "2026-10-01T00:00:00.000Z" },
    { organizationId: "org_b", at: "2026-10-01T00:00:00.000Z" },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.organizations, 2);
  assert.equal(report.scanned, 2);
  assert.equal(report.deleted, 1);
  assert.equal(report.retained, 1);
  assert.deepEqual(report.errors, [{ organizationId: "org_b", message: "database unavailable" }]);
});
