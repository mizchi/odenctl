# oden and odenctl Design

This document describes odenctl's current design. It assumes WASIp3 and the Wasmtime Component Model,
with WIT defining the platform API contract.

## Direction (2026-09-11)

Build around a standalone Wasm application runtime, with the control plane using the same runtime core.
Use the latest upstream stable Wasmtime or `mizchi/wasmtime-threads`.
Wasmtime 48.0.2 is adopted, and a gateway adapter connects to `denoland/celld` Durable Objects.

[Standalone Wasm runtime direction](runtime-direction.md) covers responsibility boundaries,
engine selection, celld contracts, and the validation sequence.
See the [runtime guide](standalone-runtime.md) for the standalone CLI, permissions, and local celld validation.
The old custom worker WIT was removed; the node adapter also calls standard WASI HTTP.
The following sections describe the control plane. For current runnable workflows,
start with the [runtime quickstart](../user/getting-started.md) or
[deployment walkthrough](../user/control-plane.md). Historical measurements below
are retained for design context, not as current performance guarantees.

## Current Implementation Goals

odenctl is a Wasm hosting control plane for building a Cloudflare Workers-like operational model on Wasmtime.
Its main goals are:

- Register worker artifacts as immutable deployments.
- Treat routes as mutable pointers to deployments, making rollback a pointer update.
- Serve the hot path from compact runtime-local route snapshots without database reads.
- Deny host capabilities by default and grant them explicitly through WIT.
- Avoid cold compilation and process spawning with `.cwasm` and an embedded Wasmtime daemon.
- Separate the control plane from horizontally scalable runtime nodes.

## Architecture

There are five main components:

| Component | Role |
| --- | --- |
| Control Plane | Manages projects, deployments, routes, secrets, KV namespaces, and the runtime node registry |
| Artifact Store | Stores Wasm component bytes by digest, with local file and S3/R2-compatible backends |
| Snapshot Publisher | Converts the route graph into compact route snapshots and distributes them to runtime nodes |
| Runtime Node | Holds snapshots, resolves HTTP requests to routes/deployments, and invokes prepared components |
| Wasmtime Host Daemon | Rust embedded Wasmtime runtime that deserializes `.cwasm`, instantiates components, and provides WIT host APIs |

Conceptual request path:

```text
client
  -> runtime node HTTP endpoint
  -> route snapshot lookup
  -> prepared deployment cache
  -> local .cwasm artifact
  -> Wasmtime host daemon POST /invoke
  -> guest component handle(request)
```

Control path:

```text
operator/API
  -> control plane
  -> artifact validation/upload
  -> immutable deployment
  -> route pointer update
  -> route snapshot publish
  -> runtime node warmup/materialize/precompile
```

## Contract Layer

WIT defines the worker–host boundary. The control plane's deployment contract must preserve that boundary.
Before accepting a deployment, the runtime validates at least the following:

- The runtime backend is Wasmtime.
- The WASI profile is WASIp3.
- The world is the worker world.
- The artifact digest uses `sha256:*`.
- Privileged capabilities are false.

A deployment holds the following immutable information:

- Project ID
- Artifact ID, location, and digest
- WIT world
- Runtime backend/version/WASI profile
- Resource limits
- Capability policy
- Legacy resource-binding metadata (not supported as guest imports by the current standard WASI adapter)

A route is a mutable pointer to a single deployment or weighted targets.
Canary releases and rollbacks are represented as route target changes.

## Control Plane

The control plane prioritizes correctness and auditability over write throughput.

Repository backends:

- Local/development: SQLite
- Production: Postgres

Primary data:

- projects
- deployments
- routes
- artifacts
- secrets
- kv_namespaces
- runtime_nodes
- route_snapshot_publications
- audit events

API authentication uses scoped bearer tokens. Legacy `ODENCTL_API_TOKEN` retains full access;
production uses `ODENCTL_API_TOKENS` to separate `read`, `write`, `publish`, and `*` scopes.
Mutations can be recorded in a JSONL audit sink.

Schema migrations are tracked in `schema_migrations`. At startup, repository initialization applies known migrations,
then compares the current/latest versions against the compiled migration catalog.
Startup/check detects pending database migrations and future migrations unknown to the binary.

Operational commands are `pnpm odenctl migrate check|apply` and `just db-migrate-check|db-migrate-apply`.
Before a production rollout, use `just pg-backup` to create a custom-format `pg_dump`.
To roll back, stop writers, restore the backup with `just pg-restore`, then redeploy the previous application image.
Down migrations are not automated.

## Artifact Design

Artifacts are identified by content digest. Local ingestion stores component bytes and validates them as a
Wasm component through the Rust host. Production uses an S3/R2-compatible store.

Artifacts may carry a signature and provenance. When creating a deployment, the control plane verifies the signature
with the configured verifier and rejects unsigned or invalidly signed artifacts.
The implementation includes a `sha256-hmac` verifier over the digest, with a contract that allows replacement by
KMS-backed signing or Sigstore verification. Provenance records the builder, source, revision, and build ID,
and is exposed in artifact responses and route snapshots.

Runtime nodes support materializing `file://`, `http://`, `https://`, private `s3://`, and `oci://` artifacts.
Private S3/R2 artifacts are fetched with SigV4 GET and cached after digest verification.
When `ODENCTL_ARTIFACT_BUCKET` is set, `s3://` artifacts from other buckets are rejected.
For OCI artifacts, the node fetches the manifest through the registry v2 API and downloads only the layer
matching the control plane artifact digest. `oci://registry/repo@sha256:<digest>` is treated as a digest-addressed
blob pull. Private registries use a static bearer token or basic authentication.

`.cwasm` is a node-local cache artifact, not a user artifact. It depends closely on:

- Host binary
- Wasmtime version
- Wasmtime Engine configuration
- Pooling allocator configuration
- Target machine

The `.cwasm` cache key therefore includes the deployment ID, artifact digest, and Engine variant.
The Engine variant is a short hash rather than a long configuration string.

## Runtime Node

Runtime nodes are driven by snapshots. The normal request path does not read the control plane database.

Runtime node responsibilities:

- Receive and validate route snapshots.
- Materialize artifacts and verify their digests.
- Precompile `.cwasm` into the node-local cache.
- Resolve HTTP requests to deployments through the route snapshot.
- Pass deployment capabilities and limits to host invocations.
- Emit request metrics, structured events, and OTLP traces.
- Reject requests above the global concurrency limit.
- Reject requests above the project's concurrency budget.
- Bound materialization and precompilation concurrency during snapshot warmup.
- Garbage-collect node-local artifact and `.cwasm` caches according to retention policy.

The runtime node registry stores region, labels, capacity, and current load alongside node URL/status.
Heartbeats update capacity and active request load. Operators can set node status to `active`, `draining`, or `offline`
through the control plane API or Admin UI. Status updates preserve the latest heartbeat metadata and support draining
before maintenance or scale-down. Publication targets must be active and within the heartbeat TTL;
draining, offline, stale, and saturated nodes are excluded. Snapshot publication evaluates project placement policies
by region and label, and can target the union of registered runtime nodes matching the projects in the snapshot.

Placement rules can define ordered `failover` tiers. As long as the primary tier has an active target,
fallback regions do not receive publications. If the primary region has no eligible nodes because they are
offline, stale, saturated, or otherwise excluded, tiers are evaluated in order and the first with targets is used.
Nodes also advertise the Wasmtime backend, WASI profile, runtime version, host version, and Engine variant
in registration and heartbeats. The Admin UI displays this metadata to help identify mixed Engine variants during upgrades.

Operators can garbage-collect old registry entries by status and age. Default cleanup targets only offline nodes;
deleting active nodes requires explicitly selecting that status. Age is evaluated using `lastSeenAt ?? registeredAt`.

Runtime node identity is stored as public registry metadata. Nodes advertise a `keyId` and optional transport
certificate SHA-256 fingerprint during registration and heartbeats. The control plane selects the corresponding
secret from its runtime identity keyring and signs snapshot publications with HMAC-SHA256.
When the node has an identity keyring configured, `PUT /__runtime/snapshots/routes` verifies the signature
in addition to the bearer token. Rotation uses a multi-key keyring: add the new key to both sides, switch the node's
active `keyId`, wait for the heartbeat update, then remove the old key. Actual mTLS is handled by TLS termination
on the Fly private network or an edge proxy. This contract provides application-level proof of possession and
certificate fingerprint pinning.

Cache retention applies to `ODEN_ARTIFACT_CACHE_DIR` and `ODEN_CACHE_DIR`.
Garbage collection first removes files older than the maximum age, then removes the oldest files if a directory
still exceeds its byte limit. Materialized artifacts and `.cwasm` files referenced by prepared deployments are protected
as keep paths, preserving the hot path during snapshot changes and warmup. Garbage collection can be triggered through
a runtime management endpoint or run periodically when the interval environment variable is set.
`.cwasm` cache keys include an Engine variant derived from the host version label, host binary stat, and precompilation
Engine configuration. After a Wasmtime/Cranelift upgrade, `POST /__runtime/cache/invalidate-cwasm` removes `.cwasm`
files from other variants. Files referenced by prepared components remain protected, allowing invalidation on a draining node.

With `RUNTIME_SNAPSHOT_WARMUP=1`, target deployments are materialized and precompiled before the snapshot ACK,
reducing first-request latency after a deployment switch. `RUNTIME_SNAPSHOT_WARMUP_CONCURRENCY` bounds the warmup queue
so a snapshot with many deployments does not overwhelm the node with simultaneous compilation.

## Embedded Wasmtime Host Daemon

The initial implementation spawned a Rust CLI process per request. This was simple, but process spawning dominated
the hot path. The current production-oriented path uses a Rust embedded Wasmtime host daemon.

Daemon responsibilities:

- Maintain a shared Wasmtime `Engine`.
- Maintain an LRU-bounded prepared component cache.
- Deserialize `.cwasm` and instantiate components.
- Create a fresh `Store` / Instance per request.
- Provide WIT host imports.
- Bound in-flight invocations through admission control.
- Expose `/stats` and `/metrics`.

Each request gets a fresh Store/Instance. The prepared component LRU and Wasmtime pooling allocator remain in use.
The old custom WIT Store reuse/reset contract was removed.

Daemon endpoints:

- `GET /healthz`
- `POST /invoke`
- `GET /stats`
- `GET /metrics`

Main settings:

- `ODEN_WASIP3_HOST_DAEMON=1`
- `ODEN_WASIP3_HOST_DAEMON_PORT`
- `ODEN_WASIP3_HOST_DAEMON_URL`
- `ODEN_WASIP3_HOST_MAX_PREPARED_COMPONENTS`
- `ODEN_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS`
- `ODEN_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES`
- `ODEN_WASIP3_POOLING_MEMORY_MB`
- `ODEN_WASIP3_POOLING_TOTAL_CORE_INSTANCES`
- `ODEN_WASIP3_POOLING_TOTAL_MEMORIES`
- `ODEN_WASIP3_POOLING_TOTAL_TABLES`

A `.cwasm` passed to a daemon using the pooling allocator must have been precompiled with an Engine using
the same pooling configuration. The runtime backend aligns daemon-mode compile arguments and cache variants.

## Capability Model

Workers do not receive arbitrary filesystem access, sockets, process spawning, or environment variables.
Host capabilities are granted explicitly through deployment policy.

The Wasm node supports an origin allowlist for standard WASI HTTP outbound requests.
It does not use path prefixes or automatic redirect following. The old KV / Secrets / Durable storage / service bindings
were removed, and configurations enabling them are rejected. Control plane resource management, KMS,
and the Node-side storage facade remain independent APIs.

Standalone execution can explicitly configure environment variables and preopened directories.
celld actor calls use `oden:durable/objects@0.1.0`.
See the [runtime guide](standalone-runtime.md).

## Limits

Deployment limits are passed to the runtime and host:

- Wall clock deadline
- Memory MB
- Request bytes
- Response bytes
- Subrequest count
- cpuMs

`cpuMs` is a compute budget enforced through Wasmtime epoch interruption. The runtime passes the smaller of
`wallMs` and `cpuMs` as the host epoch deadline. When the CPU budget triggers interruption, it returns `cpu_limit`
to distinguish it from a wall timeout. This is cooperative interruption based on epoch ticks, not kernel CPU time,
so it is not suitable as an exact billing unit.

The control plane can check per-project quotas for artifacts, deployments, routes, secrets, and KV namespaces before writes.
In addition to global `RUNTIME_CONCURRENCY`, runtime nodes can set per-project concurrency budgets with
`RUNTIME_PROJECT_CONCURRENCY_LIMITS=project=count,...`. Requests over a project budget are immediately rejected with
`503 overloaded`, while requests from other projects remain admissible on the same node.
`RUNTIME_PROJECT_RATE_LIMITS=project=rps[:burst],...` sets per-project token bucket rate limits;
excess requests are immediately rejected with `429 rate_limited`.

## Deployment and Rollback

Deployment flow:

1. Upload/record artifact bytes.
2. Verify the artifact digest and component validity.
3. Create an immutable deployment.
4. Point the route at the deployment.
5. Publish a route snapshot to runtime nodes.
6. Materialize and precompile on each runtime node.

Rollback flow:

1. Point the route back to the previous stable deployment.
2. Publish a route snapshot.
3. Apply the new snapshot on runtime nodes.

Canaries use weighted route targets. The control plane implements canary start and rollback as route mutations.
Automatic canary analysis aggregates runtime worker request events by deployment ID and compares the candidate's
sample count, p95 latency, error rate, and reject count against thresholds. If a threshold is exceeded, it rolls back
to the stable target. Continue/rollback decisions are stored in `canary_decisions` history.

The WIT worker world is stored as both `world` and explicit `worldVersion` in deployments and route snapshots.
Before loading a snapshot, runtime nodes validate both fields and reject upgraded or downgraded worlds the host does not support.

## Observability

Runtime node:

- Worker request metrics endpoint
- Structured worker request events
- Bounded worker logs by request/project/deployment
- Saturation signals for autoscaling
- OTLP/HTTP JSON trace exporter
- Heartbeat capacity reporting
- Configured host daemon `/stats` payload embedded under runtime metrics `hostDaemon`

Worker logs are stored in a bounded ring buffer local to each runtime node. Entries contain a timestamp,
request ID, host, path, project ID, deployment ID, level, and message. Before storing optional invocation response logs,
the runtime replaces resolved secret values and values associated with keys such as `authorization`, `cookie`,
`token`, `password`, and `secret` with `[REDACTED]`. The control plane exposes `GET /runtime-nodes/:id/logs`
with read scope, proxying the target node's `GET /__runtime/logs` with the runtime management token.

Autoscaling calculates per-node load ratios from heartbeat `capacity.concurrentRequests` and `load.activeRequests`.
The control plane exposes signals through `GET /autoscaling/signals`. A policy helper determines the desired node count
from minimum/maximum nodes and scale-up/scale-down thresholds. Scale-up registers a new node as `draining`,
directly publishes and warms the current route snapshot, then marks it `active` through a heartbeat.
Scale-down selects a low-load node, removes it from snapshot publication targets, then performs a provider action
such as stopping a Fly Machine.

The Fly Machines controller is a separate provider prototype. Its public API base is `https://api.machines.dev/v1`;
scale-up uses `POST /apps/{app}/machines`, and scale-down uses `POST /apps/{app}/machines/{id}/stop`.
In production, the controller uses a coordination store for leases and cooldowns to avoid API rate limits and
conflicts with deployments or updates. A lease prevents simultaneous reconciliation by multiple controllers;
a cooldown limits successive scale-up/down actions after a successful provider action.
The in-memory store is for a single process. Production uses a durable SQLite/Postgres store, persisting lease/cooldown
state in `fly_autoscaler_coordination`. Idempotency metadata and provider-side reconciliation audits are future work.

## Admin UI

The control plane serves a server-rendered HTML Admin UI at `GET /admin`.
The UI has no separate state model: it builds the active route snapshot, runtime node registry,
route snapshot publications, canary decisions, and autoscaling signals from existing API contracts.

The page shows projects, routes, deployments, canaries, runtime nodes, and autoscaling signals.
Canary start and rollback forms submit to `POST /admin/routes/canary` and `POST /admin/routes/rollback`,
calling the existing `startRouteCanary` / `rollbackRoute` control plane operations.
Authentication uses the same boundary as the API: `GET /admin` requires `read` scope, and admin actions require `write` scope.

Host daemon:

- `/stats`: prepared components, active invocations, max concurrency, total/fail/reject, average latency
- `/metrics`: Prometheus text format

Collector:

- OTLP/gRPC `4317`
- OTLP/HTTP `4318`
- spanmetrics connector
- Prometheus metrics `:9464/metrics`
- Starter alert rules for runtime error rate and p95 latency

## Scaling Model

Runtime nodes are mostly stateless, with node-local caches.

Node-local state:

- Materialized artifact cache
- `.cwasm` cache
- Optional bounded HTTP response cache, separate from executable caches
- Daemon prepared component cache

Scale-out adds runtime nodes and publishes route snapshots from the control plane to each node.
On Fly.io, each Machine registers its private URL through heartbeats, and the control plane sends snapshots directly to active nodes.

Across regions, the primary control plane replicates route snapshots to regional control plane replicas through
`PUT /replication/snapshots/routes`. A replica keeps only the snapshot with the latest `generatedAt` and rejects older ones as stale.
After runtime publication, the primary's `POST /snapshots/routes/publish` sends the same snapshot to configured replicas.
If a replica ACK has a different `snapshotId` or `generatedAt`, the response includes a consistency failure.
This validates the consistency of state used on the hot path; it is not database multi-writer replication.

Approaching the density of Cloudflare Workers' 128 MB processes requires combining:

- Wasmtime pooling allocator
- Per-deployment memory limits
- Daemon admission control
- Prepared component LRU
- Route snapshot warmup
- Node-local `.cwasm` cache

The isolate/process unit is currently represented by a Wasmtime Store/Instance rather than an OS process.
Deployment requests use fresh Stores; a cache hit skips execution. Standalone
resident mode keeps one Store per service generation and is a separate execution mode.

## Historical Local Performance

These measurements predate the current standard-WASI/rebranding work and do not
establish current throughput. Rerun the [benchmark commands](control-plane-reference.md#benchmarks)
for deployment nodes or the [service benchmark](service-benchmark.md) for
standalone fresh/resident execution, recording the source revision and conditions.

Local measurement conditions:

- Host binary: release build
- Guest component: existing debug component
- Machine: darwin/arm64, 10 CPUs, Node v24.12.0

Main results:

- CLI spawn + component: approximately 12.6 RPS, 79 ms average
- CLI spawn + `.cwasm`: approximately 856 RPS at concurrency 16, 16 ms average
- Runtime prepare, cold: approximately 40 ms
- Runtime prepare, warm cache: approximately 2 ms
- Cluster CLI spawn path: plateaus around 1.1k RPS
- Cluster daemon + pooling path: approximately 5.6k–6.0k RPS
- Daemon stats: 6028 invocations, 0 failures, 0 rejects, approximately 0.24 ms average host invocation time

Interpretation:

- `.cwasm` eliminates compilation work.
- CLI spawning caps hot-path throughput at roughly 1k RPS.
- The embedded daemon and pooling remove process spawning, delivering several times the throughput and lower p95 latency.
- Visible deployment-switch latency is dominated by materialization, precompilation, and the first request rather than snapshot publication.

## Production Deployment Shape

A minimal production-like deployment contains:

- Control plane application
- Runtime application
- OTEL collector
- Postgres
- S3/R2 artifact store
- Runtime persistent volume for artifact/compiled caches and accepted route snapshots

The Fly.io trial uses:

- Control application
- Runtime application
- Collector application
- Fly private networking
- Runtime Machine heartbeats
- Direct snapshot publication to `*.vm.<app>.internal`

The README cost estimator covers a single-region deployment. Current assumptions describe a setup with meaningful traffic,
running the control plane, runtime, collector, and Postgres continuously rather than minimizing idle infrastructure.

## ADR: Cloudflare Backend Strategy

Decision: the control plane POC uses Cloudflare Containers. The production Wasmtime runtime stays on container-capable infrastructure such as Fly Machines, ECS/Fargate, GKE, EKS, or Cloud Run.
The native Cloudflare backend is a separate target that can use Workers, Durable Objects, R2, D1, and
Queues without pretending to be the same runtime-node architecture.

Rationale:

- Wasmtime, WASIp3, `.cwasm`, and the pooling allocator have clearer performance and isolation boundaries
  when built around long-lived runtime processes and node-local caches.
- Cloudflare Workers isolates offer high density, but the current odenctl Wasmtime host daemon cannot
  be assumed to run unchanged inside a Worker isolate.
- Cloudflare Containers can run the existing Docker image, making them suitable for control plane smoke tests
  and API lifecycle validation. Container disks are not treated as production-persistent storage.
- A Cloudflare-native backend should use a separate provider adapter built around Durable Objects/R2/D1,
  rather than directly porting the runtime node registry and snapshot publication model.

This ADR positions Cloudflare Containers as a control plane compatibility and release lifecycle POC.
The production Wasmtime runtime prioritizes infrastructure that supports direct runtime node addressing,
warmup, draining, node-local `.cwasm` caches, and OTEL/metrics operations.

## Current Limitations

- The design assumes WASIp3/Component Model, but must keep up with guest toolchain and host ABI changes.
- `cpuMs` uses Wasmtime epoch ticks, not precise kernel CPU time enforcement.
- Secret values support local/environment KMS envelope encryption, command-provider keyrings,
  and AWS/GCP/Azure wrapped data key adapters.
- Multi-region support includes route snapshot replication and ACK consistency checks;
  a durable replica snapshot store and database multi-writer consistency are not implemented.
- The daemon uses a local HTTP interface and assumes the same trust boundary as the runtime node.
- Wasmtime upgrades are separated through Engine variant hashes and runtime cache invalidation;
  automated multi-node rolling upgrade orchestration is not implemented.
- Snapshot publication supports per-target retries/timeouts and attempt records;
  a durable queue and dead-letter/replay UI are not implemented.
- Fly autoscaler leases/cooldowns support in-memory, SQLite, and Postgres stores;
  provider idempotency metadata is not implemented.
- The node JSON/route adapter buffers bodies within a size limit. Standalone HTTP supports streaming.
- Weekly performance regression checks support fixed budgets and optional historical median trends;
  automatic retrieval of historical GitHub Actions artifacts is not implemented.

## Next Implementation Priorities

1. celld fleet ownership transfer and recovery validation
2. Provider idempotency metadata for autoscaling
3. Durable route snapshot replica store
4. Managed identity token providers for GCP/Azure KMS
5. GitHub Actions historical perf artifact download
