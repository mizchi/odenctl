# Contribution guide

This repository contains **oden**, the standalone Wasm component runtime, and
**odenctl**, the control plane and deployment CLI. Start with the
[user documentation](docs/user/README.md) to understand their execution modes, and
[developer documentation](docs/developer/README.md) for architecture, internals,
conformance tests, benchmarks, and design proposals.

Run commands from the repository root unless a step says otherwise. Project tasks
live in [justfile](justfile); use `just --list` to discover them. Use pnpm for Node
dependencies and Playwright for browser tests. Write user-facing documentation
in English.

## Set up a checkout

The baseline tools are Git, Rust/Cargo 1.95 or later, a native linker, Node.js 24
or later, pnpm 10.33.0, and just. Wasmtime is embedded through Cargo dependencies;
running oden does not require an external Wasmtime executable.

```sh
git clone https://github.com/mizchi/odenctl.git
cd odenctl
pnpm install --frozen-lockfile
just rust-build
export PATH="$PWD/target/debug:$PATH"
oden --version
oden run examples/minimal-command/command.wat
just test
```

`rust-build` produces `target/debug/oden` and `target/debug/oden-host`.
`just test` runs the Node tests and Rust workspace tests. Integration tests that
need built guests or external tools can be skipped by this command; use the
recipes below to exercise the affected feature fully.

For guest builds and Component Model tooling:

```sh
rustup target add wasm32-wasip2
bash scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
just guest-build
```

The installer supports Linux x86_64 and macOS arm64 and installs pinned Wasmtime,
wasm-tools, and wit-bindgen executables under `$HOME/.local/bin`. It does not
install MoonBit. See [tool versions and setup](docs/user/getting-started.md#prerequisites).
Older interop fixtures also need `wasm32-wasip1` and the JCO preview1 adapter
installed by pnpm. The standard HTTP guest uses `wasm32-wasip2` with WASI HTTP 0.3
exports and needs no preview1 adaptation.

For MoonBit and WAC composition, install MoonBit, then run:

```sh
moon version
just telemetry-tools
export PATH="$PWD/target/telemetry-tools/bin:$PATH"
just service-test
```

`telemetry-tools` installs the pinned generator and WAC fork locally. The
`wasmplane-wac-0.10.1-p1` tag intentionally retains its historical name. An
unrelated WAC executable already on PATH may lack the resource-aliasing fix;
keep the locally installed tools ahead of it when testing composition.

## Find the right layer

The product workspaces are `crates/oden` and `crates/odenctl`. Use
`just oden-build` / `just oden-test` for the standalone runtime, or
`just odenctl-build` / `just odenctl-test` for the deployment platform. See
[product workspaces](docs/developer/workspaces.md) for dependency boundaries,
pnpm filters, working directories, and packaging.

| Location | Responsibility |
| --- | --- |
| [crates/runtime-core](crates/runtime-core) | Wasmtime Engine, component linking, Store lifetime, WASI permissions, service execution, telemetry, celld adapter |
| [crates/oden/src/standalone.rs](crates/oden/src/standalone.rs) | Public `oden` commands; adjacent modules implement manifests, scaffolding, and tests |
| [crates/odenctl/src/main.rs](crates/odenctl/src/main.rs) | Internal `oden-host` compile/invoke/daemon protocol |
| [wit](wit) | Versioned application contracts and vendored standard WASI definitions |
| [sdk](sdk) | Rust and MoonBit service APIs and their build support |
| [crates/odenctl/src/cli.ts](crates/odenctl/src/cli.ts) | `odenctl` management CLI |
| [crates/odenctl/src/control-plane](crates/odenctl/src/control-plane) and [crates/odenctl/src/http](crates/odenctl/src/http) | Deployment types, resource policies, repositories, and management HTTP API |
| [crates/odenctl/src/runtime](crates/odenctl/src/runtime) | Node gateway, snapshots, artifact preparation, routing, response cache, and host transport |
| [examples](examples) | Guest applications and conformance fixtures |
| [tests](tests) and [crates/runtime-core/tests](crates/runtime-core/tests) | Node and Rust regression/integration tests; browser tests are in `tests/e2e` |
| [infra](infra) and [.github/workflows](.github/workflows) | Deployment prototypes, image checks, and CI |

Keep runtime execution independent of control-plane databases and project IDs.
Separate state storage from policy and business logic. Define changes at the
API/type/WIT boundary before extending adapters, and keep generated bindings
reproducible from their inputs.

Ordinary HTTP and deployment invocations use fresh Stores. Resident services
retain one instance per generation and process HTTP handlers serially. A prepared
component cache is not retained guest state, and a response-cache hit avoids guest
execution. Check the [execution limits](docs/user/configuration.md#execution-limits)
before changing lifecycle or concurrency behavior.

## Develop with TDD

1. Explore the relevant contract, implementation, and existing tests. For a bug,
   capture the smallest request, component, or configuration that reproduces it.
2. Add a failing test for the expected observable behavior and run it to confirm
   the failure is caused by the missing behavior.
3. Make the smallest implementation change that passes the test.
4. Refactor while preserving the contract, then run the feature's integration
   recipe and update its documentation and example.

Prefer assertions about behavior over source text or implementation details.
For documentation-only edits, check links and execute affected examples; do not
add tests that merely repeat prose. Keep permission-denied, trap, timeout, and
cancellation cases alongside successful execution when changing a host boundary.

Use temporary directories and loopback ports for local integration tests. Each
test must clean up processes, sockets, and files it owns. Guest instances do not
reset host files or external Durable Objects; give these fixtures isolated state.
Preserve the deliberate failure routes in the resident service examples because
conformance tests depend on them. Use `oden init` for a separate application.

## Choose validation for the change

Start with a focused test, for example:

```sh
node --test tests/cli.test.ts
cargo test -p oden --test test_runner
```

Use the matching recipe when a change crosses the guest/host boundary:

| Change | Validation |
| --- | --- |
| Control-plane deployment or routing | `just e2e` |
| Installation, CLI packaging, or installed host lookup | `just installer-test` |
| Ordinary WASI HTTP or runtime configuration | `just standalone-test` |
| Binary request/response transport | `just binary-http-test` |
| Gateway response caching | `just response-cache-test` |
| Resident lifecycle or application manifests | `just service-test` |
| SDK APIs, packaging, or generated projects | `just sdk-test` |
| Exported component test runner | `just test-runner-test` |
| Host/guest telemetry or composed wrappers | `just telemetry-test` |
| Rust/MoonBit release composition | `just sample-rust-moonbit-smoke` |
| Static-site delivery or browser behavior | `just static-site-test` |
| celld adapter | `ODEN_CELLD_BIN=/absolute/path/to/celld just celld-test`; SDK calls also use `just sdk-celld-test` with that variable |
| Terraform configuration | `just tofu-fmt-check` and `just tofu-validate` |

Install Chromium before the static-site tests:

```sh
pnpm exec playwright install --only-shell chromium
just static-site-test
```

The static-site test builds two site components and uses the real CLI, Wasmtime
host, and Chromium to verify HTML/CSS/JavaScript/PNG delivery, caching, an update,
and rollback. On Linux, use Playwright's `--with-deps` option if browser system
dependencies are missing. The test starts its own local stack and writes browser
reports under `target/`; it does not deploy a public site. See the
[static-site example](examples/static-site/README.md) for its assertions and reports.

Run `just test` before submitting code changes. For release preparation,
`just release-check` also checks whitespace, action pins, and infrastructure
format/validation; it requires the tools for those checks. `just coverage` is
available when investigating coverage and additionally requires `cargo-llvm-cov`.
It does not replace the feature-specific guest or browser tests above. Record
skipped checks and missing prerequisites in the PR.

Default CI includes Rust/Node tests, guest integrations, a Linux deployment-image
test, and a dedicated MoonBit/WAC job. Live cloud release and readiness workflows
use separate environment configuration. See the
[CI and composition reference](docs/developer/control-plane-reference.md#rust--moonbit-ci-policy).

## Change WIT, SDKs, or the engine

Custom contracts use the `oden:*` namespace. Standard interfaces retain `wasi:*`.
Treat package names, versions, function signatures, and sync/async declarations
as part of the ABI. Document incompatible changes and rebuild affected guests;
editing a host implementation alone does not migrate existing components.

For service contract changes, check `wit/app`, the self-contained definitions in
`sdk/rust/wit`, both SDK implementations, and the scaffold templates under
`crates/oden/templates`. MoonBit builds regenerate `target/generated` from WIT,
then copy the editable SDK and application sources into it. Edit those inputs
instead of generated files. `just sdk-pack` verifies the Rust package and stages
the MoonBit SDK with its WIT under `target/sdk-packages`; it does not publish them.
Rebuild oden after SDK/template changes so `oden init` embeds the new assets, then
run `just sdk-test` and the relevant conformance tests.

Wasmtime dependencies are pinned to 48.0.2. Keep the engine, WASI crates, bindings,
and composition tools compatible when upgrading. Selecting `mizchi/wasmtime-threads`
would be a build-time dependency change, not a CLI switch. `.cwasm` files are
trusted local caches tied to the engine/build/target; distribute portable Wasm
components and regenerate caches when these inputs change. See
[runtime direction](docs/developer/runtime-direction.md#wasmtime-selection-and-updates).

## Prepare a pull request

Keep changes focused and preserve nearby formatting. Include required lockfile
updates with dependency changes. Add reusable tasks to `justfile`, link new
examples from [examples/README.md](examples/README.md), link user guides from
[docs/user/README.md](docs/user/README.md), and link implementation or verification
guides from [docs/developer/README.md](docs/developer/README.md). Explain implemented behavior separately from
design proposals, including execution mode and configuration scope.

Describe the concrete problem, the resulting behavior, and the commands used to
validate it. Call out ABI, configuration, persistence, or migration changes and
include a minimal reproduction for bug fixes. Benchmark claims need the measured
revision, toolchain, workload, concurrency, and cold/warm conditions; see the
[benchmark guide](docs/developer/service-benchmark.md).

Keep local database files, generated builds, compiled caches, credentials, and
environment-specific Terraform state out of the patch. Publish or deploy through
the applicable release workflow after the change has been reviewed.
