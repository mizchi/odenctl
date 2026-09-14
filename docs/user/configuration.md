# CLI and Configuration Reference

[User guide](README.md) / CLI and configuration reference

Use the Rust `oden` binary built in the [Quickstart](getting-started.md).

## CLI

| Command | Behavior |
| --- | --- |
| `oden --help` | Show available commands |
| `oden --version` | Show runtime, Wasmtime, and build information |
| `oden init <directory> [--language rust\|moonbit]` | Generate a service with a vendored SDK; defaults to Rust |
| `oden inspect <component> [--json]` | Report imports, exports, supported modes, and potential capability interfaces |
| `oden check <app.json> [--json]` | Validate the manifest, component contract, and host configuration |
| `oden run <component>` | Run a WASI CLI component once |
| `oden test <component>` | Discover and run exported `-test` functions in fresh instances |
| `oden serve <component>` | Handle HTTP requests in independent instances |
| `oden serve <component> --resident` | Start a resident HTTP service with lifecycle hooks |
| `oden build <app.json>` | Execute the manifest's build commands in order |
| `oden start <app.json>` | Start the existing component specified by the manifest |
| `oden dev <app.json>` | Build, start, watch for changes, and rebuild |

`run`, `serve`, and `test` accept `.wasm` binaries and `.wat` files in `(component ...)` format.
`run` supports WASI CLI 0.2 and 0.3; ordinary `serve` supports WASI HTTP 0.2 and 0.3.
`--resident` additionally requires the `oden:app/lifecycle@0.1.0` export.
The service SDKs use WASI HTTP 0.3.

### Options for running a component directly

| Option | Commands | Meaning |
| --- | --- | --- |
| `--config runtime.json` | run / serve / test | Set permissions and execution limits |
| `--timeout-ms 5000` | run / serve / test | Override `timeout_ms` from the configuration file; per test in test mode |
| `--filter text` | test | Select exported test paths containing this case-sensitive substring |
| `--list` | test | Discover tests and validate signatures without instantiating |
| `--json` | test | Emit a machine-readable test report |
| `--addr 127.0.0.1:8081` | serve | Listen address; defaults to `127.0.0.1:8080` |
| `--resident` | serve | Select resident mode |
| `-- arg1 arg2` | run | Pass arguments after `--` to the guest |

```sh
oden run examples/minimal-command/command.wat --timeout-ms 1000
oden serve examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm \
  --resident --addr 127.0.0.1:8081
```

`build`, `start`, and `dev` accept only a manifest path. Set ports and execution
limits in the manifest.

See [testing component exports](testing.md) for supported function signatures,
async behavior, isolation, and test exit codes.

### Preflight checks

```sh
oden inspect my-app/target/service.wasm
oden check my-app/app.json --json
```

`inspect` reports the component contract without configuration. `check` verifies
the exports required by the manifest's mode, checks imported types against the host,
and verifies that host resources such as directories can be prepared.
`check` exits with code 0 on success and 1 on failure. `inspect` reports unsupported
imports with exit code 0, but exits with code 1 if reading or compiling the input fails.

Neither command instantiates the guest, calls `start` or `run`, or builds the app.
They do not guarantee network connectivity, successful guest initialization, or
successful file operations. `--json` emits a machine-readable report with
`schema_version: 1`. In `check`, `grants.env` lists environment variable names only;
values and Durable Object authentication tokens are not displayed.
`capability_interfaces` lists potential capabilities inferred from imports, not
actual use or granted access. SDK bindings may include interfaces the app does not use.

`dev` runs the same checks after building and before stopping the old generation.
It passes the validated compiled snapshot to the new generation, so a later change
to the component file cannot replace the checked content. Validation failures keep
the old generation running. The guest's `start` hook runs after the switch, so an
initialization trap or error does not roll back to the old generation.

## Application manifest

An application manifest is a JSON file describing how to run an app. For example,
create `command.app.json` at the repository root with the following content to run
the minimal WAT command:

```json
{
  "version": 1,
  "mode": "command",
  "component": "examples/minimal-command/command.wat"
}
```

```sh
oden start command.app.json
```

| Field | Type | Default and purpose |
| --- | --- | --- |
| `version` | Integer | Required; currently `1` |
| `mode` | String | Required; `command`, `http`, or `service` |
| `component` | String | Required; path to the executable component |
| `listen` | String | `127.0.0.1:8080`; listen address for http/service |
| `args` | String array | `[]`; command arguments |
| `build` | Array of string arrays | `[]`; argument vectors executed in order |
| `watch` | Path array | Watches the component if omitted or empty; always watches the manifest |
| `runtime` | Object | Permissions and execution limits; defaults are listed below |
| `service` | Object | Resident service startup and shutdown deadlines |

Unknown fields, unsupported versions, and invalid limits are errors. JSON comments
are not supported.

### Paths and builds

Relative paths in `component`, `watch`, and `runtime.directories[].host` are resolved
**from the manifest's parent directory**. They refer to the same files regardless
of where you run `oden start`.

Build commands also run in the manifest's parent directory. The Rust example uses:

```json
{
  "version": 1,
  "mode": "service",
  "component": "target/wasm32-wasip2/debug/service_rust.wasm",
  "build": [["cargo", "build", "--locked", "--target", "wasm32-wasip2"]],
  "watch": ["src", "Cargo.toml", "Cargo.lock", "../../sdk/rust"]
}
```

Each inner array is one command. Shell expansion of `$VAR`, `~`, pipes, and redirects
is not performed. Add more argument vectors for multiple steps, or put them in a
just recipe or script. Build commands run on the host and inherit its environment;
guest permissions do not apply to the build.

`build` checks that commands succeed and the component file exists. Linking and
guest initialization happen when starting, so a successful build can still fail to start.

### File watching in dev

`dev` checks file contents every 100 ms and rebuilds after 200 ms without changes.
It watches directories in `watch` recursively, excluding `target`, `_build`, `.git`,
and `node_modules`. It does not follow symlink contents; add a symlink's target to
`watch` explicitly if needed.

| Result after a change | Running application |
| --- | --- |
| Invalid manifest, failed build, or failed preflight validation | Keep the current app and wait for another change |
| Successful build and validation | Stop the current app and start a new instance |
| New guest fails to initialize after the switch | Report the error and wait for another change |
| App exits successfully or fails | Wait for another change without automatically restarting |

Switching causes downtime and resets in-memory state. Changes made during a build
trigger a subsequent build. Ctrl-C stops the running app and interrupts any active
build. On Unix, it also terminates children in the build's process group.

## Granting permissions

By default, guests receive no host environment variables, directories, outbound HTTP
access, or Durable Object bindings. Grant only what the app needs in `runtime`.
Standard input, output, and error are inherited from the host.

The following is the **value** of the manifest's `runtime` field. When using
`--config runtime.json`, save this object itself as `runtime.json`.

```json
{
  "timeout_ms": 5000,
  "memory_mb": 128,
  "max_body_bytes": 1048576,
  "max_concurrent_requests": 32,
  "env": { "APP_MODE": "development" },
  "directories": [{ "host": "./data", "guest": "/data", "write": true }],
  "outbound_origins": ["https://example.com"]
}
```

The runtime does not create `data` automatically. Run `mkdir -p data` beside the
manifest. The guest accesses it as `/data`, rather than by its host path.
Omitting `write` or setting it to `false` makes the directory read-only.

Relative `directories[].host` paths in a `--config` file are resolved **from the
command's working directory**. This differs from `runtime.directories[].host` in
a manifest.

Values in `runtime.env` are passed as literal JSON strings; `${TOKEN}` and other
variable references are not expanded. Arbitrary WASI sockets and process spawning
are not allowed. Each `outbound_origins` entry specifies a scheme, host, and port,
without a path, user information, query, or fragment. Outbound HTTP redirects are
not followed.

## Execution limits

| Runtime field | Default | Range and meaning |
| --- | --- | --- |
| `timeout_ms` | `30000` | 1–86400000 ms; command or HTTP request deadline |
| `memory_mb` | `128` | 1–65536; limit per linear memory, in MiB |
| `max_body_bytes` | `1048576` | Positive integer; limit for each request and response body, in bytes |
| `max_concurrent_requests` | `64` | 1–65536; maximum admitted concurrent HTTP requests |

`memory_mb` does not limit the entire process's memory usage. HTTP connections are
also limited to `max(32, max_concurrent_requests * 2)`.

| Behavior | http / ordinary serve | service / serve --resident |
| --- | --- | --- |
| HTTP handler | Concurrent execution in separate instances | Serial execution in one instance |
| Body | Streamed with a size limit | Fully buffered within the size limit |
| Request deadline | Instantiation, processing, and response body consumption | Body receipt, queue wait, execution, and response body production |
| Concurrency slot | Held until response body consumption finishes | Held through body receipt, queue wait, execution, and response production |
| Guest trap or execution deadline | Fails that request; others continue | Failure of the executing guest terminates the service |
| Normal shutdown | Cancel requests and connections | Stop admission, drain accepted requests, then call stop |

Loading and compilation are outside the guest execution deadline. Idle resident
services do not exit because of a request timeout. Resident mode does not support
SSE, WebSocket, or indefinite streaming responses, and does not forward HTTP trailers.

Set separate resident startup and shutdown deadlines in the manifest's `service` field:

```json
{
  "startup_timeout_ms": 10000,
  "shutdown_timeout_ms": 10000
}
```

Save this object as the value of `service`. Both settings default to 10000 ms and
accept 1–86400000 ms. Startup covers instantiation plus start; shutdown covers
draining accepted requests plus stop. Exceeding a deadline discards the app and
returns a nonzero exit code. Direct `serve --resident` uses the defaults for both.

See [celld Durable Objects](durable-objects.md) for Durable Object configuration and
[Troubleshooting](troubleshooting.md) for error-specific guidance.
