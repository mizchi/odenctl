# wasmplane User Guide

wasmplane runs Wasm components as commands, HTTP servers, or resident services that
retain state. You can write applications in Rust or MoonBit and run them locally
without setting up a control plane or database.

Start with the **[Quickstart](getting-started.md)** to build the runtime and run a
minimal WAT command and a resident HTTP service.

## Find a guide

| Task | Guide |
| --- | --- |
| Install the runtime and run examples | [Quickstart](getting-started.md) |
| Write a Rust or MoonBit service | [Writing services](writing-services.md) |
| Run exported component tests in any language | [Testing](testing.md) |
| Browse runnable WAT, Rust, and MoonBit examples | [Examples](../examples/README.md) |
| Use files, environment variables, and outbound HTTP | [Shared I/O SDK](sdk-io.md) |
| Trace requests, background tasks, and composed components | [Built-in telemetry](telemetry.md) |
| Compare fresh/resident performance and sustained load | [Service benchmarks](service-benchmark.md) |
| Prepare, deploy, observe and recover a service | [First service deployment](operations.md) |
| Configure commands, ports, environment variables, and permissions | [CLI and configuration reference](configuration.md) |
| Keep state across restarts | [celld Durable Objects](durable-objects.md) |
| Diagnose startup, reload, or request failures | [Troubleshooting](troubleshooting.md) |
| Measure celld calls | [celld benchmarks](celld-benchmark.md) |

## Choose an execution mode

| Use case | Command | Manifest mode | State and lifetime |
| --- | --- | --- | --- |
| Batch jobs and CLI tools | `wasmplane run app.wasm` | `command` | Runs once and exits |
| Independent HTTP request handling | `wasmplane serve app.wasm` | `http` | Creates a new instance for each request |
| HTTP apps with state or background tasks | `wasmplane serve app.wasm --resident` | `service` | Keeps one instance from startup to shutdown |

During development, `wasmplane dev app.json` combines building, running, and watching
for changes. `app.json` specifies the component path, execution mode, build commands,
and permissions.

A *component* is a Wasm execution unit that exports or imports functions defined by
standard WASI or WIT contracts. Pass a `.wasm` file or a `.wat` file in `(component ...)`
format to the runtime. Compile `.rs` or `.mbt` source into a component with the
language's tools first. Direct JavaScript/TypeScript execution, Node.js API
compatibility, and npm package compatibility are not currently implemented.

Resident services reset their in-memory state on restart. They process HTTP requests
serially and buffer request and response bodies within the configured limits.
For streaming, consider `http` mode, which creates an independent instance per
request. Request deadlines still apply. See [execution limits](configuration.md#execution-limits).

## Scope

This guide covers the Rust `wasmplane` binary in this repository.
`pnpm wasmplane` is a separate CLI for managing the control plane.
Run commands from the repository root unless a guide says otherwise.

The execution engine is pinned to Wasmtime 48.0.2. These guides describe the current
implementation and its limits. For internals, see the [standalone runtime](standalone-runtime.md),
[service runtime](service-runtime.md), and [runtime direction](runtime-direction.md).

For AWS hosting, see [Standalone runtime on ECS/Fargate](../infra/terraform/aws-standalone/README.md), including local Terraform validation with kumo.
