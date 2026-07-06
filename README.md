# wasmplane

`wasmplane` is an early control plane for a WIT-defined Wasm hosting platform.
The MVP follows the design memo in `/Users/mz/Downloads/wasi-edge-worker-platform-design.md`:

- WIT is the platform contract.
- Deployments are immutable.
- Routes are mutable pointers to deployments, so rollback is a pointer update.
- The initial runtime backend is Wasmtime with WASIp3.
- Deployments and route snapshots track the WIT worker world version explicitly as `worldVersion`.
- Workers do not receive arbitrary filesystem, socket, process, or env access.
- Request hot paths should consume compact route snapshots, not query the product DB.

## Run

```sh
just test
just release-check
just coverage
pnpm start
just runtime
pnpm wasmplane deploy --project-id prj_hello --component ./worker.component.wasm --host hello.example.dev
just bench
just e2e
```

`just coverage` runs Node's test-runner coverage and Rust coverage through
`rustup run stable cargo llvm-cov --workspace --summary-only`. Use `just node-coverage` or
`just rust-coverage` to collect one side only.

The control plane listens on `http://127.0.0.1:8787` by default and stores state in
`wasmplane.sqlite`. Set `WASMPLANE_DB`, `HOST`, or `PORT` to override this. For production, set
`DATABASE_URL` or `WASMPLANE_DATABASE_URL` to use the async Postgres repository instead of SQLite.
`WASMPLANE_POSTGRES_SSL=1` forces TLS, while `sslmode=require` in the URL also enables TLS.
Startup applies known migrations and logs the current/latest schema version. Run
`just db-migrate-check` in CI or before rollout, and `just db-migrate-apply` when applying schema
outside the app startup path. `just pg-migrate` is kept as a Postgres-compatible alias.
Before production changes, take a custom-format backup with
`just pg-backup backups/wasmplane.dump`; rollback is restore-first:
stop writers, run `just pg-restore backups/wasmplane.dump`, then redeploy the previous app image.
Set
`WASMPLANE_RUNTIME_NODES` to a comma-separated list of static runtime node base URLs, or register
runtime nodes through `POST /runtime-nodes`, when using `POST /snapshots/routes/publish`.
Set `WASMPLANE_API_TOKEN` to require `Authorization: Bearer <token>` on all control-plane API
endpoints except `GET /healthz`; this legacy token has all scopes. For scoped tokens, set
`WASMPLANE_API_TOKENS` as semicolon-separated `token=scope,scope` entries, for example
`reader=read;publisher=publish,read;writer=write,read`. Supported scopes are `read`, `write`,
`publish`, and `*`. Once a bootstrap token is configured, project-scoped API keys stored in the
control-plane repository can also authenticate requests; API key values are returned only at creation
time, while the repository stores a SHA-256 token hash. Set `WASMPLANE_AUDIT_LOG=/data/audit.jsonl`
to append authenticated mutation audit events as JSONL.
Set `WASMPLANE_RUNTIME_TOKEN` on the control plane to sign route snapshot publishes sent to runtime
nodes.
Set `WASMPLANE_RUNTIME_IDENTITY_KEYS` on the control plane and runtime nodes as a comma-separated
keyring such as `rt-key=secret,old-key=old-secret`. Runtime nodes advertise their active key with
`WASMPLANE_RUNTIME_IDENTITY_KEY_ID=rt-key`, and can also advertise a pinned transport certificate
fingerprint through `WASMPLANE_RUNTIME_IDENTITY_CERT_SHA256=<sha256>`. When a registered runtime
node has an identity key id and the control plane has the matching secret, snapshot publishes to
`PUT /__runtime/snapshots/routes` include an HMAC proof-of-possession signature in addition to the
optional bearer token.
Set `WASMPLANE_QUOTA_MAX_ARTIFACTS`, `WASMPLANE_QUOTA_MAX_DEPLOYMENTS`,
`WASMPLANE_QUOTA_MAX_ROUTES`, `WASMPLANE_QUOTA_MAX_SECRETS`, and
`WASMPLANE_QUOTA_MAX_KV_NAMESPACES`, and `WASMPLANE_QUOTA_MAX_DURABLE_OBJECT_NAMESPACES` to
enforce per-project resource quotas before writes are
accepted.
Set `WASMPLANE_ENFORCEMENT_CPU_MS_LIMITS`,
`WASMPLANE_ENFORCEMENT_MEMORY_MB_MS_LIMITS`, `WASMPLANE_ENFORCEMENT_STORAGE_BYTES_LIMITS`,
`WASMPLANE_ENFORCEMENT_CONCURRENCY_LIMITS`, and `WASMPLANE_ENFORCEMENT_RATE_LIMITS` to expose
per-project enforcement reports from usage ledgers. Values are comma-separated `project=value`
pairs; rate limits use `project=rps` or `project=rps:burst`.
Set `WASMPLANE_USAGE_QUOTA_INVOCATION_LIMITS`, `WASMPLANE_USAGE_QUOTA_CPU_MS_LIMITS`,
`WASMPLANE_USAGE_QUOTA_WALL_MS_LIMITS`, `WASMPLANE_USAGE_QUOTA_MEMORY_MB_MS_LIMITS`,
`WASMPLANE_USAGE_QUOTA_EGRESS_BYTES_LIMITS`, `WASMPLANE_USAGE_QUOTA_STORAGE_BYTES_LIMITS`, and
`WASMPLANE_USAGE_QUOTA_SQLITE_UNIT_LIMITS` to enforce calendar-month billing quotas from usage
ledgers before accepting new usage events. Values are comma-separated `project=value` pairs.
Usage event ids are idempotency keys: retrying the same event payload with the same id returns the
existing event without incrementing ledger totals, while reusing an id for different payloads is a
conflict.
Set `WASMPLANE_BILLING_INVOCATION_PER_MILLION_USD`,
`WASMPLANE_BILLING_CPU_MS_PER_MILLION_USD`, `WASMPLANE_BILLING_WALL_MS_PER_MILLION_USD`,
`WASMPLANE_BILLING_MEMORY_MB_MS_PER_MILLION_USD`, `WASMPLANE_BILLING_EGRESS_GB_USD`,
`WASMPLANE_BILLING_STORAGE_GB_MONTH_USD`, and `WASMPLANE_BILLING_SQLITE_UNIT_USD` to expose
invoice-ready calendar-month usage statements from `GET /projects/:id/billing-statement` and
organization rollups from `GET /organizations/:id/billing-statement`.
Set `WASMPLANE_BILLING_MONTHLY_USD_LIMITS` to comma-separated `project=usd` entries to reject
usage events that would exceed a project's calendar-month spend budget. Current budget status is
available from `GET /projects/:id/billing-budget`.
Set `WASMPLANE_BILLING_RATE_CARD_VERSION` before issuing invoices so saved billing invoice
snapshots record the exact rate card version used for that period. Issue immutable organization
invoices with `POST /organizations/:id/billing-invoices`; the same organization/month returns the
existing saved invoice even if rates later change. Each saved invoice includes a `contentDigest`
over the invoice payload for audit comparisons. List saved invoices for an organization with
`GET /organizations/:id/billing-invoices`. Set `WASMPLANE_BILLING_EXPORT_SIGNATURE_KEY_ID` and
`WASMPLANE_BILLING_EXPORT_SIGNATURE_KEY_BASE64` or `WASMPLANE_BILLING_EXPORT_SIGNATURE_KEY` to
enable signed accounting export bundles from `GET /billing-invoices/:id/export`.
Set `WASMPLANE_BILLING_WEBHOOK_URL` to enqueue a durable `billing.invoice.issued` webhook outbox
record whenever an invoice is issued. Webhook POSTs include an `Idempotency-Key` header derived
from the invoice id and content digest. Set `WASMPLANE_BILLING_WEBHOOK_DELIVERY_INTERVAL_MS` to
run the delivery loop in-process; tune retry behavior with `WASMPLANE_BILLING_WEBHOOK_MAX_ATTEMPTS`
and `WASMPLANE_BILLING_WEBHOOK_RETRY_DELAY_MS`.
Credit notes and debit adjustments are stored as separate immutable records linked to an issued
invoice; they do not mutate the saved invoice payload, rate card, or `contentDigest`.
Retention and legal hold controls are stored as separate invoice policy records. Use
`PUT /billing-invoices/:id/retention-policy` to set `retainUntil` and optional legal hold metadata,
`GET /billing-invoices/:id/retention-policy` to audit it, and
`POST /billing-invoices/retention/prune` to delete only expired, non-held invoices for an
organization.
Set `WASMPLANE_BILLING_RETENTION_PRUNE_INTERVAL_MS` with
`WASMPLANE_BILLING_RETENTION_ORGANIZATIONS=org_a,org_b` to run the same retention prune loop
in-process on a schedule.
Set `WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS` to run a background publish job that periodically
generates the current route snapshot and publishes it to configured/registered active runtime
nodes. Each generated route snapshot includes a content-derived `snap_<hash>` id, and publish
history records that id for retry and audit correlation. Snapshot publishes retry retryable target
failures by default; tune this with `WASMPLANE_SNAPSHOT_PUBLISH_MAX_ATTEMPTS`,
`WASMPLANE_SNAPSHOT_PUBLISH_RETRY_DELAY_MS`, and `WASMPLANE_SNAPSHOT_PUBLISH_TIMEOUT_MS`.
Set `WASMPLANE_ROUTE_SNAPSHOT_REPLICAS` to comma-separated `region=https://control-plane` entries
to replicate each published route snapshot to regional control-plane replicas through
`PUT /replication/snapshots/routes`. Use `WASMPLANE_ROUTE_SNAPSHOT_REPLICA_TOKEN` for the replica
bearer token and `WASMPLANE_CONTROL_REGION` to label the source region. Replication responses are
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
Local artifact ingestion stores bytes in `.wasmplane/artifacts` by default; set
`WASMPLANE_ARTIFACT_DIR` to override it. Local artifact ingestion validates components through
`wasmplane-wasip3-host` by default; set `WASMPLANE_VALIDATE_LOCAL_ARTIFACTS=0` to disable that
for development.
For production artifact storage, configure an S3-compatible bucket:

```sh
export WASMPLANE_ARTIFACT_STORE=s3
export WASMPLANE_ARTIFACT_BUCKET=wasmplane-artifacts
export WASMPLANE_ARTIFACT_PREFIX=workers
export WASMPLANE_ARTIFACT_REGION=auto
export WASMPLANE_ARTIFACT_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export WASMPLANE_ARTIFACT_ACCESS_KEY_ID=...
export WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY=...
export WASMPLANE_ARTIFACT_PUBLIC_BASE_URL=https://cdn.example.com/artifacts
```

If `WASMPLANE_ARTIFACT_PUBLIC_BASE_URL` is omitted for S3/R2, artifact locations are recorded as
`s3://<bucket>/<key>`. Runtime nodes materialize `file://`, `http://`, `https://`, private
`s3://`, and `oci://` artifacts. Private S3/R2 runtime fetches use SigV4 GET with the same
`WASMPLANE_ARTIFACT_*` or `AWS_*` credentials; if `WASMPLANE_ARTIFACT_BUCKET` is set, runtime
nodes reject `s3://` artifacts from other buckets.

OCI locations may point at a tag (`oci://registry.example.com/team/worker:v1`) or directly at the
artifact blob digest (`oci://registry.example.com/team/worker@sha256:<digest>`). For tag references,
runtime nodes fetch the OCI manifest and require a layer digest that exactly matches the control
plane artifact digest before downloading the blob. Configure private registry auth with either a
single registry:

```sh
export WASMPLANE_OCI_REGISTRY=registry.example.com
export WASMPLANE_OCI_REGISTRY_TOKEN=...
# or:
export WASMPLANE_OCI_REGISTRY_USERNAME=...
export WASMPLANE_OCI_REGISTRY_PASSWORD=...
```

or multiple registries through `WASMPLANE_OCI_REGISTRIES_JSON`. Each entry can include `scheme`,
`bearerToken`, `username`, and `password`; `scheme: "http"` is useful for local registry tests.

The runtime node listens on `http://127.0.0.1:8788` by default. Set `RUNTIME_HOST`,
`RUNTIME_PORT`, `WASMPLANE_CACHE_DIR`, or `WASMPLANE_ARTIFACT_CACHE_DIR` to override this.
Set `CONTROL_PLANE_URL` or `WASMPLANE_CONTROL_PLANE_URL` to make the runtime register itself and
send heartbeat updates.
`RUNTIME_PUBLIC_URL`, `RUNTIME_NODE_ID`, `RUNTIME_CONCURRENCY`, `RUNTIME_MEMORY_MB`, and
`RUNTIME_HEARTBEAT_INTERVAL_MS` tune the heartbeat payload. `RUNTIME_REGION` or `FLY_REGION` records
node placement region, and `RUNTIME_LABELS` accepts comma-separated `key=value` labels such as
`pool=default,tier=edge`. Heartbeats include current active worker request load so the control plane
can skip saturated nodes when publishing snapshots. Runtime secret values are loaded from environment
variables named `WASMPLANE_SECRET_<secretId>` or `WASMPLANE_SECRET_<NORMALIZED_ID>` by default. Set
`WASMPLANE_SECRET_DB` to a control-plane SQLite database path to resolve values from the local secret
registry instead. If the control plane stores encrypted secret envelopes, set the same secret KMS
keyring settings on the runtime so repository secret values can be decrypted before worker
invocation. Route snapshots only carry `secretId`, never the secret value.
To isolate noisy tenants, label dedicated runtime nodes with an isolation pool such as
`RUNTIME_LABELS=pool=isolation`, then set
`WASMPLANE_ISOLATION_POOL_PROJECTS=projectId=isolation` on the control plane. The publisher sends
filtered per-node route snapshots so isolated project routes are removed from default-pool nodes and
published only to matching isolation-pool nodes. Set `WASMPLANE_DRAINED_PROJECTS` to comma-separated
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
Set `WASMPLANE_RUNTIME_CACHE_MAX_BYTES` and/or `WASMPLANE_RUNTIME_CACHE_MAX_AGE_MS` to enable
runtime cache retention. `POST /__runtime/cache/gc` scans `WASMPLANE_ARTIFACT_CACHE_DIR` and
`WASMPLANE_CACHE_DIR`, removes files older than the age limit, then removes the oldest remaining
files until each cache directory is below the byte limit. Artifact and `.cwasm` paths for currently
prepared deployments are protected from deletion. Set `WASMPLANE_RUNTIME_CACHE_GC_INTERVAL_MS` to
run the same cache GC periodically in the runtime node.
Runtime nodes include Wasmtime host metadata and an engine variant hash in registration/heartbeat.
The `.cwasm` cache key includes that variant, and `POST /__runtime/cache/invalidate-cwasm` removes
precompiled files from older variants while keeping currently prepared components. Set
`WASMPLANE_WASIP3_HOST_VERSION` during host binary upgrades when you want an explicit version label
in the runtime registry and Admin UI.
Use `GET /__runtime/healthz` for process liveness and `GET /__runtime/readyz` for load-balancer
readiness. Readiness returns `503` until a route snapshot has been loaded, while the local lifecycle
state is `draining`, or when configured host-daemon stats are unavailable. Operators can take a node
out of service locally with `POST /__runtime/drain` and restore readiness with
`POST /__runtime/activate`; both management calls honor `WASMPLANE_RUNTIME_TOKEN` when it is set.
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
Set `WASMPLANE_KV_STORE_DIR` to choose the host-side persistent KV directory; the default is
`.wasmplane/kv`.
Set `WASMPLANE_WASIP3_HOST_DAEMON=1` to make the Node runtime start a local embedded Rust
Wasmtime daemon and invoke warmed `.cwasm` components over `POST /invoke` instead of spawning
`wasmplane-wasip3-host invoke` for every worker request. The daemon keeps a shared Wasmtime
`Engine` and LRU-bounded prepared component cache inside one process. Use
`WASMPLANE_WASIP3_HOST_MAX_PREPARED_COMPONENTS` to cap prepared components; the default is 256.
Use `WASMPLANE_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS` to cap in-flight host invocations before
Wasmtime instantiation; the default is 128. The daemon also exposes `GET /stats` for compact JSON
pressure counters and `GET /metrics` for Prometheus-format host metrics.
`WASMPLANE_WASIP3_EXPERIMENTAL_INSTANCE_REUSE` sets the maximum idle Store/Instance reuse pool per
prepared component, but reuse is inactive unless the daemon also receives
`WASMPLANE_WASIP3_INSTANCE_REUSE_CONTRACT=stateless-v1` or `guest-reset-v1`. The `stateless-v1`
contract is an explicit workload-author promise for benchmarking and trusted stateless workers:
guest memory and globals are not reset by the component model. The stricter `guest-reset-v1`
contract requires a top-level component export named `wasmplane-reset` with type `func() -> ()`;
the daemon calls it after a successful `handle` call and only returns the instance to the idle pool
when reset succeeds. Stateful or untrusted workloads should use `guest-reset-v1` or keep the default
isolated-per-request instantiation path. Use `WASMPLANE_WASIP3_INSTANCE_REUSE_CONTRACT=disabled` or
omit it to force isolated instances even when the pool size env is present.
When the runtime is configured with `WASMPLANE_WASIP3_HOST_DAEMON=1` or
`WASMPLANE_WASIP3_HOST_DAEMON_URL`, `GET /__runtime/metrics` includes the daemon `/stats` payload
under `hostDaemon`.
Set `WASMPLANE_WASIP3_HOST_DAEMON_ROUTES=1` to publish accepted route snapshots into the daemon's
prepared route table. This keeps the Node runtime responsible for management endpoints, snapshot
validation, warmup, metrics, logs, and drains while worker HTTP traffic can be served directly by the
Rust daemon route table.
Set `WASMPLANE_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES` to enable Wasmtime's pooling allocator
for high-density instance allocation. `WASMPLANE_WASIP3_POOLING_MEMORY_MB` caps each pooled linear
memory slot, while `WASMPLANE_WASIP3_POOLING_TOTAL_CORE_INSTANCES`,
`WASMPLANE_WASIP3_POOLING_TOTAL_MEMORIES`, and `WASMPLANE_WASIP3_POOLING_TOTAL_TABLES` tune pool
capacity. Use `WASMPLANE_WASIP3_HOST_DAEMON_PORT` to change the local port, or set
`WASMPLANE_WASIP3_HOST_DAEMON_URL` to point at an already running host daemon. For local testing:

```sh
just host-daemon
WASMPLANE_WASIP3_HOST_DAEMON_URL=http://127.0.0.1:8790 just runtime
```

Set `WASMPLANE_CONTROL_PLANE_TOKEN` or `CONTROL_PLANE_TOKEN` on the runtime node when the control
plane requires bearer-token authentication for registration and heartbeat updates.
Set `WASMPLANE_RUNTIME_TOKEN` on the runtime node to require `Authorization: Bearer <token>` for
runtime management endpoints such as `PUT /__runtime/snapshots/routes`; `GET /__runtime/healthz`
remains unauthenticated.
Set `WASMPLANE_RUNTIME_IDENTITY_KEYS` on the runtime node to require signed route snapshot publishes.
The same keyring must be available to the control plane. Rotate keys online by first adding the new
key to both keyrings, then switching runtime nodes to the new
`WASMPLANE_RUNTIME_IDENTITY_KEY_ID`, waiting for heartbeat/registration to advertise it, and finally
removing the old key after all publishers and nodes have moved. For transport-level mTLS, terminate
TLS on the runtime edge or private network proxy and pin the certificate fingerprint with
`WASMPLANE_RUNTIME_IDENTITY_CERT_SHA256`; the built-in identity signature protects the application
request even when bearer tokens are also configured.
Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` to emit OTLP/HTTP JSON
trace spans for worker requests. `OTEL_SERVICE_NAME` defaults to `wasmplane-runtime`, and
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
export WASMPLANE_CONTROL_PLANE_TOKEN="$(openssl rand -hex 24)"
export WASMPLANE_RUNTIME_TOKEN="$(openssl rand -hex 24)"
export WASMPLANE_RUNTIME_IDENTITY_KEY_ID=rt-key
export WASMPLANE_RUNTIME_IDENTITY_SECRET="$(openssl rand -hex 32)"

fly apps create "$FLY_CONTROL_APP"
fly apps create "$FLY_RUNTIME_APP"
fly apps create "$FLY_COLLECTOR_APP"
just fly-create-volumes

fly secrets set -a "$FLY_CONTROL_APP" \
  WASMPLANE_API_TOKEN="$WASMPLANE_CONTROL_PLANE_TOKEN" \
  WASMPLANE_RUNTIME_TOKEN="$WASMPLANE_RUNTIME_TOKEN" \
  WASMPLANE_RUNTIME_IDENTITY_KEYS="$WASMPLANE_RUNTIME_IDENTITY_KEY_ID=$WASMPLANE_RUNTIME_IDENTITY_SECRET"

fly secrets set -a "$FLY_RUNTIME_APP" \
  CONTROL_PLANE_URL="https://$FLY_CONTROL_APP.fly.dev" \
  RUNTIME_PUBLIC_URL="auto" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://$FLY_COLLECTOR_APP.internal:4318" \
  WASMPLANE_CONTROL_PLANE_TOKEN="$WASMPLANE_CONTROL_PLANE_TOKEN" \
  WASMPLANE_RUNTIME_TOKEN="$WASMPLANE_RUNTIME_TOKEN" \
  WASMPLANE_RUNTIME_IDENTITY_KEY_ID="$WASMPLANE_RUNTIME_IDENTITY_KEY_ID" \
  WASMPLANE_RUNTIME_IDENTITY_KEYS="$WASMPLANE_RUNTIME_IDENTITY_KEY_ID=$WASMPLANE_RUNTIME_IDENTITY_SECRET"

just fly-deploy-collector
just fly-deploy-control
just fly-deploy-runtime
```

Check the deployed services:

```sh
just fly-status
just fly-smoke
just fly-smoke-rust-forward

curl -H "authorization: Bearer $WASMPLANE_CONTROL_PLANE_TOKEN" \
  "https://$FLY_CONTROL_APP.fly.dev/runtime-nodes"
curl "https://$FLY_RUNTIME_APP.fly.dev/__runtime/healthz"
curl "https://$FLY_COLLECTOR_APP.fly.dev/"
```

`just fly-smoke` checks public health endpoints, authenticated control-plane
`/autoscaling/signals` and `/snapshots/routes`, authenticated runtime `/__runtime/metrics`, and one
worker request using `WASMPLANE_SMOKE_WORKER_HOST`/`WASMPLANE_SMOKE_WORKER_PATH` defaulting to
`hello.example.dev` and `/`. Run `pnpm ops-smoke -- --skip-worker` when no route has been deployed
yet. `just fly-smoke-rust-forward` adds production posture checks plus a host daemon assertion that
runtime metrics include `hostDaemon.preparedRoutes > 0`.

The control app stores SQLite state and uploaded local artifacts on `/data`. For Fly, local uploads
are recorded as `https://<control-app>/artifacts/local/<digest>.wasm`, so the separate runtime app can
materialize them over HTTP. The runtime app stores `.cwasm`, artifact, and KV cache under `/data`.
For multiple runtime Machines, create one `wasmplane_runtime_data` volume per Machine region.
The control plane also includes a volume-backed high-density SQLite registry for Turso-style
file-per-project or file-per-tenant state. `createVolumeSqliteRegistry({ rootDir: "/data/sqlite" })`
stores a `catalog.sqlite` plus per-database files under `/data/sqlite/dbs`, applies WAL-oriented
SQLite pragmas, tracks schema version and ownership metadata, and uses an LRU `SqliteDatabasePool`
to cap open handles. This is intended for local-first project state on a single attached volume;
multi-machine writers still need a managed primary such as Postgres or Turso/libSQL. Set
`WASMPLANE_VOLUME_SQLITE_ROOT=/data/sqlite` to enable the registry in the control API, and tune the
open handle cap with `WASMPLANE_VOLUME_SQLITE_MAX_OPEN`. `writeDatabase()` provides a per-database
FIFO writer queue; `WASMPLANE_VOLUME_SQLITE_MAX_PENDING_WRITES` caps active plus queued writes per
database and rejects excess work with a conflict error instead of allowing unbounded request buildup.
Individual database files can be exported into `/data/sqlite/backups` with `VACUUM INTO` and
restored back into the registry without exposing arbitrary SQL execution. Backup retention can be
applied automatically with `WASMPLANE_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE` and
`WASMPLANE_VOLUME_SQLITE_BACKUP_RETENTION_MS`. Database directories are chmodded to `0700`, SQLite
database, WAL, SHM, and backup files are chmodded to `0600`, and backup/restore paths are constrained
under the registry root. Plain SQLite database files are not SQLCipher-encrypted by this layer; on Fly
they rely on the attached volume's platform encryption plus these local file permissions. Backup
files can be encrypted with AES-256-GCM by setting `WASMPLANE_VOLUME_SQLITE_BACKUP_KEY_BASE64` to a
32-byte base64 key. Set `WASMPLANE_VOLUME_SQLITE_BACKUP_KEY_ID` for the active key id, and keep old
decrypt-only keys in `WASMPLANE_VOLUME_SQLITE_BACKUP_KEYS_BASE64` as comma-separated
`keyId=base64` entries during rotation. The CLI uses the same environment, so encrypted backups can
be restored with `volume-sqlite restore` as long as the matching key id is configured.

A Durable Objects-style storage facade can be layered on the same registry when the application
wants object-local state rather than direct database-file lifecycle management:

```ts
import {
  createDurableObjectAlarmDispatcherJob,
  createDurableObjectStorageNamespace,
  createVolumeSqliteRegistry,
} from "@mizchi/wasmplane";

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
For the packaged control-plane process, set `WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS`,
`WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES`, and `WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL` to
poll due alarms from the volume SQLite registry and POST them to an application webhook. Optional
settings are `WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN`,
`WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TIMEOUT_MS`, and `WASMPLANE_DURABLE_OBJECT_ALARM_LIMIT`.
Idle alarm polling ticks are not logged by default; set
`WASMPLANE_DURABLE_OBJECT_ALARM_LOG_IDLE_TICKS=1` when diagnosing scheduler liveness.
The Fly control-plane config enables an `alarm-demo` app backed by the same durable object registry:
`POST /alarm-demo/schedules` schedules an object-local alarm, the dispatcher POSTs
`/alarm-demo/webhook`, and `GET /alarm-demo/objects/:name` reports `alarmCount`, `alarmAt`, and the
last fired timestamp. Set the shared webhook secret before deploying:

```sh
fly secrets set -a "$FLY_CONTROL_APP" \
  WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN="$(openssl rand -hex 24)"
just fly-deploy-control
WASMPLANE_CONTROL_PLANE_TOKEN="$WASMPLANE_CONTROL_PLANE_TOKEN" just fly-alarm-demo
```

Set `WASMPLANE_VOLUME_SQLITE_BACKUP_INTERVAL_MS` on the control plane to run scheduled backups for
all cataloged volume SQLite databases. Scheduled backups require encryption by default; set
`WASMPLANE_VOLUME_SQLITE_BACKUP_REQUIRE_ENCRYPTION=0` only for local development. Enable
`WASMPLANE_VOLUME_SQLITE_BACKUP_RESTORE_DRILL=1` to copy each new backup into a temporary SQLite
file, decrypting it when needed, and run `pragma quick_check` plus schema-version inspection before
retention deletes older backups. Retention can also be applied manually with `volume-sqlite gc`:

```sh
pnpm wasmplane volume-sqlite backup --root /data/sqlite --id prj_example --backup-id before-migration
pnpm wasmplane volume-sqlite restore --root /data/sqlite --id prj_example --backup-id before-migration
pnpm wasmplane volume-sqlite gc --root /data/sqlite --id prj_example --keep-latest 24 --older-than-ms 604800000
```

To move the control plane state to managed Postgres, create a Postgres database and set
`DATABASE_URL` on the control app. To remove the control app volume dependency, also set the
S3/R2 artifact store variables above so local uploads are persisted outside `/data`.
Set `WASMPLANE_REQUIRE_EXTERNAL_DATABASE=1` when a production control-plane process must refuse to
start on the fallback SQLite database. Set `WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE=1` to apply
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
`WASMPLANE_RUNTIME_NODE_ACTIVE_TTL_MS`, defaulting to 90 seconds.

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
  -H "authorization: Bearer $WASMPLANE_CONTROL_PLANE_TOKEN" \
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
current route snapshot, runs production smoke checks, measures HTTP throughput at the requested
concurrency levels, and performs a runtime drain/activate readiness drill. Machine restarts are
available only when explicit ids are supplied with `--restart-runtime-machine <id>` or
`--restart-control-machine <id>`. Volume SQLite backup drills require an explicit database id with
`--volume-sqlite-drill-id <id>`.

## Multi-cloud Deploy POC

Fly remains the most exercised deployment target, but the repository now includes first-pass
scaffolds for other clouds:

- AWS ECS/Fargate: `infra/terraform/aws`
- GCP Cloud Run: `infra/terraform/gcp`
- Cloudflare Containers control-plane POC: `cloudflare/containers-control`

The Terraform scaffolds expect externally managed secrets for `DATABASE_URL`, API tokens, runtime
tokens, and artifact-store credentials. They are intended as planable starting points, not hardened
production modules.

```sh
just tofu-fmt-check
just tofu-validate

just aws-terraform-plan
just gcp-terraform-plan

cd cloudflare/containers-control
pnpm install
pnpm wrangler login
pnpm dev
pnpm deploy

WASMPLANE_CLOUDFLARE_CONTROL_URL=https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev \
  WASMPLANE_CONTROL_PLANE_TOKEN=... \
  pnpm cloudflare-control-smoke -- \
    --json-output reports/cloudflare-control-smoke.json \
    --markdown-output reports/cloudflare-control-smoke.md
```

Latest deployed Cloudflare Containers smoke was run on July 3, 2026 UTC against
`https://wasmplane-control-container-poc.mizchi.workers.dev`. The initial smoke completed in
2958ms with container health at 1439ms, control-plane writes, generated edge-worker release
manifest/list, and release delete all returning success. The sleep/wakeup run waited about 11
minutes, then returned container health in 58ms and post-wakeup health in 135ms while preserving the
generated release record. Raw JSON/Markdown reports are written under `reports/` and ignored by Git;
keep only this summary in the repository unless a report is intentionally promoted to a release
artifact.

AWS is closest to the current Fly shape: ECS/Fargate runs separate control-plane and runtime
services behind an ALB, with S3 for artifacts. GCP Cloud Run can run the same containers, but it
does not expose stable per-instance runtime addresses, so the scaffold uses a single runtime service
URL as a POC. Use GKE/EKS when direct runtime-node publication, warmup, and drain need to match Fly
Machines. Cloudflare Containers can boot the existing control-plane Docker image behind a Worker,
but container disk is ephemeral; production would need external Postgres plus R2/S3-compatible
artifact storage.

The control plane can also generate Cloudflare Worker release records for an existing wasm
deployment. `POST /edge-workers/releases` renders a module-worker stub with a
`/__wasmplane/manifest` endpoint and persists the provider result in the configured SQLite or
Postgres control-plane repository. By default this uses the mock deployer, so it has no provider
side effects. Set
`WASMPLANE_EDGE_WORKER_DEPLOYER=cloudflare-api` with `WASMPLANE_CLOUDFLARE_ACCOUNT_ID` and
`WASMPLANE_CLOUDFLARE_API_TOKEN` to upload the generated script through the Cloudflare Workers
script API. Requests that create `mode: "api"` releases require the `publish` API scope and are
written to the audit sink when API auth and audit logging are enabled. Release details are available
from `GET /edge-workers/releases/:id`, and `DELETE /edge-workers/releases/:id?provider=1&force=1`
soft-deletes the control-plane record after deleting the provider-side Worker script. This POC keeps
WASIp3 execution delegated to Wasmtime runtime nodes; the generated Worker is control-plane-owned
metadata, not an embedded runtime. If provider-side deletion fails, the release is marked `failed`
and a retryable operation is stored. Operators can inspect
`GET /edge-workers/releases/:id/operations` and retry pending work with
`POST /edge-workers/releases/operations/deliver`.

The runtime supervisor code currently prepares deployments by resolving a route snapshot,
materializing `file://`, `http://`, `https://`, or private `s3://` artifacts, verifying their
`sha256` digest, validating the component through the Rust `wasmplane-wasip3-host` linker, and
precompiling through that same host binary. Runtime invocation uses the generated `.cwasm` artifact
so cold invokes skip Cranelift compilation. `.cwasm` files are trusted node-local cache entries
tied to the host binary, Wasmtime version/configuration, and target machine; they are not portable
user artifacts. The runtime separates `.cwasm` entries by engine variant and can invalidate older
variants through the runtime management endpoint. Remote HTTP(S) and S3 artifacts are cached under
`WASMPLANE_ARTIFACT_CACHE_DIR`.
Strict `wasm-tools component targets` validation is available as an opt-in backend setting, but it
is not the default because WASI-adapted Rust components include additional WASI imports that the
host linker satisfies.

Runtime invocation enforces the route snapshot contract before calling guest code. The runtime node
rejects privileged capabilities (`arbitraryFilesystem`, `arbitrarySockets`, `processSpawn`) and
passes denied-by-default capability policy to the Rust host. The Rust host applies Wasmtime memory
limits, wall-clock and `cpuMs` interruption through Wasmtime epoch deadlines, request and response
byte limits, KV namespace allowlists, Durable Object namespace allowlists, outbound HTTP
allowlists, service binding allowlists, host API call counters, and subrequest counters. `cpuMs` uses epoch-tick compute budgeting rather than kernel CPU-time
accounting; CPU budget exits are reported as `503 cpu_limit`, while wall-clock exits remain
`504 timeout`.
Guest components resolve configured capability bindings through WIT handles: `kv.open-namespace`
maps a binding name such as `MAIN` to its physical namespace, and `secrets.open-secret` returns a
secret handle whose `reveal` operation is backed by host-loaded secret values. Secret values are
redacted from host logs. KV `get`/`put`/`delete` operations are backed by a host-side persistent
store when `--kv-store-dir`/`WASMPLANE_KV_STORE_DIR` is configured, including TTL expiry.
`durable.open-object(binding, name)` opens object-local storage under a configured
`durableObjects` binding. Its `get`/`put`/`delete` operations use the same host-side persistent
store today, scoped by namespace and object name, so it provides a Durable Objects-style API surface
for Wasm workers while the SQLite-backed Node facade remains available for control-plane code.
Worker-to-worker calls use `service.fetch(binding, req)`. The Rust host resolves only configured
`services` bindings, rejects unknown bindings with 403, and treats outbound HTTP allowlists as a
separate capability from service access.
The control plane stores local secret values through `POST /secrets`, but all public API responses
return only secret metadata. Set `WASMPLANE_SECRET_KMS_KEY_BASE64` to a 32-byte base64 key to store
secret values as `wasmplane:v1:aes-256-gcm:*` envelopes before repository persistence. For local
development and Fly trials, `WASMPLANE_SECRET_KMS_KEY` is accepted as a passphrase-style key and is
derived with SHA-256; prefer the base64 key form for production. `WASMPLANE_SECRET_KMS_KEY_ID` is
recorded in the envelope and selects the primary encryption key. During online rotation, keep old
decrypt keys in `WASMPLANE_SECRET_KMS_KEYS_BASE64` as comma-separated `keyId=base64` entries until
all stored envelopes have been rewritten with the new primary key. For external KMS integrations,
set `WASMPLANE_SECRET_KMS_KEY_PROVIDER_COMMAND` to an executable that prints JSON such as
`{"primaryKeyId":"kid2","keys":[{"keyId":"kid1","keyBase64":"..."},{"keyId":"kid2","keyBase64":"..."}]}`.
`WASMPLANE_SECRET_KMS_KEY_PROVIDER_ARGS` may contain a JSON string array of command arguments.
For cloud KMS, set `WASMPLANE_SECRET_KMS_PROVIDER` to `aws`, `gcp`, or `azure`. For AWS KMS, set
`WASMPLANE_SECRET_KMS_AWS_REGION`,
`WASMPLANE_SECRET_KMS_KEY_ID`, and `WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS` to JSON such as
`{"keys":[{"keyId":"kid2","ciphertextBase64":"...","kmsKeyId":"arn:aws:kms:...","encryptionContext":{"service":"wasmplane"}}]}`.
The AWS adapter calls KMS `Decrypt` during process startup, then uses the unwrapped 32-byte data
keys as the in-memory AES-GCM keyring. AWS credentials are read from `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`; `WASMPLANE_SECRET_KMS_AWS_ENDPOINT` can
point at a KMS-compatible local endpoint.
For GCP Cloud KMS, set `WASMPLANE_SECRET_KMS_GCP_ACCESS_TOKEN` and
`WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS` with `cryptoKeyName` values such as
`projects/p/locations/global/keyRings/r/cryptoKeys/k`. For Azure Key Vault, set
`WASMPLANE_SECRET_KMS_AZURE_ACCESS_TOKEN` and `WASMPLANE_SECRET_KMS_AZURE_WRAPPED_KEYS` with
`vaultUrl`, `keyName`, `keyVersion`, and `algorithm` values such as `RSA-OAEP-256`.
Configure the same keyring or provider on runtime nodes when they read `WASMPLANE_SECRET_DB`.
KV namespaces are also registered in the control plane. Deployments can only reference registered
secrets and KV namespaces owned by the same project.
Outbound requests go through the host `outbound.fetch` proxy and are checked against the deployment
allowlist and subrequest limit. The host proxy supports `http://` and `https://` upstreams, with
system trust roots used for TLS verification. Outbound allowlists are matched by URL scheme, host,
port, and path prefix rather than raw string prefix, and hostname targets that resolve to
private/loopback/link-local addresses are rejected unless the allowlist uses an explicit IP literal
for local development. Redirects are followed up to five hops, with each target rechecked against
the allowlist; HTTPS-to-HTTP redirect downgrades are rejected.

The real guest example can be rebuilt and invoked through the Rust Wasmtime host:

```sh
just guest-invoke
```

`guest-build` uses a WASI preview1 reactor adapter when turning the Rust guest's
`wasm32-wasip1` core module into a component. The default adapter comes from the
`@bytecodealliance/jco` dev dependency, so `just e2e` works on a fresh checkout after `pnpm
install --frozen-lockfile`. Override `WASI_PREVIEW1_ADAPTER` to use a different adapter.

## Benchmarks

The benchmark harness measures three paths:

- `host`: direct `wasmplane-wasip3-host invoke` throughput for both raw component loading
  (`host.invoke.component`) and precompiled `.cwasm` loading (`host.invoke.cwasm`), including
  process startup and instantiation for each invocation.
- `cold`: runtime supervisor prepare latency, covering artifact materialization and Rust-host
  precompile on a cold cache, plus warm cache lookup.
- `http`: throughput against an already running runtime node HTTP endpoint.

Build the example component and run the default host/cold benchmarks:

```sh
just bench
```

Run specific benchmark modes:

```sh
pnpm bench host \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host-bin target/debug/wasmplane-wasip3-host \
  --iterations 100 \
  --concurrency 1,4,16

pnpm bench cold \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host-bin target/debug/wasmplane-wasip3-host \
  --format json

pnpm bench http \
  --runtime-url http://127.0.0.1:8788 \
  --host hello.example.dev \
  --path / \
  --iterations 1000 \
  --concurrency 1,8,32
```

The output includes per-run throughput, average latency, p50/p95/p99 latency, and errors. Compare
`host.invoke.component` with `host.invoke.cwasm` to isolate the benefit of skipping Cranelift
compilation on each host process start. Use `--format json` or `--output bench.json` for
machine-readable result capture.

To measure the experimental Rust-forward runtime path, run:

```sh
just rust-daemon-bench

pnpm rust-daemon-bench \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host-bin target/debug/wasmplane-wasip3-host \
  --iterations 1000 \
  --concurrency 1,8,32,64 \
  --pooling-total-component-instances 64 \
  --pooling-memory-mb 64
```

`rust-daemon-bench` precompiles the component, starts `wasmplane-wasip3-host serve`, publishes a
prepared route table to `PUT /routes`, then sends worker HTTP traffic directly to the Rust daemon.
This bypasses the Node runtime's request routing and supervisor path while still using the same
WASI p3 Wasmtime host. The daemon HTTP server is async HTTP/1.1 with keep-alive, so direct Rust
daemon results can be compared against the Node runtime shell without forcing per-request TCP
connection setup.
Pass `--baseline-url http://127.0.0.1:8788` to include an already-running Node runtime in the same
report.

Runtime nodes can publish accepted route snapshots into an embedded host daemon by setting
`WASMPLANE_WASIP3_HOST_DAEMON=1` and `WASMPLANE_WASIP3_HOST_DAEMON_ROUTES=1`. In that mode the Node
runtime still accepts `PUT /__runtime/snapshots/routes`, warms the snapshot to produce `.cwasm`
artifacts, and forwards a prepared route table to the daemon's `PUT /routes` endpoint. The daemon
route table carries weighted targets, so canary route snapshots use the same deterministic
host/path target selection as the Node runtime supervisor.
Set `WASMPLANE_WASIP3_HOST_DAEMON_WORKER_PROXY=1` to dogfood the Rust-forward worker path in the
Node runtime: after Node performs lifecycle, route match, rate, concurrency, request-byte, and
capability checks, the guest HTTP request is proxied to the daemon route endpoint instead of the
JSON `/invoke` endpoint. Node reserves the daemon management paths (`/healthz`, `/stats`,
`/metrics`, `/routes`, `/invoke`) for the legacy invoker path so worker routes cannot expose host
daemon internals by path collision.

Volume-backed SQLite density can be measured separately:

```sh
just volume-sqlite-bench

pnpm volume-sqlite-bench \
  --root .wasmplane/volume-sqlite-bench \
  --databases 1000 \
  --max-open 64 \
  --max-pending-writes 64 \
  --schema-version 1 \
  --write-iterations 1000 \
  --write-concurrency 1,4,16 \
  --format json
```

The report includes database creation density, LRU open-handle cap behavior, schema-version
migration time, per-database writer admission settings, and write-contention throughput/latency.
To run the same probe on the Fly control volume, use `just fly-volume-sqlite-bench`.

## Cost Estimate

Run the built-in estimator for the current single-region production shape:

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
about `$241.84/month`. Prices are intentionally data constants in `src/cost-estimator.ts` so they
can be updated when provider pricing changes.

The Cloudflare Containers estimate models the current control-plane POC as 1 x `lite` container
behind a Worker and Durable Object. Smoke-test scale stays at the Workers Paid plan floor of about
`$5.00/month`. If the `lite` container is kept effectively always-on for 720 hours/month at 20%
average CPU while active, the estimate is about `$6.91/month` before external Postgres/R2 usage.
Scaling that shape to many concurrently active container instances adds Durable Object duration,
logs, request, and egress overages.

Cluster emulation starts multiple in-process runtime nodes, publishes route snapshots to every node,
switches from a blue deployment to a green deployment, waits until each node returns the new
`x-wasmplane-deployment`, and then runs aggregate HTTP throughput against the warmed green
deployment:

```sh
just cluster-bench

# In another terminal, run `just host-daemon` first.
just cluster-bench-daemon

pnpm cluster-bench \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host-bin target/debug/wasmplane-wasip3-host \
  --nodes 1,2,4 \
  --iterations 100 \
  --concurrency 1,8,32 \
  --placement \
  --format json
```

`cluster.switch.cold` reports snapshot publish acknowledgement latency separately from the
post-publish visibility latency. The visibility latency includes the first green request on each
node, so it includes lazy materialization and `.cwasm` precompile for that deployment. The
`cluster.http.cwasm` rows report aggregate worker HTTP throughput across the emulated runtime nodes.
With `--placement`, `cluster.placement.region` publishes a new deployment only to the emulated `nrt`
region nodes and verifies that skipped-region nodes keep serving the previous deployment.
Placement rules can define ordered `failover` tiers. A failover tier is used only when the primary
region/label rule has no active publish targets, so healthy primary regions are not widened
unnecessarily.
With `--autoscaling`, the report also includes `cluster.autoscale.scale_up_warm` and
`cluster.autoscale.scale_down_exclude` rows for new-node warmup and target exclusion timing.
Pass `--host-daemon-url` to use the embedded Wasmtime daemon instead of spawning the host CLI for
every request. When the daemon uses Wasmtime pooling, pass the same `--pooling-*` flags to
`pnpm cluster-bench` so benchmark-generated `.cwasm` files are compiled with the same Engine
settings.

CI runs `just test` and `just e2e` on GitHub Actions. The workflow installs Node 24, Rust stable,
`wasm32-wasip1`, `wasm-tools 1.245.1`, and `wit-bindgen-cli 0.51.0`.
Weekly performance regression runs are configured in `.github/workflows/perf.yml` and can be
reproduced locally with `just perf-regression`. The job writes `perf-results/bench.json`,
`perf-results/cluster-bench.json`, and `perf-results/perf-regression.md`, then checks them against
`perf/budgets.json`. The budget file supports fixed ceilings/floors and optional historical median
trend thresholds. Set `WASMPLANE_PERF_HISTORY` to a previous benchmark or cluster benchmark JSON
file to compare the current run against historical p95/avg latency, throughput, and rollout timing.
Tune `WASMPLANE_PERF_ITERATIONS`, `WASMPLANE_PERF_WARMUP`, `WASMPLANE_PERF_CONCURRENCY`, and
`WASMPLANE_PERF_NODES` to widen or shorten the weekly run.

SQLite and Postgres schema upgrades are tracked in `schema_migrations`; repository initialization
applies missing migrations before serving requests, then verifies the current schema version against
the compiled migration catalog. `pnpm wasmplane migrate check` exits non-zero when migrations are
pending or when the database is ahead of the running binary; `pnpm wasmplane migrate apply` applies
the configured database migrations and prints the resulting status JSON.

Runtime node endpoints:

- `GET /__runtime/healthz`
- `GET /__runtime/metrics`
- `GET /__runtime/events`
- `GET /__runtime/logs`
- `GET /__runtime/traces`
- `POST /__runtime/cache/gc`
- `PUT /__runtime/snapshots/routes`
- any other path: resolve by `x-forwarded-host` or `host`, prepare the component, then invoke it
  through `wasmplane-wasip3-host`.

`GET /__runtime/metrics` exposes in-memory counters for worker requests, route matches/misses,
invocations, active/rejected invocation concurrency, response status codes, runtime error codes,
and loaded route snapshots. Add `projectId` or `deploymentId` query parameters to return scoped
metrics for a single project or deployment. `GET /__runtime/events` returns a bounded in-memory list
of structured worker request events with request id, host/path, project/deployment, status,
duration, and error code, and accepts the same scope filters. `GET /__runtime/traces` returns recent
trace contexts for worker requests that carried `traceparent`, also filterable by project or
deployment. Worker responses include `x-wasmplane-request-id`.

Worker logs can be retained locally through `GET /__runtime/logs?projectId=...&deploymentId=...`
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
pnpm wasmplane deploy \
  --control-plane-url http://127.0.0.1:8787 \
  --token "$WASMPLANE_CONTROL_PLANE_TOKEN" \
  --project-id prj_hello \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host hello.example.dev \
  --path-prefix / \
  --kv MAIN=kv_main \
  --secret API_KEY=sec_api_key \
  --service AUTH=prj_auth@https://auth.internal/ \
  --outbound https://api.example.dev/
```

The command uploads bytes through `POST /artifacts/local`, creates an immutable deployment, points
the route, then publishes a route snapshot unless `--no-publish` is passed. Limit overrides use
`--limit name=value`, for example `--limit wallMs=2500 --limit cpuMs=100`. The CLI also reads
`WASMPLANE_CONTROL_PLANE_TOKEN` when `--token` is omitted. Pass `--diff` to fetch the current route
snapshot before deploying and include JSON diff output for the route pointer, rollout targets,
runtime version, limits, outbound allowlist, KV bindings, secret bindings, and service bindings.

Worker projects can be bootstrapped from the canonical WIT package with generated SDK helpers:

```sh
pnpm wasmplane new --language rust --name hello-worker --out workers/hello
pnpm wasmplane new --language typescript --name hello-worker-ts --out workers/hello-ts
```

The templates copy `wit/myedge-runtime.wit` to `wit/world.wit`, generate small helper modules
(`src/wasmplane.rs` or `src/wasmplane.ts`), and include build scripts for `wit-bindgen`/`wasm-tools`
or `jco componentize`.

## Rust and MoonBit WASI p3 interop

`examples/interop/wit/world.wit` defines a small Component Model contract shared by the Rust and
MoonBit examples:

```wit
package myedge:interop@0.1.0;

world probe-world {
  export ping: func(message: string) -> string;
}
```

Build both components and verify the Wasmtime call path with:

```sh
just interop-smoke
```

The smoke test builds `examples/rust-interop` with `wit-bindgen rust` and
`examples/moonbit-interop` with `wit-bindgen moonbit`, then invokes both components through
`wasmtime run --invoke`. This is the current MoonBit-to-Wasmtime ABI round-trip baseline. The full
`myedge:runtime/worker@0.1.0` world still stays Rust/TypeScript-only until MoonBit bindings handle
the async resource-heavy worker API cleanly.

For local development, run a control plane and runtime node, then use `dev` to validate the
component, create a deploy preview, publish the route snapshot directly to the local runtime, and
print a route-preview curl command:

```sh
pnpm start
pnpm runtime
pnpm wasmplane dev \
  --project-id prj_hello \
  --component examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm \
  --host dev.localhost \
  --env FEATURE_FLAG=on
```

`wasmplane dev` defaults to `http://127.0.0.1:8787` for the control plane and
`http://127.0.0.1:8788` for the runtime. It validates through `wasmplane-wasip3-host compile`
unless `--no-validate` is passed, publishes to `PUT /__runtime/snapshots/routes`, and reads
`GET /__runtime/logs?projectId=...&deploymentId=...` unless `--no-tail-logs` is passed.

## Rust + MoonBit release sample

`examples/rust-moonbit-release` contains a real deployable sample that composes two Component Model
projects into one wasmplane runtime worker:

- Rust `rust-worker` exports the HTTP `handle` function for `myedge:runtime/worker@0.1.0`
- MoonBit `moonbit-ping` exports `ping(value) -> value + 7`
- The build links MoonBit into the Rust worker so the deployed response proves the cross-language
  call path

Build and validate locally:

```sh
just sample-rust-moonbit-smoke
```

Release to the deployed Fly control/runtime pair:

```sh
WASMPLANE_CONTROL_PLANE_URL=https://mz-wasmplane-control.fly.dev \
WASMPLANE_RUNTIME_URL=https://mz-wasmplane-runtime.fly.dev \
WASMPLANE_CONTROL_PLANE_TOKEN=... \
just sample-rust-moonbit-release
```

The release recipe uploads `examples/rust-moonbit-release/target/rust-moonbit-release.component.wasm`,
publishes a route for `rust-moonbit.sample.wasmplane.local`, and checks the runtime response with a
`Host` header. A successful response contains `moonbit=42`.

## Rust + MoonBit CI policy

The default CI should keep the structural checks in `tests/project-files.test.ts` but the full build
smoke stays out of default CI for now because it requires MoonBit, `wit-bindgen`, `wasm-tools`, the
JCO WASI adapter, and a Rust wasm target. Run `just sample-rust-moonbit-smoke` locally or in a
release gate before publishing.

WAC 0.10.1 and the Component Model docs both point to `wac plug <socket> --plug <provider>` as the
replacement shape for linking the MoonBit provider into a Rust socket. Run
`just sample-rust-moonbit-wac-smoke` to prove that path with a synchronous Rust `wac-caller`
component and the existing MoonBit `bridge` provider. `just sample-rust-moonbit-wac-probe` keeps the
intended runtime worker migration command available.
Run `just sample-rust-moonbit-wac-status` to write `reports/wac-migration.md`; known WAC issue #180
blockers are reported as `blocked` instead of failing the tracking command. The report also includes
a static WIT summary for the runtime worker so the async/resource blocker remains visible even when
the command output changes.

The deployable runtime worker still defaults to deprecated `wasm-tools compose` because WAC currently
panics on this WASIp3 async/resource-heavy worker world. Keep the default build on `wasm-tools compose`
until [WAC upstream issue #180](https://github.com/bytecodealliance/wac/issues/180) lands enough
WASIp3 async support for this composition.

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

Available endpoints:

- `GET /admin`
- `POST /admin/routes/canary`
- `POST /admin/routes/rollback`
- `POST /organizations`
- `GET /organizations/:id/billing-statement`
- `GET /organizations/:id/billing-invoices`
- `POST /organizations/:id/billing-invoices`
- `GET /billing-invoices/:id`
- `GET /billing-invoices/:id/export`
- `GET /billing-invoices/:id/retention-policy`
- `PUT /billing-invoices/:id/retention-policy`
- `POST /billing-invoices/retention/prune`
- `POST /users`
- `POST /projects`
- `POST /projects/:id/memberships`
- `GET /projects/:id/memberships`
- `POST /api-keys`
- `GET /projects/:id/api-keys`
- `POST /usage/events`
- `GET /projects/:id/usage`
- `POST /custom-domains`
- `GET /projects/:id/custom-domains`
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
`WASMPLANE_ADMISSION_REQUIRE_ARTIFACT_SIGNATURE=1`, optionally restrict signature key ids with
`WASMPLANE_ADMISSION_ARTIFACT_SIGNATURE_KEY_IDS`, cap artifact metadata size with
`WASMPLANE_ADMISSION_MAX_ARTIFACT_SIZE_BYTES`, restrict WIT contracts with
`WASMPLANE_ADMISSION_ALLOWED_WORLDS` and `WASMPLANE_ADMISSION_ALLOWED_WORLD_VERSIONS`, and restrict
deployment capabilities with `WASMPLANE_ADMISSION_OUTBOUND_HTTP_PREFIXES`,
`WASMPLANE_ADMISSION_KV_NAMESPACE_IDS`, `WASMPLANE_ADMISSION_DURABLE_OBJECT_NAMESPACE_IDS`, and
`WASMPLANE_ADMISSION_SECRET_IDS`. Worker-to-worker service bindings can be restricted with
`WASMPLANE_ADMISSION_SERVICE_PROJECT_IDS` and `WASMPLANE_ADMISSION_SERVICE_URL_PREFIXES`.

Custom domains are registered before routing through `POST /custom-domains`. The response includes
a DNS TXT challenge under `_wasmplane-challenge.<host>`; submit observed TXT values to
`POST /custom-domains/:id/verify` to mark ownership verified. TLS provisioning is intentionally a
hook for Fly/ACME/provider automation: `POST /custom-domains/:id/tls` records an external
provisioning request, and `POST /custom-domains/:id/tls/complete` records success or failure. Once
the domain is active, routes for that host can be pointed by the owning project; registered domains
cannot be claimed by another project.

Deploy previews create temporary route pointers with preview URLs. If `host` is omitted, the
control plane derives a DNS-safe `*.preview.wasmplane.local` host from the project/deployment ids.
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

Deployment capability bindings reference only the secret id:

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

Deployment KV capability bindings reference the registered namespace id:

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
