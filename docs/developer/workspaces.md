# Product workspaces

The repository has two product directories, selected explicitly by
[pnpm-workspace.yaml](../../pnpm-workspace.yaml). The root package holds shared
development tools and task aliases.

| Workspace | Contents | Dependencies |
| --- | --- | --- |
| [crates/oden](../../crates/oden) | Standalone Rust `oden` CLI, application manifests, embedded templates, component test runner | `oden-runtime-core`; no Node runtime dependencies |
| [crates/odenctl](../../crates/odenctl) | Node management CLI, control-plane API, deployment gateway, SQL migrations, Rust `oden-host` adapter | `pg` for PostgreSQL; `oden-host` depends on `oden-runtime-core` |

The root [Cargo workspace](../../Cargo.toml) contains `oden`, `oden-host`, and
the shared `oden-runtime-core` crate. Neither executable depends on the other.
Wasmtime execution, host permissions, and component lifecycle live in
`crates/runtime-core`. Its build fingerprint covers the engine sources, WIT,
dependency lockfile, compiler, and target settings; CLI source changes do not
invalidate the shared engine fingerprint.

Shared WIT contracts remain in `wit/`, guest SDKs in `sdk/`, and integration
fixtures in `examples/`. Node and cross-product tests remain in `tests/`, with
browser release tests in `tests/e2e/`. Rust integration tests live alongside
their owning crate.

The Cloudflare container prototype keeps its own pnpm workspace and lockfile
under `cloudflare/containers-control`, so its deployment tooling is installed
separately from the two product workspaces.

## Build and test

Run these commands from the checkout root:

```sh
pnpm install --frozen-lockfile
just oden-build
just oden-test
just odenctl-build
just odenctl-test
```

`just rust-build` builds both executables, and `just test` runs all Node and Rust
workspace tests. Cargo places both products in the root `target/debug/` or
`target/release/` directory. Building `oden` alone only needs Rust and a native
linker:

```sh
cargo build --locked -p oden
cargo build --locked -p oden-host
```

The same product tasks are available through pnpm:

```sh
pnpm --filter @mizchi/oden build
pnpm --filter @mizchi/odenctl build
pnpm --filter @mizchi/odenctl cli --help
```

Filtered scripts run inside their product directory. Relative application paths,
database paths, and cache paths are resolved from that working directory. The
root aliases `pnpm oden`, `pnpm odenctl`, `pnpm start`, and `pnpm runtime` retain
the repository root as their working directory. Prefer those aliases for the
examples and root `target/debug/oden-host` defaults documented in the user guides.

## Installation and images

[install.sh](../../install.sh) builds only `oden` by default. `--with-odenctl`
also selects the `oden-host` Cargo package and deploys the Node workspace into
a self-contained directory with production dependencies and SQL migrations.
Dependency installation happens in a temporary workspace, preserving the
checkout's development tools.

[Dockerfile](../../Dockerfile) uses the same pnpm deployment layout: the contents
of `crates/odenctl` become `/app`, so existing container entry points remain
`src/main.ts` and `src/runtime/main.ts`. Node source files stay outside
`node_modules` so Node.js 24 can load their TypeScript directly.
[Dockerfile.standalone](../../Dockerfile.standalone) builds only `oden` and runs
without Node.js.
