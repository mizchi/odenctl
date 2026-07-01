import { DatabaseSync } from "node:sqlite";
import type {
  ApiKey,
  Artifact,
  CanaryDecision,
  CustomDomain,
  DeployPreview,
  Deployment,
  KvNamespace,
  Organization,
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

export interface ControlPlaneRepository {
  createOrganization(organization: Organization): Organization;
  getOrganization(id: string): Organization | undefined;
  createUser(user: User): User;
  getUser(id: string): User | undefined;
  createProjectMembership(membership: ProjectMembership): ProjectMembership;
  listProjectMemberships(projectId: string): ProjectMembership[];
  createApiKey(apiKey: ApiKey, tokenHash: string): ApiKey;
  getApiKeyByTokenHash(tokenHash: string): ApiKey | undefined;
  listProjectApiKeys(projectId: string): ApiKey[];
  updateApiKeyLastUsed(id: string, lastUsedAt: string): ApiKey;
  createUsageEvent(event: UsageEvent): UsageEvent;
  getUsageEvent(id: string): UsageEvent | undefined;
  getProjectUsageSummary(projectId: string, from?: string, to?: string): ProjectUsageSummary;
  createCustomDomain(domain: CustomDomain): CustomDomain;
  getCustomDomain(id: string): CustomDomain | undefined;
  getCustomDomainByHost(host: string): CustomDomain | undefined;
  listProjectCustomDomains(projectId: string): CustomDomain[];
  updateCustomDomain(domain: CustomDomain): CustomDomain;
  createDeployPreview(preview: DeployPreview): DeployPreview;
  getDeployPreview(id: string): DeployPreview | undefined;
  listProjectDeployPreviews(projectId: string): DeployPreview[];
  updateDeployPreview(preview: DeployPreview): DeployPreview;
  createProject(project: Project): Project;
  getProject(id: string): Project | undefined;
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
        .prepare("insert into organizations (id, name, created_at) values (?, ?, ?)")
        .run(organization.id, organization.name, organization.createdAt);
      return organization;
    } catch (error) {
      throw writeError("organization", organization.id, error);
    }
  }

  getOrganization(id: string): Organization | undefined {
    const row = this.db.prepare("select * from organizations where id = ?").get(id);
    return row ? organizationFromRow(row) : undefined;
  }

  createUser(user: User): User {
    try {
      this.db
        .prepare("insert into users (id, email, name, created_at) values (?, ?, ?, ?)")
        .run(user.id, user.email, user.name ?? null, user.createdAt);
      return user;
    } catch (error) {
      throw writeError("user", user.id, error);
    }
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare("select * from users where id = ?").get(id);
    return row ? userFromRow(row) : undefined;
  }

  createProjectMembership(membership: ProjectMembership): ProjectMembership {
    try {
      this.db
        .prepare(
          `insert into project_memberships (
            project_id,
            user_id,
            role,
            created_at
          ) values (?, ?, ?, ?)
          on conflict(project_id, user_id) do update set role = excluded.role`,
        )
        .run(membership.projectId, membership.userId, membership.role, membership.createdAt);
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

  getProjectUsage(projectId: string): ProjectResourceUsage {
    const row = this.db
      .prepare(
        `select
          (select count(*) from artifacts where project_id = ?) as artifacts,
          (select count(*) from deployments where project_id = ?) as deployments,
          (select count(*) from routes where project_id = ?) as routes,
          (select count(*) from secrets where project_id = ?) as secrets,
          (select count(*) from kv_namespaces where project_id = ?) as kv_namespaces`,
      )
      .get(projectId, projectId, projectId, projectId, projectId) as any;
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
  created_at text not null
);

create table if not exists users (
  id text primary key,
  email text not null unique,
  name text,
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
          created_at text not null
        );

        create table if not exists project_memberships (
          project_id text not null,
          user_id text not null,
          role text not null,
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
];

export const SQLITE_SCHEMA_MIGRATION_IDS = migrations.map((migration) => migration.id);

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all();
  if (rows.some((row: any) => row.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
