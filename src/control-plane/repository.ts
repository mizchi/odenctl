import { DatabaseSync } from "node:sqlite";
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
  ProductionQuotaIncrease,
  Project,
  ProjectMembership,
  RoutePointer,
  RouteSnapshotPublication,
  RuntimeNode,
  RuntimeNodeStatus,
  Secret,
  ProjectUsageSummary,
  UsageEvent,
  User,
} from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";
import { invoiceContentDigest, type OrganizationBillingInvoice } from "./billing-invoice.ts";
import type { BillingWebhookDelivery, BillingWebhookDeliveryStatus } from "./billing-webhook.ts";
import type { BillingInvoiceAdjustment } from "./billing-adjustment.ts";
import type { BillingInvoiceRetentionPolicy } from "./billing-retention.ts";

export interface ControlPlaneRepository {
  createOrganization(organization: Organization): Organization;
  getOrganization(id: string): Organization | undefined;
  updateOrganizationBilling(organization: Organization): Organization;
  createUser(user: User): User;
  getUser(id: string): User | undefined;
  updateUserEmailVerification(id: string, emailVerifiedAt: string): User;
  createProjectMembership(membership: ProjectMembership): ProjectMembership;
  listProjectMemberships(projectId: string): ProjectMembership[];
  acceptProjectMembershipInvite(projectId: string, userId: string, acceptedAt: string): ProjectMembership;
  createApiKey(apiKey: ApiKey, tokenHash: string): ApiKey;
  getApiKeyByTokenHash(tokenHash: string): ApiKey | undefined;
  listProjectApiKeys(projectId: string): ApiKey[];
  updateApiKeyLastUsed(id: string, lastUsedAt: string): ApiKey;
  createUsageEvent(event: UsageEvent): UsageEvent;
  getUsageEvent(id: string): UsageEvent | undefined;
  getProjectUsageSummary(projectId: string, from?: string, to?: string): ProjectUsageSummary;
  createProductionQuotaIncrease(increase: ProductionQuotaIncrease): ProductionQuotaIncrease;
  createBillingInvoice(invoice: OrganizationBillingInvoice): OrganizationBillingInvoice;
  getBillingInvoice(id: string): OrganizationBillingInvoice | undefined;
  getOrganizationBillingInvoiceByPeriod(
    organizationId: string,
    periodKey: string,
  ): OrganizationBillingInvoice | undefined;
  listOrganizationBillingInvoices(organizationId: string): OrganizationBillingInvoice[];
  deleteBillingInvoice(id: string): OrganizationBillingInvoice;
  createBillingWebhookDelivery(delivery: BillingWebhookDelivery): BillingWebhookDelivery;
  getBillingWebhookDeliveryByIdempotencyKey(idempotencyKey: string): BillingWebhookDelivery | undefined;
  listBillingWebhookDeliveries(status?: BillingWebhookDeliveryStatus): BillingWebhookDelivery[];
  updateBillingWebhookDelivery(delivery: BillingWebhookDelivery): BillingWebhookDelivery;
  createBillingInvoiceAdjustment(adjustment: BillingInvoiceAdjustment): BillingInvoiceAdjustment;
  listBillingInvoiceAdjustments(invoiceId: string): BillingInvoiceAdjustment[];
  upsertBillingInvoiceRetentionPolicy(policy: BillingInvoiceRetentionPolicy): BillingInvoiceRetentionPolicy;
  getBillingInvoiceRetentionPolicy(invoiceId: string): BillingInvoiceRetentionPolicy | undefined;
  createCustomDomain(domain: CustomDomain): CustomDomain;
  getCustomDomain(id: string): CustomDomain | undefined;
  getCustomDomainByHost(host: string): CustomDomain | undefined;
  listProjectCustomDomains(projectId: string): CustomDomain[];
  updateCustomDomain(domain: CustomDomain): CustomDomain;
  createDeployPreview(preview: DeployPreview): DeployPreview;
  getDeployPreview(id: string): DeployPreview | undefined;
  listProjectDeployPreviews(projectId: string): DeployPreview[];
  updateDeployPreview(preview: DeployPreview): DeployPreview;
  createEdgeWorkerRelease(release: EdgeWorkerRelease): EdgeWorkerRelease;
  getEdgeWorkerRelease(id: string): EdgeWorkerRelease | undefined;
  listProjectEdgeWorkerReleases(projectId: string): EdgeWorkerRelease[];
  updateEdgeWorkerRelease(release: EdgeWorkerRelease): EdgeWorkerRelease;
  createEdgeWorkerReleaseOperation(operation: EdgeWorkerReleaseOperation): EdgeWorkerReleaseOperation;
  listEdgeWorkerReleaseOperations(releaseId?: string): EdgeWorkerReleaseOperation[];
  listPendingEdgeWorkerReleaseOperations(now: string): EdgeWorkerReleaseOperation[];
  updateEdgeWorkerReleaseOperation(operation: EdgeWorkerReleaseOperation): EdgeWorkerReleaseOperation;
  createProject(project: Project): Project;
  getProject(id: string): Project | undefined;
  listOrganizationProjects(organizationId: string): Project[];
  getProjectUsage(projectId: string): ProjectResourceUsage;
  createArtifact(artifact: Artifact): Artifact;
  getArtifact(id: string): Artifact | undefined;
  getArtifactByProjectDigest(projectId: string, digest: string): Artifact | undefined;
  createSecret(secret: Secret, value: string): Secret;
  getSecret(id: string): Secret | undefined;
  getSecretValue(id: string): string | undefined;
  listProjectSecrets(projectId: string): Secret[];
  updateSecretValue(id: string, value: string, updatedAt: string): Secret;
  deleteSecret(id: string): void;
  createKvNamespace(namespace: KvNamespace): KvNamespace;
  getKvNamespace(id: string): KvNamespace | undefined;
  listProjectKvNamespaces(projectId: string): KvNamespace[];
  deleteKvNamespace(id: string): void;
  createDurableObjectNamespace(namespace: DurableObjectNamespace): DurableObjectNamespace;
  getDurableObjectNamespace(id: string): DurableObjectNamespace | undefined;
  listProjectDurableObjectNamespaces(projectId: string): DurableObjectNamespace[];
  deleteDurableObjectNamespace(id: string): void;
  createDeployment(deployment: Deployment): Deployment;
  getDeployment(id: string): Deployment | undefined;
  upsertRoute(route: RoutePointer): RoutePointer;
  getRoute(projectId: string, host: string, pathPrefix: string): RoutePointer | undefined;
  deleteRoute(projectId: string, host: string, pathPrefix: string): void;
  listRoutes(): RoutePointer[];
  createRuntimeNode(node: RuntimeNode): RuntimeNode;
  getRuntimeNode(id: string): RuntimeNode | undefined;
  updateRuntimeNodeHeartbeat(node: RuntimeNode): RuntimeNode;
  updateRuntimeNodeStatus(id: string, status: RuntimeNodeStatus): RuntimeNode;
  deleteRuntimeNode(id: string): RuntimeNode;
  listRuntimeNodes(): RuntimeNode[];
  createRouteSnapshotPublication(publication: RouteSnapshotPublication): RouteSnapshotPublication;
  listRouteSnapshotPublications(): RouteSnapshotPublication[];
  createCanaryDecision(decision: CanaryDecision): CanaryDecision;
  listCanaryDecisions(): CanaryDecision[];
}

export interface ProjectResourceUsage {
  artifacts: number;
  deployments: number;
  routes: number;
  secrets: number;
  kvNamespaces: number;
  durableObjectNamespaces: number;
}

export function createMemoryRepository(): ControlPlaneRepository {
  return new SqliteControlPlaneRepository(new DatabaseSync(":memory:"));
}

export function createSqliteRepository(path: string): ControlPlaneRepository {
  return new SqliteControlPlaneRepository(new DatabaseSync(path));
}

export function applySqliteMigrations(path: string): void {
  const db = new DatabaseSync(path);
  try {
    new SqliteControlPlaneRepository(db);
  } finally {
    db.close();
  }
}

class SqliteControlPlaneRepository implements ControlPlaneRepository {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(schema);
    this.runMigrations();
  }

  createOrganization(organization: Organization): Organization {
    try {
      this.db
        .prepare(
          `insert into organizations (
            id,
            name,
            billing_provider,
            billing_customer_id,
            payment_status,
            billing_email,
            payment_status_updated_at,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          organization.id,
          organization.name,
          organization.billingProvider,
          organization.billingCustomerId ?? null,
          organization.paymentStatus,
          organization.billingEmail ?? null,
          organization.paymentStatusUpdatedAt,
          organization.createdAt,
        );
      return organization;
    } catch (error) {
      throw writeError("organization", organization.id, error);
    }
  }

  getOrganization(id: string): Organization | undefined {
    const row = this.db.prepare("select * from organizations where id = ?").get(id);
    return row ? organizationFromRow(row) : undefined;
  }

  updateOrganizationBilling(organization: Organization): Organization {
    try {
      const result = this.db
        .prepare(
          `update organizations set
            billing_provider = ?,
            billing_customer_id = ?,
            payment_status = ?,
            billing_email = ?,
            payment_status_updated_at = ?
           where id = ?`,
        )
        .run(
          organization.billingProvider,
          organization.billingCustomerId ?? null,
          organization.paymentStatus,
          organization.billingEmail ?? null,
          organization.paymentStatusUpdatedAt,
          organization.id,
        );
      if (result.changes === 0) {
        throw new ControlPlaneError("not_found", `organization ${organization.id} was not found`);
      }
      const row = this.db.prepare("select * from organizations where id = ?").get(organization.id);
      return organizationFromRow(row);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }
      throw writeError("organization", organization.id, error);
    }
  }

  createUser(user: User): User {
    try {
      this.db
        .prepare("insert into users (id, email, name, email_verified_at, created_at) values (?, ?, ?, ?, ?)")
        .run(user.id, user.email, user.name ?? null, user.emailVerifiedAt ?? null, user.createdAt);
      return user;
    } catch (error) {
      throw writeError("user", user.id, error);
    }
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare("select * from users where id = ?").get(id);
    return row ? userFromRow(row) : undefined;
  }

  updateUserEmailVerification(id: string, emailVerifiedAt: string): User {
    const result = this.db
      .prepare("update users set email_verified_at = ? where id = ?")
      .run(emailVerifiedAt, id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `user ${id} was not found`);
    }
    const row = this.db.prepare("select * from users where id = ?").get(id);
    return userFromRow(row);
  }

  createProjectMembership(membership: ProjectMembership): ProjectMembership {
    try {
      this.db
        .prepare(
          `insert into project_memberships (
            project_id,
            user_id,
            role,
            invite_status,
            invited_at,
            accepted_at,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?)
          on conflict(project_id, user_id) do update set
            role = excluded.role,
            invite_status = excluded.invite_status,
            invited_at = excluded.invited_at,
            accepted_at = excluded.accepted_at`,
        )
        .run(
          membership.projectId,
          membership.userId,
          membership.role,
          membership.inviteStatus,
          membership.invitedAt,
          membership.acceptedAt ?? null,
          membership.createdAt,
        );
      const row = this.db
        .prepare("select * from project_memberships where project_id = ? and user_id = ?")
        .get(membership.projectId, membership.userId);
      return membershipFromRow(row);
    } catch (error) {
      throw writeError("project membership", `${membership.projectId}/${membership.userId}`, error);
    }
  }

  listProjectMemberships(projectId: string): ProjectMembership[] {
    return this.db
      .prepare("select * from project_memberships where project_id = ? order by user_id asc")
      .all(projectId)
      .map(membershipFromRow);
  }

  acceptProjectMembershipInvite(projectId: string, userId: string, acceptedAt: string): ProjectMembership {
    const result = this.db
      .prepare(
        `update project_memberships set
          invite_status = 'accepted',
          accepted_at = ?
         where project_id = ? and user_id = ?`,
      )
      .run(acceptedAt, projectId, userId);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `project membership ${projectId}/${userId} was not found`);
    }
    const row = this.db
      .prepare("select * from project_memberships where project_id = ? and user_id = ?")
      .get(projectId, userId);
    return membershipFromRow(row);
  }

  createApiKey(apiKey: ApiKey, tokenHash: string): ApiKey {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          apiKey.id,
          apiKey.organizationId ?? null,
          apiKey.projectId ?? null,
          apiKey.name,
          tokenHash,
          JSON.stringify(apiKey.scopes),
          apiKey.createdAt,
          apiKey.lastUsedAt ?? null,
          apiKey.revokedAt ?? null,
        );
      return apiKey;
    } catch (error) {
      throw writeError("api key", apiKey.id, error);
    }
  }

  getApiKeyByTokenHash(tokenHash: string): ApiKey | undefined {
    const row = this.db.prepare("select * from api_keys where token_hash = ?").get(tokenHash);
    return row ? apiKeyFromRow(row) : undefined;
  }

  listProjectApiKeys(projectId: string): ApiKey[] {
    return this.db
      .prepare("select * from api_keys where project_id = ? order by created_at desc, id desc")
      .all(projectId)
      .map(apiKeyFromRow);
  }

  updateApiKeyLastUsed(id: string, lastUsedAt: string): ApiKey {
    const result = this.db
      .prepare("update api_keys set last_used_at = ? where id = ?")
      .run(lastUsedAt, id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `api key ${id} was not found`);
    }
    const row = this.db.prepare("select * from api_keys where id = ?").get(id);
    return apiKeyFromRow(row);
  }

  createUsageEvent(event: UsageEvent): UsageEvent {
    try {
      this.db
        .prepare(
          `insert into usage_events (
            id,
            organization_id,
            project_id,
            metric,
            quantity,
            dimensions_json,
            recorded_at
          ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.organizationId ?? null,
          event.projectId,
          event.metric,
          event.quantity,
          event.dimensions ? JSON.stringify(event.dimensions) : null,
          event.recordedAt,
        );
      return event;
    } catch (error) {
      throw writeError("usage event", event.id, error);
    }
  }

  getUsageEvent(id: string): UsageEvent | undefined {
    const row = this.db.prepare("select * from usage_events where id = ?").get(id);
    return row ? usageEventFromRow(row) : undefined;
  }

  getProjectUsageSummary(projectId: string, from?: string, to?: string): ProjectUsageSummary {
    const params: string[] = [projectId];
    const where = ["project_id = ?"];
    if (from) {
      where.push("recorded_at >= ?");
      params.push(from);
    }
    if (to) {
      where.push("recorded_at < ?");
      params.push(to);
    }
    const row = this.db
      .prepare(
        `select
          coalesce(sum(case when metric = 'invocation' then quantity else 0 end), 0) as invocations,
          coalesce(sum(case when metric = 'cpu_ms' then quantity else 0 end), 0) as cpu_ms,
          coalesce(sum(case when metric = 'wall_ms' then quantity else 0 end), 0) as wall_ms,
          coalesce(sum(case when metric = 'memory_mb_ms' then quantity else 0 end), 0) as memory_mb_ms,
          coalesce(sum(case when metric = 'egress_bytes' then quantity else 0 end), 0) as egress_bytes,
          coalesce(sum(case when metric = 'storage_bytes' then quantity else 0 end), 0) as storage_bytes,
          coalesce(sum(case when metric = 'sqlite_unit' then quantity else 0 end), 0) as sqlite_units
        from usage_events
        where ${where.join(" and ")}`,
      )
      .get(...params);
    const project = this.getProject(projectId);
    return usageSummaryFromRow(projectId, project?.organizationId, from, to, row);
  }

  createProductionQuotaIncrease(increase: ProductionQuotaIncrease): ProductionQuotaIncrease {
    try {
      this.db
        .prepare(
          `insert into production_quota_increases (
            id,
            organization_id,
            project_id,
            requested_quotas_json,
            status,
            checks_json,
            created_at,
            approved_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          increase.id,
          increase.organizationId,
          increase.projectId ?? null,
          JSON.stringify(increase.requestedQuotas),
          increase.status,
          JSON.stringify(increase.checks),
          increase.createdAt,
          increase.approvedAt,
        );
      return increase;
    } catch (error) {
      throw writeError("production quota increase", increase.id, error);
    }
  }

  createBillingInvoice(invoice: OrganizationBillingInvoice): OrganizationBillingInvoice {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return invoice;
    } catch (error) {
      throw writeError("billing invoice", invoice.id, error);
    }
  }

  getBillingInvoice(id: string): OrganizationBillingInvoice | undefined {
    const row = this.db.prepare("select * from billing_invoices where id = ?").get(id);
    return row ? billingInvoiceFromRow(row) : undefined;
  }

  getOrganizationBillingInvoiceByPeriod(
    organizationId: string,
    periodKey: string,
  ): OrganizationBillingInvoice | undefined {
    const row = this.db
      .prepare("select * from billing_invoices where organization_id = ? and period_key = ?")
      .get(organizationId, periodKey);
    return row ? billingInvoiceFromRow(row) : undefined;
  }

  listOrganizationBillingInvoices(organizationId: string): OrganizationBillingInvoice[] {
    return this.db
      .prepare(
        `select * from billing_invoices
         where organization_id = ?
         order by issued_at desc, id desc`,
      )
      .all(organizationId)
      .map(billingInvoiceFromRow);
  }

  deleteBillingInvoice(id: string): OrganizationBillingInvoice {
    const invoice = this.getBillingInvoice(id);
    if (!invoice) {
      throw new ControlPlaneError("not_found", `billing invoice ${id} was not found`);
    }
    this.db.exec("begin");
    try {
      this.db.prepare("delete from billing_invoice_adjustments where invoice_id = ?").run(id);
      this.db.prepare("delete from billing_invoice_retention_policies where invoice_id = ?").run(id);
      this.db
        .prepare(
          `delete from billing_webhook_deliveries
           where event_type = 'billing.invoice.issued'
             and json_extract(payload_json, '$.invoice.id') = ?`,
        )
        .run(id);
      this.db.prepare("delete from billing_invoices where id = ?").run(id);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw writeError("billing invoice", id, error);
    }
    return invoice;
  }

  createBillingWebhookDelivery(delivery: BillingWebhookDelivery): BillingWebhookDelivery {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return delivery;
    } catch (error) {
      throw writeError("billing webhook delivery", delivery.id, error);
    }
  }

  getBillingWebhookDeliveryByIdempotencyKey(idempotencyKey: string): BillingWebhookDelivery | undefined {
    const row = this.db
      .prepare("select * from billing_webhook_deliveries where idempotency_key = ?")
      .get(idempotencyKey);
    return row ? billingWebhookDeliveryFromRow(row) : undefined;
  }

  listBillingWebhookDeliveries(status?: BillingWebhookDeliveryStatus): BillingWebhookDelivery[] {
    const rows = status
      ? this.db
        .prepare(
          `select * from billing_webhook_deliveries
           where status = ?
           order by created_at asc, id asc`,
        )
        .all(status)
      : this.db
        .prepare(
          `select * from billing_webhook_deliveries
           order by created_at asc, id asc`,
        )
        .all();
    return rows.map(billingWebhookDeliveryFromRow);
  }

  updateBillingWebhookDelivery(delivery: BillingWebhookDelivery): BillingWebhookDelivery {
    const result = this.db
      .prepare(
        `update billing_webhook_deliveries set
          status = ?,
          payload_json = ?,
          attempts = ?,
          next_attempt_at = ?,
          last_attempt_at = ?,
          last_status = ?,
          last_error = ?,
          updated_at = ?,
          delivered_at = ?
         where id = ?`,
      )
      .run(
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
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `billing webhook delivery ${delivery.id} was not found`);
    }
    return delivery;
  }

  createBillingInvoiceAdjustment(adjustment: BillingInvoiceAdjustment): BillingInvoiceAdjustment {
    try {
      this.db
        .prepare(
          `insert into billing_invoice_adjustments (
            id,
            invoice_id,
            organization_id,
            type,
            currency,
            amount_usd,
            reason,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          adjustment.id,
          adjustment.invoiceId,
          adjustment.organizationId,
          adjustment.type,
          adjustment.currency,
          adjustment.amountUsd,
          adjustment.reason,
          adjustment.createdAt,
        );
      return adjustment;
    } catch (error) {
      throw writeError("billing invoice adjustment", adjustment.id, error);
    }
  }

  listBillingInvoiceAdjustments(invoiceId: string): BillingInvoiceAdjustment[] {
    return this.db
      .prepare(
        `select * from billing_invoice_adjustments
         where invoice_id = ?
         order by created_at asc, id asc`,
      )
      .all(invoiceId)
      .map(billingInvoiceAdjustmentFromRow);
  }

  upsertBillingInvoiceRetentionPolicy(policy: BillingInvoiceRetentionPolicy): BillingInvoiceRetentionPolicy {
    try {
      this.db
        .prepare(
          `insert into billing_invoice_retention_policies (
            invoice_id,
            organization_id,
            retain_until,
            legal_hold,
            legal_hold_reason,
            updated_at
          ) values (?, ?, ?, ?, ?, ?)
          on conflict(invoice_id) do update set
            organization_id = excluded.organization_id,
            retain_until = excluded.retain_until,
            legal_hold = excluded.legal_hold,
            legal_hold_reason = excluded.legal_hold_reason,
            updated_at = excluded.updated_at`,
        )
        .run(
          policy.invoiceId,
          policy.organizationId,
          policy.retainUntil,
          policy.legalHold ? 1 : 0,
          policy.legalHoldReason ?? null,
          policy.updatedAt,
        );
      return policy;
    } catch (error) {
      throw writeError("billing invoice retention policy", policy.invoiceId, error);
    }
  }

  getBillingInvoiceRetentionPolicy(invoiceId: string): BillingInvoiceRetentionPolicy | undefined {
    const row = this.db.prepare("select * from billing_invoice_retention_policies where invoice_id = ?").get(invoiceId);
    return row ? billingInvoiceRetentionPolicyFromRow(row) : undefined;
  }

  createCustomDomain(domain: CustomDomain): CustomDomain {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return domain;
    } catch (error) {
      throw writeError("custom domain", domain.id, error);
    }
  }

  getCustomDomain(id: string): CustomDomain | undefined {
    const row = this.db.prepare("select * from custom_domains where id = ?").get(id);
    return row ? customDomainFromRow(row) : undefined;
  }

  getCustomDomainByHost(host: string): CustomDomain | undefined {
    const row = this.db.prepare("select * from custom_domains where host = ?").get(host);
    return row ? customDomainFromRow(row) : undefined;
  }

  listProjectCustomDomains(projectId: string): CustomDomain[] {
    return this.db
      .prepare("select * from custom_domains where project_id = ? order by host asc, id asc")
      .all(projectId)
      .map(customDomainFromRow);
  }

  updateCustomDomain(domain: CustomDomain): CustomDomain {
    const result = this.db
      .prepare(
        `update custom_domains set
          status = ?,
          tls_status = ?,
          tls_provider = ?,
          tls_request_id = ?,
          tls_error = ?,
          updated_at = ?,
          verified_at = ?,
          tls_provisioned_at = ?
        where id = ?`,
      )
      .run(
        domain.status,
        domain.tlsStatus,
        domain.tlsProvider ?? null,
        domain.tlsRequestId ?? null,
        domain.tlsError ?? null,
        domain.updatedAt,
        domain.verifiedAt ?? null,
        domain.tlsProvisionedAt ?? null,
        domain.id,
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `custom domain ${domain.id} was not found`);
    }
    return this.getCustomDomain(domain.id) as CustomDomain;
  }

  createDeployPreview(preview: DeployPreview): DeployPreview {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return preview;
    } catch (error) {
      throw writeError("deploy preview", preview.id, error);
    }
  }

  getDeployPreview(id: string): DeployPreview | undefined {
    const row = this.db.prepare("select * from deploy_previews where id = ?").get(id);
    return row ? deployPreviewFromRow(row) : undefined;
  }

  listProjectDeployPreviews(projectId: string): DeployPreview[] {
    return this.db
      .prepare("select * from deploy_previews where project_id = ? order by created_at desc, id desc")
      .all(projectId)
      .map(deployPreviewFromRow);
  }

  updateDeployPreview(preview: DeployPreview): DeployPreview {
    const result = this.db
      .prepare(
        `update deploy_previews set
          status = ?,
          updated_at = ?,
          rolled_back_at = ?
        where id = ?`,
      )
      .run(preview.status, preview.updatedAt, preview.rolledBackAt ?? null, preview.id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `deploy preview ${preview.id} was not found`);
    }
    return this.getDeployPreview(preview.id) as DeployPreview;
  }

  createEdgeWorkerRelease(release: EdgeWorkerRelease): EdgeWorkerRelease {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return release;
    } catch (error) {
      throw writeError("edge worker release", release.id, error);
    }
  }

  getEdgeWorkerRelease(id: string): EdgeWorkerRelease | undefined {
    const row = this.db.prepare("select * from edge_worker_releases where id = ?").get(id);
    return row ? edgeWorkerReleaseFromRow(row) : undefined;
  }

  listProjectEdgeWorkerReleases(projectId: string): EdgeWorkerRelease[] {
    return this.db
      .prepare("select * from edge_worker_releases where project_id = ? order by created_at desc, id desc")
      .all(projectId)
      .map(edgeWorkerReleaseFromRow);
  }

  updateEdgeWorkerRelease(release: EdgeWorkerRelease): EdgeWorkerRelease {
    const result = this.db
      .prepare(
        `update edge_worker_releases set
          status = ?,
          script_digest = ?,
          script_module = ?,
          version_id = ?,
          external_deployment_id = ?,
          url = ?,
          updated_at = ?,
          deleted_at = ?,
          last_error = ?
        where id = ?`,
      )
      .run(
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
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `edge worker release ${release.id} was not found`);
    }
    return this.getEdgeWorkerRelease(release.id) as EdgeWorkerRelease;
  }

  createEdgeWorkerReleaseOperation(operation: EdgeWorkerReleaseOperation): EdgeWorkerReleaseOperation {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.id,
          operation.releaseId,
          operation.action,
          operation.status,
          operation.attempts,
          operation.nextAttemptAt,
          operation.deleteProvider ? 1 : 0,
          operation.forceProviderDelete ? 1 : 0,
          operation.createdAt,
          operation.updatedAt,
          operation.lastError ?? null,
        );
      return operation;
    } catch (error) {
      throw writeError("edge worker release operation", operation.id, error);
    }
  }

  listEdgeWorkerReleaseOperations(releaseId?: string): EdgeWorkerReleaseOperation[] {
    const rows = releaseId
      ? this.db
        .prepare(
          "select * from edge_worker_release_operations where release_id = ? order by created_at asc, id asc",
        )
        .all(releaseId)
      : this.db
        .prepare("select * from edge_worker_release_operations order by created_at asc, id asc")
        .all();
    return rows.map(edgeWorkerReleaseOperationFromRow);
  }

  listPendingEdgeWorkerReleaseOperations(now: string): EdgeWorkerReleaseOperation[] {
    return this.db
      .prepare(
        `select * from edge_worker_release_operations
         where status = 'pending' and next_attempt_at <= ?
         order by next_attempt_at asc, id asc`,
      )
      .all(now)
      .map(edgeWorkerReleaseOperationFromRow);
  }

  updateEdgeWorkerReleaseOperation(operation: EdgeWorkerReleaseOperation): EdgeWorkerReleaseOperation {
    const result = this.db
      .prepare(
        `update edge_worker_release_operations set
          status = ?,
          attempts = ?,
          next_attempt_at = ?,
          delete_provider = ?,
          force_provider_delete = ?,
          updated_at = ?,
          last_error = ?
         where id = ?`,
      )
      .run(
        operation.status,
        operation.attempts,
        operation.nextAttemptAt,
        operation.deleteProvider ? 1 : 0,
        operation.forceProviderDelete ? 1 : 0,
        operation.updatedAt,
        operation.lastError ?? null,
        operation.id,
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `edge worker release operation ${operation.id} was not found`);
    }
    return this.listEdgeWorkerReleaseOperations().find((item) => item.id === operation.id) as EdgeWorkerReleaseOperation;
  }

  createProject(project: Project): Project {
    try {
      this.db
        .prepare("insert into projects (id, organization_id, name, created_at) values (?, ?, ?, ?)")
        .run(project.id, project.organizationId ?? null, project.name, project.createdAt);
      return project;
    } catch (error) {
      throw writeError("project", project.id, error);
    }
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("select * from projects where id = ?").get(id);
    return row ? projectFromRow(row) : undefined;
  }

  listOrganizationProjects(organizationId: string): Project[] {
    return this.db
      .prepare("select * from projects where organization_id = ? order by created_at asc, id asc")
      .all(organizationId)
      .map(projectFromRow);
  }

  getProjectUsage(projectId: string): ProjectResourceUsage {
    const row = this.db
      .prepare(
        `select
          (select count(*) from artifacts where project_id = ?) as artifacts,
          (select count(*) from deployments where project_id = ?) as deployments,
          (select count(*) from routes where project_id = ?) as routes,
          (select count(*) from secrets where project_id = ?) as secrets,
          (select count(*) from kv_namespaces where project_id = ?) as kv_namespaces,
          (select count(*) from durable_object_namespaces where project_id = ?) as durable_object_namespaces`,
      )
      .get(projectId, projectId, projectId, projectId, projectId, projectId) as any;
    return usageFromRow(row);
  }

  createArtifact(artifact: Artifact): Artifact {
    try {
      this.db
        .prepare(
          `insert into artifacts (
            id,
            project_id,
            digest,
            location,
            size_bytes,
            signature_json,
            provenance_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.projectId,
          artifact.digest,
          artifact.location,
          artifact.sizeBytes,
          artifact.signature ? JSON.stringify(artifact.signature) : null,
          artifact.provenance ? JSON.stringify(artifact.provenance) : null,
          artifact.createdAt,
        );
      return artifact;
    } catch (error) {
      throw writeError("artifact", artifact.id, error);
    }
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.db.prepare("select * from artifacts where id = ?").get(id);
    return row ? artifactFromRow(row) : undefined;
  }

  getArtifactByProjectDigest(projectId: string, digest: string): Artifact | undefined {
    const row = this.db
      .prepare("select * from artifacts where project_id = ? and digest = ?")
      .get(projectId, digest);
    return row ? artifactFromRow(row) : undefined;
  }

  createSecret(secret: Secret, value: string): Secret {
    try {
      this.db
        .prepare(
          `insert into secrets (
            id,
            project_id,
            name,
            value,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          secret.id,
          secret.projectId,
          secret.name,
          value,
          secret.createdAt,
          secret.updatedAt,
        );
      return secret;
    } catch (error) {
      throw writeError("secret", secret.id, error);
    }
  }

  getSecret(id: string): Secret | undefined {
    const row = this.db.prepare("select * from secrets where id = ?").get(id);
    return row ? secretFromRow(row) : undefined;
  }

  getSecretValue(id: string): string | undefined {
    const row = this.db.prepare("select value from secrets where id = ?").get(id);
    return row ? (row as any).value : undefined;
  }

  listProjectSecrets(projectId: string): Secret[] {
    const rows = this.db
      .prepare("select * from secrets where project_id = ? order by name asc, id asc")
      .all(projectId);
    return rows.map(secretFromRow);
  }

  updateSecretValue(id: string, value: string, updatedAt: string): Secret {
    const result = this.db
      .prepare("update secrets set value = ?, updated_at = ? where id = ?")
      .run(value, updatedAt, id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `secret ${id} was not found`);
    }
    return this.getSecret(id) as Secret;
  }

  deleteSecret(id: string): void {
    const result = this.db.prepare("delete from secrets where id = ?").run(id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `secret ${id} was not found`);
    }
  }

  createKvNamespace(namespace: KvNamespace): KvNamespace {
    try {
      this.db
        .prepare(
          `insert into kv_namespaces (
            id,
            project_id,
            name,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?)`,
        )
        .run(
          namespace.id,
          namespace.projectId,
          namespace.name,
          namespace.createdAt,
          namespace.updatedAt,
        );
      return namespace;
    } catch (error) {
      throw writeError("kv namespace", namespace.id, error);
    }
  }

  getKvNamespace(id: string): KvNamespace | undefined {
    const row = this.db.prepare("select * from kv_namespaces where id = ?").get(id);
    return row ? kvNamespaceFromRow(row) : undefined;
  }

  listProjectKvNamespaces(projectId: string): KvNamespace[] {
    const rows = this.db
      .prepare("select * from kv_namespaces where project_id = ? order by name asc, id asc")
      .all(projectId);
    return rows.map(kvNamespaceFromRow);
  }

  deleteKvNamespace(id: string): void {
    const result = this.db.prepare("delete from kv_namespaces where id = ?").run(id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `kv namespace ${id} was not found`);
    }
  }

  createDurableObjectNamespace(namespace: DurableObjectNamespace): DurableObjectNamespace {
    try {
      this.db
        .prepare(
          `insert into durable_object_namespaces (
            id,
            project_id,
            name,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?)`,
        )
        .run(
          namespace.id,
          namespace.projectId,
          namespace.name,
          namespace.createdAt,
          namespace.updatedAt,
        );
      return namespace;
    } catch (error) {
      throw writeError("durable object namespace", namespace.id, error);
    }
  }

  getDurableObjectNamespace(id: string): DurableObjectNamespace | undefined {
    const row = this.db.prepare("select * from durable_object_namespaces where id = ?").get(id);
    return row ? durableObjectNamespaceFromRow(row) : undefined;
  }

  listProjectDurableObjectNamespaces(projectId: string): DurableObjectNamespace[] {
    const rows = this.db
      .prepare("select * from durable_object_namespaces where project_id = ? order by name asc, id asc")
      .all(projectId);
    return rows.map(durableObjectNamespaceFromRow);
  }

  deleteDurableObjectNamespace(id: string): void {
    const result = this.db.prepare("delete from durable_object_namespaces where id = ?").run(id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `durable object namespace ${id} was not found`);
    }
  }

  createDeployment(deployment: Deployment): Deployment {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return deployment;
    } catch (error) {
      throw writeError("deployment", deployment.id, error);
    }
  }

  getDeployment(id: string): Deployment | undefined {
    const row = this.db.prepare("select * from deployments where id = ?").get(id);
    return row ? deploymentFromRow(row) : undefined;
  }

  upsertRoute(route: RoutePointer): RoutePointer {
    try {
      this.db
        .prepare(
          `insert into routes (
            id,
            project_id,
            host,
            path_prefix,
            deployment_id,
            targets_json,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?)
          on conflict(project_id, host, path_prefix) do update set
            deployment_id = excluded.deployment_id,
            targets_json = excluded.targets_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          route.id,
          route.projectId,
          route.host,
          route.pathPrefix,
          route.deploymentId,
          JSON.stringify(route.targets),
          route.updatedAt,
        );
      const row = this.db
        .prepare("select * from routes where project_id = ? and host = ? and path_prefix = ?")
        .get(route.projectId, route.host, route.pathPrefix);
      return routeFromRow(row);
    } catch (error) {
      throw writeError("route", route.id, error);
    }
  }

  getRoute(projectId: string, host: string, pathPrefix: string): RoutePointer | undefined {
    const row = this.db
      .prepare("select * from routes where project_id = ? and host = ? and path_prefix = ?")
      .get(projectId, host, pathPrefix);
    return row ? routeFromRow(row) : undefined;
  }

  deleteRoute(projectId: string, host: string, pathPrefix: string): void {
    this.db
      .prepare("delete from routes where project_id = ? and host = ? and path_prefix = ?")
      .run(projectId, host, pathPrefix);
  }

  listRoutes(): RoutePointer[] {
    const rows = this.db
      .prepare("select * from routes order by host asc, length(path_prefix) desc, path_prefix asc")
      .all();
    return rows.map(routeFromRow);
  }

  createRuntimeNode(node: RuntimeNode): RuntimeNode {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return node;
    } catch (error) {
      throw writeError("runtime node", node.id, error);
    }
  }

  getRuntimeNode(id: string): RuntimeNode | undefined {
    const row = this.db.prepare("select * from runtime_nodes where id = ?").get(id);
    return row ? runtimeNodeFromRow(row) : undefined;
  }

  updateRuntimeNodeHeartbeat(node: RuntimeNode): RuntimeNode {
    const result = this.db
      .prepare(
        `update runtime_nodes set
          status = ?,
          last_seen_at = ?,
          version = ?,
          capacity_json = ?,
          region = ?,
          labels_json = ?,
          load_json = ?,
          identity_json = ?,
          host_json = ?
        where id = ?`,
      )
      .run(
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
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${node.id} was not found`);
    }
    return this.getRuntimeNode(node.id) as RuntimeNode;
  }

  updateRuntimeNodeStatus(id: string, status: RuntimeNodeStatus): RuntimeNode {
    const result = this.db
      .prepare("update runtime_nodes set status = ? where id = ?")
      .run(status, id);
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${id} was not found`);
    }
    return this.getRuntimeNode(id) as RuntimeNode;
  }

  deleteRuntimeNode(id: string): RuntimeNode {
    const node = this.getRuntimeNode(id);
    if (!node) {
      throw new ControlPlaneError("not_found", `runtime node ${id} was not found`);
    }
    this.db.prepare("delete from runtime_nodes where id = ?").run(id);
    return node;
  }

  listRuntimeNodes(): RuntimeNode[] {
    const rows = this.db.prepare("select * from runtime_nodes order by id asc").all();
    return rows.map(runtimeNodeFromRow);
  }

  createRouteSnapshotPublication(
    publication: RouteSnapshotPublication,
  ): RouteSnapshotPublication {
    try {
      this.db
        .prepare(
          `insert into route_snapshot_publications (
            id,
            snapshot_id,
            snapshot_generated_at,
            routes,
            ok,
            targets_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publication.id,
          publication.snapshotId ?? null,
          publication.snapshotGeneratedAt,
          publication.routes,
          publication.ok ? 1 : 0,
          JSON.stringify(publication.targets),
          publication.createdAt,
        );
      return publication;
    } catch (error) {
      throw writeError("route snapshot publication", publication.id, error);
    }
  }

  listRouteSnapshotPublications(): RouteSnapshotPublication[] {
    const rows = this.db
      .prepare("select * from route_snapshot_publications order by created_at desc, id desc")
      .all();
    return rows.map(routeSnapshotPublicationFromRow);
  }

  createCanaryDecision(decision: CanaryDecision): CanaryDecision {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      return decision;
    } catch (error) {
      throw writeError("canary decision", decision.id, error);
    }
  }

  listCanaryDecisions(): CanaryDecision[] {
    const rows = this.db.prepare("select * from canary_decisions order by created_at desc, id desc").all();
    return rows.map(canaryDecisionFromRow);
  }

  private runMigrations() {
    for (const migration of migrations) {
      const row = this.db
        .prepare("select id from schema_migrations where id = ?")
        .get(migration.id);
      if (row) {
        continue;
      }
      migration.apply(this.db);
      this.db
        .prepare("insert into schema_migrations (id, applied_at) values (?, ?)")
        .run(migration.id, new Date().toISOString());
    }
  }
}

function organizationFromRow(row: any): Organization {
  return {
    id: row.id,
    name: row.name,
    billingProvider: row.billing_provider ?? "none",
    ...(row.billing_customer_id ? { billingCustomerId: row.billing_customer_id } : {}),
    paymentStatus: row.payment_status ?? "payment_pending",
    ...(row.billing_email ? { billingEmail: row.billing_email } : {}),
    paymentStatusUpdatedAt: row.payment_status_updated_at ?? row.created_at,
    createdAt: row.created_at,
  };
}

function userFromRow(row: any): User {
  return {
    id: row.id,
    email: row.email,
    ...(row.name ? { name: row.name } : {}),
    ...(row.email_verified_at ? { emailVerifiedAt: row.email_verified_at } : {}),
    createdAt: row.created_at,
  };
}

function membershipFromRow(row: any): ProjectMembership {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    inviteStatus: row.invite_status ?? "pending",
    invitedAt: row.invited_at || row.created_at,
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    createdAt: row.created_at,
  };
}

function apiKeyFromRow(row: any): ApiKey {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function usageEventFromRow(row: any): UsageEvent {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    projectId: row.project_id,
    metric: row.metric,
    quantity: Number(row.quantity),
    ...(row.dimensions_json ? { dimensions: JSON.parse(row.dimensions_json) } : {}),
    recordedAt: row.recorded_at,
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
    environment: JSON.parse(row.environment_json),
    ...(row.previous_route_json ? { previousRoute: JSON.parse(row.previous_route_json) } : {}),
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
    artifact: JSON.parse(row.artifact_json),
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
    attempts: row.attempts,
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
    sizeBytes: row.size_bytes,
    ...(row.signature_json ? { signature: JSON.parse(row.signature_json) } : {}),
    ...(row.provenance_json ? { provenance: JSON.parse(row.provenance_json) } : {}),
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
    limits: JSON.parse(row.limits_json),
    capabilities: JSON.parse(row.capabilities_json),
    createdAt: row.created_at,
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

function routeFromRow(row: any): RoutePointer {
  return {
    id: row.id,
    projectId: row.project_id,
    host: row.host,
    pathPrefix: row.path_prefix,
    deploymentId: row.deployment_id,
    targets: row.targets_json
      ? JSON.parse(row.targets_json)
      : [{ deploymentId: row.deployment_id, weight: 100 }],
    updatedAt: row.updated_at,
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
    node.capacity = JSON.parse(row.capacity_json);
  }
  if (row.region) {
    node.region = row.region;
  }
  if (row.labels_json) {
    node.labels = JSON.parse(row.labels_json);
  }
  if (row.load_json) {
    node.load = JSON.parse(row.load_json);
  }
  if (row.identity_json) {
    node.identity = JSON.parse(row.identity_json);
  }
  if (row.host_json) {
    node.host = JSON.parse(row.host_json);
  }
  return node;
}

function routeSnapshotPublicationFromRow(row: any): RouteSnapshotPublication {
  return {
    id: row.id,
    ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
    snapshotGeneratedAt: row.snapshot_generated_at,
    routes: row.routes,
    ok: row.ok === 1,
    targets: JSON.parse(row.targets_json),
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
    metrics: JSON.parse(row.metrics_json),
    thresholds: JSON.parse(row.thresholds_json),
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
    period: JSON.parse(row.period_json),
    currency: row.currency,
    totalUsd: Number(row.total_usd),
    rates: JSON.parse(row.rates_json),
    rateCardVersion: row.rate_card_version,
    statement: JSON.parse(row.statement_json),
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
    payload: JSON.parse(row.payload_json),
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

function writeError(kind: string, id: string, error: unknown): ControlPlaneError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed")) {
    return new ControlPlaneError("conflict", `${kind} ${id} already exists`);
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ControlPlaneError("validation", `${kind} ${id} references missing records`);
  }
  return new ControlPlaneError("validation", message);
}

const schema = `
pragma foreign_keys = on;

create table if not exists schema_migrations (
  id text primary key,
  applied_at text not null
);

create table if not exists organizations (
  id text primary key,
  name text not null unique,
  billing_provider text not null default 'none',
  billing_customer_id text,
  payment_status text not null default 'payment_pending',
  billing_email text,
  payment_status_updated_at text not null,
  created_at text not null
);

create table if not exists users (
  id text primary key,
  email text not null unique,
  name text,
  email_verified_at text,
  created_at text not null
);

create table if not exists projects (
  id text primary key,
  organization_id text,
  name text not null unique,
  created_at text not null,
  foreign key (organization_id) references organizations(id)
);

create table if not exists project_memberships (
  project_id text not null,
  user_id text not null,
  role text not null,
  invite_status text not null default 'pending',
  invited_at text not null,
  accepted_at text,
  created_at text not null,
  primary key (project_id, user_id),
  foreign key (project_id) references projects(id),
  foreign key (user_id) references users(id)
);

create table if not exists production_quota_increases (
  id text primary key,
  organization_id text not null,
  project_id text,
  requested_quotas_json text not null,
  status text not null,
  checks_json text not null,
  created_at text not null,
  approved_at text not null,
  foreign key (organization_id) references organizations(id),
  foreign key (project_id) references projects(id)
);

create index if not exists production_quota_increases_org_idx
  on production_quota_increases (organization_id, created_at desc, id desc);

create table if not exists api_keys (
  id text primary key,
  organization_id text,
  project_id text,
  name text not null,
  token_hash text not null unique,
  scopes_json text not null,
  created_at text not null,
  last_used_at text,
  revoked_at text,
  foreign key (organization_id) references organizations(id),
  foreign key (project_id) references projects(id)
);

create table if not exists usage_events (
  id text primary key,
  organization_id text,
  project_id text not null,
  metric text not null,
  quantity real not null,
  dimensions_json text,
  recorded_at text not null,
  foreign key (organization_id) references organizations(id),
  foreign key (project_id) references projects(id)
);

create index if not exists usage_events_project_time_idx
  on usage_events (project_id, recorded_at);

create index if not exists usage_events_org_time_idx
  on usage_events (organization_id, recorded_at);

create table if not exists billing_invoices (
  id text primary key,
  organization_id text not null,
  period_key text not null,
  period_json text not null,
  currency text not null,
  total_usd real not null,
  rates_json text not null,
  rate_card_version text not null,
  content_digest text not null,
  statement_json text not null,
  issued_at text not null,
  unique (organization_id, period_key),
  foreign key (organization_id) references organizations(id)
);

create index if not exists billing_invoices_org_issued_idx
  on billing_invoices (organization_id, issued_at desc, id desc);

create table if not exists billing_webhook_deliveries (
  id text primary key,
  event_type text not null,
  target_url text not null,
  idempotency_key text not null unique,
  status text not null,
  payload_json text not null,
  attempts integer not null,
  next_attempt_at text,
  last_attempt_at text,
  last_status integer,
  last_error text,
  created_at text not null,
  updated_at text not null,
  delivered_at text
);

create index if not exists billing_webhook_deliveries_status_next_idx
  on billing_webhook_deliveries (status, next_attempt_at, created_at, id);

create table if not exists billing_invoice_adjustments (
  id text primary key,
  invoice_id text not null,
  organization_id text not null,
  type text not null,
  currency text not null,
  amount_usd real not null,
  reason text not null,
  created_at text not null,
  foreign key (invoice_id) references billing_invoices(id),
  foreign key (organization_id) references organizations(id)
);

create index if not exists billing_invoice_adjustments_invoice_idx
  on billing_invoice_adjustments (invoice_id, created_at asc, id asc);

create table if not exists billing_invoice_retention_policies (
  invoice_id text primary key,
  organization_id text not null,
  retain_until text not null,
  legal_hold integer not null,
  legal_hold_reason text,
  updated_at text not null,
  foreign key (invoice_id) references billing_invoices(id),
  foreign key (organization_id) references organizations(id)
);

create index if not exists billing_invoice_retention_policies_org_idx
  on billing_invoice_retention_policies (organization_id, retain_until, invoice_id);

create table if not exists custom_domains (
  id text primary key,
  project_id text not null,
  host text not null unique,
  status text not null,
  verification_token text not null,
  verification_record_name text not null,
  verification_record_value text not null,
  tls_status text not null,
  tls_provider text,
  tls_request_id text,
  tls_error text,
  created_at text not null,
  updated_at text not null,
  verified_at text,
  tls_provisioned_at text,
  foreign key (project_id) references projects(id)
);

create index if not exists custom_domains_project_idx
  on custom_domains (project_id, host);

create table if not exists artifacts (
  id text primary key,
  project_id text not null,
  digest text not null unique,
  location text not null,
  size_bytes integer not null,
  signature_json text,
  provenance_json text,
  created_at text not null,
  foreign key (project_id) references projects(id)
);

create table if not exists secrets (
  id text primary key,
  project_id text not null,
  name text not null,
  value text not null,
  created_at text not null,
  updated_at text not null,
  unique (project_id, name),
  foreign key (project_id) references projects(id)
);

create table if not exists kv_namespaces (
  id text primary key,
  project_id text not null,
  name text not null,
  created_at text not null,
  updated_at text not null,
  unique (project_id, name),
  foreign key (project_id) references projects(id)
);

create table if not exists durable_object_namespaces (
  id text primary key,
  project_id text not null,
  name text not null,
  created_at text not null,
  updated_at text not null,
  unique (project_id, name),
  foreign key (project_id) references projects(id)
);

create table if not exists deployments (
  id text primary key,
  project_id text not null,
  artifact_id text not null,
  world text not null,
  world_version text not null default '0.1.0',
  runtime_backend text not null,
  runtime_version text not null,
  wasi_version text not null,
  limits_json text not null,
  capabilities_json text not null,
  created_at text not null,
  foreign key (project_id) references projects(id),
  foreign key (artifact_id) references artifacts(id)
);

create table if not exists routes (
  id text primary key,
  project_id text not null,
  host text not null,
  path_prefix text not null,
  deployment_id text not null,
  targets_json text,
  updated_at text not null,
  unique (project_id, host, path_prefix),
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);

create table if not exists deploy_previews (
  id text primary key,
  project_id text not null,
  deployment_id text not null,
  host text not null,
  path_prefix text not null,
  url text not null,
  environment_json text not null,
  previous_route_json text,
  status text not null,
  created_at text not null,
  updated_at text not null,
  rolled_back_at text,
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);

create index if not exists deploy_previews_project_idx
  on deploy_previews (project_id, created_at desc, id desc);

create table if not exists edge_worker_releases (
  id text primary key,
  project_id text not null,
  deployment_id text not null,
  provider text not null,
  mode text not null,
  status text not null default 'active',
  script_name text not null,
  script_digest text not null,
  script_module text not null,
  artifact_json text not null,
  version_id text,
  external_deployment_id text,
  url text,
  created_at text not null,
  updated_at text not null default '',
  deleted_at text,
  last_error text,
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);

create index if not exists edge_worker_releases_project_idx
  on edge_worker_releases (project_id, created_at desc, id desc);

create table if not exists edge_worker_release_operations (
  id text primary key,
  release_id text not null,
  action text not null,
  status text not null,
  attempts integer not null,
  next_attempt_at text not null,
  delete_provider integer not null,
  force_provider_delete integer not null,
  created_at text not null,
  updated_at text not null,
  last_error text,
  foreign key (release_id) references edge_worker_releases(id)
);

create index if not exists edge_worker_release_operations_pending_idx
  on edge_worker_release_operations (status, next_attempt_at, id);

create index if not exists edge_worker_release_operations_release_idx
  on edge_worker_release_operations (release_id, created_at asc, id asc);

create table if not exists runtime_nodes (
  id text primary key,
  url text not null unique,
  status text not null default 'active',
  last_seen_at text,
  version text,
  capacity_json text,
  region text,
  labels_json text,
  load_json text,
  identity_json text,
  host_json text,
  registered_at text not null
);

create table if not exists route_snapshot_publications (
  id text primary key,
  snapshot_id text,
  snapshot_generated_at text not null,
  routes integer not null,
  ok integer not null,
  targets_json text not null,
  created_at text not null
);

create table if not exists canary_decisions (
  id text primary key,
  project_id text not null,
  host text not null,
  path_prefix text not null,
  stable_deployment_id text not null,
  candidate_deployment_id text not null,
  action text not null,
  reason text not null,
  metrics_json text not null,
  thresholds_json text not null,
  created_at text not null,
  foreign key (project_id) references projects(id)
);

create table if not exists fly_autoscaler_coordination (
  coordination_key text primary key,
  lease_holder text,
  lease_expires_at_ms integer,
  cooldown_action text,
  cooldown_at_ms integer,
  cooldown_until_ms integer,
  updated_at text not null
);
`;

interface SchemaMigration {
  id: string;
  apply(db: DatabaseSync): void;
}

const migrations: SchemaMigration[] = [
  {
    id: "202606260001_wasip3_alias",
    apply(db) {
      db.exec("update deployments set wasi_version = 'wasip3' where wasi_version = '0.3'");
    },
  },
  {
    id: "202606260002_route_targets",
    apply(db) {
      ensureColumn(db, "routes", "targets_json", "text");
    },
  },
  {
    id: "202606260003_runtime_node_health",
    apply(db) {
      ensureColumn(db, "runtime_nodes", "status", "text not null default 'active'");
      ensureColumn(db, "runtime_nodes", "last_seen_at", "text");
      ensureColumn(db, "runtime_nodes", "version", "text");
      ensureColumn(db, "runtime_nodes", "capacity_json", "text");
    },
  },
  {
    id: "202606260004_route_snapshot_publications",
    apply(db) {
      db.exec(`
        create table if not exists route_snapshot_publications (
          id text primary key,
          snapshot_id text,
          snapshot_generated_at text not null,
          routes integer not null,
          ok integer not null,
          targets_json text not null,
          created_at text not null
        )
      `);
    },
  },
  {
    id: "202606270001_secret_registry",
    apply(db) {
      db.exec(`
        create table if not exists secrets (
          id text primary key,
          project_id text not null,
          name text not null,
          value text not null,
          created_at text not null,
          updated_at text not null,
          unique (project_id, name),
          foreign key (project_id) references projects(id)
        )
      `);
    },
  },
  {
    id: "202606270002_kv_namespace_registry",
    apply(db) {
      db.exec(`
        create table if not exists kv_namespaces (
          id text primary key,
          project_id text not null,
          name text not null,
          created_at text not null,
          updated_at text not null,
          unique (project_id, name),
          foreign key (project_id) references projects(id)
        )
      `);
    },
  },
  {
    id: "202606270003_durable_object_namespace_registry",
    apply(db) {
      db.exec(`
        create table if not exists durable_object_namespaces (
          id text primary key,
          project_id text not null,
          name text not null,
          created_at text not null,
          updated_at text not null,
          unique (project_id, name),
          foreign key (project_id) references projects(id)
        )
      `);
    },
  },
  {
    id: "202606300002_route_snapshot_id",
    apply(db) {
      ensureColumn(db, "route_snapshot_publications", "snapshot_id", "text");
    },
  },
  {
    id: "202606300003_runtime_node_placement",
    apply(db) {
      ensureColumn(db, "runtime_nodes", "region", "text");
      ensureColumn(db, "runtime_nodes", "labels_json", "text");
      ensureColumn(db, "runtime_nodes", "load_json", "text");
    },
  },
  {
    id: "202606300004_canary_decisions",
    apply(db) {
      db.exec(`
        create table if not exists canary_decisions (
          id text primary key,
          project_id text not null,
          host text not null,
          path_prefix text not null,
          stable_deployment_id text not null,
          candidate_deployment_id text not null,
          action text not null,
          reason text not null,
          metrics_json text not null,
          thresholds_json text not null,
          created_at text not null,
          foreign key (project_id) references projects(id)
        )
      `);
    },
  },
  {
    id: "202606300005_worker_world_version",
    apply(db) {
      ensureColumn(db, "deployments", "world_version", "text not null default '0.1.0'");
      db.exec("update deployments set world_version = '0.1.0' where world_version is null or world_version = ''");
    },
  },
  {
    id: "202606300006_artifact_metadata",
    apply(db) {
      ensureColumn(db, "artifacts", "signature_json", "text");
      ensureColumn(db, "artifacts", "provenance_json", "text");
    },
  },
  {
    id: "202607010001_runtime_node_identity",
    apply(db) {
      ensureColumn(db, "runtime_nodes", "identity_json", "text");
    },
  },
  {
    id: "202607010002_runtime_node_host_info",
    apply(db) {
      ensureColumn(db, "runtime_nodes", "host_json", "text");
    },
  },
  {
    id: "202607010003_fly_autoscaler_coordination",
    apply(db) {
      db.exec(`
        create table if not exists fly_autoscaler_coordination (
          coordination_key text primary key,
          lease_holder text,
          lease_expires_at_ms integer,
          cooldown_action text,
          cooldown_at_ms integer,
          cooldown_until_ms integer,
          updated_at text not null
        )
      `);
    },
  },
  {
    id: "202607010004_tenant_identity",
    apply(db) {
      db.exec(`
        create table if not exists organizations (
          id text primary key,
          name text not null unique,
          created_at text not null
        );

        create table if not exists users (
          id text primary key,
          email text not null unique,
          name text,
          email_verified_at text,
          created_at text not null
        );

        create table if not exists project_memberships (
          project_id text not null,
          user_id text not null,
          role text not null,
          invite_status text not null default 'pending',
          invited_at text not null,
          accepted_at text,
          created_at text not null,
          primary key (project_id, user_id),
          foreign key (project_id) references projects(id),
          foreign key (user_id) references users(id)
        );

        create table if not exists api_keys (
          id text primary key,
          organization_id text,
          project_id text,
          name text not null,
          token_hash text not null unique,
          scopes_json text not null,
          created_at text not null,
          last_used_at text,
          revoked_at text,
          foreign key (organization_id) references organizations(id),
          foreign key (project_id) references projects(id)
        );
      `);
      ensureColumn(db, "projects", "organization_id", "text references organizations(id)");
    },
  },
  {
    id: "202607010005_usage_metering",
    apply(db) {
      db.exec(`
        create table if not exists usage_events (
          id text primary key,
          organization_id text,
          project_id text not null,
          metric text not null,
          quantity real not null,
          dimensions_json text,
          recorded_at text not null,
          foreign key (organization_id) references organizations(id),
          foreign key (project_id) references projects(id)
        );

        create index if not exists usage_events_project_time_idx
          on usage_events (project_id, recorded_at);

        create index if not exists usage_events_org_time_idx
          on usage_events (organization_id, recorded_at);
      `);
    },
  },
  {
    id: "202607010006_custom_domains",
    apply(db) {
      db.exec(`
        create table if not exists custom_domains (
          id text primary key,
          project_id text not null,
          host text not null unique,
          status text not null,
          verification_token text not null,
          verification_record_name text not null,
          verification_record_value text not null,
          tls_status text not null,
          tls_provider text,
          tls_request_id text,
          tls_error text,
          created_at text not null,
          updated_at text not null,
          verified_at text,
          tls_provisioned_at text,
          foreign key (project_id) references projects(id)
        );

        create index if not exists custom_domains_project_idx
          on custom_domains (project_id, host);
      `);
    },
  },
  {
    id: "202607010007_deploy_previews",
    apply(db) {
      db.exec(`
        create table if not exists deploy_previews (
          id text primary key,
          project_id text not null,
          deployment_id text not null,
          host text not null,
          path_prefix text not null,
          url text not null,
          environment_json text not null,
          previous_route_json text,
          status text not null,
          created_at text not null,
          updated_at text not null,
          rolled_back_at text,
          foreign key (project_id) references projects(id),
          foreign key (deployment_id) references deployments(id)
        );

        create index if not exists deploy_previews_project_idx
          on deploy_previews (project_id, created_at desc, id desc);
      `);
    },
  },
  {
    id: "202607020001_billing_invoices",
    apply(db) {
      db.exec(`
        create table if not exists billing_invoices (
          id text primary key,
          organization_id text not null,
          period_key text not null,
          period_json text not null,
          currency text not null,
          total_usd real not null,
          rates_json text not null,
          rate_card_version text not null,
          content_digest text not null,
          statement_json text not null,
          issued_at text not null,
          unique (organization_id, period_key),
          foreign key (organization_id) references organizations(id)
        );

        create index if not exists billing_invoices_org_issued_idx
          on billing_invoices (organization_id, issued_at desc, id desc);
      `);
    },
  },
  {
    id: "202607020002_billing_invoice_digest",
    apply(db) {
      ensureColumn(db, "billing_invoices", "content_digest", "text not null default ''");
    },
  },
  {
    id: "202607020003_billing_webhook_deliveries",
    apply(db) {
      db.exec(`
        create table if not exists billing_webhook_deliveries (
          id text primary key,
          event_type text not null,
          target_url text not null,
          idempotency_key text not null unique,
          status text not null,
          payload_json text not null,
          attempts integer not null,
          next_attempt_at text,
          last_attempt_at text,
          last_status integer,
          last_error text,
          created_at text not null,
          updated_at text not null,
          delivered_at text
        );

        create index if not exists billing_webhook_deliveries_status_next_idx
          on billing_webhook_deliveries (status, next_attempt_at, created_at, id);
      `);
    },
  },
  {
    id: "202607020004_billing_invoice_adjustments",
    apply(db) {
      db.exec(`
        create table if not exists billing_invoice_adjustments (
          id text primary key,
          invoice_id text not null,
          organization_id text not null,
          type text not null,
          currency text not null,
          amount_usd real not null,
          reason text not null,
          created_at text not null,
          foreign key (invoice_id) references billing_invoices(id),
          foreign key (organization_id) references organizations(id)
        );

        create index if not exists billing_invoice_adjustments_invoice_idx
          on billing_invoice_adjustments (invoice_id, created_at asc, id asc);
      `);
    },
  },
  {
    id: "202607020005_billing_invoice_retention_policies",
    apply(db) {
      db.exec(`
        create table if not exists billing_invoice_retention_policies (
          invoice_id text primary key,
          organization_id text not null,
          retain_until text not null,
          legal_hold integer not null,
          legal_hold_reason text,
          updated_at text not null,
          foreign key (invoice_id) references billing_invoices(id),
          foreign key (organization_id) references organizations(id)
        );

        create index if not exists billing_invoice_retention_policies_org_idx
          on billing_invoice_retention_policies (organization_id, retain_until, invoice_id);
      `);
    },
  },
  {
    id: "202607030001_edge_worker_releases",
    apply(db) {
      db.exec(`
        create table if not exists edge_worker_releases (
          id text primary key,
          project_id text not null,
          deployment_id text not null,
          provider text not null,
          mode text not null,
          status text not null default 'active',
          script_name text not null,
          script_digest text not null,
          script_module text not null,
          artifact_json text not null,
          version_id text,
          external_deployment_id text,
          url text,
          created_at text not null,
          updated_at text not null default '',
          deleted_at text,
          last_error text,
          foreign key (project_id) references projects(id),
          foreign key (deployment_id) references deployments(id)
        );

        create index if not exists edge_worker_releases_project_idx
          on edge_worker_releases (project_id, created_at desc, id desc);
      `);
    },
  },
  {
    id: "202607030002_edge_worker_release_lifecycle",
    apply(db) {
      ensureColumn(db, "edge_worker_releases", "status", "text not null default 'active'");
      ensureColumn(db, "edge_worker_releases", "deleted_at", "text");
    },
  },
  {
    id: "202607030003_edge_worker_release_operations",
    apply(db) {
      ensureColumn(db, "edge_worker_releases", "updated_at", "text not null default ''");
      ensureColumn(db, "edge_worker_releases", "last_error", "text");
      db.exec(`
        update edge_worker_releases
        set updated_at = created_at
        where updated_at = '';

        create table if not exists edge_worker_release_operations (
          id text primary key,
          release_id text not null,
          action text not null,
          status text not null,
          attempts integer not null,
          next_attempt_at text not null,
          delete_provider integer not null,
          force_provider_delete integer not null,
          created_at text not null,
          updated_at text not null,
          last_error text,
          foreign key (release_id) references edge_worker_releases(id)
        );

        create index if not exists edge_worker_release_operations_pending_idx
          on edge_worker_release_operations (status, next_attempt_at, id);

        create index if not exists edge_worker_release_operations_release_idx
          on edge_worker_release_operations (release_id, created_at asc, id asc);
      `);
    },
  },
  {
    id: "202607070001_organization_billing_profile",
    apply(db) {
      ensureColumn(db, "organizations", "billing_provider", "text not null default 'none'");
      ensureColumn(db, "organizations", "billing_customer_id", "text");
      ensureColumn(db, "organizations", "payment_status", "text not null default 'payment_pending'");
      ensureColumn(db, "organizations", "billing_email", "text");
      ensureColumn(db, "organizations", "payment_status_updated_at", "text not null default ''");
      db.exec(`
        update organizations
        set payment_status_updated_at = created_at
        where payment_status_updated_at = ''
      `);
    },
  },
  {
    id: "202607080001_invite_email_quota_gate",
    apply(db) {
      ensureColumn(db, "users", "email_verified_at", "text");
      ensureColumn(db, "project_memberships", "invite_status", "text not null default 'pending'");
      ensureColumn(db, "project_memberships", "invited_at", "text not null default ''");
      ensureColumn(db, "project_memberships", "accepted_at", "text");
      db.exec(`
        update project_memberships
        set invited_at = created_at
        where invited_at = '';

        create table if not exists production_quota_increases (
          id text primary key,
          organization_id text not null,
          project_id text,
          requested_quotas_json text not null,
          status text not null,
          checks_json text not null,
          created_at text not null,
          approved_at text not null,
          foreign key (organization_id) references organizations(id),
          foreign key (project_id) references projects(id)
        );

        create index if not exists production_quota_increases_org_idx
          on production_quota_increases (organization_id, created_at desc, id desc);
      `);
    },
  },
];

export const SQLITE_SCHEMA_MIGRATION_IDS = migrations.map((migration) => migration.id);

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all();
  if (rows.some((row: any) => row.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
