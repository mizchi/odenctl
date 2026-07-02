# TODO

Production readiness tasks, in implementation order.

## 1. KMS-backed secrets

- [x] Add a secret encryption contract with envelope encryption.
- [x] Add an env/local KMS provider for development and Fly trials.
- [x] Encrypt secret values before repository persistence.
- [x] Decrypt repository-backed secrets when runtime resolves worker bindings.
- [x] Document key configuration, rotation constraints, and migration notes.
- [x] Add external KMS providers and multi-key decrypt support for online rotation.
- [x] Add AWS KMS wrapped data key adapter for cloud KMS deployments.
- [x] Add GCP Cloud KMS wrapped data key adapter.
- [x] Add Azure Key Vault wrapped data key adapter.

## 2. Project quota and rate limit

- [x] Define per-project quotas for deployments, routes, artifacts, KV namespaces, and secrets.
- [x] Add runtime per-project concurrent invocation budgets.
- [x] Add runtime request rate limits.
- [x] Expose quota usage through control-plane APIs.
- [x] Add tests for quota enforcement and noisy-neighbor concurrency protection.

## 3. Runtime node placement

- [x] Extend runtime node capacity with region, labels, and current load.
- [x] Select snapshot publish targets by project/route placement policy.
- [x] Prefer healthy nodes and exclude saturated or draining nodes.
- [x] Add placement-aware benchmark scenarios.

## 4. Automatic canary analysis

- [x] Collect canary candidate metrics by deployment id.
- [x] Define p95 latency, error-rate, and reject-count thresholds.
- [x] Automatically rollback when thresholds fail.
- [x] Record canary decisions in audit history.

## 5. WIT/API versioning

- [x] Track worker world versions in deployments and route snapshots.
- [x] Validate compatibility between host runtime and deployed WIT world.
- [x] Add upgrade/downgrade compatibility tests.

## 6. Artifact signing and provenance

- [x] Add artifact signature metadata.
- [x] Verify signatures before deployment creation.
- [x] Record CI/build provenance for uploaded artifacts.
- [x] Surface provenance in deployment APIs.

## 7. OCI registry support

- [x] Materialize `oci://` artifact locations in runtime nodes.
- [x] Support registry auth.
- [x] Verify digest-addressed pulls.
- [x] Add local registry integration tests.

## 8. Worker logs

- [x] Capture host-side worker logs and request events by project/deployment.
- [x] Add bounded local retention.
- [x] Expose logs through scoped control-plane APIs.
- [x] Add redaction for secrets and sensitive headers.

## 9. Autoscaling

- [x] Export runtime saturation signals for autoscalers.
- [x] Add a Fly Machines autoscale controller prototype.
- [x] Warm new nodes before routing traffic.
- [x] Add scale-up/scale-down benchmark scenarios.

## 10. CPU metering

- [x] Evaluate Wasmtime fuel/epoch strategies for better CPU accounting.
- [x] Enforce `cpuMs` beyond wall-clock deadlines.
- [x] Report CPU-limit exits distinctly from wall timeout.

## 11. Admin UI

- [x] Show projects, deployments, routes, canaries, runtime nodes, and metrics.
- [x] Add deployment rollback and canary actions.
- [x] Keep auth scope boundaries aligned with the API.

## 12. DB migration/version management

- [x] Track schema version on startup.
- [x] Add explicit migration apply/check commands.
- [x] Document rollback and backup procedure.

## 13. mTLS / runtime node identity

- [x] Add runtime node identity material.
- [x] Authenticate control-plane-to-runtime snapshot publish beyond bearer tokens.
- [x] Add certificate/key rotation notes.

## 14. Runtime node lifecycle operations

- [x] Add a control-plane API to mark runtime nodes active, draining, or offline.
- [x] Preserve heartbeat capacity/load metadata when operators change lifecycle status.
- [x] Exclude draining nodes from snapshot publish targets.
- [x] Add Admin UI controls for runtime node lifecycle changes.

## 15. Runtime node registry garbage collection

- [x] Add an operator API to delete old runtime node registry entries by status and age.
- [x] Default cleanup to offline nodes only.
- [x] Keep stale active node deletion explicit.
- [x] Add Admin UI controls for registry cleanup.

## 16. Runtime cache retention

- [x] Add cache retention for materialized artifact and `.cwasm` cache directories.
- [x] Protect currently prepared component files from cache GC.
- [x] Add a runtime management endpoint to trigger cache GC.
- [x] Add env configuration for max cache bytes and max cache age.
- [x] Add optional background cache GC interval.

## 17. Wasmtime upgrade / `.cwasm` cache invalidation

- [x] Add runtime node host metadata for Wasmtime/WASI/runtime/host/Engine variant.
- [x] Persist and display host metadata in the control plane and Admin UI.
- [x] Include Engine variant in all runtime `.cwasm` cache keys.
- [x] Add runtime management endpoint to invalidate older `.cwasm` variants.
- [x] Protect currently prepared `.cwasm` files during variant invalidation.

## 18. Snapshot publish retry / reliability

- [x] Retry retryable runtime publish failures per target.
- [x] Do not retry non-retryable auth/validation responses.
- [x] Record publish attempts and elapsed time in responses and publication history.
- [x] Add publish timeout and retry tuning env vars.
- [x] Treat unsuccessful background publish reports as job failures.

## 19. Fly autoscaler lease / cooldown

- [x] Add a Fly autoscaler coordination store interface.
- [x] Add an in-memory coordination store for single-process controllers and tests.
- [x] Skip provider actions when another controller holds the lease.
- [x] Record cooldown after successful scale actions.
- [x] Skip provider actions while cooldown is active.

## 20. Multi-region failover

- [x] Add ordered failover tiers to runtime placement rules.
- [x] Use failover only when the primary region/label rule has no active targets.
- [x] Keep primary targets preferred even when fallback regions are less loaded.
- [x] Apply failover policy to HTTP snapshot publish target selection.
- [x] Document placement failover behavior and remaining cross-region state limits.

## 21. CI / weekly perf regression

- [x] Add a perf budget evaluator for benchmark and cluster benchmark JSON reports.
- [x] Add checked-in perf budgets for latency, throughput, errors, and cluster rollout timing.
- [x] Add a reproducible `just perf-regression` command that emits JSON and Markdown artifacts.
- [x] Add a scheduled GitHub Actions workflow with artifact upload and step summary.

## 22. Store / Instance reuse experiment

- [x] Add a disabled-by-default Rust host daemon flag for per-component idle Store/Instance reuse.
- [x] Bound reusable instances per prepared component.
- [x] Return only successful invocations to the reuse pool; drop trapped or timed-out instances.
- [x] Expose reusable instance counts through daemon `/stats` and `/metrics`.
- [x] Wire the Node runtime daemon launcher through `WASMPLANE_WASIP3_EXPERIMENTAL_INSTANCE_REUSE`.
- [x] Require an explicit `stateless-v1` instance reuse contract before reusing idle guest instances.
- [x] Wire the Node runtime daemon launcher through `WASMPLANE_WASIP3_INSTANCE_REUSE_CONTRACT`.
- [x] Add a `guest-reset-v1` export contract and reject reuse for components that do not implement it.
- [x] Call the `wasmplane-reset: func() -> ()` export before returning instances to the idle pool.
- [x] Document `stateless-v1` versus `guest-reset-v1` reuse modes.
- [x] Add a conforming reset-export Wasm fixture that proves a mutable guest can be reset and reused.

## 23. Durable autoscaler coordination store

- [x] Add a SQLite Fly autoscaler coordination store.
- [x] Add a Postgres Fly autoscaler coordination store.
- [x] Persist lease/cooldown state in control-plane schemas and SQLite migrations.
- [x] Export durable store constructors for production controllers.
- [x] Document production usage and remaining provider idempotency work.

## 24. Cross-region route snapshot consistency

- [x] Add a route snapshot replication publisher for regional control-plane replicas.
- [x] Reject stale snapshots in the replica store.
- [x] Expose `PUT`/`GET /replication/snapshots/routes` for replicated snapshot state.
- [x] Include replica ACK consistency in `POST /snapshots/routes/publish` responses.
- [x] Add env configuration for regional replica targets.

## 25. Historical perf trend analysis

- [x] Add optional historical benchmark inputs to `perf-check`.
- [x] Compare current rows against historical medians by name and dimensions.
- [x] Add trend thresholds to `perf/budgets.json`.
- [x] Wire `WASMPLANE_PERF_HISTORY` into `just perf-regression`.
- [x] Document remaining GitHub Actions artifact-download work.

## 26. Runtime readiness and local drain controls

- [x] Expose runtime readiness separately from process liveness.
- [x] Fail readiness before the first route snapshot is loaded.
- [x] Add local drain and activate management endpoints.
- [x] Report local lifecycle state in runtime heartbeats.
- [x] Fail readiness when a configured embedded host daemon is unavailable.
- [x] Document readiness and local drain operations.
- [x] Add graceful shutdown that drains, rejects new requests, and waits for active invocations.
- [x] Add a startup option to restore the latest accepted route snapshot from disk.

## 27. Runtime snapshot persistence hardening

- [x] Validate restored route snapshot file shape before using it.
- [x] Configure the Fly runtime volume path for persisted route snapshots.

## 28. Fly readiness and corrupt snapshot quarantine

- [x] Quarantine malformed persisted route snapshot files instead of failing startup.
- [x] Use runtime readiness, not process liveness, for the Fly runtime service check.
- [x] Document persisted snapshot quarantine behavior.

## 29. Volume-backed high-density SQLite

- [x] Add a cataloged file-per-project/tenant SQLite registry for Fly volumes.
- [x] Add an LRU-bounded SQLite handle pool.
- [x] Apply WAL-oriented SQLite pragmas and track per-database schema versions.
- [x] Wire project state APIs to the volume SQLite registry.
- [x] Add backup/export and restore commands for individual database files.
- [x] Add density benchmarks for database count, open handles, migration time, and write contention.
- [x] Add per-database writer queues for serialized SQLite mutations.
- [x] Add per-database write admission control to reject unbounded pending work.
- [x] Add backup retention GC for count- and age-based pruning.
- [x] Add AES-256-GCM encryption for volume SQLite backup files.
- [x] Harden volume SQLite directory/file permissions and backup restore path validation.

## 30. Multi-tenant hosting product layer

- [x] Add organization, user, project membership, and project-scoped API key models.
- [x] Resolve DB-backed API keys during HTTP authorization in addition to bootstrap env tokens.
- [x] Add usage metering for invocations, CPU ms, wall ms, memory, egress, storage, and tenant SQLite units.
- [x] Add admission policies for required artifact signatures, WIT world/version constraints, capability allowlists, and artifact size limits.
- [x] Add custom domain registration with ownership verification and TLS provisioning hooks.
- [x] Add deploy previews with preview URLs, environment bindings, and one-command rollback.
- [x] Add scheduled encrypted volume SQLite backups, retention policy, and restore drills.

## 31. Platform developer experience

- [x] Add `wasmplane dev` with local runtime, WIT validation, log tailing, and route preview.
- [x] Add worker templates and generated WIT SDK helpers for common languages.
- [x] Add deployment diff output for routes, capabilities, secrets, KV bindings, and runtime limits.
- [x] Add project/deployment scoped metrics, logs, traces, and log drain configuration.

## 32. Runtime packing and isolation

- [x] Add per-tenant runtime packing policy for warm deployments, idle instance pools, and LRU eviction.
- [x] Add per-tenant memory, CPU, storage, concurrency, and rate enforcement reports.
- [x] Add forced tenant drain and isolation-pool routing for noisy-neighbor mitigation.
- [x] Add billing-ready quota enforcement tied to usage ledgers.
- [x] Add invoice-ready project and organization billing statements from usage ledgers.
- [x] Add project monthly USD budget enforcement from billing rate cards.
- [x] Persist immutable organization billing invoice snapshots with rate card versions.
- [x] Add content digests to billing invoices for audit comparison.

## 33. Billing operations and accounting integration

- [x] List organization billing invoices for audit and accounting workflows.
- [x] Add signed invoice export bundles for external accounting systems.
- [x] Add billing outbox/webhook delivery with retry and idempotency keys.
- [x] Add credit-note and adjustment records without mutating issued invoices.
- [x] Add invoice retention and legal hold policy controls.
