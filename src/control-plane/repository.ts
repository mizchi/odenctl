import { DatabaseSync } from "node:sqlite";
import type {
  Artifact,
  Deployment,
  Project,
  RoutePointer,
  RouteSnapshotPublication,
  RuntimeNode,
} from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export interface ControlPlaneRepository {
  createProject(project: Project): Project;
  getProject(id: string): Project | undefined;
  createArtifact(artifact: Artifact): Artifact;
  getArtifact(id: string): Artifact | undefined;
  createDeployment(deployment: Deployment): Deployment;
  getDeployment(id: string): Deployment | undefined;
  upsertRoute(route: RoutePointer): RoutePointer;
  listRoutes(): RoutePointer[];
  createRuntimeNode(node: RuntimeNode): RuntimeNode;
  getRuntimeNode(id: string): RuntimeNode | undefined;
  updateRuntimeNodeHeartbeat(node: RuntimeNode): RuntimeNode;
  listRuntimeNodes(): RuntimeNode[];
  createRouteSnapshotPublication(publication: RouteSnapshotPublication): RouteSnapshotPublication;
  listRouteSnapshotPublications(): RouteSnapshotPublication[];
}

export function createMemoryRepository(): ControlPlaneRepository {
  return new SqliteControlPlaneRepository(new DatabaseSync(":memory:"));
}

export function createSqliteRepository(path: string): ControlPlaneRepository {
  return new SqliteControlPlaneRepository(new DatabaseSync(path));
}

class SqliteControlPlaneRepository implements ControlPlaneRepository {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(schema);
    this.runMigrations();
  }

  createProject(project: Project): Project {
    try {
      this.db
        .prepare("insert into projects (id, name, created_at) values (?, ?, ?)")
        .run(project.id, project.name, project.createdAt);
      return project;
    } catch (error) {
      throw writeError("project", project.id, error);
    }
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("select * from projects where id = ?").get(id);
    return row ? projectFromRow(row) : undefined;
  }

  createArtifact(artifact: Artifact): Artifact {
    try {
      this.db
        .prepare(
          "insert into artifacts (id, project_id, digest, location, size_bytes, created_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          artifact.id,
          artifact.projectId,
          artifact.digest,
          artifact.location,
          artifact.sizeBytes,
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

  createDeployment(deployment: Deployment): Deployment {
    try {
      this.db
        .prepare(
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
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
            capacity_json
          ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          node.id,
          node.url,
          node.status,
          node.registeredAt,
          node.lastSeenAt ?? null,
          node.version ?? null,
          node.capacity ? JSON.stringify(node.capacity) : null,
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
          capacity_json = ?
        where id = ?`,
      )
      .run(
        node.status,
        node.lastSeenAt ?? null,
        node.version ?? null,
        node.capacity ? JSON.stringify(node.capacity) : null,
        node.id,
      );
    if (result.changes === 0) {
      throw new ControlPlaneError("not_found", `runtime node ${node.id} was not found`);
    }
    return this.getRuntimeNode(node.id) as RuntimeNode;
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
            snapshot_generated_at,
            routes,
            ok,
            targets_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publication.id,
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
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
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
  return node;
}

function routeSnapshotPublicationFromRow(row: any): RouteSnapshotPublication {
  return {
    id: row.id,
    snapshotGeneratedAt: row.snapshot_generated_at,
    routes: row.routes,
    ok: row.ok === 1,
    targets: JSON.parse(row.targets_json),
    createdAt: row.created_at,
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

create table if not exists projects (
  id text primary key,
  name text not null unique,
  created_at text not null
);

create table if not exists artifacts (
  id text primary key,
  project_id text not null,
  digest text not null unique,
  location text not null,
  size_bytes integer not null,
  created_at text not null,
  foreign key (project_id) references projects(id)
);

create table if not exists deployments (
  id text primary key,
  project_id text not null,
  artifact_id text not null,
  world text not null,
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

create table if not exists runtime_nodes (
  id text primary key,
  url text not null unique,
  status text not null default 'active',
  last_seen_at text,
  version text,
  capacity_json text,
  registered_at text not null
);

create table if not exists route_snapshot_publications (
  id text primary key,
  snapshot_generated_at text not null,
  routes integer not null,
  ok integer not null,
  targets_json text not null,
  created_at text not null
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
          snapshot_generated_at text not null,
          routes integer not null,
          ok integer not null,
          targets_json text not null,
          created_at text not null
        )
      `);
    },
  },
];

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all();
  if (rows.some((row: any) => row.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
