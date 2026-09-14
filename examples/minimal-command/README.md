# Minimal CLI Component

A sample that exits successfully with `oden run`. It exports standard `wasi:cli/run@0.2.0`
and requires no host imports, environment configuration, or control plane. Standard output is empty and the exit code is `0`.
Use `run`: this is a CLI component, not an HTTP service.

Run the commands from the repository root.

## Run WAT directly

```sh
just run examples/minimal-command/command.wat
```

If the runtime is already built, only this command is needed:

```sh
target/debug/oden run examples/minimal-command/command.wat
echo $? # 0
```

The runtime parses `.wat` directly, so no prior `.wasm` conversion, wasm-tools, or MoonBit installation is required.
The input must use `(component ...)` syntax. A plain `(module ...)` does not satisfy the CLI component contract.

## Build and verify both samples

```sh
just minimal-smoke
```

Requires Rust, Node.js 24+, just, MoonBit, wasm-tools, and wit-bindgen.
Add the pinned wasm-tools / wit-bindgen versions from `scripts/install-wasm-ci-tools.sh` to PATH.
Verified with `moon 0.1.20260904` and wit-bindgen `0.62.0`.

## WAT → Wasm (to save a binary)

[`command.wat`](command.wat) uses Component Model text format and contains a core module.

```sh
just rust-build minimal-wat-build
target/debug/oden run examples/minimal-command/target/wat.wasm
echo $? # 0
```

The core function's `i32.const 0` represents `ok(())` in the WIT `result` type.

## MoonBit → Wasm

The application is the three lines in [`command.mbt`](command.mbt).
[`command.wit`](command.wit) is a minimal definition of the standard WASI CLI entry point.
Bindings and MoonBit package configuration are generated in `target/moonbit/` during the build.

```sh
just rust-build minimal-moonbit-build
target/debug/oden run examples/minimal-command/target/moonbit.wasm
echo $? # 0
```

The pipeline is `.mbt → core Wasm → WIT metadata embedding → component Wasm`.
Run the final `target/moonbit.wasm`. No Rust guest or WAC is required.
All generated files go in the Git-ignored `target/` directory.
