# Troubleshooting

[User guide](README.md) / Troubleshooting

Start with `oden check app.json`, `oden --version`, and the server terminal's
logs. This page covers the standalone `oden` binary.

## Commands and builds

| Symptom | Check or fix |
| --- | --- |
| `oden: command not found` | Run `just rust-build` at the repository root and use `target/debug/oden`. Set PATH in each terminal. |
| `dev` asks for a project/component instead of accepting `app.json` | `pnpm odenctl dev` creates a deployment preview. Use `oden dev app.json` for a local file watcher. |
| Missing `start` command | `pnpm odenctl` is the management CLI. Use `target/debug/oden start app.json`. |
| Build reports an outdated Rust version | Check `rustc --version` and use Rust 1.95 or later. |
| Missing standard library for `wasm32-wasip2` | Run `rustup target add wasm32-wasip2`. |
| `--locked` requires a Cargo.lock update | After changing dependencies, run `cargo build --target wasm32-wasip2` in the app directory and review the updated lockfile. |
| Missing `moon`, `wit-bindgen`, or `wasm-tools` | Follow the [MoonBit setup](getting-started.md#run-the-same-service-in-moonbit). |
| MoonBit async syntax or generated code fails to compile | Check `moon version` and `wit-bindgen --version`. The tested versions are moon 0.1.20260904 and wit-bindgen 0.62.0. |
| Old `wasmplane:*` WIT import is missing | Update custom WIT names, regenerate bindings, and rebuild the component using the [rename guide](rebranding.md). |
| `Obsolete environment settings: WASMPLANE_...` | Rename the listed host variables to the documented `ODENCTL_*` or `ODEN_*` settings. The Node processes stop before opening a database or listener. |

## Startup and manifests

For `component does not exist`, run `oden build <app.json>` first. `start` does
not build. Resolve the component path relative to the manifest's parent directory.
For MoonBit, run `target/service.wasm`, not the intermediate `gen.wasm`.

For `unknown field` or `unsupported manifest version`, check names and types in the
[configuration reference](configuration.md). A manifest requires `version: 1`,
`mode`, and `component`. A `--config` file contains only the runtime configuration
object; do not confuse the two formats.

For `component must export wasi:cli/run`, check whether you are trying to run an
HTTP component with `run`. For `resident service must export oden:app/lifecycle`,
you may be starting an ordinary HTTP component in resident mode, which requires
additional start/stop hooks. Use `serve` for ordinary HTTP components, and
`serve --resident` or `mode: service` for service SDK output.

`Address already in use` means another server is using that port. Stop the previous
example with Ctrl-C or change the manifest's `listen` or serve's `--addr`.
Both bundled Rust and MoonBit examples use `127.0.0.1:8080`.

## Changes are not reflected in dev

`dev` watches the manifest and paths in `watch`. Make sure your source is included;
when `watch` is omitted, only the component itself is watched in addition to the
manifest. Recursive watching excludes `target`, `_build`, `.git`, and `node_modules`,
and does not follow symlinks. For MoonBit, edit the original `app.mbt`, not generated files.

`build failed; keeping current generation` means the previous app is still serving.
Fix the build error and save. `validation failed; keeping current generation` also
keeps the old app running. Use `oden check app.json` to find unsupported imports
or missing exports for the selected mode.
If a successful build is followed by `application exited; waiting for changes`,
check the preceding initialization or guest error. `dev` does not automatically
restart a failed app.

## HTTP and shutdown

| Symptom | Check or fix |
| --- | --- |
| 503 from a resident service | Executing, queued, or body-receiving requests have filled the admission limit. Check slow handlers and client concurrency. |
| 503 in ordinary HTTP mode | Requests still consuming response bodies hold admission slots. Finish reading or cancel unwanted bodies. |
| 413 / 408 from a resident service | Request body size / receipt deadline exceeded. Check `max_body_bytes` and `timeout_ms`. |
| 500, a closed connection, or `deadline exceeded` | Check logs for guest errors or execution timeouts. In resident mode, failure of the executing guest terminates the service. |
| Body chunks are not visible as they arrive | Resident mode buffers the whole body. Use ordinary HTTP mode for streaming. |
| Counter is always 1 | Ordinary `serve` creates a new instance per request. Use `--resident` or `mode: service` to retain state. |
| State disappears on restart | In-memory state is not persisted. Use [celld](durable-objects.md) or another persistent store. |
| Shutdown takes time after Ctrl-C | Resident services drain accepted requests and wait for stop. `service.shutdown_timeout_ms` bounds the entire shutdown. |

Resident handlers run serially. Increasing the admission limit does not make one
instance process handlers in parallel. In ordinary HTTP mode, exceeding a body
limit while streaming can appear as a midstream disconnect or body error.

For a gateway deployment that returns 404 or readiness 503, check the route's
host/path, configured runtime targets, and snapshot publication result. Artifact
uploads alone do not publish a route. A local `file://` artifact must be visible
to the runtime; use HTTP artifact delivery for separate filesystems. See the
[deployment walkthrough](control-plane.md).

## Permissions and celld

For file access failures, check `runtime.directories`, the directory's existence,
the `guest` path, and `write`. For outbound HTTP denials, make sure the destination's
scheme, host, and port match `outbound_origins`. Host environment variables are not
automatically inherited; put guest values in `runtime.env`.

For `gateway secret environment variable is missing`, set the variable named by
`token_env` in **the terminal that starts oden**. Setting the same name in
`runtime.env` does not configure the host's gateway token.
For denied bindings, check the keys under `durable`. For authentication failures,
check the gateway and host tokens. For connection failures, check the gateway process
and port. See [retrying updates and limits](durable-objects.md#retrying-updates-and-limits)
for handling `outcome-unknown`.

When reporting a bug, include the reproduction command, `oden --version`,
language and binding-generator versions, the logs immediately before failure,
and configuration with tokens and other credentials removed.
