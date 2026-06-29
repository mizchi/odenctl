import { readFile } from "node:fs/promises";
import pg from "pg";
import type { AsyncControlPlaneRepository } from "./async-service.ts";
import type {
  Artifact,
  Deployment,
  KvNamespace,
  Project,
  RoutePointer,
  RouteSnapshotPublication,
  RuntimeNode,
  Secret,
} from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

const { Pool } = pg;
const initMigrationId = "202606300001_postgres_init";
const initMigrationUrl = new URL("../../db/postgres/001_init.sql", import.meta.url);

export interface PostgresRepositoryOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
}

export async function createPostgresRepository(
  options: PostgresRepositoryOptions,
): Promise<PostgresControlPlaneRepository> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
  });
  const repository = new PostgresControlPlaneRepository(pool);
  await repository.migrate();
  return repository;
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

  async createProject(project: Project): Promise<Project> {
    try {
      await this.pool.query("insert into projects (id, name, created_at) values ($1, $2, $3)", [
        project.id,
        project.name,
        project.createdAt,
      ]);
      return project;
    } catch (error) {
      throw writeError("project", project.id, error);
    }
  }

  async getProject(id: string): Promise<Project | undefined> {
    const result = await this.pool.query("select * from projects where id = $1", [id]);
    return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    try {
      await this.pool.query(
        `insert into artifacts (id, project_id, digest, location, size_bytes, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          artifact.id,
          artifact.projectId,
          artifact.digest,
          artifact.location,
          artifact.sizeBytes,
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

  async createDeployment(deployment: Deployment): Promise<Deployment> {
    try {
      await this.pool.query(
        `insert into deployments (
          id,
          project_id,
          artifact_id,
          world,
          runtime_backend,
          runtime_version,
          wasi_version,
          limits_json,
          capabilities_json,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
        [
          deployment.id,
          deployment.projectId,
          deployment.artifactId,
          deployment.world,
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
          capacity_json
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          node.id,
          node.url,
          node.status,
          node.registeredAt,
          node.lastSeenAt ?? null,
          node.version ?? null,
          node.capacity ? JSON.stringify(node.capacity) : null,
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
        capacity_json = $4::jsonb
      where id = $5
      returning *`,
      [
        node.status,
        node.lastSeenAt ?? null,
        node.version ?? null,
        node.capacity ? JSON.stringify(node.capacity) : null,
        node.id,
      ],
    );
    if (result.rowCount === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${node.id} was not found`);
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
}

function projectFromRow(row: any): Project {
  return {
    id: row.id,
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
