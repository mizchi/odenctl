import { createServer } from "node:http";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RouteSnapshot,
  RouteSnapshotPublication,
  RuntimeNode,
} from "../control-plane/contracts.ts";
import type { AuditSink } from "../control-plane/audit.ts";
import { type ApiScope, type ApiToken, tokenAllows } from "../control-plane/authz.ts";
import type { LocalArtifactValidator } from "../control-plane/artifact-validation.ts";
import { ControlPlaneError, isControlPlaneError } from "../control-plane/errors.ts";
import {
  type ControlPlaneArtifactStore,
  createFileControlPlaneArtifactStore,
  decodeLocalArtifactBytes,
} from "../control-plane/artifact-store.ts";
import {
  type FetchLike,
  type RouteSnapshotPublishOptions,
  publishRouteSnapshot,
  type RuntimeNodeTarget,
} from "../control-plane/snapshot-publisher.ts";
import {
  assertReplicatedRouteSnapshot,
  replicateRouteSnapshot,
  type RouteSnapshotReplicaTarget,
  type RouteSnapshotReplicationOptions,
  type RouteSnapshotReplicaStore,
} from "../control-plane/snapshot-replication.ts";
import {
  defaultRouteSnapshotForTenantDrain,
  planRuntimeSnapshotPlacements,
  snapshotRequiresTenantDrainPublish,
  type RuntimePlacementPolicy,
} from "../control-plane/placement.ts";
import { runtimeSaturationSignals } from "../control-plane/autoscaling.ts";
import type {
  EnsureVolumeSqliteDatabaseInput,
  ExportVolumeSqliteDatabaseInput,
  PruneVolumeSqliteBackupsInput,
  RestoreVolumeSqliteDatabaseInput,
  VolumeSqliteBackupRecord,
  VolumeSqliteBackupGcReport,
  VolumeSqliteDatabaseRecord,
} from "../control-plane/volume-sqlite.ts";

type MaybePromise<T> = T | Promise<T>;

export interface HttpAppOptions {
  controlPlane: {
    createOrganization(input: any): MaybePromise<unknown>;
    createUser(input: any): MaybePromise<unknown>;
    createProject(input: any): MaybePromise<unknown>;
    addProjectMembership(input: any): MaybePromise<unknown>;
    listProjectMemberships(input: any): MaybePromise<unknown>;
    createApiKey(input: any): MaybePromise<unknown>;
    listProjectApiKeys(input: any): MaybePromise<unknown>;
    authenticateApiToken?(input: any): MaybePromise<ApiToken | undefined>;
    recordUsageEvent(input: any): MaybePromise<unknown>;
    getProjectUsageSummary(input: any): MaybePromise<unknown>;
    getProjectEnforcementReport(input: any): MaybePromise<unknown>;
    getProjectUsageQuotaReport(input: any): MaybePromise<unknown>;
    getProjectBillingStatement(input: any): MaybePromise<unknown>;
    getProjectBillingBudgetReport(input: any): MaybePromise<unknown>;
    getOrganizationBillingStatement(input: any): MaybePromise<unknown>;
    issueOrganizationBillingInvoice(input: any): MaybePromise<unknown>;
    getBillingInvoice(input: any): MaybePromise<unknown>;
    listOrganizationBillingInvoices(input: any): MaybePromise<unknown>;
    createCustomDomain(input: any): MaybePromise<unknown>;
    listProjectCustomDomains(input: any): MaybePromise<unknown>;
    verifyCustomDomainOwnership(input: any): MaybePromise<unknown>;
    requestCustomDomainTlsProvisioning(input: any): MaybePromise<unknown>;
    completeCustomDomainTlsProvisioning(input: any): MaybePromise<unknown>;
    createDeployPreview(input: any): MaybePromise<unknown>;
    listProjectDeployPreviews(input: any): MaybePromise<unknown>;
    rollbackDeployPreview(input: any): MaybePromise<unknown>;
    getProjectUsage(input: any): MaybePromise<unknown>;
    createArtifact(input: any): MaybePromise<unknown>;
    getProjectArtifactByDigest(input: any): MaybePromise<any | undefined>;
    createSecret(input: any): MaybePromise<unknown>;
    getSecret(input: any): MaybePromise<unknown>;
    listProjectSecrets(input: any): MaybePromise<unknown>;
    updateSecretValue(input: any): MaybePromise<unknown>;
    deleteSecret(input: any): MaybePromise<void>;
    createKvNamespace(input: any): MaybePromise<unknown>;
    getKvNamespace(input: any): MaybePromise<unknown>;
    listProjectKvNamespaces(input: any): MaybePromise<unknown>;
    deleteKvNamespace(input: any): MaybePromise<void>;
    createDeployment(input: any): MaybePromise<unknown>;
    pointRoute(input: any): MaybePromise<unknown>;
    startRouteCanary(input: any): MaybePromise<unknown>;
    analyzeRouteCanary(input: any): MaybePromise<unknown>;
    rollbackRoute(input: any): MaybePromise<unknown>;
    createRouteSnapshot(): MaybePromise<RouteSnapshot>;
    registerRuntimeNode(input: any): MaybePromise<RuntimeNode>;
    recordRuntimeNodeHeartbeat(input: any): MaybePromise<RuntimeNode>;
    updateRuntimeNodeStatus(input: any): MaybePromise<RuntimeNode>;
    cleanupRuntimeNodes(input: any): MaybePromise<unknown>;
    listRuntimeNodes(): MaybePromise<RuntimeNode[]>;
    listActiveRuntimeNodes(): MaybePromise<RuntimeNode[]>;
    recordRouteSnapshotPublication(input: any): MaybePromise<RouteSnapshotPublication>;
    listRouteSnapshotPublications(): MaybePromise<RouteSnapshotPublication[]>;
    listCanaryDecisions(): MaybePromise<unknown[]>;
  };
  runtimeNodes?: RuntimeNodeTarget[];
  runtimeNodeToken?: string;
  runtimeIdentityKeys?: Record<string, string>;
  runtimePlacement?: RuntimePlacementPolicy;
  routeSnapshotReplicaStore?: RouteSnapshotReplicaStore;
  routeSnapshotReplicas?: RouteSnapshotReplicaTarget[];
  snapshotReplication?: RouteSnapshotReplicationOptions;
  volumeSqliteRegistry?: VolumeSqliteRegistryApi;
  artifactStore?: ControlPlaneArtifactStore;
  artifactStoreDir?: string;
  artifactPublicBaseUrl?: string;
  artifactValidator?: LocalArtifactValidator;
  apiToken?: string;
  apiTokens?: ApiToken[];
  auditSink?: AuditSink;
  now?: () => string;
  fetch?: FetchLike;
  snapshotPublish?: RouteSnapshotPublishOptions;
}

export interface VolumeSqliteRegistryApi {
  ensureDatabase(input: EnsureVolumeSqliteDatabaseInput): MaybePromise<VolumeSqliteDatabaseRecord>;
  exportDatabase(input: ExportVolumeSqliteDatabaseInput): MaybePromise<VolumeSqliteBackupRecord>;
  restoreDatabase(input: RestoreVolumeSqliteDatabaseInput): MaybePromise<VolumeSqliteDatabaseRecord>;
  pruneBackups(input?: PruneVolumeSqliteBackupsInput): MaybePromise<VolumeSqliteBackupGcReport>;
  getDatabase(id: string): MaybePromise<VolumeSqliteDatabaseRecord | undefined>;
  listDatabases(): MaybePromise<VolumeSqliteDatabaseRecord[]>;
  listBackups(id?: string): MaybePromise<VolumeSqliteBackupRecord[]>;
  stats?(): MaybePromise<unknown>;
}

export function createHttpApp(options: HttpAppOptions) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }
      const localArtifact = localArtifactMatch(method, url.pathname);
      if (localArtifact) {
        const store = readableArtifactStore(options);
        if (!store) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        await writeLocalArtifact(response, store, localArtifact.digestHex);
        return;
      }
      const requiredScope = requiredScopeFor(method, url.pathname);
      const authorization = await authorizeRequest(options, request.headers, requiredScope);
      if (!authorization.ok) {
        writeJson(
          response,
          authorization.status,
          { error: { code: authorization.code, message: authorization.message } },
        );
        return;
      }
      installAuditHook(options, request, response, authorization.token, requiredScope, url.pathname);
      if (method === "GET" && url.pathname === "/admin") {
        writeHtml(response, 200, await renderAdminPage(options, url.searchParams.get("notice")));
        return;
      }
      if (method === "POST" && url.pathname === "/admin/routes/canary") {
        const form = await readForm(request);
        await options.controlPlane.startRouteCanary({
          projectId: requiredFormValue(form, "projectId"),
          host: requiredFormValue(form, "host"),
          pathPrefix: requiredFormValue(form, "pathPrefix"),
          deploymentId: requiredFormValue(form, "deploymentId"),
          weight: Number(requiredFormValue(form, "weight")),
        });
        writeRedirect(response, "/admin?notice=canary");
        return;
      }
      if (method === "POST" && url.pathname === "/admin/routes/rollback") {
        const form = await readForm(request);
        await options.controlPlane.rollbackRoute({
          projectId: requiredFormValue(form, "projectId"),
          host: requiredFormValue(form, "host"),
          pathPrefix: requiredFormValue(form, "pathPrefix"),
          deploymentId: optionalFormValue(form, "deploymentId"),
        });
        writeRedirect(response, "/admin?notice=rollback");
        return;
      }
      if (method === "POST" && url.pathname === "/admin/runtime-nodes/status") {
        const form = await readForm(request);
        await options.controlPlane.updateRuntimeNodeStatus({
          id: requiredFormValue(form, "runtimeNodeId"),
          status: requiredFormValue(form, "status"),
        });
        writeRedirect(response, "/admin?notice=runtime-node-status");
        return;
      }
      if (method === "POST" && url.pathname === "/admin/runtime-nodes/gc") {
        const form = await readForm(request);
        await options.controlPlane.cleanupRuntimeNodes({
          olderThanMs: Number(requiredFormValue(form, "olderThanMs")),
          statuses: formListValue(form, "statuses"),
        });
        writeRedirect(response, "/admin?notice=runtime-node-gc");
        return;
      }
      if (method === "POST" && url.pathname === "/organizations") {
        writeJson(response, 201, await options.controlPlane.createOrganization(await readJson(request)));
        return;
      }
      const organizationBillingStatement = organizationBillingStatementMatch(method, url.pathname);
      if (organizationBillingStatement) {
        writeJson(
          response,
          200,
          await options.controlPlane.getOrganizationBillingStatement({
            organizationId: organizationBillingStatement.organizationId,
            at: url.searchParams.get("at") ?? undefined,
          }),
        );
        return;
      }
      const listOrganizationBillingInvoices = listOrganizationBillingInvoicesMatch(method, url.pathname);
      if (listOrganizationBillingInvoices) {
        writeJson(
          response,
          200,
          await options.controlPlane.listOrganizationBillingInvoices({
            organizationId: listOrganizationBillingInvoices.organizationId,
          }),
        );
        return;
      }
      const organizationBillingInvoices = organizationBillingInvoicesMatch(method, url.pathname);
      if (organizationBillingInvoices) {
        writeJson(
          response,
          201,
          await options.controlPlane.issueOrganizationBillingInvoice({
            ...(await readJson(request)),
            organizationId: organizationBillingInvoices.organizationId,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/users") {
        writeJson(response, 201, await options.controlPlane.createUser(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/api-keys") {
        writeJson(response, 201, await options.controlPlane.createApiKey(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/usage/events") {
        writeJson(response, 201, await options.controlPlane.recordUsageEvent(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/custom-domains") {
        writeJson(response, 201, await options.controlPlane.createCustomDomain(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/deploy-previews") {
        writeJson(response, 201, await options.controlPlane.createDeployPreview(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/projects") {
        writeJson(response, 201, await options.controlPlane.createProject(await readJson(request)));
        return;
      }
      const projectCustomDomains = projectCustomDomainsMatch(method, url.pathname);
      if (projectCustomDomains) {
        writeJson(
          response,
          200,
          { domains: await options.controlPlane.listProjectCustomDomains({ projectId: projectCustomDomains.projectId }) },
        );
        return;
      }
      const projectDeployPreviews = projectDeployPreviewsMatch(method, url.pathname);
      if (projectDeployPreviews) {
        writeJson(
          response,
          200,
          {
            previews: await options.controlPlane.listProjectDeployPreviews({
              projectId: projectDeployPreviews.projectId,
            }),
          },
        );
        return;
      }
      const deployPreviewRollback = deployPreviewRollbackMatch(method, url.pathname);
      if (deployPreviewRollback) {
        writeJson(
          response,
          200,
          await options.controlPlane.rollbackDeployPreview({
            ...(await readJson(request)),
            id: deployPreviewRollback.id,
          }),
        );
        return;
      }
      const customDomainVerify = customDomainVerifyMatch(method, url.pathname);
      if (customDomainVerify) {
        writeJson(
          response,
          200,
          await options.controlPlane.verifyCustomDomainOwnership({
            ...(await readJson(request)),
            id: customDomainVerify.id,
          }),
        );
        return;
      }
      const customDomainTls = customDomainTlsMatch(method, url.pathname);
      if (customDomainTls) {
        writeJson(
          response,
          200,
          await options.controlPlane.requestCustomDomainTlsProvisioning({
            ...(await readJson(request)),
            id: customDomainTls.id,
          }),
        );
        return;
      }
      const customDomainTlsComplete = customDomainTlsCompleteMatch(method, url.pathname);
      if (customDomainTlsComplete) {
        writeJson(
          response,
          200,
          await options.controlPlane.completeCustomDomainTlsProvisioning({
            ...(await readJson(request)),
            id: customDomainTlsComplete.id,
          }),
        );
        return;
      }
      const projectMemberships = projectMembershipsMatch(method, url.pathname);
      if (projectMemberships && method === "POST") {
        const input = objectRecord(await readJson(request));
        writeJson(response, 201, await options.controlPlane.addProjectMembership({
          projectId: projectMemberships.projectId,
          userId: input.userId,
          role: input.role,
        }));
        return;
      }
      if (projectMemberships && method === "GET") {
        writeJson(
          response,
          200,
          { memberships: await options.controlPlane.listProjectMemberships({ projectId: projectMemberships.projectId }) },
        );
        return;
      }
      const projectApiKeys = projectApiKeysMatch(method, url.pathname);
      if (projectApiKeys) {
        writeJson(
          response,
          200,
          { apiKeys: await options.controlPlane.listProjectApiKeys({ projectId: projectApiKeys.projectId }) },
        );
        return;
      }
      const projectSqliteDatabases = projectSqliteDatabasesMatch(method, url.pathname);
      if (projectSqliteDatabases && method === "POST") {
        writeJson(response, 201, await ensureProjectSqliteDatabase(options, projectSqliteDatabases.projectId, request));
        return;
      }
      if (projectSqliteDatabases && method === "GET") {
        writeJson(response, 200, await listProjectSqliteDatabases(options, projectSqliteDatabases.projectId));
        return;
      }
      const sqliteDatabaseBackups = sqliteDatabaseBackupsMatch(method, url.pathname);
      const sqliteDatabaseBackupsGc = sqliteDatabaseBackupsGcMatch(method, url.pathname);
      if (sqliteDatabaseBackupsGc) {
        writeJson(response, 200, await pruneSqliteDatabaseBackups(options, sqliteDatabaseBackupsGc.id, request));
        return;
      }
      if (sqliteDatabaseBackups && method === "POST") {
        writeJson(response, 201, await createSqliteDatabaseBackup(options, sqliteDatabaseBackups.id, request));
        return;
      }
      if (sqliteDatabaseBackups && method === "GET") {
        writeJson(response, 200, await listSqliteDatabaseBackups(options, sqliteDatabaseBackups.id));
        return;
      }
      const sqliteDatabaseRestores = sqliteDatabaseRestoresMatch(method, url.pathname);
      if (sqliteDatabaseRestores) {
        writeJson(response, 200, await restoreSqliteDatabase(options, sqliteDatabaseRestores.id, request));
        return;
      }
      const sqliteDatabase = sqliteDatabaseMatch(method, url.pathname);
      if (sqliteDatabase) {
        writeJson(response, 200, await getSqliteDatabase(options, sqliteDatabase.id));
        return;
      }
      if (method === "GET" && url.pathname === "/sqlite-databases") {
        writeJson(response, 200, await listSqliteDatabases(options));
        return;
      }
      const projectQuotaUsage = projectQuotaUsageMatch(method, url.pathname);
      if (projectQuotaUsage) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectUsage({ projectId: projectQuotaUsage.projectId }),
        );
        return;
      }
      const projectUsage = projectUsageMatch(method, url.pathname);
      if (projectUsage) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectUsageSummary({
            projectId: projectUsage.projectId,
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
          }),
        );
        return;
      }
      const projectEnforcementReport = projectEnforcementReportMatch(method, url.pathname);
      if (projectEnforcementReport) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectEnforcementReport({
            projectId: projectEnforcementReport.projectId,
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
          }),
        );
        return;
      }
      const projectUsageQuotaReport = projectUsageQuotaReportMatch(method, url.pathname);
      if (projectUsageQuotaReport) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectUsageQuotaReport({
            projectId: projectUsageQuotaReport.projectId,
            at: url.searchParams.get("at") ?? undefined,
          }),
        );
        return;
      }
      const projectBillingStatement = projectBillingStatementMatch(method, url.pathname);
      if (projectBillingStatement) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectBillingStatement({
            projectId: projectBillingStatement.projectId,
            at: url.searchParams.get("at") ?? undefined,
          }),
        );
        return;
      }
      const projectBillingBudget = projectBillingBudgetMatch(method, url.pathname);
      if (projectBillingBudget) {
        writeJson(
          response,
          200,
          await options.controlPlane.getProjectBillingBudgetReport({
            projectId: projectBillingBudget.projectId,
            at: url.searchParams.get("at") ?? undefined,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts") {
        writeJson(response, 201, await options.controlPlane.createArtifact(await readJson(request)));
        return;
      }
      const billingInvoice = billingInvoiceMatch(method, url.pathname);
      if (billingInvoice) {
        writeJson(response, 200, await options.controlPlane.getBillingInvoice({ id: billingInvoice.id }));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts/local") {
        const store = artifactStoreForRequest(options);
        if (!store) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        const input = objectRecord(await readJson(request));
        const decoded = decodeLocalArtifactBytes(input.bytesBase64);
        const existing = await options.controlPlane.getProjectArtifactByDigest({
          projectId: input.projectId,
          digest: decoded.digest,
        });
        if (existing) {
          writeJson(response, 200, existing);
          return;
        }
        const stored = await putValidatedArtifact({
          store,
          validator: options.artifactValidator,
          decoded,
          publicBaseUrl: localArtifactPublicBaseUrl(options, request.headers),
        });
        writeJson(
          response,
          201,
          await options.controlPlane.createArtifact({
            id: input.id,
            projectId: input.projectId,
            digest: stored.digest,
            location: stored.location,
            sizeBytes: stored.sizeBytes,
            signature: input.signature,
            provenance: input.provenance,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/secrets") {
        writeJson(response, 201, await options.controlPlane.createSecret(await readJson(request)));
        return;
      }
      const projectSecrets = projectSecretsMatch(method, url.pathname);
      if (projectSecrets) {
        writeJson(
          response,
          200,
          await options.controlPlane.listProjectSecrets({ projectId: projectSecrets.projectId }),
        );
        return;
      }
      const secret = secretMatch(method, url.pathname);
      if (secret && method === "GET") {
        writeJson(response, 200, await options.controlPlane.getSecret({ id: secret.id }));
        return;
      }
      if (secret && method === "PUT") {
        writeJson(
          response,
          200,
          await options.controlPlane.updateSecretValue({
            ...(await readJson(request)),
            id: secret.id,
          }),
        );
        return;
      }
      if (secret && method === "DELETE") {
        await options.controlPlane.deleteSecret({ id: secret.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/kv-namespaces") {
        writeJson(response, 201, await options.controlPlane.createKvNamespace(await readJson(request)));
        return;
      }
      const projectKvNamespaces = projectKvNamespacesMatch(method, url.pathname);
      if (projectKvNamespaces) {
        writeJson(
          response,
          200,
          await options.controlPlane.listProjectKvNamespaces({
            projectId: projectKvNamespaces.projectId,
          }),
        );
        return;
      }
      const kvNamespace = kvNamespaceMatch(method, url.pathname);
      if (kvNamespace && method === "GET") {
        writeJson(response, 200, await options.controlPlane.getKvNamespace({ id: kvNamespace.id }));
        return;
      }
      if (kvNamespace && method === "DELETE") {
        await options.controlPlane.deleteKvNamespace({ id: kvNamespace.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/deployments") {
        writeJson(response, 201, await options.controlPlane.createDeployment(await readJson(request)));
        return;
      }
      if (method === "PUT" && url.pathname === "/routes") {
        writeJson(response, 200, await options.controlPlane.pointRoute(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/routes/canary") {
        writeJson(response, 200, await options.controlPlane.startRouteCanary(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/routes/canary/analyze") {
        writeJson(response, 200, await options.controlPlane.analyzeRouteCanary(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/routes/rollback") {
        writeJson(response, 200, await options.controlPlane.rollbackRoute(await readJson(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/canary-decisions") {
        writeJson(response, 200, await options.controlPlane.listCanaryDecisions());
        return;
      }
      if (method === "POST" && url.pathname === "/runtime-nodes") {
        writeJson(response, 201, await options.controlPlane.registerRuntimeNode(await readJson(request)));
        return;
      }
      const runtimeNodeHeartbeat = runtimeNodeHeartbeatMatch(method, url.pathname);
      if (runtimeNodeHeartbeat) {
        writeJson(
          response,
          200,
          await options.controlPlane.recordRuntimeNodeHeartbeat({
            ...(await readJson(request)),
            id: runtimeNodeHeartbeat.id,
          }),
        );
        return;
      }
      const runtimeNodeStatus = runtimeNodeStatusMatch(method, url.pathname);
      if (runtimeNodeStatus) {
        writeJson(
          response,
          200,
          await options.controlPlane.updateRuntimeNodeStatus({
            ...(await readJson(request)),
            id: runtimeNodeStatus.id,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/runtime-nodes/gc") {
        writeJson(response, 200, await options.controlPlane.cleanupRuntimeNodes(await readJson(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/runtime-nodes") {
        writeJson(response, 200, await options.controlPlane.listRuntimeNodes());
        return;
      }
      if (method === "GET" && url.pathname === "/autoscaling/signals") {
        writeJson(response, 200, {
          signals: runtimeSaturationSignals(await options.controlPlane.listRuntimeNodes()),
        });
        return;
      }
      const runtimeNodeLogs = runtimeNodeLogsMatch(method, url.pathname);
      if (runtimeNodeLogs) {
        writeJson(response, 200, await readRuntimeNodeLogs(options, runtimeNodeLogs.id, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes") {
        writeJson(response, 200, await options.controlPlane.createRouteSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/snapshots/routes/publish") {
        writeJson(response, 200, await publishCurrentRouteSnapshot(options));
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes/publishes") {
        writeJson(response, 200, await options.controlPlane.listRouteSnapshotPublications());
        return;
      }
      if (method === "PUT" && url.pathname === "/replication/snapshots/routes") {
        writeJson(response, 200, await applyReplicatedRouteSnapshot(options, request));
        return;
      }
      if (method === "GET" && url.pathname === "/replication/snapshots/routes") {
        writeJson(response, 200, readReplicatedRouteSnapshot(options));
        return;
      }

      writeJson(response, 404, { error: { code: "not_found", message: "route not found" } });
    } catch (error) {
      if (isControlPlaneError(error)) {
        writeJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: { code: "internal", message } });
    }
  });

  return {
    listen(options: { port: number; host?: string }) {
      return new Promise<typeof server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function ensureProjectSqliteDatabase(
  options: HttpAppOptions,
  projectId: string,
  request: any,
) {
  const registry = requiredVolumeSqliteRegistry(options);
  const input = objectRecord(await readJson(request));
  return registry.ensureDatabase({
    id: typeof input.id === "string" ? input.id : projectId,
    kind: typeof input.kind === "string" ? input.kind : "project",
    ownerId: projectId,
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : undefined,
  });
}

async function listProjectSqliteDatabases(options: HttpAppOptions, projectId: string) {
  const databases = await requiredVolumeSqliteRegistry(options).listDatabases();
  return {
    databases: databases.filter((database) => database.ownerId === projectId),
  };
}

async function getSqliteDatabase(options: HttpAppOptions, id: string) {
  const database = await requiredVolumeSqliteRegistry(options).getDatabase(id);
  if (!database) {
    throw new ControlPlaneError("not_found", `volume sqlite database ${id} was not found`);
  }
  return database;
}

async function createSqliteDatabaseBackup(options: HttpAppOptions, id: string, request: any) {
  const input = objectRecord(await readJson(request));
  return requiredVolumeSqliteRegistry(options).exportDatabase({
    id,
    backupId: typeof input.backupId === "string" ? input.backupId : undefined,
  });
}

async function listSqliteDatabaseBackups(options: HttpAppOptions, id: string) {
  return {
    backups: await requiredVolumeSqliteRegistry(options).listBackups(id),
  };
}

async function pruneSqliteDatabaseBackups(options: HttpAppOptions, id: string, request: any) {
  const input = objectRecord(await readJson(request));
  return requiredVolumeSqliteRegistry(options).pruneBackups({
    id,
    keepLatest: typeof input.keepLatest === "number" ? input.keepLatest : undefined,
    olderThanMs: typeof input.olderThanMs === "number" ? input.olderThanMs : undefined,
  });
}

async function restoreSqliteDatabase(options: HttpAppOptions, id: string, request: any) {
  const input = objectRecord(await readJson(request));
  return requiredVolumeSqliteRegistry(options).restoreDatabase({
    id,
    backupId: typeof input.backupId === "string" ? input.backupId : undefined,
    sourcePath: typeof input.sourcePath === "string" ? input.sourcePath : undefined,
    kind: typeof input.kind === "string" ? input.kind : undefined,
    ownerId: typeof input.ownerId === "string" ? input.ownerId : undefined,
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : undefined,
  });
}

async function listSqliteDatabases(options: HttpAppOptions) {
  const registry = requiredVolumeSqliteRegistry(options);
  return {
    databases: await registry.listDatabases(),
    stats: await registry.stats?.(),
  };
}

function requiredVolumeSqliteRegistry(options: HttpAppOptions): VolumeSqliteRegistryApi {
  if (!options.volumeSqliteRegistry) {
    throw new ControlPlaneError("validation", "volume sqlite registry is not configured");
  }
  return options.volumeSqliteRegistry;
}

export async function publishCurrentRouteSnapshot(options: HttpAppOptions) {
  const snapshot = await options.controlPlane.createRouteSnapshot();
  const runtimeNodes = await publishTargets(options, snapshot);
  if (runtimeNodes.length === 0) {
    throw new ControlPlaneError("validation", "no runtime nodes are configured");
  }
  const report = await publishAndRecordRouteSnapshot(options, snapshot, runtimeNodes);
  if (!options.routeSnapshotReplicas || options.routeSnapshotReplicas.length === 0) {
    return report;
  }
  const replication = await replicateRouteSnapshot(
    snapshot,
    options.routeSnapshotReplicas,
    options.fetch ?? fetch,
    options.snapshotReplication,
  );
  return {
    ...report,
    ok: report.ok && replication.ok,
    replication,
  };
}

type AuthorizationResult =
  | { ok: true; token?: ApiToken }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string };

async function authorizeRequest(
  options: HttpAppOptions,
  headers: Record<string, string | string[] | undefined>,
  requiredScope: ApiScope,
): Promise<AuthorizationResult> {
  const tokens = configuredApiTokens(options);
  if (tokens.length === 0) {
    return { ok: true };
  }
  const authorization = firstHeader(headers.authorization);
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = bearer
    ? tokens.find((candidate) => candidate.token === bearer) ?? await authenticateDbApiToken(options, bearer)
    : undefined;
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid bearer token",
    };
  }
  if (!tokenAllows(token, requiredScope)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: `bearer token is missing ${requiredScope} scope`,
    };
  }
  return { ok: true, token };
}

async function authenticateDbApiToken(options: HttpAppOptions, token: string): Promise<ApiToken | undefined> {
  return await options.controlPlane.authenticateApiToken?.({ token });
}

function configuredApiTokens(options: HttpAppOptions): ApiToken[] {
  return [
    ...(options.apiToken ? [{ token: options.apiToken, scopes: ["*" as const], principal: "legacy" }] : []),
    ...(options.apiTokens ?? []),
  ];
}

function requiredScopeFor(method: string, pathname: string): ApiScope {
  if (
    (method === "POST" && pathname === "/snapshots/routes/publish") ||
    (method === "PUT" && pathname === "/replication/snapshots/routes")
  ) {
    return "publish";
  }
  if (method === "GET") {
    return "read";
  }
  return "write";
}

function installAuditHook(
  options: HttpAppOptions,
  request: { method?: string },
  response: any,
  token: ApiToken | undefined,
  scope: ApiScope,
  pathname: string,
) {
  if (!options.auditSink || !token || request.method === "GET") {
    return;
  }
  response.once("finish", () => {
    void options.auditSink?.record({
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      principal: token.principal,
      scope,
      method: request.method ?? "GET",
      path: pathname,
      status: response.statusCode,
    });
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function publishTargets(options: HttpAppOptions, snapshot: RouteSnapshot): Promise<RuntimeNodeTarget[]> {
  const activeNodes = await options.controlPlane.listActiveRuntimeNodes();
  const requiresTenantDrain = snapshotRequiresTenantDrainPublish(snapshot, options.runtimePlacement);
  const placedNodes = options.runtimePlacement
    ? planRuntimeSnapshotPlacements(activeNodes, snapshot, options.runtimePlacement).map((plan) => ({
      ...plan.node,
      snapshot: plan.snapshot,
    }))
    : activeNodes;
  const staticSnapshot = requiresTenantDrain
    ? defaultRouteSnapshotForTenantDrain(snapshot, options.runtimePlacement)
    : undefined;
  const targets = [
    ...(options.runtimeNodes ?? []).map((target) => staticSnapshot ? { ...target, snapshot: staticSnapshot } : target),
    ...placedNodes,
  ];
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.url)) {
      return false;
    }
    seen.add(target.url);
    return true;
  }).map((target) => ({
    ...target,
    token: target.token ?? options.runtimeNodeToken,
    identity: runtimeTargetIdentity(target, options.runtimeIdentityKeys, activeNodes),
  }));
}

function runtimeTargetIdentity(
  target: RuntimeNodeTarget,
  keys: Record<string, string> | undefined,
  nodes: RuntimeNode[],
): RuntimeNodeTarget["identity"] {
  if (target.identity?.secret) {
    return target.identity;
  }
  if (!target.id || !keys) {
    return undefined;
  }
  const keyId = nodes.find((node) => node.id === target.id)?.identity?.keyId;
  const secret = keyId ? keys[keyId] : undefined;
  return keyId && secret ? { keyId, secret } : undefined;
}

async function readRuntimeNodeLogs(
  options: HttpAppOptions,
  runtimeNodeId: string,
  searchParams: URLSearchParams,
) {
  const target = await runtimeNodeTargetById(options, runtimeNodeId);
  const response = await (options.fetch ?? fetch)(runtimeLogsEndpoint(target.url, searchParams), {
    method: "GET",
    headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
  } as any);
  if (!response.ok) {
    throw new ControlPlaneError(
      "validation",
      `runtime node ${runtimeNodeId} logs fetch failed with ${response.status}: ${await response.text()}`,
    );
  }
  const payload = objectRecord(await response.json());
  return {
    runtimeNodeId,
    url: target.url,
    logs: Array.isArray(payload.logs) ? payload.logs : [],
  };
}

async function runtimeNodeTargetById(
  options: HttpAppOptions,
  runtimeNodeId: string,
): Promise<RuntimeNodeTarget> {
  const staticTarget = options.runtimeNodes?.find((target) => target.id === runtimeNodeId);
  if (staticTarget) {
    return {
      ...staticTarget,
      token: staticTarget.token ?? options.runtimeNodeToken,
    };
  }
  const registered = (await options.controlPlane.listRuntimeNodes()).find((node) => node.id === runtimeNodeId);
  if (!registered) {
    throw new ControlPlaneError("not_found", `runtime node ${runtimeNodeId} was not found`);
  }
  return {
    id: registered.id,
    url: registered.url,
    token: options.runtimeNodeToken,
  };
}

async function publishAndRecordRouteSnapshot(
  options: HttpAppOptions,
  snapshot: RouteSnapshot,
  runtimeNodes: RuntimeNodeTarget[],
) {
  const report = await publishRouteSnapshot(snapshot, runtimeNodes, options.fetch ?? fetch, options.snapshotPublish);
  const publication = await options.controlPlane.recordRouteSnapshotPublication({
    snapshotId: snapshot.id,
    snapshotGeneratedAt: report.snapshot.generatedAt,
    routes: report.snapshot.routes,
    ok: report.ok,
    targets: report.targets,
  });
  return {
    ...report,
    publicationId: publication.id,
  };
}

async function applyReplicatedRouteSnapshot(options: HttpAppOptions, request: any) {
  if (!options.routeSnapshotReplicaStore) {
    throw new ControlPlaneError("validation", "route snapshot replica store is not configured");
  }
  const snapshot = await readJson(request);
  try {
    assertReplicatedRouteSnapshot(snapshot);
  } catch (error) {
    throw new ControlPlaneError("validation", error instanceof Error ? error.message : String(error));
  }
  return options.routeSnapshotReplicaStore.apply({
    snapshot,
    sourceRegion: firstHeader(request.headers["x-wasmplane-source-region"]),
    receivedAt: (options.now ?? (() => new Date().toISOString()))(),
  });
}

function readReplicatedRouteSnapshot(options: HttpAppOptions) {
  if (!options.routeSnapshotReplicaStore) {
    throw new ControlPlaneError("validation", "route snapshot replica store is not configured");
  }
  const state = options.routeSnapshotReplicaStore.current();
  if (!state) {
    throw new ControlPlaneError("not_found", "replicated route snapshot was not found");
  }
  return state;
}

function runtimeNodeHeartbeatMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/runtime-nodes\/([^/]+)\/heartbeat$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function runtimeNodeStatusMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "PATCH") {
    return undefined;
  }
  const match = /^\/runtime-nodes\/([^/]+)\/status$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function runtimeNodeLogsMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/runtime-nodes\/([^/]+)\/logs$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function runtimeLogsEndpoint(baseUrl: string, searchParams: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const key of ["projectId", "deploymentId"]) {
    const value = searchParams.get(key);
    if (value) {
      query.set(key, value);
    }
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return `${baseUrl.replace(/\/+$/, "")}/__runtime/logs${suffix}`;
}

async function renderAdminPage(options: HttpAppOptions, notice: string | null): Promise<string> {
  const [snapshot, runtimeNodes, publications, canaryDecisions] = await Promise.all([
    options.controlPlane.createRouteSnapshot(),
    options.controlPlane.listRuntimeNodes(),
    options.controlPlane.listRouteSnapshotPublications(),
    options.controlPlane.listCanaryDecisions(),
  ]);
  const projectRows = adminProjectRows(snapshot);
  const deploymentRows = adminDeploymentRows(snapshot);
  const canaryRoutes = snapshot.routes.filter((route) =>
    route.targets.length > 1 || route.targets.some((target) => target.weight !== 100)
  );
  const signals = runtimeSaturationSignals(runtimeNodes);
  const latestPublication = publications[0];
  const escapedNotice = notice ? htmlEscape(notice) : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wasmplane admin</title>
  <style>
    :root { color-scheme: light; --ink: #18202f; --muted: #64748b; --line: #d8dee8; --bg: #f7f9fc; --accent: #0f766e; --warn: #b45309; --bad: #b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { background: #ffffff; border-bottom: 1px solid var(--line); padding: 18px 28px 14px; position: sticky; top: 0; z-index: 1; }
    h1 { font-size: 22px; margin: 0 0 10px; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: 0; }
    nav { display: flex; gap: 14px; flex-wrap: wrap; }
    nav a { color: var(--accent); font-weight: 650; text-decoration: none; }
    main { max-width: 1280px; margin: 0 auto; padding: 22px 28px 48px; }
    section { margin: 0 0 28px; }
    .notice { border-left: 4px solid var(--accent); background: #ffffff; padding: 10px 12px; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid var(--line); }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #334155; background: #eef3f8; font-size: 12px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .muted { color: var(--muted); }
    .ok { color: var(--accent); font-weight: 650; }
    .warn { color: var(--warn); font-weight: 650; }
    .bad { color: var(--bad); font-weight: 650; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    form { background: #ffffff; border: 1px solid var(--line); padding: 14px; }
    label { display: grid; gap: 4px; margin-bottom: 10px; color: #334155; font-weight: 650; }
    input, select { width: 100%; min-height: 34px; border: 1px solid #b8c2d1; padding: 6px 8px; font: inherit; background: #ffffff; }
    input[type="checkbox"] { width: auto; min-height: 0; margin: 0 6px 0 0; }
    label.inline { display: flex; align-items: center; gap: 4px; }
    button { min-height: 36px; border: 0; background: var(--accent); color: #ffffff; padding: 7px 12px; font: inherit; font-weight: 700; cursor: pointer; }
    button.secondary { background: #334155; }
    .empty { color: var(--muted); text-align: center; }
    @media (max-width: 760px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>wasmplane admin</h1>
    <nav>
      <a href="#projects">Projects</a>
      <a href="#routes">Routes</a>
      <a href="#deployments">Deployments</a>
      <a href="#canaries">Canaries</a>
      <a href="#runtime-nodes">Runtime nodes</a>
      <a href="#metrics">Metrics</a>
    </nav>
  </header>
  <main>
    ${escapedNotice ? `<div class="notice">${escapedNotice}</div>` : ""}
    <section id="overview">
      <h2>Overview</h2>
      <table>
        <tbody>
          <tr><th>Projects</th><td>${projectRows.length}</td><th>Routes</th><td>${snapshot.routes.length}</td></tr>
          <tr><th>Deployments</th><td>${deploymentRows.length}</td><th>Runtime nodes</th><td>${runtimeNodes.length}</td></tr>
          <tr><th>Snapshot</th><td><code>${htmlEscape(snapshot.id ?? "pending")}</code></td><th>Generated</th><td>${htmlEscape(snapshot.generatedAt)}</td></tr>
          <tr><th>Last publish</th><td colspan="3">${latestPublication ? htmlEscape(`${latestPublication.id} ${latestPublication.ok ? "ok" : "failed"}`) : '<span class="muted">none</span>'}</td></tr>
        </tbody>
      </table>
    </section>

    <section id="projects">
      <h2>Projects</h2>
      <table>
        <thead><tr><th>Project</th><th>Routes</th><th>Deployments</th><th>Canaries</th><th>Quota</th></tr></thead>
        <tbody>${projectRows.length ? projectRows.map((row) => `
          <tr>
            <td><code>${htmlEscape(row.projectId)}</code></td>
            <td>${row.routes}</td>
            <td>${row.deployments}</td>
            <td>${row.canaries}</td>
            <td><a href="/projects/${encodeURIComponent(row.projectId)}/quota-usage">quota usage</a></td>
          </tr>`).join("") : emptyRow(5, "No projects in the active snapshot")}</tbody>
      </table>
    </section>

    <section id="routes">
      <h2>Routes</h2>
      <table>
        <thead><tr><th>Host</th><th>Path</th><th>Project</th><th>Primary deployment</th><th>Targets</th></tr></thead>
        <tbody>${snapshot.routes.length ? snapshot.routes.map((route) => `
          <tr>
            <td>${htmlEscape(route.host)}</td>
            <td><code>${htmlEscape(route.pathPrefix)}</code></td>
            <td><code>${htmlEscape(route.projectId)}</code></td>
            <td><code>${htmlEscape(route.deploymentId)}</code></td>
            <td>${route.targets.map((target) => `<code>${htmlEscape(target.deploymentId)}</code> ${target.weight}%`).join("<br>")}</td>
          </tr>`).join("") : emptyRow(5, "No routes")}</tbody>
      </table>
    </section>

    <section id="deployments">
      <h2>Deployments</h2>
      <table>
        <thead><tr><th>Deployment</th><th>Project</th><th>Route</th><th>Runtime</th><th>Limits</th><th>Artifact</th></tr></thead>
        <tbody>${deploymentRows.length ? deploymentRows.map((row) => `
          <tr>
            <td><code>${htmlEscape(row.deploymentId)}</code></td>
            <td><code>${htmlEscape(row.projectId)}</code></td>
            <td>${htmlEscape(row.route)}</td>
            <td>${htmlEscape(row.runtime)}</td>
            <td><code>${htmlEscape(row.limits)}</code></td>
            <td><code>${htmlEscape(row.artifactDigest)}</code></td>
          </tr>`).join("") : emptyRow(6, "No deployments")}</tbody>
      </table>
    </section>

    <section id="canaries">
      <h2>Canaries</h2>
      <table>
        <thead><tr><th>Route</th><th>Stable</th><th>Candidate targets</th></tr></thead>
        <tbody>${canaryRoutes.length ? canaryRoutes.map((route) => `
          <tr>
            <td>${htmlEscape(route.host)} <code>${htmlEscape(route.pathPrefix)}</code></td>
            <td><code>${htmlEscape(route.deploymentId)}</code></td>
            <td>${route.targets.map((target) => `<code>${htmlEscape(target.deploymentId)}</code> ${target.weight}%`).join("<br>")}</td>
          </tr>`).join("") : emptyRow(3, "No active canaries")}</tbody>
      </table>
      <div class="actions">
        <form method="post" action="/admin/routes/canary">
          <h2>Start canary</h2>
          ${adminRouteInputs()}
          <label>Candidate deployment <input name="deploymentId" autocomplete="off"></label>
          <label>Weight <input name="weight" type="number" min="1" max="99" value="10"></label>
          <button type="submit">Start</button>
        </form>
        <form method="post" action="/admin/routes/rollback">
          <h2>Rollback route</h2>
          ${adminRouteInputs()}
          <label>Stable deployment <input name="deploymentId" autocomplete="off"></label>
          <button class="secondary" type="submit">Rollback</button>
        </form>
      </div>
      <table>
        <thead><tr><th>Decision</th><th>Route</th><th>Candidate</th><th>Reason</th><th>Metrics</th></tr></thead>
        <tbody>${canaryDecisions.length ? canaryDecisions.map((decision: any) => `
          <tr>
            <td class="${decision.action === "rollback" ? "bad" : "ok"}">${htmlEscape(String(decision.action))}</td>
            <td>${htmlEscape(String(decision.host))} <code>${htmlEscape(String(decision.pathPrefix))}</code></td>
            <td><code>${htmlEscape(String(decision.candidateDeploymentId))}</code></td>
            <td>${htmlEscape(String(decision.reason))}</td>
            <td><code>${htmlEscape(adminDecisionMetrics(decision))}</code></td>
          </tr>`).join("") : emptyRow(5, "No canary decisions")}</tbody>
      </table>
    </section>

    <section id="runtime-nodes">
      <h2>Runtime nodes</h2>
      <table>
        <thead><tr><th>Node</th><th>Status</th><th>Region</th><th>URL</th><th>Runtime</th><th>Capacity</th><th>Load</th><th>Logs</th></tr></thead>
        <tbody>${runtimeNodes.length ? runtimeNodes.map((node) => `
          <tr>
            <td><code>${htmlEscape(node.id)}</code></td>
            <td class="${node.status === "active" ? "ok" : "warn"}">${htmlEscape(node.status)}</td>
            <td>${htmlEscape(node.region ?? "")}</td>
            <td><code>${htmlEscape(node.url)}</code></td>
            <td>${runtimeNodeHostCell(node)}</td>
            <td>${node.capacity ? `${node.capacity.concurrentRequests} req / ${node.capacity.memoryMb} MB` : '<span class="muted">unknown</span>'}</td>
            <td>${node.load ? `${node.load.activeRequests} active` : '<span class="muted">unknown</span>'}</td>
            <td><a href="/runtime-nodes/${encodeURIComponent(node.id)}/logs">logs</a></td>
          </tr>`).join("") : emptyRow(8, "No runtime nodes")}</tbody>
      </table>
      <div class="actions">
        <form method="post" action="/admin/runtime-nodes/status">
          <h2>Set node status</h2>
          <label>Runtime node <input name="runtimeNodeId" autocomplete="off"></label>
          <label>Status
            <select name="status">
              <option value="draining">draining</option>
              <option value="active">active</option>
              <option value="offline">offline</option>
            </select>
          </label>
          <button class="secondary" type="submit">Update</button>
        </form>
        <form method="post" action="/admin/runtime-nodes/gc">
          <h2>Clean stale nodes</h2>
          <label>Older than ms <input name="olderThanMs" type="number" min="1" value="86400000"></label>
          <label class="inline"><input name="statuses" type="checkbox" value="offline" checked> offline</label>
          <label class="inline"><input name="statuses" type="checkbox" value="draining"> draining</label>
          <label class="inline"><input name="statuses" type="checkbox" value="active"> active</label>
          <button class="secondary" type="submit">Clean</button>
        </form>
      </div>
    </section>

    <section id="metrics">
      <h2>Autoscaling signals</h2>
      <table>
        <thead><tr><th>Node</th><th>Load ratio</th><th>Active</th><th>Capacity</th><th>Saturated</th></tr></thead>
        <tbody>${signals.length ? signals.map((signal) => `
          <tr>
            <td><code>${htmlEscape(signal.id)}</code></td>
            <td>${Math.round(signal.loadRatio * 100)}%</td>
            <td>${signal.activeRequests}</td>
            <td>${signal.concurrentRequests}</td>
            <td class="${signal.saturated ? "bad" : "ok"}">${signal.saturated ? "yes" : "no"}</td>
          </tr>`).join("") : emptyRow(5, "No autoscaling signals")}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function adminProjectRows(snapshot: RouteSnapshot): Array<{
  projectId: string;
  routes: number;
  deployments: number;
  canaries: number;
}> {
  const rows = new Map<string, { routes: number; deployments: Set<string>; canaries: number }>();
  for (const route of snapshot.routes) {
    const row = rows.get(route.projectId) ?? { routes: 0, deployments: new Set<string>(), canaries: 0 };
    row.routes += 1;
    if (route.targets.length > 1 || route.targets.some((target) => target.weight !== 100)) {
      row.canaries += 1;
    }
    for (const target of route.targets) {
      row.deployments.add(target.deploymentId);
    }
    rows.set(route.projectId, row);
  }
  return [...rows.entries()].map(([projectId, row]) => ({
    projectId,
    routes: row.routes,
    deployments: row.deployments.size,
    canaries: row.canaries,
  }));
}

function adminDeploymentRows(snapshot: RouteSnapshot): Array<{
  projectId: string;
  deploymentId: string;
  route: string;
  runtime: string;
  limits: string;
  artifactDigest: string;
}> {
  return snapshot.routes.flatMap((route) =>
    route.targets.map((target) => ({
      projectId: route.projectId,
      deploymentId: target.deploymentId,
      route: `${route.host}${route.pathPrefix}`,
      runtime: `${target.runtime.backend}/${target.runtime.version}/${target.runtime.wasi}`,
      limits: `cpu=${target.limits.cpuMs}ms wall=${target.limits.wallMs}ms mem=${target.limits.memoryMb}MB`,
      artifactDigest: target.artifact.digest,
    }))
  );
}

function adminRouteInputs(): string {
  return `<label>Project <input name="projectId" autocomplete="off"></label>
          <label>Host <input name="host" autocomplete="off"></label>
          <label>Path prefix <input name="pathPrefix" value="/"></label>`;
}

function adminDecisionMetrics(decision: any): string {
  const metrics = decision.metrics ?? {};
  return `requests=${metrics.requests ?? 0} errors=${metrics.errors ?? 0} p95=${metrics.p95Ms ?? 0}ms`;
}

function runtimeNodeHostCell(node: RuntimeNode): string {
  if (!node.host) {
    return '<span class="muted">unknown</span>';
  }
  const label = [
    node.host.backend,
    node.host.hostVersion,
    node.host.wasi,
    node.host.engineVariant,
  ].filter((value): value is string => Boolean(value));
  return `<code>${htmlEscape(label.join("/"))}</code>`;
}

function emptyRow(columns: number, label: string): string {
  return `<tr><td class="empty" colspan="${columns}">${htmlEscape(label)}</td></tr>`;
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localArtifactMatch(method: string, pathname: string): { digestHex: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/artifacts\/local\/([a-fA-F0-9]{64})\.wasm$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { digestHex: match[1].toLowerCase() };
}

function projectSecretsMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/secrets$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectQuotaUsageMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/quota-usage$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectUsageMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/usage$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectEnforcementReportMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/enforcement-report$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectUsageQuotaReportMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/usage-quota$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectBillingStatementMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/billing-statement$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectBillingBudgetMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/billing-budget$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function organizationBillingStatementMatch(method: string, pathname: string): { organizationId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/organizations\/([^/]+)\/billing-statement$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { organizationId: decodeURIComponent(match[1]) };
}

function organizationBillingInvoicesMatch(method: string, pathname: string): { organizationId: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/organizations\/([^/]+)\/billing-invoices$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { organizationId: decodeURIComponent(match[1]) };
}

function listOrganizationBillingInvoicesMatch(
  method: string,
  pathname: string,
): { organizationId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/organizations\/([^/]+)\/billing-invoices$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { organizationId: decodeURIComponent(match[1]) };
}

function billingInvoiceMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/billing-invoices\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function projectCustomDomainsMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/custom-domains$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectDeployPreviewsMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/deploy-previews$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function deployPreviewRollbackMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/deploy-previews\/([^/]+)\/rollback$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function customDomainVerifyMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/custom-domains\/([^/]+)\/verify$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function customDomainTlsMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/custom-domains\/([^/]+)\/tls$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function customDomainTlsCompleteMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/custom-domains\/([^/]+)\/tls\/complete$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function projectMembershipsMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET" && method !== "POST") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/memberships$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectApiKeysMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/api-keys$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function projectSqliteDatabasesMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET" && method !== "POST") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/sqlite-databases$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function sqliteDatabaseMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/sqlite-databases\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function sqliteDatabaseBackupsMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET" && method !== "POST") {
    return undefined;
  }
  const match = /^\/sqlite-databases\/([^/]+)\/backups$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function sqliteDatabaseBackupsGcMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/sqlite-databases\/([^/]+)\/backups\/gc$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function sqliteDatabaseRestoresMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/sqlite-databases\/([^/]+)\/restores$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function secretMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/secrets\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function projectKvNamespacesMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/kv-namespaces$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function kvNamespaceMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/kv-namespaces\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

async function readJson(request: any): Promise<unknown> {
  const body = await readText(request);
  if (body.trim().length === 0) {
    return {};
  }
  return JSON.parse(body);
}

async function readForm(request: any): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(request));
}

async function readText(request: any): Promise<string> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("validation", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name)?.trim();
  if (!value) {
    throw new ControlPlaneError("validation", `${name} is required`);
  }
  return value;
}

function optionalFormValue(form: URLSearchParams, name: string): string | undefined {
  const value = form.get(name)?.trim();
  return value ? value : undefined;
}

function formListValue(form: URLSearchParams, name: string): string[] | undefined {
  const values = form.getAll(name).map((value) => value.trim()).filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function writeJson(response: any, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function writeHtml(response: any, status: number, html: string) {
  response.writeHead(status, {
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function writeRedirect(response: any, location: string) {
  response.writeHead(303, { location });
  response.end();
}

async function writeLocalArtifact(
  response: any,
  store: ControlPlaneArtifactStore & { readArtifact(digestHex: string): Promise<Buffer> },
  digestHex: string,
) {
  try {
    const bytes = await store.readArtifact(digestHex);
    response.writeHead(200, {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/wasm",
    });
    response.end(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      writeJson(response, 404, { error: { code: "not_found", message: "artifact not found" } });
      return;
    }
    throw error;
  }
}

async function putValidatedArtifact(input: {
  store: ControlPlaneArtifactStore;
  validator?: LocalArtifactValidator;
  decoded: ReturnType<typeof decodeLocalArtifactBytes>;
  publicBaseUrl?: string;
}) {
  if (input.store.kind === "file") {
    const stored = await input.store.putArtifact({
      ...input.decoded,
      publicBaseUrl: input.publicBaseUrl,
    });
    if (input.validator && stored.path) {
      try {
        await input.validator.validate({
          path: stored.path,
          digest: stored.digest,
          location: stored.location,
        });
      } catch (error) {
        await unlink(stored.path).catch(() => undefined);
        throw artifactValidationError(error);
      }
    }
    return stored;
  }

  if (input.validator) {
    const staged = await stageArtifactForValidation(input.decoded);
    try {
      await input.validator.validate({
        path: staged.path,
        digest: input.decoded.digest,
        location: staged.fileUrl,
      });
    } catch (error) {
      throw artifactValidationError(error);
    } finally {
      await rm(staged.dir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
  return input.store.putArtifact(input.decoded);
}

async function stageArtifactForValidation(decoded: ReturnType<typeof decodeLocalArtifactBytes>) {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-artifact-validation-"));
  const path = join(dir, `${decoded.digestHex}.wasm`);
  await writeFile(path, decoded.bytes);
  return { dir, path, fileUrl: `file://${path}` };
}

function artifactValidationError(error: unknown): ControlPlaneError {
  if (isControlPlaneError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ControlPlaneError("validation", message);
}

function artifactStoreForRequest(options: HttpAppOptions): ControlPlaneArtifactStore | undefined {
  if (options.artifactStore) {
    return options.artifactStore;
  }
  if (!options.artifactStoreDir) {
    return undefined;
  }
  return createFileControlPlaneArtifactStore({ storeDir: options.artifactStoreDir });
}

function readableArtifactStore(
  options: HttpAppOptions,
): (ControlPlaneArtifactStore & { readArtifact(digestHex: string): Promise<Buffer> }) | undefined {
  const store = artifactStoreForRequest(options);
  return store?.readArtifact ? store as any : undefined;
}

function localArtifactPublicBaseUrl(
  options: HttpAppOptions,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  if (!options.artifactPublicBaseUrl) {
    return undefined;
  }
  if (options.artifactPublicBaseUrl !== "auto") {
    return options.artifactPublicBaseUrl;
  }
  const host = firstHeader(headers["x-forwarded-host"]) ?? firstHeader(headers.host);
  if (!host) {
    return undefined;
  }
  const proto = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}`;
}
