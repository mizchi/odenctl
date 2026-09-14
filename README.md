# oden and odenctl

**oden** is a language-neutral application runtime for WebAssembly components.
**odenctl** is its control plane and deployment CLI. This repository contains both.
The runtime embeds Wasmtime **48.0.2** and runs components built from Rust, MoonBit,
or another language with compatible Component Model bindings.

[Documentation](docs/user/README.md) · [Runtime quickstart](docs/user/getting-started.md) ·
[Deploy with odenctl](docs/user/control-plane.md) · [Rename guide](docs/user/rebranding.md)

## Choose the tool

| Tool | Use it for | Entry point |
| --- | --- | --- |
| `oden` | Run commands, serve HTTP, retain service state, test exports, rebuild during development | `oden run`, `serve`, `test`, `dev` |
| `odenctl` | Upload components, create deployments, publish routes, manage platform resources | `pnpm odenctl` |
| Deployment gateway | Route HTTP requests from a published snapshot to Wasmtime | `just runtime` |
| `oden-host` | Compile/invoke components and serve the gateway's internal protocol | Built by `just rust-build` |

oden fills the application-runtime role of Node.js for Wasm components. It does
not currently execute JavaScript/TypeScript, resolve npm packages, or implement
Node.js APIs. Running a compiled component with oden does not require Node.js.
The management CLI and deployment gateway require Node.js 24 or later.

## Run a component

Install Git, Rust/Cargo 1.95 or later, and a native linker:

```sh
git clone https://github.com/mizchi/odenctl.git
cd odenctl
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
oden --version
oden run examples/minimal-command/command.wat
```

The WAT command exits successfully without output. oden accepts `.wasm` and
`.wat` files in Component Model format directly. A bare core Wasm module must
first be adapted into a component.

The installer builds this checkout. Use `--prefix` for another location,
`--with-odenctl` to include the management CLI, and `--force` when updating an
existing installation. See [installation](docs/user/installation.md).

To start a Rust application with retained state and background tasks:

```sh
rustup target add wasm32-wasip2
oden dev examples/service-rust/app.json
```

From another terminal, run `curl http://127.0.0.1:8080` twice. The JSON `count`
increases while `starts` stays at `1`. Ctrl-C drains accepted requests and stops
the service. For MoonBit setup and the equivalent app, follow the
[quickstart](docs/user/getting-started.md#run-the-same-service-in-moonbit).

Generate an independent app with `oden init my-app --language rust` or
`--language moonbit`. Each project includes its SDK and WIT contracts.
See [writing services](docs/user/writing-services.md).

## Execution modes

| Mode | Command | Instance lifetime | HTTP response delivery |
| --- | --- | --- | --- |
| Command | `oden run app.wasm` | One execution, then exit | Not an HTTP server |
| HTTP | `oden serve app.wasm` | Fresh Store/instance per request | Streams within body and deadline limits |
| Resident service | `oden serve app.wasm --resident` or `oden start app.json` with `mode: service` | One instance for startup, requests, idle work, and shutdown | Buffered; handlers run serially |
| Deployment gateway | `just runtime` with a published HTTP deployment | Fresh Store/instance per cache miss | Buffered; optional public response cache |

Resident memory is lost on restart. The standalone runtime can call celld Durable
Objects through `oden:durable/objects@0.1.0`; that does not persist a Wasmtime
instance or provision a celld fleet. See [Durable Objects](docs/user/durable-objects.md).

## Deploy with odenctl

The control plane stores projects, immutable artifacts/deployments, and mutable
route pointers. Runtime gateways consume route snapshots; guest requests do not
need a control-plane database query. Install the management CLI with
`bash install.sh --with-odenctl --force`, or run it from this checkout with pnpm:

```sh
pnpm install --frozen-lockfile
pnpm odenctl --help
```

Follow [the local deployment walkthrough](docs/user/control-plane.md) to start both
processes, create a project, publish a standard WASI HTTP component, and request it
through the gateway. `odenctl dev` creates a deployment preview; `oden dev app.json`
builds and watches a local application.

The [static-site example](examples/static-site/README.md) demonstrates embedded
HTML/CSS/JavaScript/PNG assets, gateway caching, release updates, and rollback.

## Current capabilities

| Capability | Status and scope |
| --- | --- |
| WASI CLI and HTTP | WASIp2/WASIp3 commands and HTTP; standard HTTP 0.3 for deployment nodes |
| Application development | Manifests, `init`, `build`, `start`, `dev`, `inspect`, `check` |
| Test runner | Exported `-test` functions from WAT, Rust, or MoonBit; fresh instances and deadlines |
| Rust and MoonBit SDKs | Lifecycle, HTTP, files, environment, timers, telemetry, celld calls; explicit host grants |
| Telemetry | Standalone host/guest traces, metrics, and logs; Node gateway request traces and counters |
| Public response cache | Optional bounded cache per Node gateway, deployment invalidation, authenticated local purge |
| Static sites | Files embedded in a component; real browser release/rollback example |
| AWS deployment | Standalone ECS/Fargate image and Terraform; local container tests and kumo validation with documented emulator limits |
| Guest Cache API, dynamic component loader, image transformations, CDN provisioning | Proposed; see the [edge platform design](docs/developer/edge-platform.md) |

Control-plane KV, secret, and Durable Object records remain management APIs.
Their removed guest bindings are not supported by the standard WASI deployment
adapter. Use the [runtime configuration](docs/user/configuration.md) for standalone
permissions and the [deployment guide](docs/user/control-plane.md) for gateway limits.

## Documentation

- [CLI and runtime configuration](docs/user/configuration.md)
- [Writing services and packaging SDKs](docs/user/writing-services.md)
- [Component tests](docs/user/testing.md)
- [Telemetry](docs/user/telemetry.md)
- [Gateway response cache](docs/user/response-cache.md)
- [Operations and AWS deployment](docs/user/operations.md)
- [Control-plane API and operations reference](docs/user/control-plane-reference.md)
- [Examples](examples/README.md)

For development setup, TDD, repository tests, and WIT/SDK changes, see the
[contribution guide](CONTRIBUTION.md) and [developer documentation](docs/developer/README.md).

Upgrading from wasmplane changes command names, environment variables, and custom
WIT package names. Existing components using those WIT contracts must be rebuilt.
Read the [migration guide](docs/user/rebranding.md) before upgrading a running system.
