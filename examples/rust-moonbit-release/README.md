# Rust + MoonBit release sample

This sample builds one deployable wasmplane worker from two Component Model projects:

- `rust-worker`: HTTP worker adapter for `myedge:runtime/worker@0.1.0`
- `moonbit-ping`: MoonBit provider that exports `ping(value) -> value + 7`

The Rust worker imports `ping`, calls it from the HTTP handler, then `wasm-tools compose` links the
MoonBit component into the final worker component.

## Build

```sh
just sample-rust-moonbit-build
```

The final component is written to:

```text
examples/rust-moonbit-release/target/rust-moonbit-release.component.wasm
```

## Local smoke

```sh
just sample-rust-moonbit-smoke
```

This compiles the composed component through `wasmplane-wasip3-host` and invokes the worker handler.

## Real release smoke

```sh
WASMPLANE_CONTROL_PLANE_URL=https://mz-wasmplane-control.fly.dev \
WASMPLANE_RUNTIME_URL=https://mz-wasmplane-runtime.fly.dev \
WASMPLANE_CONTROL_PLANE_TOKEN=... \
just sample-rust-moonbit-release
```

The release recipe uploads the composed component, creates a deployment, points a route at
`rust-moonbit.sample.wasmplane.local`, publishes the route snapshot, and checks the deployed runtime
with a `Host` header.
