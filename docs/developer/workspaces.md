# Product workspaces

The repository has two product directories, selected explicitly by
[pnpm-workspace.yaml](../../pnpm-workspace.yaml). The root package holds shared
development tools and task aliases.

## Repository layout

| Location | Responsibility |
| --- | --- |
| `crates/` | Product workspaces and the shared runtime engine |
| `sdk/` and `wit/` | Guest APIs and versioned component contracts |
| `examples/` | Runnable user examples and guest fixtures |
| `tests/` | Cross-product tests; Playwright configuration and browser tests live in `tests/e2e/` |
| [infra/](../../infra/README.md) | Dockerfiles, Fly/Cloudflare configuration, Collector settings, and Terraform |
| [tools/](../../tools/README.md) | Build/CI scripts, formal models, and performance budgets |
| `docs/user/` and `docs/developer/` | User guides, implementation guides, [architecture](architecture.md), and [roadmap](roadmap.md) |

Root files provide the README, contribution guide, installer, Cargo/pnpm
workspace definitions, dependency locks, and `justfile`. Docker builds use the
root `.dockerignore` and checkout context even though Dockerfiles live in
`infra/docker/`.

## Product boundaries

| Workspace | Contents | Dependencies |
| --- | --- | --- |
| [crates/oden](../../crates/oden) | Standalone Rust `oden` CLI, application manifests, embedded templates, component test runner | `oden-core`; no Node runtime dependencies |
| [crates/odenctl](../../crates/odenctl) | Node management CLI, control-plane API, deployment gateway, SQL migrations, Rust `oden-host` adapter | `pg` for PostgreSQL; `oden-host` depends on `oden-core` |

The root [Cargo workspace](../../Cargo.toml) contains `oden`, `oden-host`, and
the shared `oden-core` crate. Neither executable depends on the other.
Wasmtime execution, host permissions, and component lifecycle live in
`crates/oden-core`. Its build fingerprint covers the engine sources, WIT,
dependency lockfile, compiler, and target settings; CLI source changes do not
invalidate the shared engine fingerprint.

Shared WIT contracts remain in `wit/`, guest SDKs in `sdk/`, and integration
fixtures in `examples/`. Node and cross-product tests remain in `tests/`, with
browser release tests in `tests/e2e/`. Rust integration tests live alongside
their owning crate.

`just static-site-test` builds the site fixtures and runs the browser suite.
After building fixtures, `pnpm test:e2e` runs Playwright with the configuration
in `tests/e2e/playwright.config.ts`; reports still go to `target/`.

The Cloudflare container prototype keeps its own pnpm workspace and lockfile
under `infra/cloudflare/containers-control`, so its deployment tooling is installed
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

[infra/docker/odenctl.Dockerfile](../../infra/docker/odenctl.Dockerfile) uses the same pnpm deployment layout: the contents
of `crates/odenctl` become `/app`, so existing container entry points remain
`src/main.ts` and `src/runtime/main.ts`. Node source files stay outside
`node_modules` so Node.js 24 can load their TypeScript directly.
[infra/docker/oden.Dockerfile](../../infra/docker/oden.Dockerfile) builds only `oden` and runs
without Node.js.
