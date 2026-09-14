# Rust + MoonBit release sample

This sample builds one deployable odenctl worker from two Component Model projects:

- `rust-worker`: HTTP worker adapter for `wasi:http/service@0.3.0`
- `moonbit-ping`: MoonBit provider that exports `ping(value) -> value + 7`

The Rust worker imports `ping`, calls it from the HTTP handler, then the build links the MoonBit
component into the final worker component with the `mizchi/wac` fork. The fork contains the resource
aliasing fix needed for this WASIp3 async/resource-heavy worker world.

## Build

```sh
just wac-install
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

This compiles the composed component through `oden-host` and invokes the worker handler.

`just sample-rust-moonbit-compose-build` is kept as a rollback fallback for comparing the previous
deprecated `wasm-tools compose` output.

## WAC canary

```sh
just sample-rust-moonbit-wac-smoke
```

This builds a smaller Rust socket component from `wit/wac-caller.wit`, plugs the existing MoonBit
`bridge` provider into it with `wac plug`, and invokes `answer()`. It gives a cheap WAC toolchain
canary before running the full WASIp3 async HTTP worker composition.

## Real release smoke

```sh
ODENCTL_CONTROL_PLANE_URL=https://mz-wasmplane-control.fly.dev \
ODEN_RUNTIME_URL=https://mz-wasmplane-runtime.fly.dev \
ODENCTL_CONTROL_PLANE_TOKEN=... \
just sample-rust-moonbit-release
```

The release recipe first runs `sample-rust-moonbit-release-preflight`, then uploads the composed component, creates a deployment, points a route at
`rust-moonbit.sample.oden.local`, publishes the route snapshot, and checks the deployed runtime
with a `Host` header.
