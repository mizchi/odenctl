# Standalone Runtime

Start with the [User guide](../user/README.md) and [Quickstart](../user/getting-started.md).
This page covers the execution engine, control-plane adapter, and verification details.

The Rust `oden-runtime-core` crate embeds Wasmtime 48.0.2 to run Wasm components
without a control plane or database. Runtime nodes call standard WASI HTTP through
the same crate's `node` adapter. See the [service runtime](service-runtime.md) for
resident services, application manifests, and watch/rebuild support.
A JS/TS engine, npm module loader, and Node.js compatibility layer are not implemented.

## Running the runtime

Use stable Rust (Wasmtime 48 requires at least 1.95), Node.js 24+, pnpm, and just.
Use the following pinned tools to build guests and test components:

```sh
pnpm install --frozen-lockfile
bash scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
just rust-build
target/debug/oden --version
target/debug/oden run ./app.wasm -- arg1 arg2
target/debug/oden run examples/minimal-command/command.wat
target/debug/oden serve ./http.wasm --addr 127.0.0.1:8080 --config runtime.json
```

The installer provides Wasmtime 48.0.2, wasm-tools 1.259.0, and wit-bindgen 0.62.0.
The standalone binary does not invoke the external Wasmtime CLI.
You can also run `just run ./app.wasm` or `just serve ./http.wasm`.

`run` and `serve` read `(component ...)` WAT directly, without a conversion step or
external tools. `run` requires a WASI CLI export; `serve` requires a WASI HTTP export.

See [minimal-command](../../examples/minimal-command/README.md) for minimal `.wat` and
`.mbt` inputs. `just minimal-smoke` builds both as `.wasm` components and verifies
them with `oden run`.

`run` detects `wasi:cli/run@0.2` or `@0.3`; `serve` detects WASIp2 HTTP proxy or
WASIp3 HTTP service exports. Commands propagate success, failure, and `wasi:cli/exit`
exit codes. SIGINT or SIGTERM cancels a command; an ordinary HTTP server stops its
requests and connections before exiting. Loading and compilation are outside the
execution deadline; command instantiation is included.

## Permissions and limits

Configuration is optional. Without it, guests receive no environment variables,
preopened directories, outbound HTTP access, or Durable Object bindings.
Standard input, output, and error are inherited from the host.

```json
{
  "timeout_ms": 30000,
  "memory_mb": 128,
  "max_body_bytes": 1048576,
  "max_concurrent_requests": 64,
  "env": { "APP_MODE": "development" },
  "directories": [{ "host": "./data", "guest": "/data", "write": false }],
  "outbound_origins": ["https://example.com"],
  "durable": {
    "counter": {
      "endpoint": "http://127.0.0.1:9876",
      "namespace": "COUNTER",
      "token_env": "ODEN_GATEWAY_TOKEN"
    }
  }
}
```

- `directories[].host` is relative to the working directory; `write` defaults to false. In an application manifest, `runtime.directories[].host` is relative to the manifest's parent directory.
- `outbound_origins` authorizes exact scheme/host/port matches. Entries cannot contain paths or credentials. Redirects are not followed, and arbitrary WASI sockets are not allowed.
- `memory_mb` is a Wasmtime limit **per linear memory**, not a process-wide RSS limit.
- `timeout_ms` bounds the wall-clock duration of a command or full HTTP request, including body transmission. CPU-bound guests yield at each epoch so cancellation and deadlines can progress.
- `max_body_bytes` is a cumulative limit for each input and output body. Ordinary HTTP streams bodies without buffering them in full. An excessive Content-Length returns 413; exceeding the limit midstream produces a body error.
- `max_concurrent_requests` holds an admission slot until response body consumption finishes. A full server returns 503. Connections, including idle ones, are limited to `max(32, max_concurrent_requests * 2)`.
- Ordinary HTTP creates a Store per request; other requests continue after a trap. A guest failure before the response returns 500. WASIp3 body producers continue after the handler returns and are cleaned up on disconnect, shutdown, or deadline.

Resident mode handles bodies, admission slots, and termination after traps differently.
See [execution limits by mode](../user/configuration.md#execution-limits).

## Running through the control plane

The old custom worker WIT and host imports have been removed. Deployments use world
`wasi:http/service@0.3.0` and worldVersion `0.3.0`. Build and deploy new components;
old components and route snapshots cannot be reused.

The `compile`, `invoke`, and `serve` commands in `oden-host` remain as
node protocol adapters for standard WASI HTTP components. Rust embedding uses the
`*_async` methods on `node::Wasip3Runtime`. Synchronous free functions are CLI
wrappers intended for use outside Tokio.

- Compilation validates standard HTTP exports and all imports through the linker. The prepared-component LRU and pooling allocator remain, with a fresh Store for each request.
- Custom KV, Secrets, Durable storage, service bindings, `--kv-store-dir`, `hostCalls`, and instance reuse/reset contracts have been removed. Enabling old settings is an error. The control plane's resource management APIs remain, but cannot grant these bindings to Wasm guests.
- Outbound allowlists use HTTP(S) origins, as in the standalone runtime. Path prefixes are rejected and redirects are not followed. `subrequests` limits WASI HTTP sends per execution.
- Request and response bodies are bounded by `requestBytes` and `responseBytes`, each defaulting to 1 MiB. Each outbound body uses the smaller limit.
- Guest HTTP bodies use WASI streams. The node JSON protocol and route adapter buffer the full response within the limit. The JSON envelope uses `body` for UTF-8 text and `bodyBase64` for binary/NUL-containing bytes. Use `oden serve` for streaming through to the network connection.
- The smaller of `cpuMs` and `wallMs` bounds elapsed time through body completion; the default is 30 seconds if neither is set. `cpuMs` is a conservative bound that includes I/O waits, not kernel CPU time.
- Cancellation, traps, and deadlines discard the Store and its communication. Cold loading and compilation are outside the deadline. Node guests inherit stderr only, not stdin/stdout, to preserve the JSON output protocol.

`pnpm odenctl new --language rust` generates a standard WASI template using the
`wasip3` crate, without custom WIT generation. The old TypeScript component template
has been removed. The new celld `oden:durable/objects@0.1.0` interface is available
through standalone runtime configuration.

### Binary invocation envelope

The Rust host's `invoke` command accepts `--body <text>` or
`--body-base64 <canonical-padded-base64>`. The daemon's `/invoke` request and both
response envelopes accept either `body: string` or `bodyBase64: string`, never
both. Omitting the request body means empty bytes. Wrong types and malformed or
noncanonical base64 are errors. Text responses retain the existing `body` field.

The Node adapters select the encoding automatically and decode the response to
`Uint8Array`. Limits apply to decoded guest HTTP bodies; base64 adds transport
overhead and does not turn the JSON protocol into a streaming protocol. Large
uploads should use direct HTTP or object storage instead of subprocess arguments.
Upgrade the Node adapter and Rust host together when enabling binary traffic;
older adapters cannot interpret `bodyBase64`.

The daemon accepts `serve --port 0` for an OS-assigned port and writes
`listening on http://...` to stderr only after the listener has bound successfully.

`just binary-http-test` verifies arbitrary bytes through both adapters with a real
P3 component. See the [binary HTTP example](../../examples/binary-http/README.md) and
the [edge platform design](edge-platform.md).

## celld Durable Objects

`wit/durable/objects.wit` defines `oden:durable/objects@0.1.0`.
`open(binding, name)` obtains a resource scoped to the execution, and
`object.fetch(request)` calls the actor. Host configuration selects the endpoint,
namespace, and authentication token; the guest uses only the binding name.
`token_env` is read from the host environment and does not need a guest `env` entry.

[durable-counter](../../examples/durable-counter/README.md) contains connection settings
and WAT/Rust examples. `counter.wat` awaits `fetch` from an asynchronous WASI CLI 0.3
entry point and can run directly:

```sh
just run examples/durable-counter/counter.wat --config examples/durable-counter/runtime.example.json
```

Start the gateway and set `ODEN_GATEWAY_TOKEN` on the host before running this command.

The gateway runs on celld's public Worker listener and calls
`namespace.get(namespace.idFromName(name)).fetch(...)` after authentication.
`examples/celld-gateway/index.js` validates a binding allowlist and bearer token.
It does not use the fleet's internal `/do/<ID>` endpoint. Separate applications
need separate gateway/namespace assignments.

The gateway protocol is `POST /v1/objects/{namespace}/{encoded-name}/fetch`.
The JSON request is `{method, path, headers, body, requestId?}` and the response is
`{status, headers, body}`. Bodies use base64; headers use `[name, value][]`.
Actor statuses are carried inside an outer HTTP 200 envelope, distinguishing them
from gateway authentication errors. Request and response bodies are each capped at 1 MiB.

Errors distinguish denied bindings, invalid input, connection failure, deadlines
before dispatch, and unknown outcomes after dispatch. A timeout or lost response
after dispatch returns `outcome-unknown` without an automatic retry. Cancellation
does not guarantee that the actor rolls back its update. The example Counter stores
request IDs and results in the same transaction as the update to prevent duplicate
mutations. Its deduplication records are never deleted; production use needs a
retention policy and retry-window contract.

### Local evaluation

Install the [celld 0.4.1](https://github.com/denoland/celld/releases/tag/v0.4.1) binary.
Tests generate credentials in a temporary directory and start and stop celld dev.

```sh
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-test
```

`just celld-bench` compares direct HTTP and WIT calls against real celld, reporting
p50/p95/p99, RPS, and total CLI time. See [measurement conditions and usage](celld-benchmark.md).

For manual testing, copy `examples/celld-gateway/wrangler.jsonc` to `wrangler.local.json`
in the same directory and set `vars.ODEN_GATEWAY_TOKEN` to a local token.
Set the same host token in `ODEN_GATEWAY_TOKEN`.
`wrangler.local.json` and `.celld/` are excluded from Git.

```sh
chmod 600 examples/celld-gateway/wrangler.local.json
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --no-watch
# In another terminal, save the durable configuration above to runtime.json and run:
just durable-counter-build
target/debug/oden run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config runtime.json -- counter room-1 increment-1
# The same ID returns the same result. Omit the ID to read the current value.
```

Verified behavior includes direct WAT execution, real WIT updates from Rust,
binding/object isolation, concurrent increments, persistence across celld dev
restarts, and unknown outcomes plus retry deduplication when only the response is
lost after an update. Persistence here refers to local dev storage. Fleet ownership
transfer, remote durability gates, alarms/WebSockets, and running Wasmtime actors
directly inside celld have not been verified.

## Verification commands

```sh
just test                        # Node / Rust unit + component contract tests
just standalone-test             # Real WASIp2 / WASIp3 HTTP, I/O, permissions, stream cancellation
just worker-async-test           # Standard WASI node / daemon concurrent I/O, cancellation, deadlines
just e2e                         # Control plane → standard WASI HTTP
just sample-rust-moonbit-smoke    # Rust/MoonBit composition (requires MoonBit and forked wac)
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-test
```

`.cwasm` is a native artifact produced by a trusted local compiler. In addition to
the Node-side binary/config hash, the engine checks a fingerprint of source,
lockfile, target, compiler, and build flags. Recompile caches from Wasmtime 42 or
a different host build. The standalone CLI reads `.wasm` and `.wat` components;
it does not deserialize arbitrary `.cwasm` files.
