# Developer documentation

These guides are for contributors changing oden and odenctl. Start with
[CONTRIBUTION.md](../../CONTRIBUTION.md) for checkout setup, TDD, test selection,
and pull requests. For building applications or operating a deployment, use
the [user documentation](../user/README.md).

| Task | Guide |
| --- | --- |
| Build or change either product independently | [Product workspaces](workspaces.md) |
| Understand runtime and control-plane architecture | [Architecture and decisions](architecture.md) |
| Change Wasmtime integration, Store lifetime, or the node protocol | [Standalone runtime internals](standalone-runtime.md) |
| Change resident lifecycle, manifests, or SDK generation | [Service runtime contract](service-runtime.md) |
| Verify SDK I/O, telemetry, generated packages, and component tests | [Conformance and packaging](verification.md) |
| Reproduce platform prototypes, benchmarks, and composition CI | [Control-plane implementation and verification](control-plane-reference.md) |
| Measure fresh/resident execution and sustained load | [Service benchmarks](service-benchmark.md) |
| Measure the celld WIT adapter | [celld benchmarks](celld-benchmark.md) |
| Evaluate engine changes and celld integration | [Runtime direction](runtime-direction.md) |
| Design cache, dynamic component, and image APIs | [Edge platform proposal](edge-platform.md) |
| Find planned implementation work | [Backlog](roadmap.md) |

These documents include implementation details and proposals. A proposal does
not make a feature available to users. Update the corresponding user guide when
an implementation changes behavior, configuration, or compatibility.

Run repository tasks from the checkout root. Keep user guides in `docs/user`,
implementation/design/verification material in `docs/developer`, and link each
new page from the appropriate index.
