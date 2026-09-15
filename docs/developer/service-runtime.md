# Resident Services, Manifests, and SDKs

See the [Quickstart](../user/getting-started.md) for setup, [Writing services](../user/writing-services.md)
for application examples, and the [CLI reference](../user/configuration.md) for settings.
This page describes the resident execution contract and its verification.

Resident mode retains one Wasm instance for initialization, state shared across
requests, async work while idle, and shutdown. Its contract is
[oden:app/service@0.1.0](../../wit/app/service.wit). HTTP uses standard WASI 0.3;
the additional lifecycle interface consists of `lifecycle.start` and `lifecycle.stop`.

## Try it

```sh
just service-test
just app-dev examples/service-rust/app.json
# Repeat from another terminal to increment count
curl http://127.0.0.1:8080
```

For MoonBit, use `just app-dev examples/service-moonbit/app.json`.
Both examples return JSON such as `{ "starts": 1, "count": 1, "ticks": 12 }`.
`count` increases with each request; `ticks` increases on a 20 ms timer, including
while idle. Ctrl-C stops admission, sends responses for accepted requests, prints
`lifecycle:stop`, and exits.

Building both examples requires Rust's `wasm32-wasip2` target, wit-bindgen 0.62.0,
wasm-tools 1.259.0, and an async-capable MoonBit compiler. MoonBit was tested with
`moon 0.1.20260904`. Install the Wasm tools with the [installer](../../tools/scripts/install-wasm-ci-tools.sh).

## Lifecycle

```text
load → instantiate → start → [HTTP handler → response body complete] × N → stop → drop Store
                        └──── Drive guest async tasks while waiting ────┘
```

- Readiness is reported after start succeeds. Initialization runs once per generation.
- HTTP handlers run serially through body completion. Background tasks may interleave at await points.
- SIGINT/SIGTERM stops new admission, drains accepted requests including bodies still arriving and queued requests, then calls stop once.
- Startup and shutdown each default to ten seconds. Startup covers instantiation and start, excluding component loading and compilation. Shutdown covers draining requests and stop. Exceeding either deadline discards the Store and exits with a nonzero code.
- A handler trap, execution timeout, or response body failure terminates the whole generation. Stop is not called on a failed Store.
- A request deadline covers body receipt, queue wait, guest execution, and response body production from the start of receipt. Requests that expire in the queue or disconnect before execution are not passed to the guest. Once execution starts, it runs to completion within the deadline even if the client disconnects.
- No app-wide request timeout applies while idle, allowing a guest service to wait indefinitely between requests.

The initial resident mode buffers HTTP request and response bodies up to
`runtime.max_body_bytes`. It does not support SSE, WebSocket, or indefinite streaming
responses. `runtime.max_concurrent_requests` bounds executing, queued, and
body-receiving requests; excess requests receive 503. Oversized request bodies receive
413, receipt timeouts receive 408, and guest failures produce 500 or a closed
connection. HTTP trailers are not forwarded in this mode.

Ordinary `serve` and control-plane nodes create a Store per request. Select resident
mode with `serve --resident` or manifest `"mode": "service"`. In-memory state is lost
on restart. Use an explicit persistence service such as the
[celld binding](../../examples/durable-counter/README.md). The resident instance itself
is not persisted as a Durable Object.

## Application manifest v1

```json
{
  "version": 1,
  "mode": "service",
  "component": "target/service.wasm",
  "listen": "127.0.0.1:8080",
  "build": [["just", "build"]],
  "watch": ["src", "wit", "justfile"],
  "runtime": {
    "timeout_ms": 2000,
    "max_concurrent_requests": 64,
    "directories": [{ "host": "data", "guest": "/data", "write": true }]
  },
  "service": { "startup_timeout_ms": 10000, "shutdown_timeout_ms": 10000 }
}
```

`version`, `mode`, and `component` are required. Unknown fields, unsupported versions,
empty build argument vectors, and invalid limits are rejected before startup.
`mode` is `command`, `http`, or `service`. `listen` defaults to `127.0.0.1:8080`.
`args` is a string array for commands. `runtime` uses the same
[RuntimeConfig](standalone-runtime.md#permissions-and-limits) settings.
`service` deadlines accept 1–86400000 ms; lifecycle settings are unused outside service mode.

Component paths, watch paths, and directory-grant host paths are resolved **from
the manifest's parent directory**. A component may be `.wat`. Build argument vectors
run sequentially in that directory without shell expansion. Builds inherit the host
environment; `runtime.env` specifies values passed to the guest.

```sh
oden build app.json  # Run build commands and verify the component exists
oden start app.json  # Start an existing component
oden dev app.json    # build → start → detect changes → build → stop → start
```

`dev` always watches the manifest. If `watch` is omitted, it also watches the component
itself. It checks file contents every 100 ms and rebuilds after 200 ms without changes.
Directories are watched recursively, excluding `target`, `_build`, `.git`, and
`node_modules`. Symlink targets are not followed; add them to `watch` explicitly.

Invalid manifests, build failures, and preflight validation failures preserve the old
generation. Edits during a build trigger a subsequent build. After a successful build
and validation, the old generation stops and a new instance starts, causing downtime.
Guest initialization failures after the switch are reported while dev waits for
another edit. Guest failures are not automatically retried. Shutdown interrupts the
build; on Unix, it also terminates children in the build's process group.

This manifest describes execution of one local component. It does not provide
package fetching, a registry, dependency resolution, or composition of multiple components.

## SDKs and verification

`oden init <directory> --language rust|moonbit` generates an independent app
with its SDK and WIT. `just sdk-pack` produces local `.crate` and `.tgz` distribution
files. See the [I/O SDK](../user/sdk-io.md) for shared file, environment, outbound HTTP, and
Durable Object APIs. The [CLI reference](../user/configuration.md) describes `inspect`,
`check`, and dev's validation before switching generations. [Service benchmarks](service-benchmark.md)
measure fresh/resident execution, RSS, startup/shutdown, and sustained load.

The [Rust SDK](../../sdk/rust/src/lib.rs) provides `Lifecycle`, `HttpHandler`, `export!`,
`json`, `sleep_ms`, and WASIp3 APIs. See [service-rust](../../examples/service-rust/src/lib.rs).
Its standard HTTP and custom lifecycle exports together satisfy the shared world.

The [MoonBit SDK](../../sdk/moonbit/service.mbt) provides helpers for JSON responses,
sleep, and stdout. The [build script](../../tools/scripts/build-service-moonbit.mjs) generates
async bindings from the shared WIT into `target/generated` and connects the SDK to
[app.mbt](../../examples/service-moonbit/app.mbt). Do not edit generated ABI code.
Apps implement start, stop, and handle, using the TaskGroup passed to exports for
background work.

`just service-test` builds both languages and runs shared conformance tests covering
initialization counts, retained state, idle timers, draining bodies still arriving,
serial execution, admission limits, traps, CPU-loop interruption, manifests, dev
restarts, and recovery after build failures.
