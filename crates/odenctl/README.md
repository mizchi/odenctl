# odenctl

Deployment platform: management CLI, control-plane API, Node gateway, and the
Rust `oden-host` protocol adapter in `src/main.rs`. Node.js 24 or later is required.
SQL migrations ship in `db/`; PostgreSQL dependencies belong to this workspace.

From the repository root:

```sh
pnpm install --frozen-lockfile
just odenctl-build
pnpm odenctl --help
just odenctl-test
```

See the [deployment guide](../../docs/user/control-plane.md) and
[workspace guide](../../docs/developer/workspaces.md).
