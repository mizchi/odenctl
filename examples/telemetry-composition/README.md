# Telemetry across composed components

The shared [`operations` WIT](wit/boundary.wit) exposes a synchronous echo and an
asynchronous operation returning `result<payload, string>`. Both Rust and MoonBit
implement the provider and the HTTP application. The application checks nested
records, enums, variants, lists, options, tuples and non-ASCII strings on both
calls. The provider suspends on a WASI timer before logging with its received
trace context; zero input returns an error.

The generated Rust wrapper records each boundary call, forwards its child context
and preserves return values and errors. WAC produces a single resident component.

```sh
just telemetry-compose-build
just telemetry-compose \
  examples/telemetry-composition/moonbit/provider/target/provider.wasm \
  example:boundary/operations@0.1.0 \
  target/telemetry-moonbit-composed.wasm \
  --app examples/telemetry-composition/moonbit/app/target/service.wasm
target/debug/wasmplane serve target/telemetry-moonbit-composed.wasm --resident
```

Run `just rust-build` first if the host executable has not been built. Set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` to export telemetry.
Request `/` for success and `/error` for the provider error path.

`just telemetry-test` verifies the following combinations with an OTLP receiver:

| Application | Provider |
| --- | --- |
| Rust | Rust |
| Rust | MoonBit |
| MoonBit | Rust |
| MoonBit | MoonBit |

MoonBit fixtures use [`moonbit/worlds.wit`](moonbit/worlds.wit), which imports the
same boundary and service contracts. The build script resolves those contracts
into `moonbit/target/wit` and regenerates ABI bindings in each fixture's `target`.
Edit [`moonbit/provider/implementation.mbt`](moonbit/provider/implementation.mbt)
or [`moonbit/app/app.mbt`](moonbit/app/app.mbt), then run
`just telemetry-moonbit-build`. No generated ABI code needs manual changes.
