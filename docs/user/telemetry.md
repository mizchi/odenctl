# Built-in telemetry

The Rust runtime records HTTP requests, queue waits, component compilation and
instantiation, resident lifecycle hooks, outgoing HTTP and Durable Objects calls.
Command execution records its exit code and includes a child instantiation span.
Guest applications can add spans and structured logs through the versioned
[`oden:telemetry/tracing@0.1.0`](../../sdk/rust/wit/telemetry.wit) WIT interface.
Rust and MoonBit use the same contract. Existing components need no new imports
to receive host instrumentation.

## Configure export

In `app.json`, put these settings under `runtime` (or use them directly in the
JSON passed to `oden serve --config`):

```json
{
  "telemetry": {
    "service_name": "counter-service",
    "endpoint": "http://127.0.0.1:4318",
    "queue_capacity": 2048,
    "batch_size": 128,
    "interval_ms": 1000,
    "export_timeout_ms": 1000,
    "sample_rate": 0.1
  }
}
```

`endpoint` is a base URL: the worker appends `/v1/traces`, `/v1/logs` and
`/v1/metrics`. The transport is OTLP/HTTP JSON. It does not implement gRPC or
protobuf transport. No collector is contacted if the endpoint is absent.
Counters remain available through the Rust `Runtime.telemetry.snapshot()` API.
Set `enabled: false` to disable recording, including guest recording.

The CLI also reads `OTEL_EXPORTER_OTLP_ENDPOINT` when no endpoint is configured,
`OTEL_SERVICE_NAME`, and `OTEL_SDK_DISABLED=true`. To supply collector credentials,
set `headers_env` to the name of a host environment variable containing
`header=value,header=value` pairs. `OTEL_EXPORTER_OTLP_HEADERS` is the default when
present. Header values are literal, not URL-decoded. These credentials are not
automatically exposed to guest environments. Signal-specific OTEL endpoint
and sampler variables are not currently interpreted; use the configuration above.

The repository's [Collector configuration](../../otelcol/config.yaml) accepts all
three signals. It exposes runtime metrics through Prometheus and logs/traces via
the debug exporter. Configure a storage exporter for retention. The existing
spanmetrics connector remains for the TypeScript runtime; use the direct Rust
HTTP histograms for request statistics when traces are sampled.

## Execution and completion

An HTTP server span begins when Hyper dispatches the request and ends when the
response body is consumed by Hyper, fails, or is dropped. This measures transfer
to the server transport, not acknowledgement by the remote client. A streaming
response remains open after the component returns its response resource. Partial
body cancellation is recorded once, with the bytes observed so far.

The runtime records component execution separately from HTTP transmission.
Resident services also record queue waits and lifecycle start/stop. Their
existing buffered response and serial admission behavior is unchanged. Client
HTTP spans end when response headers arrive; they do not include consumption of
the response body. Durable calls cover the complete buffered gateway operation,
and preserve `outcome-unknown` rather than reporting that a timed-out mutation
necessarily failed. Telemetry does not retry actor requests.

Duration histograms use seconds and monotonic elapsed time. HTTP metrics include
bounded method/status dimensions. Guest span names, paths, request IDs and object
IDs do not become metric labels. No route template is invented for components
whose routing is opaque to the host. Runtime metrics are computed independently
of trace sampling. Live Store/queue counts describe runtime objects; the runtime
does not attribute host RSS or CPU time to nested component instances.

## Explicit contexts in Rust

Capture the host context at your HTTP entry point and pass it to work explicitly:

```rust
use oden_service_sdk::telemetry as t;

let parent = t::from_request(&request);
if let Some(span) = t::start_span(parent.as_ref(), "orders.validate") {
    let context = span.context();
    t::log(Some(&context), t::Level::Info, "validation started", &[]);
    // Move a clone of `context` into each async task that needs this parent.
    span.end(t::Outcome::Ok);
}
```

`io::fetch_traced(&context, request, limit)` and
`durable::fetch_traced(&context, binding, name, request)` inject this context.
The host creates a client span and forwards its context to the remote service.
For celld it is forwarded in both the gateway transport headers and actor request
headers. A celld-side tracing implementation is required to emit remote spans.

`telemetry::background(name, origin)` creates an independent root span linked to
the origin. Plain `start_span` creates a child. A child may outlive its parent;
there is no mutable current-span slot on the shared Store. Calls made without
context start independent traces; the host never guesses which request caused
an unrelated background operation.

Dropping a span without calling `end` records cancellation. Repeated `end` calls
have no effect. `start_span` returns `None` when disabled or when 256 live guest
span handles already exist in that Store. Always release handles after ending
them. The resource table also releases unfinished spans when a Store is destroyed.

## Explicit contexts in MoonBit

The SDK requires `wit-bindgen` 0.62.0; `just service-moonbit-build` installs it in
`target/telemetry-tools`. Packaged SDK users can set `WIT_BINDGEN` to its path.

```moonbit
let context = @service.trace_context(request)
if @service.trace_start(context, "orders.validate") is Some(span) {
  defer span.drop()
  @service.trace_log(Some(span.context()), "validation started")
  span.end(OK)
}
```

Use `fetch_traced`, `durable_fetch_traced` and `trace_background` for the same
behavior as Rust. Capture the context in the closure passed to `spawn_bg`.
The generated `tracing` bindings expose all levels, attributes and events;
`trace_log` is an INFO-level convenience helper. See the working
[Rust](../../examples/service-rust/src/telemetry_example.rs) and
[MoonBit](../../examples/service-moonbit/telemetry_example.mbt) examples.

## Instrument composed WIT boundaries

Generate and compile a wrapper for one exported interface, plug the provider
into it, and optionally plug the result into an application:

```sh
just telemetry-compose-build
just telemetry-compose \
  target/telemetry-example/wasm32-wasip2/debug/telemetry_provider.wasm \
  example:boundary/operations@0.1.0 \
  target/telemetry-composed.wasm \
  --app target/telemetry-example/wasm32-wasip2/debug/telemetry_composed_app.wasm
```

The output is an ordinary component accepted by `oden serve --resident`.
Its `.telemetry.json` companion identifies the generated source directory and
selected interface. Bindings and forwarding code are regenerated from WIT;
the provider and its signatures are preserved.

`telemetry-compose-build` also builds a MoonBit
[application](../../examples/telemetry-composition/moonbit/app/app.mbt) and
[provider](../../examples/telemetry-composition/moonbit/provider/implementation.mbt)
against that same boundary WIT. Either side can be Rust or MoonBit; the generated
instrumentation wrapper is Rust in all cases. To compose both MoonBit components:

```sh
just telemetry-compose \
  examples/telemetry-composition/moonbit/provider/target/provider.wasm \
  example:boundary/operations@0.1.0 \
  target/telemetry-moonbit-composed.wasm \
  --app examples/telemetry-composition/moonbit/app/target/service.wasm
```

Use `just telemetry-moonbit-build` to rebuild only the MoonBit fixtures. Their
editable WIT and MoonBit sources remain separate from generated bindings under
`target`. The MoonBit service builder accepts `{ wit, world }` to extend the
standard service world with application-specific imports.

A parameter named `context` that uses the shared WIT `tracing.context` type
supplies the parent. The wrapper forwards its own span context to the provider.
Use `--context-param other-name` to select another parameter. Without such a
parameter, the wrapper records an independent trace instead of inferring an
ambient parent. WIT `result` errors set the boundary span's error status.

The generator supports synchronous/asynchronous freestanding functions with
primitive values, strings, records, enums, variants, tuples, lists, options and
results. Resources, resource methods, flags, streams and futures are rejected:
wrapping their lifetimes requires a dedicated adapter. A successful generation
does not imply arbitrary component internals or guest function names are visible
to the host. Compose selected interfaces where the extra span is useful.

## Bounds and failure behavior

The host owns a bounded queue and a dedicated export worker. Guest calls never
wait for collector I/O. Queue overflow drops records and increments
`oden.telemetry.dropped`; export failures increment
`oden.telemetry.export_errors`. Failed batches are discarded, without an
unbounded retry buffer. Graceful CLI shutdown attempts a bounded flush. Forced
process termination can lose queued telemetry.

Each span accepts up to 32 supplied attributes and 32 events, plus runtime outcome
attributes. Links are capped at 8; strings are truncated.
The built-in HTTP instrumentation records neither bodies nor authorization
headers. Guest structured log calls explicitly record their supplied messages,
so application authors should avoid putting credentials in those messages.
Guest stdout/stderr remain ordinary WASI output and are not automatically
assigned to whichever HTTP request happens to be active.

This is a versioned oden API, not a claim of stable WASI Observe support.
See [WASI Observe](https://github.com/WebAssembly/wasi-observe),
[W3C Trace Context](https://www.w3.org/TR/trace-context/) and
[OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).

Repository conformance checks are documented in
[developer verification](../developer/verification.md).
