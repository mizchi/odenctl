# Shared I/O SDK

[User guide](README.md) / Shared I/O SDK

The Rust and MoonBit SDKs bundled by `oden init` provide standard WASI access
to environment variables, files, and outbound HTTP, plus celld Durable Objects.
Configure permissions in the application's [manifest](configuration.md#granting-permissions).

## API mapping

| Operation | Rust | MoonBit |
| --- | --- | --- |
| Read an environment variable | `io::env(name)` → `Option<String>` | `@service.env(name)` → `String?` |
| Read a file | `io::read_file(path, limit).await` → `Result<Vec<u8>, IoError>` | `@service.read_file(path, limit)` → `Result[Bytes, IoError]` |
| Replace a file's contents | `io::write_file(path, bytes).await` | `@service.write_file(path, bytes)` |
| Send an HTTP request | `io::fetch(HttpRequest, limit).await` | `@service.fetch(HttpRequest, limit)` |
| Call a Durable Object | `durable::fetch(binding, name, Request).await` | `@service.durable_fetch(binding, name, request)` |

Import Rust's `io` and `durable` modules from `oden_service_sdk`.
MoonBit's `@service` alias is already configured in the generated `moon.pkg.json`.
The limits for `read_file` and `fetch` are in **bytes**. Both helpers buffer the
entire body. If it exceeds the limit, they close the remaining stream and return
`BodyTooLarge`. Use the SDK's standard WASI stream APIs to process larger data incrementally.

`IoError` distinguishes `InvalidPath`, `NotPreopened`, `BodyTooLarge`,
`File(WASI error-code)`, `Http(WASI HTTP error-code)`, `InvalidRequest`, and
`Header(header-error)`. Durable Object calls preserve their dedicated WIT error type.

## Files and environment variables

Add permissions to the manifest's `runtime` field. Create `./data` beside the manifest.

```json
{
  "env": { "APP_MODE": "development" },
  "directories": [{ "host": "./data", "guest": "/data", "write": true }]
}
```

In Rust:

```rust
use oden_service_sdk::io;

async fn save() -> Result<Vec<u8>, io::IoError> {
    let mode = io::env("APP_MODE").unwrap_or_else(|| "unknown".into());
    io::write_file("/data/mode.txt", mode.into_bytes()).await?;
    io::read_file("/data/mode.txt", 4096).await
}
```

For UTF-8 in MoonBit, add `"moonbitlang/core/encoding/utf8"` to the imports in your
app's `moon.pkg.json`.

```moonbit
async fn save() -> Result[Bytes, @service.IoError] {
  let mode = @service.env("APP_MODE").unwrap_or("unknown")
  match @service.write_file("/data/mode.txt", @utf8.encode(mode)) {
    Err(error) => Err(error)
    Ok(_) => @service.read_file("/data/mode.txt", 4096)
  }
}
```

Paths are absolute guest paths. Paths containing `.` or `..` segments or NUL are
rejected. The helpers select the preopen with the longest matching prefix and do
not fall back to another preopen if access fails. They do not open a file that is
itself a symlink. Traversal through parent directories is subject to the host's
WASI filesystem access control.

`write_file` truncates an existing file before writing. It does not create parent
directories, perform an atomic replacement, or call fsync. Use standard WASI
descriptor APIs when you need those operations.

## Outbound HTTP

Allow the destination in `runtime.outbound_origins`:

```json
{ "outbound_origins": ["https://example.com"] }
```

Like WASI, `HttpRequest` takes separate scheme, authority, and path fields.
It does not automatically parse URLs or follow redirects.

```rust
use oden_service_sdk::{io, types};

async fn load() -> Result<io::HttpResponse, io::IoError> {
    io::fetch(io::HttpRequest {
        method: types::Method::Get,
        scheme: types::Scheme::Https,
        authority: "example.com".into(),
        path: "/".into(),
        headers: vec![],
        body: vec![],
    }, 64 * 1024).await
}
```

```moonbit
async fn load() -> Result[@service.HttpResponse, @service.IoError] {
  @service.fetch({
    method_: Get, scheme: Https, authority: "example.com", path: "/",
    headers: [], body: b"",
  }, 64 * 1024)
}
```

Responses contain `status`, `headers`, and `body`. HTTP statuses such as 404 and
503 are returned as ordinary responses; connection failures and stream errors
return `Err`. Header values are byte arrays, not strings. The helper waits for
body transmission and receipt, then releases header, trailer, and stream resources
before returning. Time spent waiting on outbound I/O counts toward the request deadline.

## Durable Objects

After [setting up celld and its bindings](durable-objects.md), call it through the
SDK helper. WIT contracts and bindings are bundled with the SDK; no custom code
generation configuration is required.

```rust
use oden_service_sdk::durable;

async fn increment() -> Result<durable::Response, durable::Error> {
    durable::fetch("counter", "my-counter", durable::Request {
        method: "POST".into(), path: "/increment".into(),
        headers: vec![], body: vec![], request_id: Some("update-1".into()),
    }).await
}
```

To name the generated types explicitly in MoonBit, add this import to your app:

```json
{ "path": "oden/service-sdk/interface/oden/durable/objects", "alias": "objects" }
```

```moonbit
async fn increment() -> Result[@objects.Response, @objects.Error_] {
  @service.durable_fetch("counter", "my-counter", {
    method_: "POST", path: "/increment", headers: [], body: [],
    request_id: Some("update-1"),
  })
}
```

The helper opens the object, dispatches one fetch, and releases the handle.
It never retries automatically, including on `OutcomeUnknown`. The fixed request ID
above is an example for testing retries. Use a different ID for each distinct update,
and make sure the object implements deduplication.

Repository conformance checks are documented in
[developer verification](../developer/verification.md).
