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
  organization_id text references organizations(id),
  name text not null unique,
  created_at text not null
);

create table if not exists project_memberships (
  project_id text not null references projects(id),
  user_id text not null references users(id),
  role text not null check (role in ('owner', 'developer', 'viewer')),
  created_at text not null,
  primary key (project_id, user_id)
);

create table if not exists api_keys (
  id text primary key,
  organization_id text references organizations(id),
  project_id text references projects(id),
  name text not null,
  token_hash text not null unique,
  scopes_json jsonb not null,
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create table if not exists usage_events (
  id text primary key,
  organization_id text references organizations(id),
  project_id text not null references projects(id),
  metric text not null check (metric in (
    'invocation',
    'cpu_ms',
    'wall_ms',
    'memory_mb_ms',
    'egress_bytes',
    'storage_bytes',
    'sqlite_unit'
  )),
  quantity double precision not null check (quantity > 0),
  dimensions_json jsonb,
  recorded_at text not null
);

create table if not exists custom_domains (
  id text primary key,
  project_id text not null references projects(id),
  host text not null unique,
  status text not null check (status in (
    'pending_verification',
    'verified',
    'tls_pending',
    'active',
    'tls_failed'
  )),
  verification_token text not null,
  verification_record_name text not null,
  verification_record_value text not null,
  tls_status text not null check (tls_status in ('none', 'pending', 'provisioned', 'failed')),
  tls_provider text,
  tls_request_id text,
  tls_error text,
  created_at text not null,
  updated_at text not null,
  verified_at text,
  tls_provisioned_at text
);

create table if not exists artifacts (
  id text primary key,
  project_id text not null references projects(id),
  digest text not null unique,
  location text not null,
  size_bytes bigint not null check (size_bytes > 0),
  signature_json jsonb,
  provenance_json jsonb,
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
  world_version text not null default '0.1.0',
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

create table if not exists deploy_previews (
  id text primary key,
  project_id text not null references projects(id),
  deployment_id text not null references deployments(id),
  host text not null,
  path_prefix text not null,
  url text not null,
  environment_json jsonb not null,
  previous_route_json jsonb,
  status text not null check (status in ('active', 'rolled_back')),
  created_at text not null,
  updated_at text not null,
  rolled_back_at text
);

create table if not exists runtime_nodes (
  id text primary key,
  url text not null unique,
  status text not null default 'active' check (status in ('active', 'draining', 'offline')),
  last_seen_at text,
  version text,
  capacity_json jsonb,
  region text,
  labels_json jsonb,
  load_json jsonb,
  identity_json jsonb,
  host_json jsonb,
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

create table if not exists canary_decisions (
  id text primary key,
  project_id text not null references projects(id),
  host text not null,
  path_prefix text not null,
  stable_deployment_id text not null,
  candidate_deployment_id text not null,
  action text not null check (action in ('continue', 'rollback')),
  reason text not null,
  metrics_json jsonb not null,
  thresholds_json jsonb not null,
  created_at text not null
);

create table if not exists fly_autoscaler_coordination (
  coordination_key text primary key,
  lease_holder text,
  lease_expires_at_ms bigint,
  cooldown_action text,
  cooldown_at_ms bigint,
  cooldown_until_ms bigint,
  updated_at text not null
);

alter table if exists route_snapshot_publications
  add column if not exists snapshot_id text;

alter table if exists projects
  add column if not exists organization_id text references organizations(id);

alter table if exists deployments
  add column if not exists world_version text not null default '0.1.0';

alter table if exists artifacts
  add column if not exists signature_json jsonb,
  add column if not exists provenance_json jsonb;

alter table if exists runtime_nodes
  add column if not exists region text,
  add column if not exists labels_json jsonb,
  add column if not exists load_json jsonb,
  add column if not exists identity_json jsonb,
  add column if not exists host_json jsonb;

create index if not exists artifacts_project_digest_idx
  on artifacts (project_id, digest);

create index if not exists project_memberships_user_id_idx
  on project_memberships (user_id);

create index if not exists api_keys_project_created_idx
  on api_keys (project_id, created_at desc, id desc);

create index if not exists usage_events_project_time_idx
  on usage_events (project_id, recorded_at);

create index if not exists usage_events_org_time_idx
  on usage_events (organization_id, recorded_at);

create index if not exists custom_domains_project_idx
  on custom_domains (project_id, host);

create index if not exists deployments_project_id_idx
  on deployments (project_id);

create index if not exists routes_lookup_idx
  on routes (host, path_prefix);

create index if not exists deploy_previews_project_idx
  on deploy_previews (project_id, created_at desc, id desc);

create index if not exists fly_autoscaler_coordination_lease_idx
  on fly_autoscaler_coordination (lease_expires_at_ms);

create index if not exists runtime_nodes_status_last_seen_idx
  on runtime_nodes (status, last_seen_at);

create index if not exists route_snapshot_publications_created_at_idx
  on route_snapshot_publications (created_at desc, id desc);

create index if not exists canary_decisions_created_at_idx
  on canary_decisions (created_at desc, id desc);
