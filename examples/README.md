# Examples

Start with the [user guide](../docs/README.md). Run the recipes below from the
repository root; build artifacts stay under each example's `target/` directory.

| Example | Languages | Learn | Build or verify |
| --- | --- | --- | --- |
| [Exported test suites](testing/README.md) | WAT, Rust, MoonBit | Language-neutral tests, isolation, async workers, and outbound HTTP | `just test-runner-test` |
| [Minimal commands](minimal-command) | WAT, MoonBit | The smallest CLI components; direct WAT input | `just minimal-smoke` |
| [Resident Rust service](service-rust) | Rust | HTTP, persistent in-memory state, lifecycle, timers, I/O, telemetry | `just service-rust-build` |
| [Resident MoonBit service](service-moonbit) | MoonBit | The same service contract and host capabilities | `just service-moonbit-build` |
| [Standard HTTP](standard-http) | Rust | Fresh instances with WASI HTTP P2 | `just standalone-http-build` |
| [Standard HTTP P3](standard-http-p3) | Rust | Async HTTP and streaming | `just standalone-http-p3-build` |
| [Durable counter](durable-counter) and [celld gateway](celld-gateway) | Rust, WAT, JavaScript | WIT-based calls into celld Durable Objects | `just durable-counter-build`; see the [celld guide](../docs/durable-objects.md) |
| [Telemetry composition](telemetry-composition) | Rust, MoonBit | WAC composition and trace propagation across language boundaries | `just telemetry-test` |

The resident services are conformance fixtures and include intentional trap,
loop, and error routes. Keep them intact for the repository tests. For an editable
application, use `wasmplane init`, then follow [writing services](../docs/writing-services.md).
For the stateless AWS deployment sample with `/healthz`, see
[first service deployment](../docs/operations.md).
