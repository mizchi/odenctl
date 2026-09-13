# Testing Component Exports

[User guide](README.md) / Testing

`wasmplane test` discovers exported functions whose WIT names end in `-test` and
executes them in Wasmtime. The same convention works for WAT, Rust, MoonBit, and
other languages that produce components. No test framework import is required.

```sh
just component-test examples/testing/basic.wat
```

The example runs three tests, including two that verify instance isolation.
See [runnable examples](../examples/testing/README.md) for Rust, MoonBit, async
background work, and outbound HTTP.

## Export contract

Add test functions to your WIT world or an exported interface:

```wit
package example:app-tests;

interface checks {
  arithmetic-test: func() -> result<_, string>;
  state-test: func();
  timer-test: async func() -> result;
}

world suite {
  export checks;
}
```

| Signature | Pass | Fail |
| --- | --- | --- |
| `func()` | Returns normally | Trap or deadline |
| `func() -> result` | Returns `ok` | Returns `err`, traps, or exceeds deadline |
| `func() -> result<_, string>` | Returns `ok` | Returns `err(message)`, traps, or exceeds deadline |

Each signature also supports `async func`. Tests cannot take parameters or return
arbitrary values. A matching export with an unsupported signature is a failed test,
including during `--list`. WASI `exit`, even with status 0, fails the test because
the test function did not return successfully.

Discovery examines top-level component functions and functions within exported
interfaces, recursively. It ignores unrelated exports, unexported language functions,
and core Wasm module exports. Paths such as
`example:testing/checks@0.1.0/arithmetic-test` identify interface functions.
Tests run sequentially in lexicographic path order.

In Rust and MoonBit source, the corresponding function is typically named
`arithmetic_test`. The runner reads **the WIT export name** `arithmetic-test`;
source naming alone does not export a test. Rust `#[test]` and MoonBit `test` blocks
continue to use their own language test runners.

## Commands and output

```sh
wasmplane test tests.wasm
wasmplane test tests.wat --list
wasmplane test tests.wasm --filter arithmetic-test
wasmplane test tests.wasm --config runtime.json --timeout-ms 2000 --json
```

| Option | Behavior |
| --- | --- |
| `--list` | Compile, discover, and check signatures without instantiating or calling guest code |
| `--filter text` | Select paths containing the case-sensitive substring |
| `--json` | Write one JSON report to stdout |
| `--config runtime.json` | Apply the normal runtime permissions and limits |
| `--timeout-ms N` | Override the per-test deadline regardless of option order; default 30000 ms |

The input is one `.wasm` component or `.wat` component text file. Build source
files first. Manifests, directories, and globs are not inputs to this command.
For WAC compositions, discovery sees the final component's public exports; keep
the test interface exported when composing.

Exit status is 0 when at least one test matches and every selected test passes
(or every listed signature is valid). It is 1 for a failed test, invalid input,
configuration or linking failure, or zero matches. A failed test does not stop the
remaining tests. SIGINT and SIGTERM cancel execution and exit with 130 and 143.

JSON reports have `schema_version: 1`, `passed`, `failed`, and a `tests` array.
Each entry includes `name`, `asynchronous`, `status` (`passed`, `failed`, or
`listed`), `duration_ms`, and an `error` string on failure. Listing does not count
entries as passed. Durations cover per-test preparation and execution, excluding
component compilation and shared linking. Fatal input/configuration/link errors
are printed to stderr without a test report; zero matches produces an empty report
and a stderr diagnostic.

Guest stdout is discarded so it cannot corrupt the JSON report. Guest stderr is
inherited. Write useful assertion details in `err(message)`; use stderr for extra
diagnostics. Normal runtime telemetry configuration also applies, with a `test.run`
span for each executed test. Guest span context propagation is still explicit.

## Isolation and async lifetime

The runtime compiles the component once and creates a **new Store and instance
for every test**. Memories, globals, guest resource handles, and unfinished guest
tasks are discarded after each test. Both instantiation and invocation are covered
by the per-test deadline. CPU loops yield to the runtime's epoch interrupt, and
suspended async I/O is cancelled when its Store is dropped.

The runner does not call `wasi:cli/run` or service lifecycle `start`/`stop` hooks.
Core Wasm start functions still run as part of normal instantiation. Tests must
perform their own initialization and await any background work they need to
verify; returning does not wait for detached work.

Host files, external services, and Durable Objects are **not reset** between
tests. Use disposable paths, object names, and local peers for integration tests.
Capabilities are denied by default using the same policy as `run` and `serve`:
grant environment variables, preopened directories, outbound origins, and durable
bindings explicitly. `--list` does not validate host linkage or access resources.

## Keep tests alongside application logic

Separate business logic from the generated bindings. Export test functions from
a dedicated test world that calls this logic, and build the production component
from a world without those test exports. The
[Rust pricing example](../examples/testing/rust/src/pricing.rs) and
[MoonBit pricing example](../examples/testing/moonbit/pricing.mbt) demonstrate this
separation using the same [WIT contract](../examples/testing/wit/suite.wit).

Use `wasmplane test` for component-level assertions and host integration. Keep
HTTP-level tests for routing, request/response behavior, and service lifecycle;
the existing `just service-test` and `just sdk-test` cover those boundaries.

Run the runner regression tests and all three language examples with:

```sh
just test-runner-test
```

This starts an ephemeral local HTTP peer, exercises granted and denied requests,
and verifies the deadline for an upstream that never responds. No external service
or celld process is required.
