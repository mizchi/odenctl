import { readFile } from "node:fs/promises";
import pg from "pg";
import type { AsyncControlPlaneRepository } from "./async-service.ts";
import type { ProjectResourceUsage } from "./repository.ts";
import type {
  ApiKey,
  Artifact,
  CanaryDecision,
  CustomDomain,
  DeployPreview,
  Deployment,
  DurableObjectNamespace,
  EdgeWorkerReleaseOperation,
  EdgeWorkerRelease,
  KvNamespace,
  Organization,
  Project,
  ProjectMembership,
  ProjectUsageSummary,
  RoutePointer,
  RouteSnapshotPublication,
  RuntimeNode,
  RuntimeNodeStatus,
  Secret,
  UsageEvent,
  User,
} from "./contracts.ts";
import { ControlPlaneError, isControlPlaneError } from "./errors.ts";
import { invoiceContentDigest, type OrganizationBillingInvoice } from "./billing-invoice.ts";
import type { BillingWebhookDelivery, BillingWebhookDeliveryStatus } from "./billing-webhook.ts";
import type { BillingInvoiceAdjustment } from "./billing-adjustment.ts";
import type { BillingInvoiceRetentionPolicy } from "./billing-retention.ts";

const { Pool } = pg;
const initMigrationId = "202606300001_postgres_init";
const initMigrationUrl = new URL("../../db/postgres/001_init.sql", import.meta.url);
export const POSTGRES_SCHEMA_MIGRATION_IDS = [initMigrationId];

export interface PostgresRepositoryOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
}

export async function createPostgresRepository(
  options: PostgresRepositoryOptions,
): Promise<PostgresControlPlaneRepository> {
  const pool = new Pool(createPostgresPoolConfig(options));
  const repository = new PostgresControlPlaneRepository(pool);
  await repository.migrate();
  return repository;
}

export function createPostgresPoolConfig(options: PostgresRepositoryOptions) {
  return {
    connectionString: options.ssl === undefined
      ? options.connectionString
      : stripPostgresSslQueryParams(options.connectionString),
    max: options.max ?? 10,
    ssl: options.ssl === undefined
      ? undefined
      : options.ssl
      ? { rejectUnauthorized: false }
      : false,
  };
}

export async function applyPostgresMigrations(
  options: PostgresRepositoryOptions,
): Promise<void> {
  const repository = await createPostgresRepository(options);
  await repository.close();
}

function stripPostgresSslQueryParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    let changed = false;
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : connectionString;
  } catch {
    return connectionString;
  }
}

export class PostgresControlPlaneRepository implements AsyncControlPlaneRepository {
  pool: any;

  constructor(pool: any) {
    this.pool = pool;
  }

  async migrate(): Promise<void> {
    const schema = await readFile(initMigrationUrl, "utf8");
    await this.pool.query("begin");
    try {
      await this.pool.query(schema);
      await this.pool.query(
        `insert into schema_migrations (id, applied_at)
         values ($1, $2)
         on conflict (id) do nothing`,
        [initMigrationId, new Date().toISOString()],
      );
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createOrganization(organization: Organization): Promise<Organization> {
    try {
      await this.pool.query(
        "insert into organizations (id, name, created_at) values ($1, $2, $3)",
        [organization.id, organization.name, organization.createdAt],
      );
      return organization;
    } catch (error) {
      throw writeError("organization", organization.id, error);
    }
  }

  async getOrganization(id: string): Promise<Organization | undefined> {
    const result = await this.pool.query("select * from organizations where id = $1", [id]);
    return result.rows[0] ? organizationFromRow(result.rows[0]) : undefined;
  }

  async createUser(user: User): Promise<User> {
    try {
      await this.pool.query(
        "insert into users (id, email, name, created_at) values ($1, $2, $3, $4)",
        [user.id, user.email, user.name ?? null, user.createdAt],
      );
      return user;
    } catch (error) {
      throw writeError("user", user.id, error);
    }
  }

  async getUser(id: string): Promise<User | undefined> {
    const result = await this.pool.query("select * from users where id = $1", [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async createProjectMembership(
    membership: ProjectMembership,
  ): Promise<ProjectMembership> {
    try {
      const result = await this.pool.query(
        `insert into project_memberships (project_id, user_id, role, created_at)
         values ($1, $2, $3, $4)
         on conflict (project_id, user_id) do update set role = excluded.role
         returning *`,
        [membership.projectId, membership.userId, membership.role, membership.createdAt],
      );
      return membershipFromRow(result.rows[0]);
    } catch (error) {
      throw writeError("project membership", `${membership.projectId}/${membership.userId}`, error);
    }
  }

  async listProjectMemberships(projectId: string): Promise<ProjectMembership[]> {
    const result = await this.pool.query(
      "select * from project_memberships where project_id = $1 order by user_id asc",
      [projectId],
    );
    return result.rows.map(membershipFromRow);
  }

  async createApiKey(apiKey: ApiKey, tokenHash: string): Promise<ApiKey> {
    try {
      await this.pool.query(
        `insert into api_keys (
          id,
          organization_id,
          project_id,
          name,
          token_hash,
          scopes_json,
          created_at,
          last_used_at,
          revoked_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          apiKey.id,
          apiKey.organizationId ?? null,
          apiKey.projectId ?? null,
          apiKey.name,
          tokenHash,
          JSON.stringify(apiKey.scopes),
          apiKey.createdAt,
          apiKey.lastUsedAt ?? null,
          apiKey.revokedAt ?? null,
        ],
      );
      return apiKey;
    } catch (error) {
      throw writeError("api key", apiKey.id, error);
    }
  }

  async getApiKeyByTokenHash(tokenHash: string): Promise<ApiKey | undefined> {
    const result = await this.pool.query("select * from api_keys where token_hash = $1", [tokenHash]);
    return result.rows[0] ? apiKeyFromRow(result.rows[0]) : undefined;
  }

  async listProjectApiKeys(projectId: string): Promise<ApiKey[]> {
    const result = await this.pool.query(
      "select * from api_keys where project_id = $1 order by created_at desc, id desc",
      [projectId],
    );
    return result.rows.map(apiKeyFromRow);
  }

  async updateApiKeyLastUsed(id: string, lastUsedAt: string): Promise<ApiKey> {
    const result = await this.pool.query(
      `update api_keys set last_used_at = $1
       where id = $2
       returning *`,
      [lastUsedAt, id],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `api key ${id} was not found`);
    }
    return apiKeyFromRow(result.rows[0]);
  }

  async createUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    try {
      await this.pool.query(
        `insert into usage_events (
          id,
          organization_id,
          project_id,
          metric,
          quantity,
          dimensions_json,
          recorded_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          event.id,
          event.organizationId ?? null,
          event.projectId,
          event.metric,
          event.quantity,
          event.dimensions ? JSON.stringify(event.dimensions) : null,
          event.recordedAt,
        ],
      );
      return event;
    } catch (error) {
      throw writeError("usage event", event.id, error);
    }
  }

  async getUsageEvent(id: string): Promise<UsageEvent | undefined> {
    const result = await this.pool.query("select * from usage_events where id = $1", [id]);
    return result.rows[0] ? usageEventFromRow(result.rows[0]) : undefined;
  }

  async getProjectUsageSummary(
    projectId: string,
    from?: string,
    to?: string,
  ): Promise<ProjectUsageSummary> {
    const params: string[] = [projectId];
    const where = ["project_id = $1"];
    if (from) {
      params.push(from);
      where.push(`recorded_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`recorded_at < $${params.length}`);
    }
    const result = await this.pool.query(
      `select
        coalesce(sum(case when metric = 'invocation' then quantity else 0 end), 0)::float8 as invocations,
        coalesce(sum(case when metric = 'cpu_ms' then quantity else 0 end), 0)::float8 as cpu_ms,
        coalesce(sum(case when metric = 'wall_ms' then quantity else 0 end), 0)::float8 as wall_ms,
        coalesce(sum(case when metric = 'memory_mb_ms' then quantity else 0 end), 0)::float8 as memory_mb_ms,
        coalesce(sum(case when metric = 'egress_bytes' then quantity else 0 end), 0)::float8 as egress_bytes,
        coalesce(sum(case when metric = 'storage_bytes' then quantity else 0 end), 0)::float8 as storage_bytes,
        coalesce(sum(case when metric = 'sqlite_unit' then quantity else 0 end), 0)::float8 as sqlite_units
       from usage_events
       where ${where.join(" and ")}`,
      params,
    );
    const project = await this.getProject(projectId);
    return usageSummaryFromRow(projectId, project?.organizationId, from, to, result.rows[0]);
  }

  async createBillingInvoice(
    invoice: OrganizationBillingInvoice,
  ): Promise<OrganizationBillingInvoice> {
    try {
      await this.pool.query(
        `insert into billing_invoices (
          id,
          organization_id,
          period_key,
          period_json,
          currency,
          total_usd,
          rates_json,
          rate_card_version,
          content_digest,
          statement_json,
          issued_at
        ) values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)`,
        [
          invoice.id,
          invoice.organizationId,
          invoice.periodKey,
          JSON.stringify(invoice.period),
          invoice.currency,
          invoice.totalUsd,
          JSON.stringify(invoice.rates),
          invoice.rateCardVersion,
          invoice.contentDigest,
          JSON.stringify(invoice.statement),
          invoice.issuedAt,
        ],
      );
      return invoice;
    } catch (error) {
      throw writeError("billing invoice", invoice.id, error);
    }
  }

  async getBillingInvoice(id: string): Promise<OrganizationBillingInvoice | undefined> {
    const result = await this.pool.query("select * from billing_invoices where id = $1", [id]);
    return result.rows[0] ? billingInvoiceFromRow(result.rows[0]) : undefined;
  }

  async getOrganizationBillingInvoiceByPeriod(
    organizationId: string,
    periodKey: string,
  ): Promise<OrganizationBillingInvoice | undefined> {
    const result = await this.pool.query(
      "select * from billing_invoices where organization_id = $1 and period_key = $2",
      [organizationId, periodKey],
    );
    return result.rows[0] ? billingInvoiceFromRow(result.rows[0]) : undefined;
  }

  async listOrganizationBillingInvoices(
    organizationId: string,
  ): Promise<OrganizationBillingInvoice[]> {
    const result = await this.pool.query(
      `select * from billing_invoices
       where organization_id = $1
       order by issued_at desc, id desc`,
      [organizationId],
    );
    return result.rows.map(billingInvoiceFromRow);
  }

  async deleteBillingInvoice(id: string): Promise<OrganizationBillingInvoice> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query("select * from billing_invoices where id = $1", [id]);
      if (!result.rows[0]) {
        throw new ControlPlaneError("not_found", `billing invoice ${id} was not found`);
      }
      const invoice = billingInvoiceFromRow(result.rows[0]);
      await client.query("delete from billing_invoice_adjustments where invoice_id = $1", [id]);
      await client.query("delete from billing_invoice_retention_policies where invoice_id = $1", [id]);
      await client.query(
        `delete from billing_webhook_deliveries
         where event_type = 'billing.invoice.issued'
           and payload_json -> 'invoice' ->> 'id' = $1`,
        [id],
      );
      await client.query("delete from billing_invoices where id = $1", [id]);
      await client.query("commit");
      return invoice;
    } catch (error) {
      await client.query("rollback");
      if (isControlPlaneError(error)) {
        throw error;
      }
      throw writeError("billing invoice", id, error);
    } finally {
      client.release();
    }
  }

  async createBillingWebhookDelivery(
    delivery: BillingWebhookDelivery,
  ): Promise<BillingWebhookDelivery> {
    try {
      await this.pool.query(
        `insert into billing_webhook_deliveries (
          id,
          event_type,
          target_url,
          idempotency_key,
          status,
          payload_json,
          attempts,
          next_attempt_at,
          last_attempt_at,
          last_status,
          last_error,
          created_at,
          updated_at,
          delivered_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          delivery.id,
          delivery.eventType,
          delivery.targetUrl,
          delivery.idempotencyKey,
          delivery.status,
          JSON.stringify(delivery.payload),
          delivery.attempts,
          delivery.nextAttemptAt ?? null,
          delivery.lastAttemptAt ?? null,
          delivery.lastStatus ?? null,
          delivery.lastError ?? null,
          delivery.createdAt,
          delivery.updatedAt,
          delivery.deliveredAt ?? null,
        ],
      );
      return delivery;
    } catch (error) {
      throw writeError("billing webhook delivery", delivery.id, error);
    }
  }

  async getBillingWebhookDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BillingWebhookDelivery | undefined> {
    const result = await this.pool.query(
      "select * from billing_webhook_deliveries where idempotency_key = $1",
      [idempotencyKey],
    );
    return result.rows[0] ? billingWebhookDeliveryFromRow(result.rows[0]) : undefined;
  }

  async listBillingWebhookDeliveries(
    status?: BillingWebhookDeliveryStatus,
  ): Promise<BillingWebhookDelivery[]> {
    const result = status
      ? await this.pool.query(
        `select * from billing_webhook_deliveries
         where status = $1
         order by created_at asc, id asc`,
        [status],
      )
      : await this.pool.query(
        `select * from billing_webhook_deliveries
         order by created_at asc, id asc`,
      );
    return result.rows.map(billingWebhookDeliveryFromRow);
  }

  async updateBillingWebhookDelivery(
    delivery: BillingWebhookDelivery,
  ): Promise<BillingWebhookDelivery> {
    const result = await this.pool.query(
      `update billing_webhook_deliveries set
        status = $1,
        payload_json = $2::jsonb,
        attempts = $3,
        next_attempt_at = $4,
        last_attempt_at = $5,
        last_status = $6,
        last_error = $7,
        updated_at = $8,
        delivered_at = $9
       where id = $10`,
      [
        delivery.status,
        JSON.stringify(delivery.payload),
        delivery.attempts,
        delivery.nextAttemptAt ?? null,
        delivery.lastAttemptAt ?? null,
        delivery.lastStatus ?? null,
        delivery.lastError ?? null,
        delivery.updatedAt,
        delivery.deliveredAt ?? null,
        delivery.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `billing webhook delivery ${delivery.id} was not found`);
    }
    return delivery;
  }

  async createBillingInvoiceAdjustment(
    adjustment: BillingInvoiceAdjustment,
  ): Promise<BillingInvoiceAdjustment> {
    try {
      await this.pool.query(
        `insert into billing_invoice_adjustments (
          id,
          invoice_id,
          organization_id,
          type,
          currency,
          amount_usd,
          reason,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          adjustment.id,
          adjustment.invoiceId,
          adjustment.organizationId,
          adjustment.type,
          adjustment.currency,
          adjustment.amountUsd,
          adjustment.reason,
          adjustment.createdAt,
        ],
      );
      return adjustment;
    } catch (error) {
      throw writeError("billing invoice adjustment", adjustment.id, error);
    }
  }

  async listBillingInvoiceAdjustments(invoiceId: string): Promise<BillingInvoiceAdjustment[]> {
    const result = await this.pool.query(
      `select * from billing_invoice_adjustments
       where invoice_id = $1
       order by created_at asc, id asc`,
      [invoiceId],
    );
    return result.rows.map(billingInvoiceAdjustmentFromRow);
  }

  async upsertBillingInvoiceRetentionPolicy(
    policy: BillingInvoiceRetentionPolicy,
  ): Promise<BillingInvoiceRetentionPolicy> {
    try {
      await this.pool.query(
        `insert into billing_invoice_retention_policies (
          invoice_id,
          organization_id,
          retain_until,
          legal_hold,
          legal_hold_reason,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6)
        on conflict (invoice_id) do update set
          organization_id = excluded.organization_id,
          retain_until = excluded.retain_until,
          legal_hold = excluded.legal_hold,
          legal_hold_reason = excluded.legal_hold_reason,
          updated_at = excluded.updated_at`,
        [
          policy.invoiceId,
          policy.organizationId,
          policy.retainUntil,
          policy.legalHold,
          policy.legalHoldReason ?? null,
          policy.updatedAt,
        ],
      );
      return policy;
    } catch (error) {
      throw writeError("billing invoice retention policy", policy.invoiceId, error);
    }
  }

  async getBillingInvoiceRetentionPolicy(invoiceId: string): Promise<BillingInvoiceRetentionPolicy | undefined> {
    const result = await this.pool.query("select * from billing_invoice_retention_policies where invoice_id = $1", [
      invoiceId,
    ]);
    return result.rows[0] ? billingInvoiceRetentionPolicyFromRow(result.rows[0]) : undefined;
  }

  async createCustomDomain(domain: CustomDomain): Promise<CustomDomain> {
    try {
      await this.pool.query(
        `insert into custom_domains (
          id,
          project_id,
          host,
          status,
          verification_token,
          verification_record_name,
          verification_record_value,
          tls_status,
          tls_provider,
          tls_request_id,
          tls_error,
          created_at,
          updated_at,
          verified_at,
          tls_provisioned_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          domain.id,
          domain.projectId,
          domain.host,
          domain.status,
          domain.verificationToken,
          domain.verificationRecordName,
          domain.verificationRecordValue,
          domain.tlsStatus,
          domain.tlsProvider ?? null,
          domain.tlsRequestId ?? null,
          domain.tlsError ?? null,
          domain.createdAt,
          domain.updatedAt,
          domain.verifiedAt ?? null,
          domain.tlsProvisionedAt ?? null,
        ],
      );
      return domain;
    } catch (error) {
      throw writeError("custom domain", domain.id, error);
    }
  }

  async getCustomDomain(id: string): Promise<CustomDomain | undefined> {
    const result = await this.pool.query("select * from custom_domains where id = $1", [id]);
    return result.rows[0] ? customDomainFromRow(result.rows[0]) : undefined;
  }

  async getCustomDomainByHost(host: string): Promise<CustomDomain | undefined> {
    const result = await this.pool.query("select * from custom_domains where host = $1", [host]);
    return result.rows[0] ? customDomainFromRow(result.rows[0]) : undefined;
  }

  async listProjectCustomDomains(projectId: string): Promise<CustomDomain[]> {
    const result = await this.pool.query(
      "select * from custom_domains where project_id = $1 order by host asc, id asc",
      [projectId],
    );
    return result.rows.map(customDomainFromRow);
  }

  async updateCustomDomain(domain: CustomDomain): Promise<CustomDomain> {
    const result = await this.pool.query(
      `update custom_domains set
        status = $1,
        tls_status = $2,
        tls_provider = $3,
        tls_request_id = $4,
        tls_error = $5,
        updated_at = $6,
        verified_at = $7,
        tls_provisioned_at = $8
       where id = $9
       returning *`,
      [
        domain.status,
        domain.tlsStatus,
        domain.tlsProvider ?? null,
        domain.tlsRequestId ?? null,
        domain.tlsError ?? null,
        domain.updatedAt,
        domain.verifiedAt ?? null,
        domain.tlsProvisionedAt ?? null,
        domain.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `custom domain ${domain.id} was not found`);
    }
    return customDomainFromRow(result.rows[0]);
  }

  async createDeployPreview(preview: DeployPreview): Promise<DeployPreview> {
    try {
      await this.pool.query(
        `insert into deploy_previews (
          id,
          project_id,
          deployment_id,
          host,
          path_prefix,
          url,
          environment_json,
          previous_route_json,
          status,
          created_at,
          updated_at,
          rolled_back_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
        [
          preview.id,
          preview.projectId,
          preview.deploymentId,
          preview.host,
          preview.pathPrefix,
          preview.url,
          JSON.stringify(preview.environment),
          preview.previousRoute ? JSON.stringify(preview.previousRoute) : null,
          preview.status,
          preview.createdAt,
          preview.updatedAt,
          preview.rolledBackAt ?? null,
        ],
      );
      return preview;
    } catch (error) {
      throw writeError("deploy preview", preview.id, error);
    }
  }

  async getDeployPreview(id: string): Promise<DeployPreview | undefined> {
    const result = await this.pool.query("select * from deploy_previews where id = $1", [id]);
    return result.rows[0] ? deployPreviewFromRow(result.rows[0]) : undefined;
  }

  async listProjectDeployPreviews(projectId: string): Promise<DeployPreview[]> {
    const result = await this.pool.query(
      "select * from deploy_previews where project_id = $1 order by created_at desc, id desc",
      [projectId],
    );
    return result.rows.map(deployPreviewFromRow);
  }

  async updateDeployPreview(preview: DeployPreview): Promise<DeployPreview> {
    const result = await this.pool.query(
      `update deploy_previews set
        status = $1,
        updated_at = $2,
        rolled_back_at = $3
       where id = $4
       returning *`,
      [preview.status, preview.updatedAt, preview.rolledBackAt ?? null, preview.id],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `deploy preview ${preview.id} was not found`);
    }
    return deployPreviewFromRow(result.rows[0]);
  }

  async createEdgeWorkerRelease(release: EdgeWorkerRelease): Promise<EdgeWorkerRelease> {
    try {
      await this.pool.query(
        `insert into edge_worker_releases (
          id,
          project_id,
          deployment_id,
          provider,
          mode,
          status,
          script_name,
          script_digest,
          script_module,
          artifact_json,
          version_id,
          external_deployment_id,
          url,
          created_at,
          updated_at,
          deleted_at,
          last_error
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17)`,
        [
          release.id,
          release.projectId,
          release.deploymentId,
          release.provider,
          release.mode,
          release.status,
          release.scriptName,
          release.scriptDigest,
          release.scriptModule,
          JSON.stringify(release.artifact),
          release.versionId ?? null,
          release.externalDeploymentId ?? null,
          release.url ?? null,
          release.createdAt,
          release.updatedAt,
          release.deletedAt ?? null,
          release.lastError ?? null,
        ],
      );
      return release;
    } catch (error) {
      throw writeError("edge worker release", release.id, error);
    }
  }

  async getEdgeWorkerRelease(id: string): Promise<EdgeWorkerRelease | undefined> {
    const result = await this.pool.query("select * from edge_worker_releases where id = $1", [id]);
    return result.rows[0] ? edgeWorkerReleaseFromRow(result.rows[0]) : undefined;
  }

  async listProjectEdgeWorkerReleases(projectId: string): Promise<EdgeWorkerRelease[]> {
    const result = await this.pool.query(
      "select * from edge_worker_releases where project_id = $1 order by created_at desc, id desc",
      [projectId],
    );
    return result.rows.map(edgeWorkerReleaseFromRow);
  }

  async updateEdgeWorkerRelease(release: EdgeWorkerRelease): Promise<EdgeWorkerRelease> {
    const result = await this.pool.query(
      `update edge_worker_releases set
        status = $1,
        script_digest = $2,
        script_module = $3,
        version_id = $4,
        external_deployment_id = $5,
        url = $6,
        updated_at = $7,
        deleted_at = $8,
        last_error = $9
       where id = $10
       returning *`,
      [
        release.status,
        release.scriptDigest,
        release.scriptModule,
        release.versionId ?? null,
        release.externalDeploymentId ?? null,
        release.url ?? null,
        release.updatedAt,
        release.deletedAt ?? null,
        release.lastError ?? null,
        release.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `edge worker release ${release.id} was not found`);
    }
    return edgeWorkerReleaseFromRow(result.rows[0]);
  }

  async createEdgeWorkerReleaseOperation(
    operation: EdgeWorkerReleaseOperation,
  ): Promise<EdgeWorkerReleaseOperation> {
    try {
      await this.pool.query(
        `insert into edge_worker_release_operations (
          id,
          release_id,
          action,
          status,
          attempts,
          next_attempt_at,
          delete_provider,
          force_provider_delete,
          created_at,
          updated_at,
          last_error
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          operation.id,
          operation.releaseId,
          operation.action,
          operation.status,
          operation.attempts,
          operation.nextAttemptAt,
          operation.deleteProvider,
          operation.forceProviderDelete,
          operation.createdAt,
          operation.updatedAt,
          operation.lastError ?? null,
        ],
      );
      return operation;
    } catch (error) {
      throw writeError("edge worker release operation", operation.id, error);
    }
  }

  async listEdgeWorkerReleaseOperations(releaseId?: string): Promise<EdgeWorkerReleaseOperation[]> {
    const result = releaseId
      ? await this.pool.query(
        `select * from edge_worker_release_operations
         where release_id = $1
         order by created_at asc, id asc`,
        [releaseId],
      )
      : await this.pool.query(
        "select * from edge_worker_release_operations order by created_at asc, id asc",
      );
    return result.rows.map(edgeWorkerReleaseOperationFromRow);
  }

  async listPendingEdgeWorkerReleaseOperations(now: string): Promise<EdgeWorkerReleaseOperation[]> {
    const result = await this.pool.query(
      `select * from edge_worker_release_operations
       where status = 'pending' and next_attempt_at <= $1
       order by next_attempt_at asc, id asc`,
      [now],
    );
    return result.rows.map(edgeWorkerReleaseOperationFromRow);
  }

  async updateEdgeWorkerReleaseOperation(
    operation: EdgeWorkerReleaseOperation,
  ): Promise<EdgeWorkerReleaseOperation> {
    const result = await this.pool.query(
      `update edge_worker_release_operations set
        status = $1,
        attempts = $2,
        next_attempt_at = $3,
        delete_provider = $4,
        force_provider_delete = $5,
        updated_at = $6,
        last_error = $7
       where id = $8
       returning *`,
      [
        operation.status,
        operation.attempts,
        operation.nextAttemptAt,
        operation.deleteProvider,
        operation.forceProviderDelete,
        operation.updatedAt,
        operation.lastError ?? null,
        operation.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `edge worker release operation ${operation.id} was not found`);
    }
    return edgeWorkerReleaseOperationFromRow(result.rows[0]);
  }

  async createProject(project: Project): Promise<Project> {
    try {
      await this.pool.query(
        "insert into projects (id, organization_id, name, created_at) values ($1, $2, $3, $4)",
        [project.id, project.organizationId ?? null, project.name, project.createdAt],
      );
      return project;
    } catch (error) {
      throw writeError("project", project.id, error);
    }
  }

  async getProject(id: string): Promise<Project | undefined> {
    const result = await this.pool.query("select * from projects where id = $1", [id]);
    return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
  }

  async listOrganizationProjects(organizationId: string): Promise<Project[]> {
    const result = await this.pool.query(
      "select * from projects where organization_id = $1 order by created_at asc, id asc",
      [organizationId],
    );
    return result.rows.map(projectFromRow);
  }

  async getProjectUsage(projectId: string): Promise<ProjectResourceUsage> {
    const result = await this.pool.query(
      `select
        (select count(*) from artifacts where project_id = $1)::int as artifacts,
        (select count(*) from deployments where project_id = $1)::int as deployments,
        (select count(*) from routes where project_id = $1)::int as routes,
        (select count(*) from secrets where project_id = $1)::int as secrets,
        (select count(*) from kv_namespaces where project_id = $1)::int as kv_namespaces,
        (select count(*) from durable_object_namespaces where project_id = $1)::int as durable_object_namespaces`,
      [projectId],
    );
    return usageFromRow(result.rows[0]);
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    try {
      await this.pool.query(
        `insert into artifacts (
          id,
          project_id,
          digest,
          location,
          size_bytes,
          signature_json,
          provenance_json,
          created_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
          artifact.id,
          artifact.projectId,
          artifact.digest,
          artifact.location,
          artifact.sizeBytes,
          artifact.signature ? JSON.stringify(artifact.signature) : null,
          artifact.provenance ? JSON.stringify(artifact.provenance) : null,
          artifact.createdAt,
        ],
      );
      return artifact;
    } catch (error) {
      throw writeError("artifact", artifact.id, error);
    }
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const result = await this.pool.query("select * from artifacts where id = $1", [id]);
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async getArtifactByProjectDigest(
    projectId: string,
    digest: string,
  ): Promise<Artifact | undefined> {
    const result = await this.pool.query(
      "select * from artifacts where project_id = $1 and digest = $2",
      [projectId, digest],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async createSecret(secret: Secret, value: string): Promise<Secret> {
    try {
      await this.pool.query(
        `insert into secrets (id, project_id, name, value, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [secret.id, secret.projectId, secret.name, value, secret.createdAt, secret.updatedAt],
      );
      return secret;
    } catch (error) {
      throw writeError("secret", secret.id, error);
    }
  }

  async getSecret(id: string): Promise<Secret | undefined> {
    const result = await this.pool.query("select * from secrets where id = $1", [id]);
    return result.rows[0] ? secretFromRow(result.rows[0]) : undefined;
  }

  async getSecretValue(id: string): Promise<string | undefined> {
    const result = await this.pool.query("select value from secrets where id = $1", [id]);
    return result.rows[0]?.value;
  }

  async listProjectSecrets(projectId: string): Promise<Secret[]> {
    const result = await this.pool.query(
      "select * from secrets where project_id = $1 order by name asc, id asc",
      [projectId],
    );
    return result.rows.map(secretFromRow);
  }

  async updateSecretValue(id: string, value: string, updatedAt: string): Promise<Secret> {
    const result = await this.pool.query(
      `update secrets set value = $1, updated_at = $2
       where id = $3
       returning *`,
      [value, updatedAt, id],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `secret ${id} was not found`);
    }
    return secretFromRow(result.rows[0]);
  }

  async deleteSecret(id: string): Promise<void> {
    const result = await this.pool.query("delete from secrets where id = $1", [id]);
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `secret ${id} was not found`);
    }
  }

  async createKvNamespace(namespace: KvNamespace): Promise<KvNamespace> {
    try {
      await this.pool.query(
        `insert into kv_namespaces (id, project_id, name, created_at, updated_at)
         values ($1, $2, $3, $4, $5)`,
        [namespace.id, namespace.projectId, namespace.name, namespace.createdAt, namespace.updatedAt],
      );
      return namespace;
    } catch (error) {
      throw writeError("kv namespace", namespace.id, error);
    }
  }

  async getKvNamespace(id: string): Promise<KvNamespace | undefined> {
    const result = await this.pool.query("select * from kv_namespaces where id = $1", [id]);
    return result.rows[0] ? kvNamespaceFromRow(result.rows[0]) : undefined;
  }

  async listProjectKvNamespaces(projectId: string): Promise<KvNamespace[]> {
    const result = await this.pool.query(
      "select * from kv_namespaces where project_id = $1 order by name asc, id asc",
      [projectId],
    );
    return result.rows.map(kvNamespaceFromRow);
  }

  async deleteKvNamespace(id: string): Promise<void> {
    const result = await this.pool.query("delete from kv_namespaces where id = $1", [id]);
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `kv namespace ${id} was not found`);
    }
  }

  async createDurableObjectNamespace(namespace: DurableObjectNamespace): Promise<DurableObjectNamespace> {
    try {
      await this.pool.query(
        `insert into durable_object_namespaces (id, project_id, name, created_at, updated_at)
         values ($1, $2, $3, $4, $5)`,
        [namespace.id, namespace.projectId, namespace.name, namespace.createdAt, namespace.updatedAt],
      );
      return namespace;
    } catch (error) {
      throw writeError("durable object namespace", namespace.id, error);
    }
  }

  async getDurableObjectNamespace(id: string): Promise<DurableObjectNamespace | undefined> {
    const result = await this.pool.query("select * from durable_object_namespaces where id = $1", [id]);
    return result.rows[0] ? durableObjectNamespaceFromRow(result.rows[0]) : undefined;
  }

  async listProjectDurableObjectNamespaces(projectId: string): Promise<DurableObjectNamespace[]> {
    const result = await this.pool.query(
      "select * from durable_object_namespaces where project_id = $1 order by name asc, id asc",
      [projectId],
    );
    return result.rows.map(durableObjectNamespaceFromRow);
  }

  async deleteDurableObjectNamespace(id: string): Promise<void> {
    const result = await this.pool.query("delete from durable_object_namespaces where id = $1", [id]);
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `durable object namespace ${id} was not found`);
    }
  }

  async createDeployment(deployment: Deployment): Promise<Deployment> {
    try {
      await this.pool.query(
        `insert into deployments (
          id,
          project_id,
          artifact_id,
          world,
          world_version,
          runtime_backend,
          runtime_version,
          wasi_version,
          limits_json,
          capabilities_json,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
        [
          deployment.id,
          deployment.projectId,
          deployment.artifactId,
          deployment.world,
          deployment.worldVersion,
          deployment.runtime.backend,
          deployment.runtime.version,
          deployment.runtime.wasi,
          JSON.stringify(deployment.limits),
          JSON.stringify(deployment.capabilities),
          deployment.createdAt,
        ],
      );
      return deployment;
    } catch (error) {
      throw writeError("deployment", deployment.id, error);
    }
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    const result = await this.pool.query("select * from deployments where id = $1", [id]);
    return result.rows[0] ? deploymentFromRow(result.rows[0]) : undefined;
  }

  async upsertRoute(route: RoutePointer): Promise<RoutePointer> {
    try {
      const result = await this.pool.query(
        `insert into routes (
          id,
          project_id,
          host,
          path_prefix,
          deployment_id,
          targets_json,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)
        on conflict (project_id, host, path_prefix) do update set
          deployment_id = excluded.deployment_id,
          targets_json = excluded.targets_json,
          updated_at = excluded.updated_at
        returning *`,
        [
          route.id,
          route.projectId,
          route.host,
          route.pathPrefix,
          route.deploymentId,
          JSON.stringify(route.targets),
          route.updatedAt,
        ],
      );
      return routeFromRow(result.rows[0]);
    } catch (error) {
      throw writeError("route", route.id, error);
    }
  }

  async listRoutes(): Promise<RoutePointer[]> {
    const result = await this.pool.query(
      "select * from routes order by host asc, length(path_prefix) desc, path_prefix asc",
    );
    return result.rows.map(routeFromRow);
  }

  async getRoute(
    projectId: string,
    host: string,
    pathPrefix: string,
  ): Promise<RoutePointer | undefined> {
    const result = await this.pool.query(
      "select * from routes where project_id = $1 and host = $2 and path_prefix = $3",
      [projectId, host, pathPrefix],
    );
    return result.rows[0] ? routeFromRow(result.rows[0]) : undefined;
  }

  async deleteRoute(projectId: string, host: string, pathPrefix: string): Promise<void> {
    await this.pool.query(
      "delete from routes where project_id = $1 and host = $2 and path_prefix = $3",
      [projectId, host, pathPrefix],
    );
  }

  async createRuntimeNode(node: RuntimeNode): Promise<RuntimeNode> {
    try {
      await this.pool.query(
        `insert into runtime_nodes (
          id,
          url,
          status,
          registered_at,
          last_seen_at,
          version,
          capacity_json,
          region,
          labels_json,
          load_json,
          identity_json,
          host_json
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)`,
        [
          node.id,
          node.url,
          node.status,
          node.registeredAt,
          node.lastSeenAt ?? null,
          node.version ?? null,
          node.capacity ? JSON.stringify(node.capacity) : null,
          node.region ?? null,
          node.labels ? JSON.stringify(node.labels) : null,
          node.load ? JSON.stringify(node.load) : null,
          node.identity ? JSON.stringify(node.identity) : null,
          node.host ? JSON.stringify(node.host) : null,
        ],
      );
      return node;
    } catch (error) {
      throw writeError("runtime node", node.id, error);
    }
  }

  async getRuntimeNode(id: string): Promise<RuntimeNode | undefined> {
    const result = await this.pool.query("select * from runtime_nodes where id = $1", [id]);
    return result.rows[0] ? runtimeNodeFromRow(result.rows[0]) : undefined;
  }

  async updateRuntimeNodeHeartbeat(node: RuntimeNode): Promise<RuntimeNode> {
    const result = await this.pool.query(
      `update runtime_nodes set
        status = $1,
        last_seen_at = $2,
        version = $3,
        capacity_json = $4::jsonb,
        region = $5,
        labels_json = $6::jsonb,
        load_json = $7::jsonb,
        identity_json = $8::jsonb,
        host_json = $9::jsonb
      where id = $10
      returning *`,
      [
        node.status,
        node.lastSeenAt ?? null,
        node.version ?? null,
        node.capacity ? JSON.stringify(node.capacity) : null,
        node.region ?? null,
        node.labels ? JSON.stringify(node.labels) : null,
        node.load ? JSON.stringify(node.load) : null,
        node.identity ? JSON.stringify(node.identity) : null,
        node.host ? JSON.stringify(node.host) : null,
        node.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${node.id} was not found`);
    }
    return runtimeNodeFromRow(result.rows[0]);
  }

  async updateRuntimeNodeStatus(id: string, status: RuntimeNodeStatus): Promise<RuntimeNode> {
    const result = await this.pool.query(
      "update runtime_nodes set status = $1 where id = $2 returning *",
      [status, id],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${id} was not found`);
    }
    return runtimeNodeFromRow(result.rows[0]);
  }

  async deleteRuntimeNode(id: string): Promise<RuntimeNode> {
    const result = await this.pool.query("delete from runtime_nodes where id = $1 returning *", [id]);
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${id} was not found`);
    }
    return runtimeNodeFromRow(result.rows[0]);
  }

  async listRuntimeNodes(): Promise<RuntimeNode[]> {
    const result = await this.pool.query("select * from runtime_nodes order by id asc");
    return result.rows.map(runtimeNodeFromRow);
  }

  async createRouteSnapshotPublication(
    publication: RouteSnapshotPublication,
  ): Promise<RouteSnapshotPublication> {
    try {
      await this.pool.query(
        `insert into route_snapshot_publications (
          id,
          snapshot_id,
          snapshot_generated_at,
          routes,
          ok,
          targets_json,
          created_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          publication.id,
          publication.snapshotId ?? null,
          publication.snapshotGeneratedAt,
          publication.routes,
          publication.ok,
          JSON.stringify(publication.targets),
          publication.createdAt,
        ],
      );
      return publication;
    } catch (error) {
      throw writeError("route snapshot publication", publication.id, error);
    }
  }

  async listRouteSnapshotPublications(): Promise<RouteSnapshotPublication[]> {
    const result = await this.pool.query(
      "select * from route_snapshot_publications order by created_at desc, id desc",
    );
    return result.rows.map(routeSnapshotPublicationFromRow);
  }

  async createCanaryDecision(decision: CanaryDecision): Promise<CanaryDecision> {
    try {
      await this.pool.query(
        `insert into canary_decisions (
          id,
          project_id,
          host,
          path_prefix,
          stable_deployment_id,
          candidate_deployment_id,
          action,
          reason,
          metrics_json,
          thresholds_json,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
        [
          decision.id,
          decision.projectId,
          decision.host,
          decision.pathPrefix,
          decision.stableDeploymentId,
          decision.candidateDeploymentId,
          decision.action,
          decision.reason,
          JSON.stringify(decision.metrics),
          JSON.stringify(decision.thresholds),
          decision.createdAt,
        ],
      );
      return decision;
    } catch (error) {
      throw writeError("canary decision", decision.id, error);
    }
  }

  async listCanaryDecisions(): Promise<CanaryDecision[]> {
    const result = await this.pool.query("select * from canary_decisions order by created_at desc, id desc");
    return result.rows.map(canaryDecisionFromRow);
  }
}

function organizationFromRow(row: any): Organization {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function userFromRow(row: any): User {
  return {
    id: row.id,
    email: row.email,
    ...(row.name ? { name: row.name } : {}),
    createdAt: row.created_at,
  };
}

function membershipFromRow(row: any): ProjectMembership {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

function apiKeyFromRow(row: any): ApiKey {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    name: row.name,
    scopes: jsonValue(row.scopes_json),
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function customDomainFromRow(row: any): CustomDomain {
  return {
    id: row.id,
    projectId: row.project_id,
    host: row.host,
    status: row.status,
    verificationToken: row.verification_token,
    verificationRecordName: row.verification_record_name,
    verificationRecordValue: row.verification_record_value,
    tlsStatus: row.tls_status,
    ...(row.tls_provider ? { tlsProvider: row.tls_provider } : {}),
    ...(row.tls_request_id ? { tlsRequestId: row.tls_request_id } : {}),
    ...(row.tls_error ? { tlsError: row.tls_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
    ...(row.tls_provisioned_at ? { tlsProvisionedAt: row.tls_provisioned_at } : {}),
  };
}

function deployPreviewFromRow(row: any): DeployPreview {
  return {
    id: row.id,
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    host: row.host,
    pathPrefix: row.path_prefix,
    url: row.url,
    environment: jsonValue(row.environment_json),
    ...(row.previous_route_json ? { previousRoute: jsonValue(row.previous_route_json) } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.rolled_back_at ? { rolledBackAt: row.rolled_back_at } : {}),
  };
}

function edgeWorkerReleaseFromRow(row: any): EdgeWorkerRelease {
  return {
    id: row.id,
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    provider: row.provider,
    mode: row.mode,
    status: row.status ?? "active",
    scriptName: row.script_name,
    scriptDigest: row.script_digest,
    scriptModule: row.script_module,
    artifact: jsonValue(row.artifact_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    ...(row.version_id ? { versionId: row.version_id } : {}),
    ...(row.external_deployment_id ? { externalDeploymentId: row.external_deployment_id } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function edgeWorkerReleaseOperationFromRow(row: any): EdgeWorkerReleaseOperation {
  return {
    id: row.id,
    releaseId: row.release_id,
    action: row.action,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    deleteProvider: Boolean(row.delete_provider),
    forceProviderDelete: Boolean(row.force_provider_delete),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function projectFromRow(row: any): Project {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    name: row.name,
    createdAt: row.created_at,
  };
}

function artifactFromRow(row: any): Artifact {
  return {
    id: row.id,
    projectId: row.project_id,
    digest: row.digest,
    location: row.location,
    sizeBytes: Number(row.size_bytes),
    ...(row.signature_json ? { signature: jsonValue(row.signature_json) } : {}),
    ...(row.provenance_json ? { provenance: jsonValue(row.provenance_json) } : {}),
    createdAt: row.created_at,
  };
}

function secretFromRow(row: any): Secret {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function kvNamespaceFromRow(row: any): KvNamespace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function durableObjectNamespaceFromRow(row: any): DurableObjectNamespace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deploymentFromRow(row: any): Deployment {
  return {
    id: row.id,
    projectId: row.project_id,
    artifactId: row.artifact_id,
    world: row.world,
    worldVersion: row.world_version ?? "0.1.0",
    runtime: {
      backend: row.runtime_backend,
      version: row.runtime_version,
      wasi: row.wasi_version,
    },
    limits: jsonValue(row.limits_json),
    capabilities: jsonValue(row.capabilities_json),
    createdAt: row.created_at,
  };
}

function routeFromRow(row: any): RoutePointer {
  return {
    id: row.id,
    projectId: row.project_id,
    host: row.host,
    pathPrefix: row.path_prefix,
    deploymentId: row.deployment_id,
    targets: row.targets_json
      ? jsonValue(row.targets_json)
      : [{ deploymentId: row.deployment_id, weight: 100 }],
    updatedAt: row.updated_at,
  };
}

function usageEventFromRow(row: any): UsageEvent {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    projectId: row.project_id,
    metric: row.metric,
    quantity: Number(row.quantity),
    ...(row.dimensions_json ? { dimensions: jsonValue(row.dimensions_json) } : {}),
    recordedAt: row.recorded_at,
  };
}

function runtimeNodeFromRow(row: any): RuntimeNode {
  const node: RuntimeNode = {
    id: row.id,
    url: row.url,
    status: row.status ?? "active",
    registeredAt: row.registered_at,
  };
  if (row.last_seen_at) {
    node.lastSeenAt = row.last_seen_at;
  }
  if (row.version) {
    node.version = row.version;
  }
  if (row.capacity_json) {
    node.capacity = jsonValue(row.capacity_json);
  }
  if (row.region) {
    node.region = row.region;
  }
  if (row.labels_json) {
    node.labels = jsonValue(row.labels_json);
  }
  if (row.load_json) {
    node.load = jsonValue(row.load_json);
  }
  if (row.identity_json) {
    node.identity = jsonValue(row.identity_json);
  }
  if (row.host_json) {
    node.host = jsonValue(row.host_json);
  }
  return node;
}

function routeSnapshotPublicationFromRow(row: any): RouteSnapshotPublication {
  return {
    id: row.id,
    ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
    snapshotGeneratedAt: row.snapshot_generated_at,
    routes: row.routes,
    ok: row.ok === true,
    targets: jsonValue(row.targets_json),
    createdAt: row.created_at,
  };
}

function canaryDecisionFromRow(row: any): CanaryDecision {
  return {
    id: row.id,
    projectId: row.project_id,
    host: row.host,
    pathPrefix: row.path_prefix,
    stableDeploymentId: row.stable_deployment_id,
    candidateDeploymentId: row.candidate_deployment_id,
    action: row.action,
    reason: row.reason,
    metrics: jsonValue(row.metrics_json),
    thresholds: jsonValue(row.thresholds_json),
    createdAt: row.created_at,
  };
}

function usageFromRow(row: any): ProjectResourceUsage {
  return {
    artifacts: Number(row.artifacts ?? 0),
    deployments: Number(row.deployments ?? 0),
    routes: Number(row.routes ?? 0),
    secrets: Number(row.secrets ?? 0),
    kvNamespaces: Number(row.kv_namespaces ?? 0),
    durableObjectNamespaces: Number(row.durable_object_namespaces ?? 0),
  };
}

function usageSummaryFromRow(
  projectId: string,
  organizationId: string | undefined,
  from: string | undefined,
  to: string | undefined,
  row: any,
): ProjectUsageSummary {
  return {
    projectId,
    ...(organizationId ? { organizationId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    totals: {
      invocations: Number(row?.invocations ?? 0),
      cpuMs: Number(row?.cpu_ms ?? 0),
      wallMs: Number(row?.wall_ms ?? 0),
      memoryMbMs: Number(row?.memory_mb_ms ?? 0),
      egressBytes: Number(row?.egress_bytes ?? 0),
      storageBytes: Number(row?.storage_bytes ?? 0),
      sqliteUnits: Number(row?.sqlite_units ?? 0),
    },
  };
}

function billingInvoiceFromRow(row: any): OrganizationBillingInvoice {
  const invoice: Omit<OrganizationBillingInvoice, "contentDigest"> = {
    id: row.id,
    organizationId: row.organization_id,
    periodKey: row.period_key,
    period: jsonValue(row.period_json),
    currency: row.currency,
    totalUsd: Number(row.total_usd),
    rates: jsonValue(row.rates_json),
    rateCardVersion: row.rate_card_version,
    statement: jsonValue(row.statement_json),
    issuedAt: row.issued_at,
  };
  return {
    ...invoice,
    contentDigest: row.content_digest || invoiceContentDigest(invoice),
  };
}

function billingWebhookDeliveryFromRow(row: any): BillingWebhookDelivery {
  return {
    id: row.id,
    eventType: row.event_type,
    targetUrl: row.target_url,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    payload: jsonValue(row.payload_json),
    attempts: Number(row.attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.last_status === null || row.last_status === undefined ? {} : { lastStatus: Number(row.last_status) }),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
  };
}

function billingInvoiceAdjustmentFromRow(row: any): BillingInvoiceAdjustment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    organizationId: row.organization_id,
    type: row.type,
    currency: row.currency,
    amountUsd: Number(row.amount_usd),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function billingInvoiceRetentionPolicyFromRow(row: any): BillingInvoiceRetentionPolicy {
  return {
    invoiceId: row.invoice_id,
    organizationId: row.organization_id,
    retainUntil: row.retain_until,
    legalHold: Boolean(row.legal_hold),
    ...(row.legal_hold_reason ? { legalHoldReason: row.legal_hold_reason } : {}),
    updatedAt: row.updated_at,
  };
}

function jsonValue(value: any): any {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function writeError(kind: string, id: string, error: unknown): ControlPlaneError {
  const pgError = error as { code?: string; message?: string };
  if (pgError.code === "23505") {
    return new ControlPlaneError("conflict", `${kind} ${id} already exists`);
  }
  if (pgError.code === "23503") {
    return new ControlPlaneError("validation", `${kind} ${id} references missing records`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ControlPlaneError("validation", message);
}
