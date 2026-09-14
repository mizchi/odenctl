# Control-plane implementation and verification

[Developer documentation](README.md) / Control plane

This page records platform prototypes, benchmarks, composition fixtures, and CI
for contributors to odenctl. For deployment configuration and API usage, use the
[user reference](../user/control-plane-reference.md). Run commands from the repository root.
Historical cloud smoke measurements do not establish the current deployment state.

Development setup and `just coverage` are described in the
[contribution guide](../../CONTRIBUTION.md).

## Multi-cloud Deploy POC

The repository includes a standalone AWS deployment sample and control-plane
infrastructure prototypes. Local validation and historical cloud smoke runs have
different scopes:

- AWS standalone runtime + kumo validation: [ECS/Fargate guide](../../infra/terraform/aws-standalone/README.md)
- AWS control-plane scaffold: `infra/terraform/aws`
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
cd ../..

ODENCTL_CLOUDFLARE_CONTROL_URL=https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev \
  ODENCTL_CONTROL_PLANE_TOKEN=... \
  pnpm cloudflare-control-smoke -- \
    --json-output reports/cloudflare-control-smoke.json \
    --markdown-output reports/cloudflare-control-smoke.md
```

A historical Cloudflare Containers smoke was run on July 3, 2026 UTC against
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
`/__odenctl/manifest` endpoint and persists the provider result in the configured SQLite or
Postgres control-plane repository. By default this uses the mock deployer, so it has no provider
side effects. Set
`ODENCTL_EDGE_WORKER_DEPLOYER=cloudflare-api` with `ODENCTL_CLOUDFLARE_ACCOUNT_ID` and
`ODENCTL_CLOUDFLARE_API_TOKEN` to upload the generated script through the Cloudflare Workers
script API. Requests that create `mode: "api"` releases require the `publish` API scope and are
written to the audit sink when API auth and audit logging are enabled. Release details are available
from `GET /edge-workers/releases/:id`, and `DELETE /edge-workers/releases/:id?provider=1&force=1`
soft-deletes the control-plane record after deleting the provider-side Worker script. This POC keeps
WASIp3 execution delegated to Wasmtime runtime nodes; the generated Worker is control-plane-owned
metadata, not an embedded runtime. If provider-side deletion fails, the release is marked `failed`
and a retryable operation is stored. Operators can inspect
`GET /edge-workers/releases/:id/operations` and retry pending work with
`POST /edge-workers/releases/operations/deliver`.


## Benchmarks

The benchmark harness measures three paths:

- `host`: direct `oden-host invoke` throughput for both raw component loading
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
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --host-bin target/debug/oden-host \
  --iterations 100 \
  --concurrency 1,4,16

pnpm bench cold \
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --host-bin target/debug/oden-host \
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
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --host-bin target/debug/oden-host \
  --iterations 1000 \
  --concurrency 1,8,32,64 \
  --pooling-total-component-instances 64 \
  --pooling-memory-mb 64
```

`rust-daemon-bench` precompiles the component, starts `oden-host serve`, publishes a
prepared route table to `PUT /routes`, then sends worker HTTP traffic directly to the Rust daemon.
This bypasses the Node runtime's request routing and supervisor path while still using the same
WASI p3 Wasmtime host. The daemon HTTP server is async HTTP/1.1 with keep-alive, so direct Rust
daemon results can be compared against the Node runtime shell without forcing per-request TCP
connection setup.
Pass `--baseline-url http://127.0.0.1:8788` to include an already-running Node runtime in the same
report.

Runtime nodes can publish accepted route snapshots into an embedded host daemon by setting
`ODEN_WASIP3_HOST_DAEMON=1` and `ODEN_WASIP3_HOST_DAEMON_ROUTES=1`. In that mode the Node
runtime still accepts `PUT /__runtime/snapshots/routes`, warms the snapshot to produce `.cwasm`
artifacts, and forwards a prepared route table to the daemon's `PUT /routes` endpoint. The daemon
route table carries weighted targets, so canary route snapshots use the same deterministic
host/path target selection as the Node runtime supervisor.
Set `ODEN_WASIP3_HOST_DAEMON_WORKER_PROXY=1` to dogfood the Rust-forward worker path in the
Node runtime: after Node performs lifecycle, route match, rate, concurrency, request-byte, and
capability checks, the guest HTTP request is proxied to the daemon route endpoint instead of the
JSON `/invoke` endpoint. Node reserves the daemon management paths (`/healthz`, `/stats`,
`/metrics`, `/routes`, `/invoke`) for the legacy invoker path so worker routes cannot expose host
daemon internals by path collision.

Volume-backed SQLite density can be measured separately:

```sh
just volume-sqlite-bench

pnpm volume-sqlite-bench \
  --root .odenctl/volume-sqlite-bench \
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


## Cluster benchmarks and CI

Cluster emulation starts multiple in-process runtime nodes, publishes route snapshots to every node,
switches from a blue deployment to a green deployment, waits until each node returns the new
`x-oden-deployment`, and then runs aggregate HTTP throughput against the warmed green
deployment:

```sh
just cluster-bench

# In another terminal, run `just host-daemon` first.
just cluster-bench-daemon

pnpm cluster-bench \
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --host-bin target/debug/oden-host \
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

CI runs `just test`, `just e2e`, standalone HTTP and binary/cache integration,
static-site release tests in Chromium, and separate Rust/MoonBit SDK, test-runner,
and composition checks. Workflows install Node 24, Rust stable, MoonBit where
needed, `wasm-tools 1.259.0`, and `wit-bindgen-cli 0.62.0`. Build recipes add
`wasm32-wasip2`; older interop examples also use `wasm32-wasip1`.
Weekly performance regression runs are configured in `.github/workflows/perf.yml` and can be
reproduced locally with `just perf-regression`. The job writes `perf-results/bench.json`,
`perf-results/cluster-bench.json`, and `perf-results/perf-regression.md`, then checks them against
`perf/budgets.json`. The budget file supports fixed ceilings/floors and optional historical median
trend thresholds. Set `ODENCTL_PERF_HISTORY` to a previous benchmark or cluster benchmark JSON
file to compare the current run against historical p95/avg latency, throughput, and rollout timing.
Tune `ODENCTL_PERF_ITERATIONS`, `ODENCTL_PERF_WARMUP`, `ODENCTL_PERF_CONCURRENCY`, and
`ODENCTL_PERF_NODES` to widen or shorten the weekly run.


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
`wasmtime run --invoke`. This is a small MoonBit-to-Wasmtime ABI round-trip fixture.
For full HTTP examples, use the [Rust and MoonBit service SDKs](../user/writing-services.md).
For a deployment component with Rust HTTP exports and a composed MoonBit function,
use the [release sample](#rust--moonbit-release-sample). There is no maintained
TypeScript worker template.


## Rust + MoonBit release sample

`examples/rust-moonbit-release` contains a real deployable sample that composes two Component Model
projects into one oden runtime worker:

- Rust `rust-worker` exports the HTTP `handle` function for `wasi:http/service@0.3.0`
- MoonBit `moonbit-ping` exports `ping(value) -> value + 7`
- The build links MoonBit into the Rust worker so the deployed response proves the cross-language
  call path

Build and validate locally:

```sh
just sample-rust-moonbit-smoke
```

Release to the deployed Fly control/runtime pair:

```sh
ODENCTL_CONTROL_PLANE_URL=https://mz-wasmplane-control.fly.dev \
ODEN_RUNTIME_URL=https://mz-wasmplane-runtime.fly.dev \
ODENCTL_CONTROL_PLANE_TOKEN=... \
just sample-rust-moonbit-release
```

The release recipe runs `sample-rust-moonbit-release-preflight`, uploads `examples/rust-moonbit-release/target/rust-moonbit-release.component.wasm`,
publishes a route for `rust-moonbit.sample.oden.local`, and checks the runtime response with a
`Host` header. A successful response contains `moonbit=42`.

The `Rust MoonBit Release workflow` is the protected GitHub Actions gate for the same live scenario.
Configure a GitHub Environment named `production` with the `ODENCTL_CONTROL_PLANE_TOKEN` secret.
The workflow inputs default to the Fly control/runtime pair, install the pinned `mizchi/wac` fork,
run `just sample-rust-moonbit-release-preflight`, then run `just sample-rust-moonbit-release` and
upload the WAC migration report plus the composed component.

## Rust + MoonBit CI policy

Default CI has a dedicated `wac-migration-report` job that installs MoonBit,
`wit-bindgen`, `wasm-tools`, the JCO WASI adapter, and the Rust Wasm targets.
It runs SDK, service, test-runner, and telemetry conformance tests, executes a
synchronous WAC canary, and builds/composes/validates the full HTTP worker probe.
`tests/project-files.test.ts` also checks the workflow and build configuration.
Run `just sample-rust-moonbit-smoke` to invoke the composed HTTP worker locally;
the release gate additionally deploys it and checks the gateway response.

`wac plug <socket> --plug <provider>` is now the default linking path for the Rust + MoonBit runtime
worker. Use `just wac-install` to install the pinned `mizchi/wac` fork (`wasmplane-wac-0.10.1-p1`), which contains the
resource aliasing fix needed for this WASIp3 async/resource-heavy worker world. Run
`just sample-rust-moonbit-wac-smoke` to prove the cheap synchronous Rust `wac-caller` canary, then
`just sample-rust-moonbit-wac-probe` or `just sample-rust-moonbit-smoke` for the full runtime worker.

Run `just sample-rust-moonbit-wac-status` to write `reports/wac-migration.md`. The report records the
fork source, the static WIT summary for the runtime worker, the synchronous canary, and the full runtime
worker probe. If someone swaps back to stock upstream WAC before the equivalent fix lands, known
[WAC upstream issue #180](https://github.com/bytecodealliance/wac/issues/180) blocker output is still
classified as `blocked`.

`just sample-rust-moonbit-compose-build` is kept as a rollback fallback for comparing the previous
deprecated `wasm-tools compose` output, but release and smoke paths use forked WAC.
The `Rust MoonBit Smoke` workflow can also be triggered manually from GitHub
Actions to run the full local invocation smoke and save its composed artifact.
