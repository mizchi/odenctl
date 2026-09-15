# oden

Standalone Wasm component runtime. This Cargo package builds the `oden` binary
and embeds the application templates and guest SDK sources used by `oden init`.
It depends on the shared `crates/oden-core` engine and runs without Node.js.

From the repository root:

```sh
just oden-build
target/debug/oden --help
just oden-test
```

See the [user quickstart](../../docs/user/getting-started.md) and
[workspace guide](../../docs/developer/workspaces.md).
