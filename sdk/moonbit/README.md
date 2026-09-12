# MoonBit service SDK

`wasmplane init my-app --language moonbit` creates an independent project with
this SDK, the WIT contracts and a build script. Run `wasmplane dev my-app/app.json`.
Node.js 24+, MoonBit, wit-bindgen 0.62.0 and wasm-tools 1.259.0 are required.
Generated ABI bindings remain in the application's target directory.

The generated application's `@service` import provides `json`, `sleep_ms`, `log`,
`env`, `read_file(path, byte_limit)`, `write_file(path, bytes)`, and
`fetch(HttpRequest, byte_limit)`. HTTP requests specify WASI method/scheme,
authority, path, byte-valued headers and body; responses have status/headers/body.
`IoError` preserves WASI errors and distinguishes invalid paths and body limits.
File paths are absolute guest paths and may not contain `.` or `..` segments.

`durable_fetch(binding, name, request)` calls a celld object once and releases the
handle. The generated `interface/wasmplane/durable/objects` package provides its
request/response/error types. Unknown outcomes are returned without automatic retry.
All I/O is subject to the host's explicit runtime grants.

The package export `@wasmplane/moonbit-service-sdk/build` provides `build(appPath)`.
For a world that includes the standard service contract and adds imports, use
`build(appPath, { wit: "/path/to/wit", world: "my-world" })`.
The app's root `.mbt` files and `moon.pkg.json` are copied into a freshly generated
`target/generated`; additional subpackages require extending the build pipeline.
