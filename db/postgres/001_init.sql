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
  project_id text not null references projects(id),
  digest text not null unique,
  location text not null,
  size_bytes bigint not null check (size_bytes > 0),
  created_at text not null
);

create table if not exists secrets (
  id text primary key,
  project_id text not null references projects(id),
  name text not null,
  value text not null,
  created_at text not null,
  updated_at text not null,
  unique (project_id, name)
);

create table if not exists kv_namespaces (
  id text primary key,
  project_id text not null references projects(id),
  name text not null,
  created_at text not null,
  updated_at text not null,
  unique (project_id, name)
);

create table if not exists deployments (
  id text primary key,
  project_id text not null references projects(id),
  artifact_id text not null references artifacts(id),
  world text not null,
  runtime_backend text not null,
  runtime_version text not null,
  wasi_version text not null,
  limits_json jsonb not null,
  capabilities_json jsonb not null,
  created_at text not null
);

create table if not exists routes (
  id text primary key,
  project_id text not null references projects(id),
  host text not null,
  path_prefix text not null,
  deployment_id text not null references deployments(id),
  targets_json jsonb,
  updated_at text not null,
  unique (project_id, host, path_prefix)
);

create table if not exists runtime_nodes (
  id text primary key,
  url text not null unique,
  status text not null default 'active' check (status in ('active', 'draining', 'offline')),
  last_seen_at text,
  version text,
  capacity_json jsonb,
  registered_at text not null
);

create table if not exists route_snapshot_publications (
  id text primary key,
  snapshot_id text,
  snapshot_generated_at text not null,
  routes integer not null check (routes >= 0),
  ok boolean not null,
  targets_json jsonb not null,
  created_at text not null
);

alter table if exists route_snapshot_publications
  add column if not exists snapshot_id text;

create index if not exists artifacts_project_digest_idx
  on artifacts (project_id, digest);

create index if not exists deployments_project_id_idx
  on deployments (project_id);

create index if not exists routes_lookup_idx
  on routes (host, path_prefix);

create index if not exists runtime_nodes_status_last_seen_idx
  on runtime_nodes (status, last_seen_at);

create index if not exists route_snapshot_publications_created_at_idx
  on route_snapshot_publications (created_at desc, id desc);
