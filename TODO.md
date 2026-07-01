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
