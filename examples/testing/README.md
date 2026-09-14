# Exported tests in WAT, Rust, and MoonBit

These examples use the built-in `oden test` runner. Rust and MoonBit implement
the same [WIT interface](wit/suite.wit) with seven tests each:

| Test | Demonstrates |
| --- | --- |
| `arithmetic-test` | Test application logic through `result<_, string>` |
| `validation-test` | Reject quantities outside 1..1000 |
| `state-first-test`, `state-second-test` | A fresh instance for each test |
| `timer-test` | Await the WASI P3 clock and return `result` |
| `background-test` | Spawn and await a worker before returning |
| `http-test` | Fetch a bounded response with explicit environment and origin grants |

Run commands from the repository root. See [testing](../../docs/user/testing.md) for
the full discovery, failure, and isolation contract.

## WAT: no guest compiler required

```sh
just component-test examples/testing/basic.wat
```

This runs three passing tests directly from `(component ...)` text.

## Build Rust and MoonBit

Install the [development toolchains](../../docs/user/getting-started.md), including
`moon`, `wasm-tools`, and Rust's `wasm32-wasip2` target. The recipe installs the
pinned `wit-bindgen` 0.62.0 locally when needed.

```sh
just rust-build
just test-examples-build

target/debug/oden test examples/testing/rust/target/wasm32-wasip2/debug/exported_tests.wasm --list
target/debug/oden test examples/testing/moonbit/target/tests.wasm --list
```

The Rust target is named `wasm32-wasip2`, while its WIT bindings use WASI P3 async.
MoonBit generates bindings under `target/generated`; edit `implementation.mbt`,
`pricing.mbt`, and the shared WIT instead. Neither component is an HTTP server or
command: it is a test suite with explicit exported entry points.

Pure logic, instance isolation, and async clock/background tests need no grants:

```sh
target/debug/oden test examples/testing/rust/target/wasm32-wasip2/debug/exported_tests.wasm --filter arithmetic
target/debug/oden test examples/testing/moonbit/target/tests.wasm --filter background
```

## Run all seven tests, including HTTP

Start the local upstream in another terminal:

```sh
node examples/testing/upstream.mjs
```

Then grant access using the checked-in runtime configuration:

```sh
target/debug/oden test examples/testing/rust/target/wasm32-wasip2/debug/exported_tests.wasm \
  --config examples/testing/runtime.json
target/debug/oden test examples/testing/moonbit/target/tests.wasm \
  --config examples/testing/runtime.json --json
```

Both suites fetch `GET /greeting`, require HTTP 200, and compare the UTF-8 response
with `EXAMPLE_GREETING`. The SDK buffers at most 1024 bytes. Without the config,
`http-test` fails on missing environment variables. Removing `outbound_origins`
causes a permission failure. Stop the upstream with Ctrl-C when finished.

For an automated run with an ephemeral port and cleanup:

```sh
just test-runner-test
```
