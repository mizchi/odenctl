# oden and odenctl

The project has two products:

| Product | Responsibility | Local command |
| --- | --- | --- |
| `oden` | Language-neutral Wasm runtime: commands, HTTP, resident services, component tests, and application development | `just oden --help` or `pnpm oden --help` |
| `odenctl` | Control plane and management CLI: deploy components, publish routes, manage platform resources | `just odenctl --help` or `pnpm odenctl --help` |

`oden` fills the application-runtime role of Node.js for Wasm Component Model
programs. It does not currently execute JavaScript or implement Node.js APIs.
The Rust runtime runs without Node.js; the management CLI and deployment gateway
use Node.js 24 or later.

## Commands and packages

| Previous name | New name |
| --- | --- |
| `pnpm wasmplane deploy`, `dev`, `new`, `migrate`, `onboard`, `volume-sqlite` | `pnpm odenctl` with the same subcommand |
| Standalone `wasmplane run`, `serve`, `test`, `init`, `inspect`, `check`, `build`, `start`, `dev` | `oden` with the same subcommand |
| `wasmplane-wasip3-host` protocol adapter | `oden-host` |
| Node package `@mizchi/wasmplane` | `@mizchi/odenctl` |
| Rust host crate `wasmplane-wasip3-host` | `oden-host` in `crates/odenctl`; standalone CLI `oden` in `crates/oden` |
| Rust core crate `wasmplane-runtime-core` / `oden-runtime-core` | `oden-core` in `crates/oden-core` (`oden_core` in Rust imports) |
| Rust SDK `wasmplane-service-sdk` | `oden-service-sdk` (`oden_service_sdk` in Rust imports) |
| MoonBit SDK `@wasmplane/moonbit-service-sdk` | `@oden/moonbit-service-sdk` |
| Generated MoonBit project `wasmplane/service-sdk` | `oden/service-sdk` |
| Generated SDK directory `vendor/wasmplane-sdk` | `vendor/oden-sdk` |

Build both Rust executables with `just rust-build`. This produces
`target/debug/oden` and `target/debug/oden-host`. Add that directory to PATH to
use the commands directly. The `pnpm oden` and `just oden` wrappers run Cargo from
this checkout. `odenctl dev` prepares a control-plane deployment preview;
`oden dev app.json` builds and watches a local application.

## Existing installations

This is a coordinated rename. Old command names and `WASMPLANE_*` environment
variables are not aliases. Update the control plane, gateway, Rust host, deployment
configuration, and CI secrets together.
The Node process entry points reject obsolete variables before opening a database
or listener, so an old token setting cannot silently disable authentication.
Errors list variable names without exposing values.

Control-plane configuration now uses `ODENCTL_*`; runtime and SDK configuration
uses `ODEN_*`. Existing unprefixed settings such as `DATABASE_URL`, `RUNTIME_PORT`,
`RUNTIME_RESPONSE_CACHE_FILE`, and `OTEL_SERVICE_NAME` keep their names.

| Configuration | New examples |
| --- | --- |
| Control-plane API and database | `ODENCTL_API_TOKEN`, `ODENCTL_DB`, `ODENCTL_DATABASE_URL` |
| CLI connection to the control plane | `ODENCTL_CONTROL_PLANE_URL`, `ODENCTL_CONTROL_PLANE_TOKEN` |
| Storage and encryption shared with the control plane | `ODENCTL_ARTIFACT_BUCKET`, `ODENCTL_SECRET_KMS_KEY_BASE64` |
| Runtime management connection and identity | `ODEN_RUNTIME_URL`, `ODEN_RUNTIME_TOKEN`, `ODEN_RUNTIME_IDENTITY_KEYS` |
| Runtime process and compiled cache | `ODEN_WASIP3_HOST_BIN`, `ODEN_WASIP3_HOST_DAEMON`, `ODEN_CACHE_DIR`, `ODEN_ARTIFACT_CACHE_DIR` |
| Runtime registration policy on the control plane | `ODENCTL_RUNTIME_NODES`, `ODENCTL_RUNTIME_NODE_ACTIVE_TTL_MS` |
| Runtime secrets and celld | `ODEN_SECRET_DB`, `ODEN_SECRET_<id>`, `ODEN_GATEWAY_TOKEN`, `ODEN_CELLD_BIN` |
| SDK and composition tools | `ODEN_SERVICE_BIN`, `ODEN_WAC_GIT_URL`, `ODEN_WAC_GIT_REF_ARG` |

The default control-plane database is now `odenctl.sqlite`. Point `ODENCTL_DB` at
your existing database before restarting, for example `ODENCTL_DB=wasmplane.sqlite`.
Persistent control-plane files default to `.odenctl/`; runtime caches default to
`.oden/`. Set the documented storage paths explicitly to reuse existing artifacts,
secrets, snapshots, and volumes. This rename does not move or modify stored data.

The custom WIT namespace changed from `wasmplane:*` to `oden:*`, including
`oden:app/lifecycle@0.1.0`, `oden:durable/objects@0.1.0`, and
`oden:telemetry/tracing@0.1.0`. Update imports and exports, regenerate bindings,
rebuild Rust/MoonBit guests, and recompose WAC applications before deploying them.
Standard `wasi:*` interfaces are unchanged. Old compiled `.cwasm` files should be
regenerated with the new host; the build fingerprint changes with the host sources.

Runtime response and management signature headers now use `x-oden-*`. Telemetry
attributes use `oden.*`, and the collector's Prometheus namespace is `oden`.
Update clients, dashboards, alerts, and log queries accordingly. Cache management
endpoints retain their `/__runtime/` paths.

The source repository is [mizchi/odenctl](https://github.com/mizchi/odenctl).

Some identifiers intentionally retain the old spelling: the pinned WAC fork tag,
provisioned Fly app/volume names, and the Cloudflare
Containers proof-of-concept name and Durable Object class identifier. Stored secret envelopes, Durable Object SQLite
table names, backup authentication data, and billing export format identifiers also
retain their original spelling so existing data stays readable. Terraform defaults
for new deployments use the new names; keep existing explicit resource names when
upgrading an already provisioned stack. The checked-in Fly control-plane configuration
continues to use `/data/wasmplane.sqlite` on its existing volume.

Repository conformance checks are documented in
[developer verification](../developer/verification.md).
