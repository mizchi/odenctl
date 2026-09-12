# wasmplane-service-sdk

A self-contained Rust SDK for WASI HTTP services with asynchronous lifecycle hooks.
Build guest applications with `cargo build --target wasm32-wasip2`.
The package includes its lifecycle and Durable Object WIT contracts.

`wasmplane init my-app --language rust` creates an independent application with
a vendored copy of this SDK. `wasmplane build my-app/app.json` builds the component.
The runtime repository is not needed after generation.

Implement `Lifecycle` and `HttpHandler`, then invoke `wasmplane_service_sdk::export!(App)`.
`json(String)` returns an HTTP response and `sleep_ms(u64).await` drives async timers.

The `io` module provides `env`, `read_file(path, byte_limit)`, `write_file(path, bytes)`
and `fetch(HttpRequest, byte_limit)`. Requests specify a WASI method, scheme,
authority, path, byte-valued headers and body. Responses contain status, headers
and body. `IoError` preserves filesystem/HTTP errors and distinguishes body limits.
File paths are absolute guest paths and may not contain `.` or `..` segments.

`durable::fetch(binding, name, Request).await` calls a celld object once and drops
its handle. It preserves `Error::OutcomeUnknown` and never retries automatically.
Environment variables, directory preopens, outbound origins and durable bindings
must be explicitly granted by the application's runtime configuration.
