import { DatabaseSync } from "node:sqlite";
import type { Artifact, Deployment, Project, RoutePointer } from "./contracts.ts";
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
    this.db.exec(migrations);
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
            updated_at
          ) values (?, ?, ?, ?, ?, ?)
          on conflict(project_id, host, path_prefix) do update set
            deployment_id = excluded.deployment_id,
            updated_at = excluded.updated_at`,
        )
        .run(route.id, route.projectId, route.host, route.pathPrefix, route.deploymentId, route.updatedAt);
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
  updated_at text not null,
  unique (project_id, host, path_prefix),
  foreign key (project_id) references projects(id),
  foreign key (deployment_id) references deployments(id)
);
`;

const migrations = `
update deployments set wasi_version = 'wasip3' where wasi_version = '0.3';
`;
