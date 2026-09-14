# Conformance and packaging

[Developer documentation](README.md) / Verification

These checks validate oden and its SDK implementations. For testing your own
application exports, use the [user testing guide](../user/testing.md).
Run tasks from the repository root; setup and the test matrix are in
[CONTRIBUTION.md](../../CONTRIBUTION.md).

## Installer

`just installer-test` runs the installer with a real release build and verifies
the installed runtime and optional management CLI from outside the checkout.
It checks WAT execution, embedded SDK templates, worker generation, and local DB
migrations, including installation paths with spaces and quotes. Unit tests also
check overwrite protection and failed builds. See [installation](../user/installation.md)
for the public command and options.

## Component test runner and browser releases

`just test-runner-test` runs regression tests and WAT/Rust/MoonBit suites. It
starts an ephemeral HTTP peer, exercises granted and denied requests, and checks
deadlines for an upstream that never responds. No external service is required.

`just static-site-test` builds two site components and uses Playwright to verify
CLI upload, publication, browser rendering, caching, updates, and rollback.
Browser setup and reports are documented in the
[static-site example](../../examples/static-site/README.md).

## SDK I/O

`just sdk-test` checks files, environment variables, outbound HTTP, permission denials,
and body limits in both languages. It also repeats successful calls and early
cancellations in the same resident Store.
`ODEN_CELLD_BIN=/absolute/path/to/celld just sdk-celld-test` starts a disposable
celld instance and updates a Counter through the WIT adapter from both SDKs.
See the executable `/io/*` demos in [Rust](../../examples/service-rust/src/io_example.rs)
and [MoonBit](../../examples/service-moonbit/io_example.mbt).

## Telemetry

```sh
just telemetry-test
```

Tests cover context isolation across foreground/background tasks in one resident
Store, Rust/MoonBit WIT recording, unsampled requests contributing to metrics,
outgoing HTTP and durable propagation, response-body completion/cancellation,
collector outages/overflow, and real WAC composition of sync/async calls with
records, enums, variants, lists, options and tuples. The composition tests run all
four Rust/MoonBit caller/provider combinations, including non-ASCII strings,
error payloads, `tracestate`, server-to-wrapper parenting and provider log
correlation after async suspension. Durable propagation uses a
local gateway-compatible test server; remote celld span emission is not tested.

## Rename compatibility

```sh
just test
just service-test
just sdk-test
just telemetry-test
just static-site-test
```

These exercise the renamed runtime, generated Rust/MoonBit applications, WIT
composition, and a real CLI static-site deployment with browser verification and
rollback.

## Package the SDKs

Run `just sdk-pack` from the runtime source tree to produce local distribution files:

- `target/sdk-packages/oden-service-sdk-0.1.0.crate`
- `target/sdk-packages/oden-moonbit-service-sdk-0.1.0.tgz`

The Cargo package is verified by compiling its extracted contents. The MoonBit
package includes WASI and Durable Object WIT contracts as regular files.
`just sdk-test` extracts both packages outside this repository and builds generated
apps against them. These commands do not publish to a registry. For normal use,
`init` is enough to get started.
