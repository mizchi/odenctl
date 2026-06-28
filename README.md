# wasmplane

`wasmplane` is an early control plane for a WIT-defined Wasm hosting platform.
The MVP follows the design memo in `/Users/mz/Downloads/wasi-edge-worker-platform-design.md`:

- WIT is the platform contract.
- Deployments are immutable.
- Routes are mutable pointers to deployments, so rollback is a pointer update.
- The initial runtime backend is Wasmtime with WASIp3.
- Workers do not receive arbitrary filesystem, socket, process, or env access.
- Request hot paths should consume compact route snapshots, not query the product DB.

## Run

```sh
just test
pnpm start
just runtime
pnpm wasmplane deploy --project-id prj_hello --component ./worker.component.wasm --host hello.example.dev
just e2e
```

The control plane listens on `http://127.0.0.1:8787` by default and stores state in
`wasmplane.sqlite`. Set `WASMPLANE_DB`, `HOST`, or `PORT` to override this. Set
`WASMPLANE_RUNTIME_NODES` to a comma-separated list of static runtime node base URLs, or register
runtime nodes through `POST /runtime-nodes`, when using `POST /snapshots/routes/publish`.
Set `WASMPLANE_API_TOKEN` to require `Authorization: Bearer <token>` on all control-plane API
endpoints except `GET /healthz`.
Set `WASMPLANE_RUNTIME_TOKEN` on the control plane to sign route snapshot publishes sent to runtime
nodes.
Local artifact ingestion stores bytes in `.wasmplane/artifacts` by default; set
`WASMPLANE_ARTIFACT_DIR` to override it. Local artifact ingestion validates components through
`wasmplane-wasip3-host` by default; set `WASMPLANE_VALIDATE_LOCAL_ARTIFACTS=0` to disable that
for development.

The runtime node listens on `http://127.0.0.1:8788` by default. Set `RUNTIME_HOST`,
`RUNTIME_PORT`, `WASMPLANE_CACHE_DIR`, or `WASMPLANE_ARTIFACT_CACHE_DIR` to override this.
Set `CONTROL_PLANE_URL` or `WASMPLANE_CONTROL_PLANE_URL` to make the runtime register itself and
send heartbeat updates.
`RUNTIME_PUBLIC_URL`, `RUNTIME_NODE_ID`, `RUNTIME_CONCURRENCY`, `RUNTIME_MEMORY_MB`, and
`RUNTIME_HEARTBEAT_INTERVAL_MS` tune the heartbeat payload. Runtime secret values are loaded from
environment variables named `WASMPLANE_SECRET_<secretId>` or `WASMPLANE_SECRET_<NORMALIZED_ID>` by
default. Set `WASMPLANE_SECRET_DB` to a control-plane SQLite database path to resolve values from
the local secret registry instead. Route snapshots only carry `secretId`, never the secret value.
Set `WASMPLANE_KV_STORE_DIR` to choose the host-side persistent KV directory; the default is
`.wasmplane/kv`.
Set `WASMPLANE_CONTROL_PLANE_TOKEN` or `CONTROL_PLANE_TOKEN` on the runtime node when the control
plane requires bearer-token authentication for registration and heartbeat updates.
Set `WASMPLANE_RUNTIME_TOKEN` on the runtime node to require `Authorization: Bearer <token>` for
runtime management endpoints such as `PUT /__runtime/snapshots/routes`; `GET /__runtime/healthz`
remains unauthenticated.

Runtime-oriented tests expect these CLIs on `PATH`:

- `wasmtime`
- `wasm-tools`
- `wit-bindgen`

The runtime supervisor code currently prepares deployments by resolving a route snapshot,
materializing `file://`, `http://`, or `https://` artifacts, verifying their `sha256` digest,
validating the component through the Rust `wasmplane-wasip3-host` linker, and precompiling through
that same host binary. Remote HTTP(S) artifacts are cached under `WASMPLANE_ARTIFACT_CACHE_DIR`.
Strict `wasm-tools component targets` validation is available as an opt-in backend setting, but it
is not the default because WASI-adapted Rust components include additional WASI imports that the
host linker satisfies.

Runtime invocation enforces the route snapshot contract before calling guest code. The runtime node
rejects privileged capabilities (`arbitraryFilesystem`, `arbitrarySockets`, `processSpawn`) and
passes denied-by-default capability policy to the Rust host. The Rust host applies Wasmtime memory
limits, wall-clock interruption through epoch deadlines, request and response byte limits, KV
namespace allowlists, outbound HTTP allowlists, host API call counters, and subrequest counters.
`limits.cpuMs` remains part of the deployment contract, but it is not yet a precise CPU-time meter.
Guest components resolve configured capability bindings through WIT handles: `kv.open-namespace`
maps a binding name such as `MAIN` to its physical namespace, and `secrets.open-secret` returns a
secret handle whose `reveal` operation is backed by host-loaded secret values. Secret values are
redacted from host logs. KV `get`/`put`/`delete` operations are backed by a host-side persistent
store when `--kv-store-dir`/`WASMPLANE_KV_STORE_DIR` is configured, including TTL expiry.
The control plane stores local secret values through `POST /secrets`, but all public API responses
return only secret metadata. KV namespaces are also registered in the control plane. Deployments can
only reference registered secrets and KV namespaces owned by the same project.
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

CI runs `just test` and `just e2e` on GitHub Actions. The workflow installs Node 24, Rust stable,
`wasm32-wasip1`, `wasm-tools 1.245.1`, and `wit-bindgen-cli 0.51.0`.

SQLite schema upgrades are tracked in `schema_migrations`; repository initialization applies
missing migrations before serving requests.

Runtime node endpoints:

- `GET /__runtime/healthz`
- `GET /__runtime/metrics`
- `GET /__runtime/events`
- `PUT /__runtime/snapshots/routes`
- any other path: resolve by `x-forwarded-host` or `host`, prepare the component, then invoke it
  through `wasmplane-wasip3-host`.

`GET /__runtime/metrics` exposes in-memory counters for worker requests, route matches/misses,
invocations, active/rejected invocation concurrency, response status codes, runtime error codes,
and loaded route snapshots. `GET /__runtime/events` returns a bounded in-memory list of structured
worker request events with request id, host/path, project/deployment, status, duration, and error
code. Worker responses include `x-wasmplane-request-id`.

The runtime node enforces `RUNTIME_CONCURRENCY` as the maximum concurrent worker invocations. Extra
worker requests are rejected with `503 overloaded` and counted in metrics.

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
`--limit name=value`, for example `--limit wallMs=2500`. The CLI also reads
`WASMPLANE_CONTROL_PLANE_TOKEN` when `--token` is omitted.

## API

```sh
curl -X POST http://127.0.0.1:8787/projects \
  -H 'content-type: application/json' \
  -d '{"name":"hello"}'
```

Available endpoints:

- `POST /projects`
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
- `POST /runtime-nodes`
- `POST /runtime-nodes/:id/heartbeat`
- `GET /runtime-nodes`
- `GET /snapshots/routes`
- `POST /snapshots/routes/publish`
- `GET /snapshots/routes/publishes`
- `GET /healthz`

Artifact locations may use `file://`, `http://`, `https://`, `oci://`, or `s3://`. The runtime
materializer currently supports direct `file://` and HTTP(S) artifact bytes; OCI/S3 locations are
accepted at the contract layer for future backends.

`POST /snapshots/routes/publish` creates a fresh compact route snapshot and pushes it to each
active registered runtime node, plus statically configured runtime nodes, through
`PUT /__runtime/snapshots/routes`. The response includes a per-node publish result and stores a
publication history record.

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
