# Control-plane reference

[User documentation](README.md) / [Deploy with odenctl](control-plane.md) / Reference

This reference covers configuration, management APIs, storage, deployment, and
operations for users running odenctl. Commands run from the repository root.
Standard WASI deployment nodes use fresh instances; standalone filesystem and
celld grants do not apply to them. Legacy resource records do not enable the
removed guest bindings.

- [Configuration and startup](#run)
- [Fly deployment and operations](#flyio-trial-deploy)
- [Cost estimator](#cost-estimate)
- [Deployment CLI](#cli-deploy)
- [Management API](#api)

## Run

Use the [deployment walkthrough](control-plane.md) to start the API and gateway in
separate terminals, create a project, and publish a route.

The control plane listens on `http://127.0.0.1:8787` by default and stores state in
`odenctl.sqlite`. Set `ODENCTL_DB`, `HOST`, or `PORT` to override this. For production, set
`DATABASE_URL` or `ODENCTL_DATABASE_URL` to use the async Postgres repository instead of SQLite.
`ODENCTL_POSTGRES_SSL=1` forces TLS, while `sslmode=require` in the URL also enables TLS.
Startup applies known migrations and logs the current/latest schema version. Run
`just db-migrate-check` in CI or before rollout, and `just db-migrate-apply` when applying schema
outside the app startup path. `just pg-migrate` is kept as a Postgres-compatible alias.
Before production changes, take a custom-format backup with
`just pg-backup backups/oden.dump`; rollback is restore-first:
stop writers, run `just pg-restore backups/oden.dump`, then redeploy the previous app image.
Set
`ODENCTL_RUNTIME_NODES` to a comma-separated list of static runtime node base URLs, or register
runtime nodes through `POST /runtime-nodes`, when using `POST /snapshots/routes/publish`.
Set `ODENCTL_API_TOKEN` to require `Authorization: Bearer <token>` on the control-plane
management API; this bootstrap token has all scopes. `GET /healthz` and downloads
under `/artifacts/local/` remain public so gateways can fetch uploaded components.
For scoped tokens, set
`ODENCTL_API_TOKENS` as semicolon-separated `token=scope,scope` entries, for example
`reader=read;publisher=publish,read;writer=write,read`. Supported scopes are `read`, `write`,
`publish`, and `*`. Once a bootstrap token is configured, project-scoped API keys stored in the
control-plane repository can also authenticate requests; API key values are returned only at creation
time, while the repository stores a SHA-256 token hash. Rotate active keys with
`POST /api-keys/:id/rotate`; the response returns the replacement token and atomically revokes the
previous key. Retire leaked keys with `POST /api-keys/:id/revoke`; revoked keys remain listed for
audit visibility but no longer authenticate. Set `ODENCTL_AUDIT_LOG=/data/audit.jsonl` to append
authenticated mutation audit events as JSONL.
Set `ODEN_RUNTIME_TOKEN` on the control plane to authenticate route snapshot publishes
with the gateway's bearer token.
Set `ODEN_RUNTIME_IDENTITY_KEYS` on the control plane and runtime nodes as a comma-separated
keyring such as `rt-key=secret,old-key=old-secret`. Runtime nodes advertise their active key with
`ODEN_RUNTIME_IDENTITY_KEY_ID=rt-key`, and can also advertise a pinned transport certificate
fingerprint through `ODEN_RUNTIME_IDENTITY_CERT_SHA256=<sha256>`. When a registered runtime
node has an identity key id and the control plane has the matching secret, snapshot publishes to
`PUT /__runtime/snapshots/routes` include an HMAC proof-of-possession signature in addition to the
optional bearer token.
Set `ODENCTL_QUOTA_MAX_ARTIFACTS`, `ODENCTL_QUOTA_MAX_DEPLOYMENTS`,
`ODENCTL_QUOTA_MAX_ROUTES`, `ODENCTL_QUOTA_MAX_SECRETS`, and
`ODENCTL_QUOTA_MAX_KV_NAMESPACES`, and `ODENCTL_QUOTA_MAX_DURABLE_OBJECT_NAMESPACES` to
enforce per-project resource quotas before writes are
accepted.
Set `ODENCTL_ENFORCEMENT_CPU_MS_LIMITS`,
`ODENCTL_ENFORCEMENT_MEMORY_MB_MS_LIMITS`, `ODENCTL_ENFORCEMENT_STORAGE_BYTES_LIMITS`,
`ODENCTL_ENFORCEMENT_CONCURRENCY_LIMITS`, and `ODENCTL_ENFORCEMENT_RATE_LIMITS` to expose
per-project enforcement reports from usage ledgers. Values are comma-separated `project=value`
pairs; rate limits use `project=rps` or `project=rps:burst`.
Set `ODENCTL_USAGE_QUOTA_INVOCATION_LIMITS`, `ODENCTL_USAGE_QUOTA_CPU_MS_LIMITS`,
`ODENCTL_USAGE_QUOTA_WALL_MS_LIMITS`, `ODENCTL_USAGE_QUOTA_MEMORY_MB_MS_LIMITS`,
`ODENCTL_USAGE_QUOTA_EGRESS_BYTES_LIMITS`, `ODENCTL_USAGE_QUOTA_STORAGE_BYTES_LIMITS`, and
`ODENCTL_USAGE_QUOTA_SQLITE_UNIT_LIMITS` to enforce calendar-month billing quotas from usage
ledgers before accepting new usage events. Values are comma-separated `project=value` pairs.
Usage event ids are idempotency keys: retrying the same event payload with the same id returns the
existing event without incrementing ledger totals, while reusing an id for different payloads is a
conflict.
Set `ODENCTL_BILLING_INVOCATION_PER_MILLION_USD`,
`ODENCTL_BILLING_CPU_MS_PER_MILLION_USD`, `ODENCTL_BILLING_WALL_MS_PER_MILLION_USD`,
`ODENCTL_BILLING_MEMORY_MB_MS_PER_MILLION_USD`, `ODENCTL_BILLING_EGRESS_GB_USD`,
`ODENCTL_BILLING_STORAGE_GB_MONTH_USD`, and `ODENCTL_BILLING_SQLITE_UNIT_USD` to expose
invoice-ready calendar-month usage statements from `GET /projects/:id/billing-statement` and
organization rollups from `GET /organizations/:id/billing-statement`.
`GET /projects/:id/settings` renders a customer-facing read surface that aggregates project API
keys, usage quota status, billing statement totals, custom domains, and recent audit history while
linking back to the underlying JSON endpoints. Customer-visible audit ledgers are available from
`GET /projects/:id/audit-events` and `GET /organizations/:id/audit-events`; they record API key,
member, custom domain, billing invoice, deployment, and route actions.
Set `ODENCTL_BILLING_MONTHLY_USD_LIMITS` to comma-separated `project=usd` entries to reject
usage events that would exceed a project's calendar-month spend budget. Current budget status is
available from `GET /projects/:id/billing-budget`.
Set `ODENCTL_BILLING_RATE_CARD_VERSION` before issuing invoices so saved billing invoice
snapshots record the exact rate card version used for that period. Issue immutable organization
invoices with `POST /organizations/:id/billing-invoices`; the same organization/month returns the
existing saved invoice even if rates later change. Each saved invoice includes a `contentDigest`
over the invoice payload for audit comparisons. List saved invoices for an organization with
`GET /organizations/:id/billing-invoices`. Set `ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_ID` and
`ODENCTL_BILLING_EXPORT_SIGNATURE_KEY_BASE64` or `ODENCTL_BILLING_EXPORT_SIGNATURE_KEY` to
enable signed accounting export bundles from `GET /billing-invoices/:id/export`.
Set `ODENCTL_BILLING_WEBHOOK_URL` to enqueue a durable `billing.invoice.issued` webhook outbox
record whenever an invoice is issued. Webhook POSTs include an `Idempotency-Key` header derived
from the invoice id and content digest. Set `ODENCTL_BILLING_WEBHOOK_DELIVERY_INTERVAL_MS` to
run the delivery loop in-process; tune retry behavior with `ODENCTL_BILLING_WEBHOOK_MAX_ATTEMPTS`
and `ODENCTL_BILLING_WEBHOOK_RETRY_DELAY_MS`.
Credit notes and debit adjustments are stored as separate immutable records linked to an issued
invoice; they do not mutate the saved invoice payload, rate card, or `contentDigest`.
Retention and legal hold controls are stored as separate invoice policy records. Use
`PUT /billing-invoices/:id/retention-policy` to set `retainUntil` and optional legal hold metadata,
`GET /billing-invoices/:id/retention-policy` to audit it, and
`POST /billing-invoices/retention/prune` to delete only expired, non-held invoices for an
organization.
Set `ODENCTL_BILLING_RETENTION_PRUNE_INTERVAL_MS` with
`ODENCTL_BILLING_RETENTION_ORGANIZATIONS=org_a,org_b` to run the same retention prune loop
in-process on a schedule.
Set `ODENCTL_SNAPSHOT_PUBLISH_INTERVAL_MS` to run a background publish job that periodically
generates the current route snapshot and publishes it to configured/registered active runtime
nodes. Each generated route snapshot includes a content-derived `snap_<hash>` id, and publish
history records that id for retry and audit correlation. Snapshot publishes retry retryable target
failures by default; tune this with `ODENCTL_SNAPSHOT_PUBLISH_MAX_ATTEMPTS`,
`ODENCTL_SNAPSHOT_PUBLISH_RETRY_DELAY_MS`, and `ODENCTL_SNAPSHOT_PUBLISH_TIMEOUT_MS`.
Set `ODENCTL_ROUTE_SNAPSHOT_REPLICAS` to comma-separated `region=https://control-plane` entries
to replicate each published route snapshot to regional control-plane replicas through
`PUT /replication/snapshots/routes`. Use `ODENCTL_ROUTE_SNAPSHOT_REPLICA_TOKEN` for the replica
bearer token and `ODENCTL_CONTROL_REGION` to label the source region. Replication responses are
included under `replication` and are marked inconsistent when a replica acknowledges a different
snapshot id or `generatedAt`.
Operators can drain runtime nodes before maintenance or scale-down with
`PATCH /runtime-nodes/:id/status` and body `{"status":"draining"}`. Draining and offline nodes stay
in the registry for visibility, but are excluded from snapshot publish targets. Switch back to
`active` after warmup or mark `offline` when the node should remain out of service.
Old registry entries can be removed with `POST /runtime-nodes/gc`. The body requires
`olderThanMs` and optionally accepts `statuses`, for example
`{"olderThanMs":86400000,"statuses":["offline"]}`. If `statuses` is omitted, cleanup only removes
old offline nodes. Removing stale active nodes requires explicitly passing `["active"]`.
Local artifact ingestion stores bytes in `.odenctl/artifacts` by default; set
`ODENCTL_ARTIFACT_DIR` to override it. Local artifact ingestion validates components through
`oden-host` by default; set `ODENCTL_VALIDATE_LOCAL_ARTIFACTS=0` to disable that
for development.
For production artifact storage, configure an S3-compatible bucket:

```sh
export ODENCTL_ARTIFACT_STORE=s3
export ODENCTL_ARTIFACT_BUCKET=odenctl-artifacts
export ODENCTL_ARTIFACT_PREFIX=workers
export ODENCTL_ARTIFACT_REGION=auto
export ODENCTL_ARTIFACT_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export ODENCTL_ARTIFACT_ACCESS_KEY_ID=...
export ODENCTL_ARTIFACT_SECRET_ACCESS_KEY=...
export ODENCTL_ARTIFACT_PUBLIC_BASE_URL=https://cdn.example.com/artifacts
```

If `ODENCTL_ARTIFACT_PUBLIC_BASE_URL` is omitted for S3/R2, artifact locations are recorded as
`s3://<bucket>/<key>`. Runtime nodes materialize `file://`, `http://`, `https://`, private
`s3://`, and `oci://` artifacts. Private S3/R2 runtime fetches use SigV4 GET with the same
`ODENCTL_ARTIFACT_*` or `AWS_*` credentials; if `ODENCTL_ARTIFACT_BUCKET` is set, runtime
nodes reject `s3://` artifacts from other buckets.

OCI locations may point at a tag (`oci://registry.example.com/team/worker:v1`) or directly at the
artifact blob digest (`oci://registry.example.com/team/worker@sha256:<digest>`). For tag references,
runtime nodes fetch the OCI manifest and require a layer digest that exactly matches the control
plane artifact digest before downloading the blob. Configure private registry auth with either a
single registry:

```sh
export ODENCTL_OCI_REGISTRY=registry.example.com
export ODENCTL_OCI_REGISTRY_TOKEN=...
# or:
export ODENCTL_OCI_REGISTRY_USERNAME=...
export ODENCTL_OCI_REGISTRY_PASSWORD=...
```

or multiple registries through `ODENCTL_OCI_REGISTRIES_JSON`. Each entry can include `scheme`,
`bearerToken`, `username`, and `password`; `scheme: "http"` is useful for local registry tests.

The runtime node listens on `http://127.0.0.1:8788` by default. Set `RUNTIME_HOST`,
`RUNTIME_PORT`, `ODEN_CACHE_DIR`, or `ODEN_ARTIFACT_CACHE_DIR` to override this.
Set `RUNTIME_RESPONSE_CACHE_FILE` to a validated public-route policy to enable the
[deployment response cache](response-cache.md). Hits skip component invocation;
TTL, bounded fills, deployment isolation and authenticated local purge are supported.
Try a real WASI P3 guest with `just response-cache-demo`.
Set `CONTROL_PLANE_URL` or `ODENCTL_CONTROL_PLANE_URL` to make the runtime register itself and
send heartbeat updates.
`RUNTIME_PUBLIC_URL`, `RUNTIME_NODE_ID`, `RUNTIME_CONCURRENCY`, `RUNTIME_MEMORY_MB`, and
`RUNTIME_HEARTBEAT_INTERVAL_MS` tune the heartbeat payload. `RUNTIME_REGION` or `FLY_REGION` records
node placement region, and `RUNTIME_LABELS` accepts comma-separated `key=value` labels such as
`pool=default,tier=edge`. Heartbeats include current active worker request load so the control plane
can skip saturated nodes when publishing snapshots.
The repository retains secret-resolution helpers (`ODEN_SECRET_<id>` and
`ODEN_SECRET_DB`) for its control-plane metadata and tests. They do not make
secret imports available to standard WASI guests. Use `runtime.env` for explicitly
granted standalone environment variables; see [configuration](configuration.md).
To isolate noisy tenants, label dedicated runtime nodes with an isolation pool such as
`RUNTIME_LABELS=pool=isolation`, then set
`ODENCTL_ISOLATION_POOL_PROJECTS=projectId=isolation` on the control plane. The publisher sends
filtered per-node route snapshots so isolated project routes are removed from default-pool nodes and
published only to matching isolation-pool nodes. Set `ODENCTL_DRAINED_PROJECTS` to comma-separated
project ids to force-drain tenant routes out of every runtime snapshot; this publishes empty or
filtered snapshots so stale routes are removed from runtimes.
Runtime nodes keep bounded in-memory request events and worker log lines. `GET /__runtime/events`
returns recent request events, and `GET /__runtime/logs?projectId=...&deploymentId=...` returns
recent worker logs filtered by project or deployment. Worker logs are redacted before retention:
resolved secret values and sensitive key-value fields such as `authorization`, `cookie`, `token`,
`password`, and `secret` are replaced with `[REDACTED]`.
Set `RUNTIME_SNAPSHOT_WARMUP=1` to make route snapshot ACKs wait until every deployment target in
the snapshot has been materialized and precompiled into the node-local `.cwasm` cache. Use
`RUNTIME_SNAPSHOT_WARMUP_CONCURRENCY` to bound concurrent materialize/precompile work during
snapshot warmup; the runtime default is 4.
Set `ODEN_RUNTIME_CACHE_MAX_BYTES` and/or `ODEN_RUNTIME_CACHE_MAX_AGE_MS` to enable
runtime cache retention. `POST /__runtime/cache/gc` scans `ODEN_ARTIFACT_CACHE_DIR` and
`ODEN_CACHE_DIR`, removes files older than the age limit, then removes the oldest remaining
files until each cache directory is below the byte limit. Artifact and `.cwasm` paths for currently
prepared deployments are protected from deletion. Set `ODEN_RUNTIME_CACHE_GC_INTERVAL_MS` to
run the same cache GC periodically in the runtime node.
Runtime nodes include Wasmtime host metadata and an engine variant hash in registration/heartbeat.
The `.cwasm` cache key includes that variant, and `POST /__runtime/cache/invalidate-cwasm` removes
precompiled files from older variants while keeping currently prepared components. Set
`ODEN_WASIP3_HOST_VERSION` during host binary upgrades when you want an explicit version label
in the runtime registry and Admin UI.
Use `GET /__runtime/healthz` for process liveness and `GET /__runtime/readyz` for load-balancer
readiness. Readiness returns `503` until a route snapshot has been loaded, while the local lifecycle
state is `draining`, or when configured host-daemon stats are unavailable. Operators can take a node
out of service locally with `POST /__runtime/drain` and restore readiness with
`POST /__runtime/activate`; both management calls honor `ODEN_RUNTIME_TOKEN` when it is set.
Runtime heartbeats report the same local lifecycle status, so a drained node is also excluded from
future snapshot publish target selection by the control plane. While draining, new worker requests
are rejected with `503`; active invocations are allowed to finish. On `SIGTERM` or `SIGINT`, the
runtime enters the same drain path before process exit. Tune the wait with
`RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS`, which defaults to `30000`.
Set `RUNTIME_ROUTE_SNAPSHOT_FILE` to persist the latest accepted route snapshot and restore it on
runtime restart. When a snapshot is restored, `GET /__runtime/readyz` can become ready before the
control plane republishes, while later `PUT /__runtime/snapshots/routes` calls atomically replace
the file before ACK. Invalid restored snapshot files are moved aside with an `.invalid.<timestamp>`
suffix and ignored, leaving the node not ready until a fresh snapshot arrives. The Fly runtime config
uses `/__runtime/readyz` and `/data/route-snapshot.json` so a restarted Machine only receives traffic
after it has a valid restored or newly published route snapshot.
Autoscalers can read `GET /autoscaling/signals` from the control plane to get per-runtime
`activeRequests`, `concurrentRequests`, `loadRatio`, and saturation state. The autoscaling helpers
turn these signals into scale-up/scale-down decisions, and the Fly Machines prototype reconciler can
create Machines or stop excess Machines. The Fly reconciler accepts a coordination store for
controller leases and cooldowns so multiple controller instances do not race provider actions.
The bundled in-memory store is for single-process controllers and tests. Production controllers can
use the SQLite or Postgres coordination stores, which persist lease and cooldown state in
`fly_autoscaler_coordination`. New runtime nodes should be registered as `draining`, receive the
current route snapshot directly for warmup, then be marked `active` by heartbeat.
Runtime nodes can bound warm prepared deployments with a packing policy:
`RUNTIME_PACKING_MAX_WARM_DEPLOYMENTS` caps the node-wide prepared deployment cache,
`RUNTIME_PACKING_MAX_WARM_DEPLOYMENTS_PER_PROJECT` caps each project independently, and
`RUNTIME_PACKING_MAX_IDLE_DEPLOYMENT_AGE_MS` evicts idle prepared deployments by age. Eviction uses
least-recently-used order while protecting the deployment currently being prepared.
Set `ODEN_WASIP3_HOST_DAEMON=1` to make the Node runtime start a local embedded Rust
Wasmtime daemon and invoke warmed `.cwasm` components over `POST /invoke` instead of spawning
`oden-host invoke` for every worker request. The daemon keeps a shared Wasmtime
`Engine` and LRU-bounded prepared component cache inside one process. Use
`ODEN_WASIP3_HOST_MAX_PREPARED_COMPONENTS` to cap prepared components; the default is 256.
Use `ODEN_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS` to cap in-flight host invocations before
Wasmtime instantiation; the default is 128. The daemon also exposes `GET /stats` for compact JSON
pressure counters and `GET /metrics` for Prometheus-format host metrics.
Every request uses a fresh Store/Instance. The custom instance reuse/reset contracts were removed.
When the runtime is configured with `ODEN_WASIP3_HOST_DAEMON=1` or
`ODEN_WASIP3_HOST_DAEMON_URL`, `GET /__runtime/metrics` includes the daemon `/stats` payload
under `hostDaemon`.
Set `ODEN_WASIP3_HOST_DAEMON_ROUTES=1` to publish accepted route snapshots into the daemon's
prepared route table. This keeps the Node runtime responsible for management endpoints, snapshot
validation, warmup, metrics, logs, and drains while worker HTTP traffic can be served directly by the
Rust daemon route table.
Set `ODEN_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES` to enable Wasmtime's pooling allocator
for high-density instance allocation. `ODEN_WASIP3_POOLING_MEMORY_MB` caps each pooled linear
memory slot, while `ODEN_WASIP3_POOLING_TOTAL_CORE_INSTANCES`,
`ODEN_WASIP3_POOLING_TOTAL_MEMORIES`, and `ODEN_WASIP3_POOLING_TOTAL_TABLES` tune pool
capacity. Use `ODEN_WASIP3_HOST_DAEMON_PORT` to change the local port, or set
`ODEN_WASIP3_HOST_DAEMON_URL` to point at an already running host daemon. For local testing:

```sh
just host-daemon
ODEN_WASIP3_HOST_DAEMON_URL=http://127.0.0.1:8790 just runtime
```

Set `ODENCTL_CONTROL_PLANE_TOKEN` or `CONTROL_PLANE_TOKEN` on the runtime node when the control
plane requires bearer-token authentication for registration and heartbeat updates.
Set `ODEN_RUNTIME_TOKEN` on the runtime node to require `Authorization: Bearer <token>` for
runtime management endpoints such as `PUT /__runtime/snapshots/routes`; `GET /__runtime/healthz`
remains unauthenticated.
Set `ODEN_RUNTIME_IDENTITY_KEYS` on the runtime node to require signed route snapshot publishes.
The same keyring must be available to the control plane. Rotate keys online by first adding the new
key to both keyrings, then switching runtime nodes to the new
`ODEN_RUNTIME_IDENTITY_KEY_ID`, waiting for heartbeat/registration to advertise it, and finally
removing the old key after all publishers and nodes have moved. For transport-level mTLS, terminate
TLS on the runtime edge or private network proxy and pin the certificate fingerprint with
`ODEN_RUNTIME_IDENTITY_CERT_SHA256`; the built-in identity signature protects the application
request even when bearer tokens are also configured.
Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` to emit OTLP/HTTP JSON
trace spans for worker requests. `OTEL_SERVICE_NAME` defaults to `oden-runtime`, and
`OTEL_EXPORTER_OTLP_HEADERS` accepts comma-separated `key=value` headers for collector auth.

Runtime-oriented tests expect these CLIs on `PATH`:

- `wasmtime`
- `wasm-tools`
- `wit-bindgen`

## Fly.io Trial Deploy

The Fly setup uses one shared Docker image and two Fly apps:

- control app: `node --experimental-strip-types src/main.ts`
- runtime app: `node --experimental-strip-types src/runtime/main.ts`
- collector app: `otel/opentelemetry-collector-contrib` with `otelcol/config.yaml`

Pick globally unique app names before running the commands:

```sh
export FLY_CONTROL_APP=mz-wasmplane-control
export FLY_RUNTIME_APP=mz-wasmplane-runtime
export FLY_COLLECTOR_APP=mz-wasmplane-otel-collector
export FLY_REGION=nrt
export ODENCTL_CONTROL_PLANE_TOKEN="$(openssl rand -hex 24)"
export ODEN_RUNTIME_TOKEN="$(openssl rand -hex 24)"
export ODEN_RUNTIME_IDENTITY_KEY_ID=rt-key
export ODEN_RUNTIME_IDENTITY_SECRET="$(openssl rand -hex 32)"

fly apps create "$FLY_CONTROL_APP"
fly apps create "$FLY_RUNTIME_APP"
fly apps create "$FLY_COLLECTOR_APP"
just fly-create-volumes

fly secrets set -a "$FLY_CONTROL_APP" \
  ODENCTL_API_TOKEN="$ODENCTL_CONTROL_PLANE_TOKEN" \
  ODEN_RUNTIME_TOKEN="$ODEN_RUNTIME_TOKEN" \
  ODEN_RUNTIME_IDENTITY_KEYS="$ODEN_RUNTIME_IDENTITY_KEY_ID=$ODEN_RUNTIME_IDENTITY_SECRET"

fly secrets set -a "$FLY_RUNTIME_APP" \
  CONTROL_PLANE_URL="https://$FLY_CONTROL_APP.fly.dev" \
  RUNTIME_PUBLIC_URL="auto" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://$FLY_COLLECTOR_APP.internal:4318" \
  ODENCTL_CONTROL_PLANE_TOKEN="$ODENCTL_CONTROL_PLANE_TOKEN" \
  ODEN_RUNTIME_TOKEN="$ODEN_RUNTIME_TOKEN" \
  ODEN_RUNTIME_IDENTITY_KEY_ID="$ODEN_RUNTIME_IDENTITY_KEY_ID" \
  ODEN_RUNTIME_IDENTITY_KEYS="$ODEN_RUNTIME_IDENTITY_KEY_ID=$ODEN_RUNTIME_IDENTITY_SECRET"

just fly-deploy-collector
just fly-deploy-control
just fly-deploy-runtime
```

Check the deployed services:

```sh
just fly-status
just fly-smoke
just fly-smoke-rust-forward

curl -H "authorization: Bearer $ODENCTL_CONTROL_PLANE_TOKEN" \
  "https://$FLY_CONTROL_APP.fly.dev/runtime-nodes"
curl "https://$FLY_RUNTIME_APP.fly.dev/__runtime/healthz"
curl "https://$FLY_COLLECTOR_APP.fly.dev/"
```

`just fly-smoke` checks public health endpoints, authenticated control-plane
`/autoscaling/signals` and `/snapshots/routes`, authenticated runtime `/__runtime/metrics`, and one
worker request using `ODENCTL_SMOKE_WORKER_HOST`/`ODENCTL_SMOKE_WORKER_PATH` defaulting to
`hello.example.dev` and `/`. Run `pnpm ops-smoke -- --skip-worker` when no route has been deployed
yet. `just fly-smoke-rust-forward` adds production posture checks plus a host daemon assertion that
runtime metrics include `hostDaemon.preparedRoutes > 0`.

The control app stores SQLite state and uploaded local artifacts on `/data`. For Fly, local uploads
are recorded as `https://<control-app>/artifacts/local/<digest>.wasm`, so the separate runtime app can
materialize them over HTTP. The runtime app stores compiled components, downloaded artifacts,
and its persisted route snapshot under `/data`.
For multiple runtime Machines, create one `wasmplane_runtime_data` volume per Machine region.
The control plane also includes a volume-backed high-density SQLite registry for Turso-style
file-per-project or file-per-tenant state. `createVolumeSqliteRegistry({ rootDir: "/data/sqlite" })`
stores a `catalog.sqlite` plus per-database files under `/data/sqlite/dbs`, applies WAL-oriented
SQLite pragmas, tracks schema version and ownership metadata, and uses an LRU `SqliteDatabasePool`
to cap open handles. This is intended for local-first project state on a single attached volume;
multi-machine writers still need a managed primary such as Postgres or Turso/libSQL. Set
`ODENCTL_VOLUME_SQLITE_ROOT=/data/sqlite` to enable the registry in the control API, and tune the
open handle cap with `ODENCTL_VOLUME_SQLITE_MAX_OPEN`. `writeDatabase()` provides a per-database
FIFO writer queue; `ODENCTL_VOLUME_SQLITE_MAX_PENDING_WRITES` caps active plus queued writes per
database and rejects excess work with a conflict error instead of allowing unbounded request buildup.
Individual database files can be exported into `/data/sqlite/backups` with `VACUUM INTO` and
restored back into the registry without exposing arbitrary SQL execution. Backup retention can be
applied automatically with `ODENCTL_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE` and
`ODENCTL_VOLUME_SQLITE_BACKUP_RETENTION_MS`. Database directories are chmodded to `0700`, SQLite
database, WAL, SHM, and backup files are chmodded to `0600`, and backup/restore paths are constrained
under the registry root. Plain SQLite database files are not SQLCipher-encrypted by this layer; on Fly
they rely on the attached volume's platform encryption plus these local file permissions. Backup
files can be encrypted with AES-256-GCM by setting `ODENCTL_VOLUME_SQLITE_BACKUP_KEY_BASE64` to a
32-byte base64 key. Set `ODENCTL_VOLUME_SQLITE_BACKUP_KEY_ID` for the active key id, and keep old
decrypt-only keys in `ODENCTL_VOLUME_SQLITE_BACKUP_KEYS_BASE64` as comma-separated
`keyId=base64` entries during rotation. The CLI uses the same environment, so encrypted backups can
be restored with `volume-sqlite restore` as long as the matching key id is configured.

A Durable Objects-style storage facade can be layered on the same registry when the application
wants object-local state rather than direct database-file lifecycle management:

```ts
import {
  createDurableObjectAlarmDispatcherJob,
  createDurableObjectStorageNamespace,
  createVolumeSqliteRegistry,
} from "@mizchi/odenctl";

const registry = createVolumeSqliteRegistry({ rootDir: "/data/sqlite" });
const rooms = createDurableObjectStorageNamespace({
  namespace: "rooms",
  ownerId: "prj_chat",
  registry,
});

const room = rooms.storageForName("lobby");
await room.put("title", "Lobby");
await room.transaction(async (txn) => {
  const count = (await txn.get<number>("count")) ?? 0;
  await txn.put("count", count + 1);
});
await room.setAlarm(Date.now() + 60_000);
const dueAlarms = await rooms.listDueAlarms({ now: Date.now() });
await room.sql.exec("create table if not exists messages (id text primary key, body text not null)");

const alarmJob = createDurableObjectAlarmDispatcherJob({
  intervalMs: 1000,
  namespace: rooms,
  async handler(event) {
    await event.storage.put("alarm:last", event.scheduledTime.toISOString());
  },
});
```

Each object maps to a private `kind=durable_object` SQLite database, storage methods are serialized
through the per-database FIFO queue, and `sql.exec()` is object-local. The facade currently stores
JSON-serializable values, keeps one object-local alarm timestamp for scheduler dispatch through
`listDueAlarms()`, ships a non-overlapping alarm dispatcher job, and intentionally blocks SQL access
to its reserved KV/meta tables.
For the packaged control-plane process, set `ODENCTL_DURABLE_OBJECT_ALARM_INTERVAL_MS`,
`ODENCTL_DURABLE_OBJECT_ALARM_NAMESPACES`, and `ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_URL` to
poll due alarms from the volume SQLite registry and POST them to an application webhook. Optional
settings are `ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN`,
`ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_TIMEOUT_MS`, and `ODENCTL_DURABLE_OBJECT_ALARM_LIMIT`.
Idle alarm polling ticks are not logged by default; set
`ODENCTL_DURABLE_OBJECT_ALARM_LOG_IDLE_TICKS=1` when diagnosing scheduler liveness.
The Fly control-plane config enables an `alarm-demo` app backed by the same durable object registry:
`POST /alarm-demo/schedules` schedules an object-local alarm, the dispatcher POSTs
`/alarm-demo/webhook`, and `GET /alarm-demo/objects/:name` reports `alarmCount`, `alarmAt`, and the
last fired timestamp. Set the shared webhook secret before deploying:

```sh
fly secrets set -a "$FLY_CONTROL_APP" \
  ODENCTL_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN="$(openssl rand -hex 24)"
just fly-deploy-control
ODENCTL_CONTROL_PLANE_TOKEN="$ODENCTL_CONTROL_PLANE_TOKEN" just fly-alarm-demo
```

Set `ODENCTL_VOLUME_SQLITE_BACKUP_INTERVAL_MS` on the control plane to run scheduled backups for
all cataloged volume SQLite databases. Scheduled backups require encryption by default; set
`ODENCTL_VOLUME_SQLITE_BACKUP_REQUIRE_ENCRYPTION=0` only for local development. Enable
`ODENCTL_VOLUME_SQLITE_BACKUP_RESTORE_DRILL=1` to copy each new backup into a temporary SQLite
file, decrypting it when needed, and run `pragma quick_check` plus schema-version inspection before
retention deletes older backups. Retention can also be applied manually with `volume-sqlite gc`:

```sh
pnpm odenctl volume-sqlite backup --root /data/sqlite --id prj_example --backup-id before-migration
pnpm odenctl volume-sqlite restore --root /data/sqlite --id prj_example --backup-id before-migration
pnpm odenctl volume-sqlite gc --root /data/sqlite --id prj_example --keep-latest 24 --older-than-ms 604800000
```

To move the control plane state to managed Postgres, create a Postgres database and set
`DATABASE_URL` on the control app. To remove the control app volume dependency, also set the
S3/R2 artifact store variables above so local uploads are persisted outside `/data`.
Set `ODENCTL_REQUIRE_EXTERNAL_DATABASE=1` when a production control-plane process must refuse to
start on the fallback SQLite database. Set `ODENCTL_REQUIRE_EXTERNAL_ARTIFACT_STORE=1` to apply
the same guard for artifact storage. Authenticated `GET /ops/config` returns non-secret posture
metadata such as database kind, artifact store kind, configured snapshot replicas, static runtime
targets, and enabled durable object alarm namespaces; `just fly-smoke-production` verifies that the
deployed control plane is on an external database and has at least two active runtime nodes.
`just fly-smoke-rust-forward` also verifies that the runtime has published route snapshots into the
Rust-forward host daemon.

On Fly, leave `RUNTIME_PUBLIC_URL=auto`. Each runtime Machine registers as
`rt_<FLY_MACHINE_ID>` and advertises `http://<FLY_MACHINE_ID>.vm.<FLY_APP_NAME>.internal:<port>`
to the control plane, so route snapshots can be published directly to every Machine over Fly's
private network. The public `https://<runtime-app>.fly.dev` URL is still used for worker traffic.
The control plane ignores active runtime nodes whose heartbeat is older than
`ODENCTL_RUNTIME_NODE_ACTIVE_TTL_MS`, defaulting to 90 seconds.

The collector receives OTLP/gRPC on `4317` and OTLP/HTTP on `4318` over Fly private networking,
then exports traces to the `debug` exporter and derives Prometheus RED metrics through the
`spanmetrics` connector on `:9464/metrics`. Use `just fly-logs-collector` to inspect collected
spans. `otelcol/alerts.yaml` contains starter Prometheus alert rules for runtime error rate and
p95 latency. The debug exporter is for verification; replace or extend `otelcol/config.yaml` with a
real trace backend exporter for production retention.

Short scale test:

```sh
just fly-scale-eval
pnpm fly-scale-eval -- --runtime-machines 2 --iterations 300 --concurrency 1,8,32,64,128
pnpm fly-scale-eval -- --execute --runtime-machines 2 --output perf-results/fly-scale-eval.md

fly scale count 2 -a "$FLY_RUNTIME_APP" -r "$FLY_REGION" --with-new-volumes --yes
sleep 30
curl -X POST "https://$FLY_CONTROL_APP.fly.dev/snapshots/routes/publish" \
  -H "authorization: Bearer $ODENCTL_CONTROL_PLANE_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
pnpm bench http \
  --runtime-url "https://$FLY_RUNTIME_APP.fly.dev" \
  --host hello.example.dev \
  --iterations 120 \
  --warmup 5 \
  --concurrency 1,8,32,64
fly scale count 1 -a "$FLY_RUNTIME_APP" -r "$FLY_REGION" --yes
fly volumes list -a "$FLY_RUNTIME_APP"
```

`fly-scale-eval` is dry-run by default. With `--execute`, it scales the runtime app, publishes the
current route snapshot, runs production smoke checks, and measures HTTP throughput at the requested
concurrency levels. The runtime drain/activate readiness drill runs only with `--failure-drill`.
Machine restarts are available only when explicit ids are supplied with
`--restart-runtime-machine <id>` or `--restart-control-machine <id>`. Volume SQLite backup drills
require an explicit database id with `--volume-sqlite-drill-id <id>`.

### Production readiness gate

`.github/workflows/production-readiness.yml` is the protected manual gate for live Fly production
posture. Configure the GitHub Environment `production` with
`ODENCTL_CONTROL_PLANE_TOKEN`, `ODEN_RUNTIME_TOKEN`, and `FLY_API_TOKEN`. The workflow runs
`just actions-pin-check`, `just fly-smoke-production`, `just fly-alarm-demo`, a Fly scale
evaluation plan, and optionally executes the scale evaluation and Rust + MoonBit release smoke. It
uploads `reports/production-readiness/` as `odenctl-production-readiness`.
`scripts/install-flyctl.sh` installs a pinned `flyctl` release with SHA-256 verification whenever the
gate needs Fly API access for OTEL evidence or execute-mode drills. SLO thresholds are workflow
inputs: p95 latency, error-rate, minimum throughput, and route publish latency are passed to
`fly-scale-eval`, which fails the gate when an executed run regresses. The default p95 gate is
1500ms for the current two-runtime Fly baseline; tighten it after capacity or pooling improves.
`pnpm fly-otel-evidence`
captures collector log evidence that runtime spans reached the OTEL pipeline. Runtime drain,
Machine restart, and volume SQLite backup drills are also exposed as off/empty-by-default inputs, so
destructive checks remain explicit.

The runtime supervisor code currently prepares deployments by resolving a route snapshot,
materializing `file://`, `http://`, `https://`, private `s3://`, or `oci://` artifacts, verifying their
`sha256` digest, validating the component through the Rust `oden-host` linker, and
precompiling through that same host binary. Runtime invocation uses the generated `.cwasm` artifact
so cold invokes skip Cranelift compilation. `.cwasm` files are trusted node-local cache entries
tied to the host binary, Wasmtime version/configuration, and target machine; they are not portable
user artifacts. The runtime separates `.cwasm` entries by engine variant and can invalidate older
variants through the runtime management endpoint. Remote HTTP(S) and S3 artifacts are cached under
`ODEN_ARTIFACT_CACHE_DIR`.
Optional `wasm-tools component targets` validation is available as an opt-in backend setting, but it
is not the default because WASI-adapted Rust components include additional WASI imports that the
host linker satisfies.

Runtime nodes execute standard `wasi:http/service@0.3.0` components. The custom worker WIT,
KV/Secrets/storage/service host imports, host-call counter, and guest reset ABI were removed.
Old components and snapshots need to be rebuilt and deployed with `worldVersion: "0.3.0"`.
Configured legacy guest bindings are rejected; the control-plane resource management APIs remain.
The new celld actor binding is available through standalone runtime configuration.

The node adapter applies memory limits, request/response byte limits, outbound origin allowlists,
subrequest counters, and a deadline through body completion. `cpuMs` remains a conservative elapsed-time
cap including I/O. Standard WASI bodies stream between guest and host; the existing node JSON/route
transport collects them within its limits. Use `oden serve` for streaming to the network client.
See [node contracts and migration](../developer/standalone-runtime.md#running-through-the-control-plane).

The control plane stores local secret values through `POST /secrets`, but all public API responses
return only secret metadata. Set `ODENCTL_SECRET_KMS_KEY_BASE64` to a 32-byte base64 key to store
secret values as `wasmplane:v1:aes-256-gcm:*` envelopes before repository persistence. For local
development and Fly trials, `ODENCTL_SECRET_KMS_KEY` is accepted as a passphrase-style key and is
derived with SHA-256; prefer the base64 key form for production. `ODENCTL_SECRET_KMS_KEY_ID` is
recorded in the envelope and selects the primary encryption key. During online rotation, keep old
decrypt keys in `ODENCTL_SECRET_KMS_KEYS_BASE64` as comma-separated `keyId=base64` entries until
all stored envelopes have been rewritten with the new primary key. For external KMS integrations,
set `ODENCTL_SECRET_KMS_KEY_PROVIDER_COMMAND` to an executable that prints JSON such as
`{"primaryKeyId":"kid2","keys":[{"keyId":"kid1","keyBase64":"..."},{"keyId":"kid2","keyBase64":"..."}]}`.
`ODENCTL_SECRET_KMS_KEY_PROVIDER_ARGS` may contain a JSON string array of command arguments.
For cloud KMS, set `ODENCTL_SECRET_KMS_PROVIDER` to `aws`, `gcp`, or `azure`. For AWS KMS, set
`ODENCTL_SECRET_KMS_AWS_REGION`,
`ODENCTL_SECRET_KMS_KEY_ID`, and `ODENCTL_SECRET_KMS_AWS_WRAPPED_KEYS` to JSON such as
`{"keys":[{"keyId":"kid2","ciphertextBase64":"...","kmsKeyId":"arn:aws:kms:...","encryptionContext":{"service":"odenctl"}}]}`.
The AWS adapter calls KMS `Decrypt` during process startup, then uses the unwrapped 32-byte data
keys as the in-memory AES-GCM keyring. AWS credentials are read from `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`; `ODENCTL_SECRET_KMS_AWS_ENDPOINT` can
point at a KMS-compatible local endpoint.
For GCP Cloud KMS, set `ODENCTL_SECRET_KMS_GCP_ACCESS_TOKEN` and
`ODENCTL_SECRET_KMS_GCP_WRAPPED_KEYS` with `cryptoKeyName` values such as
`projects/p/locations/global/keyRings/r/cryptoKeys/k`. For Azure Key Vault, set
`ODENCTL_SECRET_KMS_AZURE_ACCESS_TOKEN` and `ODENCTL_SECRET_KMS_AZURE_WRAPPED_KEYS` with
`vaultUrl`, `keyName`, `keyVersion`, and `algorithm` values such as `RSA-OAEP-256`.
These settings protect control-plane secret storage. Secret-resolution helpers
can read `ODEN_SECRET_DB`, but the current standard WASI adapter rejects secret
bindings; configuring a keyring is not a guest-access grant.
KV namespaces are also registered in the control plane. Metadata validation requires
referenced secrets and KV namespaces to belong to the same project; it does not
make those bindings executable by the standard host.
Guests make outbound requests through standard `wasi:http`. The host authorizes
exact HTTP(S) origins (scheme, host, and port) and applies the deployment's
`subrequests` budget. Allowlist entries cannot include a path beyond `/`, query,
fragment, or credentials. Redirect responses are returned to the guest; the host
does not follow them automatically. Use host/container network policy for network
restrictions beyond the origin allowlist.

The real guest example can be rebuilt and invoked through the Rust Wasmtime host:

```sh
just guest-invoke
```

`just guest-build` builds the standard HTTP example with `wasm32-wasip2`,
producing `examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm`.
The guest exports WASI HTTP 0.3 and uses WASI 0.2 standard-library imports. It does
not require a preview1 adapter. `WASI_PREVIEW1_ADAPTER` is used only by the older
`wasm32-wasip1` interop and WAC canary examples.

## Cost Estimate

Run the built-in estimator for the reference single-region deployment shape:

```sh
pnpm cost
pnpm cost cloudflare-containers
```

The default estimate assumes:

- Fly region: `nrt`
- control plane: 1 x `shared-cpu-1x` / 1GB
- runtime: 1 x `performance-1x` / 2GB
- collector: 1 x `shared-cpu-1x` / 512MB
- Fly Managed Postgres Basic + 10GB provisioned storage
- Cloudflare R2 standard storage within the 10GB / 1M Class A / 10M Class B free tier
- 2GB Fly volumes and 50GB Fly public egress from Asia Pacific

With those assumptions the estimator reports about `$95.27/month`. Scaling the runtime to 4 Machines
and using 100GB R2 storage, 5M Class A ops, 20M Class B ops, and 100GB Fly public egress reports
about `$241.84/month`. Prices are data constants in `src/cost-estimator.ts`, not live
provider quotes. Check and update those constants before using the output for a
deployment budget.

The Cloudflare Containers estimate models the current control-plane POC as 1 x `lite` container
behind a Worker and Durable Object. Smoke-test scale stays at the Workers Paid plan floor of about
`$5.00/month`. If the `lite` container is kept effectively always-on for 720 hours/month at 20%
average CPU while active, the estimate is about `$6.91/month` before external Postgres/R2 usage.
Scaling that shape to many concurrently active container instances adds Durable Object duration,
logs, request, and egress overages.

SQLite and Postgres schema upgrades are tracked in `schema_migrations`; repository initialization
applies missing migrations before serving requests, then verifies the current schema version against
the compiled migration catalog. `pnpm odenctl migrate check` exits non-zero when migrations are
pending or when the database is ahead of the running binary; `pnpm odenctl migrate apply` applies
the configured database migrations and prints the resulting status JSON.

Runtime node endpoints:

- `GET /__runtime/healthz`
- `GET /__runtime/readyz`
- `GET /__runtime/response-cache` (requires configured management token)
- `POST /__runtime/response-cache/purge` (requires configured management token)
- `POST /__runtime/drain` and `POST /__runtime/activate`
- `GET /__runtime/metrics`
- `GET /__runtime/events`
- `GET /__runtime/logs`
- `GET /__runtime/traces`
- `POST /__runtime/cache/gc`
- `PUT /__runtime/snapshots/routes`
- any other path: resolve by `x-forwarded-host` or `host`, prepare the component, then invoke it
  through `oden-host`.

`GET /__runtime/metrics` exposes in-memory counters for worker requests, route matches/misses,
invocations, active/rejected invocation concurrency, response status codes, runtime error codes,
and loaded route snapshots. Add `projectId` or `deploymentId` query parameters to return scoped
metrics for a single project or deployment. `GET /__runtime/events` returns a bounded in-memory list
of structured worker request events with request id, host/path, project/deployment, status,
duration, and error code, and accepts the same scope filters. `GET /__runtime/traces` returns recent
trace contexts for worker requests that carried `traceparent`, also filterable by project or
deployment. Worker responses include `x-oden-request-id`.

The log-retention/drain API accepts structured logs supplied by an invoker. The
standard WASI adapter does not capture guest stderr into these entries; stderr
is emitted by the host process. Structured worker logs can be retained through `GET /__runtime/logs?projectId=...&deploymentId=...`
and streamed to HTTP drains by setting `RUNTIME_LOG_DRAINS` to comma-separated URLs. Optional
headers use `RUNTIME_LOG_DRAIN_HEADERS` with `name=value` comma-separated entries.

The runtime node enforces `RUNTIME_CONCURRENCY` as the maximum concurrent worker invocations. Extra
worker requests are rejected with `503 overloaded` and counted in metrics. Set
`RUNTIME_PROJECT_CONCURRENCY_LIMITS` to comma-separated `projectId=count` entries such as
`prj_a=16,prj_b=4` to cap noisy projects independently while allowing other projects to keep
serving traffic. Set `RUNTIME_PROJECT_RATE_LIMITS` to comma-separated `projectId=rps[:burst]`
entries such as `prj_a=100:200,prj_b=10`; requests over the token-bucket rate limit return
`429 rate_limited`.

The control plane serves a small server-rendered admin UI at `GET /admin`. It summarizes the active
route snapshot, projects, deployments, canaries, runtime nodes, autoscaling signals, and recent
publish/canary state. The UI uses the same bearer-token scope boundaries as the JSON API: admin
reads require `read`, while canary and rollback form posts require `write`.

## CLI Deploy

The CLI deploy flow assumes a prebuilt component and orchestrates the control-plane API:

```sh
pnpm odenctl deploy \
  --control-plane-url http://127.0.0.1:8787 \
  --token "$ODENCTL_CONTROL_PLANE_TOKEN" \
  --project-id prj_hello \
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --host hello.example.dev \
  --path-prefix / \
  --runtime-version wasmtime-48.0.2 \
  --limit cpuMs=5000 --limit wallMs=10000 \
  --outbound https://api.example.dev/
```

The command uploads bytes through `POST /artifacts/local`, creates an immutable deployment, points
the route, then publishes a route snapshot unless `--no-publish` is passed. Limit overrides use
`--limit name=value`, for example `--limit wallMs=2500 --limit cpuMs=100`. The CLI also reads
`ODENCTL_CONTROL_PLANE_TOKEN` when `--token` is omitted. Pass `--diff` to fetch the current route
snapshot before deploying and include JSON diff output for the route pointer, rollout targets,
runtime version, limits, and capability metadata. Do not pass `--kv`, `--secret`,
or `--service` for this backend: the parser retains these metadata flags, but the
standard WASI host rejects their guest bindings. Pass `--runtime-version
wasmtime-48.0.2` explicitly; the current CLI still defaults that metadata field to
`wasmtime-42`, and the field does not select or install an engine.

Rust worker projects use standard WASIp3 bindings:

```sh
pnpm odenctl new --language rust --name hello-worker --out workers/hello
cd workers/hello
just build
```

The template uses the `wasip3` crate and the `wasm32-wasip2` target. HTTP exports are WASI 0.3;
Rust standard-library imports are WASI 0.2. No custom WIT generation is required.
The old TypeScript component template was removed.

For a deployment preview, first start both processes and create `prj_hello` as in
the [walkthrough](control-plane.md). In a third terminal, use `dev` to validate the
component, create a preview, publish directly to the gateway, and print a curl command:

```sh
ODENCTL_CONTROL_PLANE_TOKEN=local-control-token \
ODEN_RUNTIME_TOKEN=local-runtime-token \
pnpm odenctl dev \
  --project-id prj_hello \
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --runtime-version wasmtime-48.0.2 \
  --limit cpuMs=5000 --limit wallMs=10000 \
  --host dev.localhost \
  --env FEATURE_FLAG=on
```

`odenctl dev` defaults to `http://127.0.0.1:8787` for the control plane and
`http://127.0.0.1:8788` for the runtime. It validates through `oden-host compile`
unless `--no-validate` is passed, publishes to `PUT /__runtime/snapshots/routes`, and reads
`GET /__runtime/logs?projectId=...&deploymentId=...` unless `--no-tail-logs` is passed.
`--env` saves preview metadata; the standard deployment adapter does not inject it
into the guest's WASI environment. Use `oden dev app.json` with explicit runtime
environment grants for a standalone application. The preview command does not
start the API/gateway or watch source files.

Canary rollout can be driven through the control-plane API by first pointing a route at the stable
deployment, then calling `POST /routes/canary` with a candidate deployment and weight. Rollback uses
`POST /routes/rollback` and returns the route to the stable target with 100% weight. Automatic
canary analysis uses `POST /routes/canary/analyze` with runtime event samples, a candidate
deployment id, and thresholds such as `minRequests`, `p95Ms`, `errorRate`, and `rejectCount`.
When a threshold fails, the route is rolled back and the decision is stored in
`GET /canary-decisions`.
Deploy previews can be created with `POST /deploy-previews`. A preview points a host/path at a
candidate deployment, stores environment bindings for preview metadata, and records the previous
route pointer. `POST /deploy-previews/:id/rollback` restores that previous pointer or removes the
preview route when no prior route existed.

## API

```sh
curl -X POST http://127.0.0.1:8787/projects \
  -H 'content-type: application/json' \
  -d '{"name":"hello"}'
```

For invite-only beta onboarding, create the organization, owner, project, owner membership, and
project-scoped deploy key in one call:

```sh
pnpm odenctl onboard beta \
  --organization-name "Acme" \
  --user-email owner@acme.example \
  --project-name "Acme API" \
  --host api.acme.example
```

The response includes a one-time deploy token, onboarding checklist, usage/billing URLs, and a
deploy command that uses `ODENCTL_CONTROL_PLANE_TOKEN=<deploy-token>`.
Organizations track a billing provider, external customer id, billing email, payment status, and
payment status update timestamp. Update those fields with `PUT /organizations/:id/billing` before
raising a beta tenant's production quota.
Production quota increase requests are durable control-plane records created with
`POST /organizations/:id/production-quota-increases`. They are approved only after payment is
active, at least one owner invite has been accepted, and that accepted owner has a verified email.
Use `POST /projects/:id/memberships/:userId/accept` and `POST /users/:id/verify-email` to complete
the beta owner checks.

Available endpoints:

- `GET /admin`
- `POST /admin/routes/canary`
- `POST /admin/routes/rollback`
- `POST /beta/onboardings`
- `POST /organizations`
- `PUT /organizations/:id/billing`
- `POST /organizations/:id/production-quota-increases`
- `GET /organizations/:id/billing-statement`
- `GET /organizations/:id/billing-invoices`
- `POST /organizations/:id/billing-invoices`
- `GET /organizations/:id/audit-events`
- `GET /billing-invoices/:id`
- `GET /billing-invoices/:id/export`
- `GET /billing-invoices/:id/retention-policy`
- `PUT /billing-invoices/:id/retention-policy`
- `POST /billing-invoices/retention/prune`
- `POST /users`
- `POST /users/:id/verify-email`
- `POST /projects`
- `POST /projects/:id/memberships`
- `GET /projects/:id/memberships`
- `PATCH /projects/:id/memberships/:userId`
- `DELETE /projects/:id/memberships/:userId`
- `POST /projects/:id/memberships/:userId/accept`
- `GET /projects/:id/settings`
- `GET /projects/:id/audit-events`
- `POST /api-keys`
- `GET /projects/:id/api-keys`
- `POST /api-keys/:id/revoke`
- `POST /api-keys/:id/rotate`
- `POST /usage/events`
- `GET /projects/:id/usage`
- `POST /custom-domains`
- `GET /projects/:id/custom-domains`
- `DELETE /custom-domains/:id`
- `POST /custom-domains/:id/verify`
- `POST /custom-domains/:id/tls`
- `POST /custom-domains/:id/tls/complete`
- `POST /deploy-previews`
- `GET /projects/:id/deploy-previews`
- `POST /deploy-previews/:id/rollback`
- `GET /projects/:id/quota-usage`
- `GET /projects/:id/enforcement-report`
- `GET /projects/:id/usage-quota`
- `GET /projects/:id/billing-statement`
- `GET /projects/:id/billing-budget`
- `POST /projects/:id/sqlite-databases`
- `GET /projects/:id/sqlite-databases`
- `GET /sqlite-databases`
- `GET /sqlite-databases/:id`
- `POST /sqlite-databases/:id/backups`
- `GET /sqlite-databases/:id/backups`
- `POST /sqlite-databases/:id/backups/gc`
- `POST /sqlite-databases/:id/restores`
- `POST /artifacts`
- `POST /artifacts/local`
- `POST /secrets`
- `GET /projects/:id/secrets`
- `GET /secrets/:id`
- `PUT /secrets/:id`
- `DELETE /secrets/:id`
- `POST /kv-namespaces`
- `GET /projects/:id/kv-namespaces`
- `GET /kv-namespaces/:id`
- `DELETE /kv-namespaces/:id`
- `POST /durable-object-namespaces`
- `GET /projects/:id/durable-object-namespaces`
- `GET /durable-object-namespaces/:id`
- `DELETE /durable-object-namespaces/:id`
- `POST /deployments`
- `PUT /routes`
- `POST /routes/canary`
- `POST /routes/canary/analyze`
- `POST /routes/rollback`
- `GET /canary-decisions`
- `POST /runtime-nodes`
- `POST /runtime-nodes/:id/heartbeat`
- `PATCH /runtime-nodes/:id/status`
- `POST /runtime-nodes/gc`
- `GET /runtime-nodes`
- `GET /runtime-nodes/:id/logs`
- `GET /autoscaling/signals`
- `GET /snapshots/routes`
- `POST /snapshots/routes/publish`
- `GET /snapshots/routes/publishes`
- `GET /healthz`

Artifact locations may use `file://`, `http://`, `https://`, `oci://`, or `s3://`. The runtime
materializer supports direct `file://` and HTTP(S) artifact bytes, private S3/R2 objects, and OCI
registry artifacts backed by manifest-layer or digest-addressed blob pulls.

Artifacts may include signature and provenance metadata. `signature` currently supports
`sha256-hmac` over the artifact digest with a configured key id, and the control plane can reject
deployment creation when the artifact signature is missing or invalid. `provenance` records CI/build
context such as builder, source, revision, and build id; artifact responses and route snapshots
surface this metadata for deploy audit and runtime publication checks.
Production admission guardrails can be enabled through environment variables: set
`ODENCTL_ADMISSION_REQUIRE_ARTIFACT_SIGNATURE=1`, optionally restrict signature key ids with
`ODENCTL_ADMISSION_ARTIFACT_SIGNATURE_KEY_IDS`, cap artifact metadata size with
`ODENCTL_ADMISSION_MAX_ARTIFACT_SIZE_BYTES`, restrict WIT contracts with
`ODENCTL_ADMISSION_ALLOWED_WORLDS` and `ODENCTL_ADMISSION_ALLOWED_WORLD_VERSIONS`, and restrict
deployment capabilities with `ODENCTL_ADMISSION_OUTBOUND_HTTP_PREFIXES`,
`ODENCTL_ADMISSION_KV_NAMESPACE_IDS`, `ODENCTL_ADMISSION_DURABLE_OBJECT_NAMESPACE_IDS`, and
`ODENCTL_ADMISSION_SECRET_IDS`. Legacy service-binding metadata can be restricted with
`ODENCTL_ADMISSION_SERVICE_PROJECT_IDS` and `ODENCTL_ADMISSION_SERVICE_URL_PREFIXES`.
Admission policies validate stored metadata; the standard host still rejects removed
KV/secret/service/DO guest bindings. Outbound execution uses the exact-origin
allowlist described above, even though the admission variable name contains `PREFIXES`.

Custom domains are registered before routing through `POST /custom-domains`. The response includes
a DNS TXT challenge under `_odenctl-challenge.<host>`; submit observed TXT values to
`POST /custom-domains/:id/verify` to mark ownership verified. TLS provisioning is intentionally a
hook for Fly/ACME/provider automation: `POST /custom-domains/:id/tls` records an external
provisioning request, and `POST /custom-domains/:id/tls/complete` records success or failure. Once
the domain is active, routes for that host can be pointed by the owning project; registered domains
cannot be claimed by another project.

Deploy previews create temporary route pointers with preview URLs. If `host` is omitted, the
control plane derives a DNS-safe `*.preview.oden.local` host from the project/deployment ids.
Environment bindings must use environment-variable-style keys and string values; they are stored as
control-plane metadata for preview orchestration, not injected into runtime snapshots yet.

`POST /snapshots/routes/publish` creates a fresh compact route snapshot and pushes it to each
active registered runtime node, plus statically configured runtime nodes, through
`PUT /__runtime/snapshots/routes`. The response includes a per-node publish result and stores a
publication history record. Each target result includes `attempts` and `elapsedMs`; retryable
statuses are retried per target without blocking successful targets from recording their result.
When regional replica targets are configured, the same snapshot is also sent to
`PUT /replication/snapshots/routes`; `GET /replication/snapshots/routes` returns the latest accepted
replicated snapshot held by that control-plane process.

Secret creation accepts a value, but responses omit it:

```json
{
  "id": "sec_api_key",
  "projectId": "prj_hello",
  "name": "API key",
  "value": "super-secret"
}
```

The resource-management schema can store a secret reference like the following.
It is metadata only: deploying it to the current standard WASI host is rejected.

```json
{
  "secrets": [{ "binding": "API_KEY", "secretId": "sec_api_key" }]
}
```

KV namespace creation returns metadata:

```json
{
  "id": "kv_main",
  "projectId": "prj_hello",
  "name": "Main KV"
}
```

The control-plane schema also retains the following legacy capability records.
They are not a runnable guest configuration for the current host. Use empty
`kv`, `durableObjects`, `secrets`, and `services` arrays for standard HTTP deployment.
The standalone celld binding is configured separately through `runtime.durable`.

```json
{
  "kv": [{ "binding": "MAIN", "namespaceId": "kv_main" }],
  "durableObjects": [{ "binding": "ROOMS", "namespaceId": "do_rooms" }],
  "services": [{ "binding": "AUTH", "targetProjectId": "prj_auth", "url": "https://auth.internal/" }]
}
```

Routes can point at one immutable deployment or at weighted rollout targets:

```json
{
  "projectId": "prj_hello",
  "host": "hello.example.dev",
  "pathPrefix": "/",
  "targets": [
    { "deploymentId": "dep_stable", "weight": 90 },
    { "deploymentId": "dep_canary", "weight": 10 }
  ]
}
```
