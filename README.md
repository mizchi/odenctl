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
pnpm start
just runtime
pnpm wasmplane deploy --project-id prj_hello --component ./worker.component.wasm --host hello.example.dev
just bench
just e2e
```

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
`publish`, and `*`. Set `WASMPLANE_AUDIT_LOG=/data/audit.jsonl` to append authenticated mutation
audit events as JSONL.
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
`WASMPLANE_QUOTA_MAX_KV_NAMESPACES` to enforce per-project resource quotas before writes are
accepted.
Set `WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS` to run a background publish job that periodically
generates the current route snapshot and publishes it to configured/registered active runtime
nodes. Each generated route snapshot includes a content-derived `snap_<hash>` id, and publish
history records that id for retry and audit correlation. Snapshot publishes retry retryable target
failures by default; tune this with `WASMPLANE_SNAPSHOT_PUBLISH_MAX_ATTEMPTS`,
`WASMPLANE_SNAPSHOT_PUBLISH_RETRY_DELAY_MS`, and `WASMPLANE_SNAPSHOT_PUBLISH_TIMEOUT_MS`.
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
Autoscalers can read `GET /autoscaling/signals` from the control plane to get per-runtime
`activeRequests`, `concurrentRequests`, `loadRatio`, and saturation state. The autoscaling helpers
turn these signals into scale-up/scale-down decisions, and the Fly Machines prototype reconciler can
create Machines or stop excess Machines. The Fly reconciler accepts a coordination store for
controller leases and cooldowns so multiple controller instances do not race provider actions.
The bundled in-memory store is for single-process controllers and tests; production should back the
same interface with durable storage. New runtime nodes should be registered as `draining`, receive
the current route snapshot directly for warmup, then be marked `active` by heartbeat.
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
When the runtime is configured with `WASMPLANE_WASIP3_HOST_DAEMON=1` or
`WASMPLANE_WASIP3_HOST_DAEMON_URL`, `GET /__runtime/metrics` includes the daemon `/stats` payload
under `hostDaemon`.
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
curl -H "authorization: Bearer $WASMPLANE_CONTROL_PLANE_TOKEN" \
  "https://$FLY_CONTROL_APP.fly.dev/runtime-nodes"
curl "https://$FLY_RUNTIME_APP.fly.dev/__runtime/healthz"
curl "https://$FLY_COLLECTOR_APP.fly.dev/"
```

The control app stores SQLite state and uploaded local artifacts on `/data`. For Fly, local uploads
are recorded as `https://<control-app>/artifacts/local/<digest>.wasm`, so the separate runtime app can
materialize them over HTTP. The runtime app stores `.cwasm`, artifact, and KV cache under `/data`.
For multiple runtime Machines, create one `wasmplane_runtime_data` volume per Machine region.
To move the control plane state to managed Postgres, create a Postgres database and set
`DATABASE_URL` on the control app. To remove the control app volume dependency, also set the
S3/R2 artifact store variables above so local uploads are persisted outside `/data`.

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
byte limits, KV namespace allowlists, outbound HTTP allowlists, host API call counters, and
subrequest counters. `cpuMs` uses epoch-tick compute budgeting rather than kernel CPU-time
accounting; CPU budget exits are reported as `503 cpu_limit`, while wall-clock exits remain
`504 timeout`.
Guest components resolve configured capability bindings through WIT handles: `kv.open-namespace`
maps a binding name such as `MAIN` to its physical namespace, and `secrets.open-secret` returns a
secret handle whose `reveal` operation is backed by host-loaded secret values. Secret values are
redacted from host logs. KV `get`/`put`/`delete` operations are backed by a host-side persistent
store when `--kv-store-dir`/`WASMPLANE_KV_STORE_DIR` is configured, including TTL expiry.
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

## Cost Estimate

Run the built-in estimator for the current single-region production shape:

```sh
pnpm cost
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
With `--autoscaling`, the report also includes `cluster.autoscale.scale_up_warm` and
`cluster.autoscale.scale_down_exclude` rows for new-node warmup and target exclusion timing.
Pass `--host-daemon-url` to use the embedded Wasmtime daemon instead of spawning the host CLI for
every request. When the daemon uses Wasmtime pooling, pass the same `--pooling-*` flags to
`pnpm cluster-bench` so benchmark-generated `.cwasm` files are compiled with the same Engine
settings.

CI runs `just test` and `just e2e` on GitHub Actions. The workflow installs Node 24, Rust stable,
`wasm32-wasip1`, `wasm-tools 1.245.1`, and `wit-bindgen-cli 0.51.0`.

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
- `POST /__runtime/cache/gc`
- `PUT /__runtime/snapshots/routes`
- any other path: resolve by `x-forwarded-host` or `host`, prepare the component, then invoke it
  through `wasmplane-wasip3-host`.

`GET /__runtime/metrics` exposes in-memory counters for worker requests, route matches/misses,
invocations, active/rejected invocation concurrency, response status codes, runtime error codes,
and loaded route snapshots. `GET /__runtime/events` returns a bounded in-memory list of structured
worker request events with request id, host/path, project/deployment, status, duration, and error
code. Worker responses include `x-wasmplane-request-id`.

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
  --outbound https://api.example.dev/
```

The command uploads bytes through `POST /artifacts/local`, creates an immutable deployment, points
the route, then publishes a route snapshot unless `--no-publish` is passed. Limit overrides use
`--limit name=value`, for example `--limit wallMs=2500 --limit cpuMs=100`. The CLI also reads
`WASMPLANE_CONTROL_PLANE_TOKEN` when `--token` is omitted.
Canary rollout can be driven through the control-plane API by first pointing a route at the stable
deployment, then calling `POST /routes/canary` with a candidate deployment and weight. Rollback uses
`POST /routes/rollback` and returns the route to the stable target with 100% weight. Automatic
canary analysis uses `POST /routes/canary/analyze` with runtime event samples, a candidate
deployment id, and thresholds such as `minRequests`, `p95Ms`, `errorRate`, and `rejectCount`.
When a threshold fails, the route is rolled back and the decision is stored in
`GET /canary-decisions`.

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
- `POST /projects`
- `GET /projects/:id/quota-usage`
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

`POST /snapshots/routes/publish` creates a fresh compact route snapshot and pushes it to each
active registered runtime node, plus statically configured runtime nodes, through
`PUT /__runtime/snapshots/routes`. The response includes a per-node publish result and stores a
publication history record. Each target result includes `attempts` and `elapsedMs`; retryable
statuses are retried per target without blocking successful targets from recording their result.

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
  "kv": [{ "binding": "MAIN", "namespaceId": "kv_main" }]
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
