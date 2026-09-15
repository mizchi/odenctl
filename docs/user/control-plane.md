# Deploy with odenctl

[Documentation](README.md) / Control plane

Use `odenctl` to upload a standard WASI HTTP component and publish a route to a
deployment gateway. Use `oden` for local commands, resident services, and
application manifests. The two CLIs share the execution engine, but their
configuration and deployment models differ.

| Process | Start command | Default address |
| --- | --- | --- |
| Control-plane API | `pnpm start` | `http://127.0.0.1:8787` |
| Node deployment gateway | `just runtime` | `http://127.0.0.1:8788` |
| Rust protocol daemon | Started by the gateway when enabled | `http://127.0.0.1:8790` |
| Standalone application | `oden start app.json` | Manifest's `listen`, usually `127.0.0.1:8080` |

## Prepare a component

Run from the repository root with Node.js 24+, pnpm, Rust/Cargo 1.95+, and just.
`guest-build` also uses `wasm-tools`; the installer supplies the pinned version.

```sh
pnpm install --frozen-lockfile
bash tools/scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
just rust-build guest-build
```

The output is
`examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm`.
It exports `wasi:http/handler@0.3.0` and targets deployment world
`wasi:http/service@0.3.0`, with `worldVersion: "0.3.0"`.
The Rust `wasm32-wasip2` target name describes standard-library imports; the
`wasip3` crate provides the HTTP 0.3 exports. No preview1 adapter is needed here.

## Start the control plane

In the first terminal, from the repository root:

```sh
ODENCTL_API_TOKEN=local-control-token \
ODEN_RUNTIME_TOKEN=local-runtime-token \
ODENCTL_RUNTIME_NODES=http://127.0.0.1:8788 \
ODENCTL_ARTIFACT_PUBLIC_BASE_URL=auto \
pnpm start
```

These example tokens are for this loopback walkthrough. The API writes to
`odenctl.sqlite` and stores uploaded components in `.odenctl/artifacts` by default.
Set `ODENCTL_DB` and `ODENCTL_ARTIFACT_DIR` to use other paths. An existing
installation should follow the [migration guide](rebranding.md) before starting.

`ODENCTL_RUNTIME_NODES` supplies one static publication target. For a registered
fleet instead, configure the gateway with `ODENCTL_CONTROL_PLANE_URL` and
`ODENCTL_CONTROL_PLANE_TOKEN`; it registers and sends heartbeats. Avoid publishing
until a target is configured or registered.

`ODENCTL_ARTIFACT_PUBLIC_BASE_URL=auto` makes uploaded artifact locations HTTP URLs
that the runtime can download. Without it, local storage publishes `file://` paths,
which require the gateway to see the same filesystem path. Remote deployments can
use [S3-compatible or OCI storage](control-plane-reference.md#run).

## Start the gateway

In a second terminal, from the same checkout:

```sh
ODEN_RUNTIME_TOKEN=local-runtime-token \
RUNTIME_SNAPSHOT_WARMUP=1 \
ODEN_WASIP3_HOST_DAEMON=1 \
just runtime
```

The gateway starts an `oden-host` daemon and invokes it through the binary-safe
JSON protocol. Compiled components and downloaded artifacts are cached under
`.oden/`. `RUNTIME_SNAPSHOT_WARMUP=1` makes publication wait for preparation.
Before the first route snapshot, `/__runtime/readyz` returns 503.

The control-plane publication token and the gateway's `ODEN_RUNTIME_TOKEN` must
match. `ODENCTL_API_TOKEN` protects the control API; the CLI sends that value as
`ODENCTL_CONTROL_PLANE_TOKEN` or `--token`. These are two distinct connections.

## Create a project and deploy

In a third terminal, from the repository root:

```sh
curl --fail-with-body http://127.0.0.1:8787/projects \
  -H 'authorization: Bearer local-control-token' \
  -H 'content-type: application/json' \
  --data '{"id":"prj_hello","name":"Hello"}'

ODENCTL_CONTROL_PLANE_TOKEN=local-control-token \
pnpm odenctl deploy \
  --control-plane-url http://127.0.0.1:8787 \
  --project-id prj_hello \
  --component examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm \
  --runtime-version wasmtime-48.0.2 \
  --host hello.example.dev \
  --path-prefix / \
  --limit cpuMs=5000 --limit wallMs=10000
```

If the project already exists, reuse it and skip creation, or choose a new ID in
both commands. Save the returned artifact, deployment, and route IDs. The CLI
uploads the artifact, creates a deployment, updates the route, and publishes a
snapshot. Check that its JSON result says `published: true`; a failed publication
can leave the control-plane records created without a successful runtime update.
Use the publication API/history to inspect individual target results.

Pass `--runtime-version wasmtime-48.0.2` explicitly: the current CLI default for
this metadata field is still `wasmtime-42`. It does not choose an installed engine;
execution uses the `oden-host` binary configured on the gateway.

```sh
curl --fail-with-body http://127.0.0.1:8788/ \
  -H 'Host: hello.example.dev'
curl --fail-with-body http://127.0.0.1:8788/__runtime/readyz
```

The first response starts with `hello from oden:`. `hello.example.dev` is a route
match in this example; no DNS record or TLS certificate is created. Behind a proxy,
the gateway uses `x-forwarded-host` ahead of `host`, so configure the ingress to
set that header to the intended site host.

## Runtime contract and permissions

Deployment nodes execute standard WASI HTTP with a fresh Store/instance per
invocation. Their HTTP response cache can avoid invocation for eligible public
requests. Nodes do not run `app.json` or call resident lifecycle hooks.

- `--outbound https://api.example.dev` grants an exact scheme/host/port origin.
  Paths beyond `/`, query strings, fragments, and credentials are rejected. Redirects are
  returned to the guest rather than followed automatically.
- `--limit name=value` sets deployment limits. `cpuMs` is a conservative elapsed
  deadline, including I/O; it is not measured kernel CPU time. `memoryMb` limits
  each Wasm linear memory. `requestBytes`/`responseBytes` default to 1 MiB each.
- `--kv`, `--secret`, and `--service` are retained metadata parser options but
  enable guest bindings removed from the current host. Do not use them for this
  standard WASI deployment path. Control-plane resource CRUD remains available.
- Standalone environment variables, directory grants, and celld bindings belong
  in the [oden runtime configuration](configuration.md). Managing resource records
  through odenctl does not inject these grants into a deployed guest.

For deployment diffs, pass `--diff`. `--no-publish` stores the deployment and route
without pushing the snapshot. `odenctl dev` creates a preview and can validate and
tail logs against running control/gateway processes; it does not start those
processes or implement the standalone application's file watcher.

## Static sites, caching, and operations

The [static-site example](../../examples/static-site/README.md) tests real releases,
versioned assets, and rollback in Chromium. The [response-cache guide](response-cache.md)
describes `RUNTIME_RESPONSE_CACHE_FILE`, freshness, limits, and authenticated local
purge. A separate policy file is required on each gateway; it is not yet published
as part of route snapshots. CDN resources, guest cache bindings, image processing,
and dynamic component APIs remain [proposed work](../developer/edge-platform.md).

Use `GET /__runtime/metrics`, `/__runtime/events`, and `/__runtime/logs` for gateway
diagnostics, with the runtime bearer token where configured. Guest stderr remains
host process stderr in this standard adapter; it is not automatically converted
into structured worker log entries. The standalone runtime's
[OTLP configuration](telemetry.md) has a different scope from the Node gateway's
request trace exporter.

Use [the control-plane reference](control-plane-reference.md) for scoped API
tokens, publication history, quotas, billing, backups, drain operations, and
infrastructure prototypes. For running a standalone application on ECS/Fargate,
follow [operations](operations.md); that deployment does not require the odenctl
control-plane service. Stop the local processes with Ctrl-C after the walkthrough.
