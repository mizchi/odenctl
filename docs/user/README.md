# User documentation

For application authors and operators using oden and odenctl. To change the
runtime or platform itself, use the [developer documentation](../developer/README.md).

oden runs Wasm components as commands, HTTP servers, or resident services that
retain state. You can write applications in Rust or MoonBit and run them locally
without setting up a control plane or database.

Start with the **[Quickstart](getting-started.md)** to build the runtime and run a
minimal WAT command and a resident HTTP service.

Use **[Deploy with odenctl](control-plane.md)** for projects, artifact upload, route
publication, and the Node deployment gateway. `oden dev app.json` watches a local
application; `pnpm odenctl dev` prepares a preview against running platform services.

## Find a guide

| Task | Guide |
| --- | --- |
| Install or update the runtime and optional management CLI | [Installation](installation.md) |
| Upgrade from the wasmplane names | [Rename and migration](rebranding.md) |
| Install the runtime and run examples | [Quickstart](getting-started.md) |
| Start the control plane and deploy a component | [Deploy with odenctl](control-plane.md) |
| Configure platform APIs, storage, publication, and quotas | [Control-plane reference](control-plane-reference.md) |
| Write a Rust or MoonBit service | [Writing services](writing-services.md) |
| Run exported component tests in any language | [Testing](testing.md) |
| Browse runnable WAT, Rust, and MoonBit examples | [Examples](../../examples/README.md) |
| Use files, environment variables, and outbound HTTP | [Shared I/O SDK](sdk-io.md) |
| Trace requests, background tasks, and composed components | [Built-in telemetry](telemetry.md) |
| Prepare, deploy, observe and recover a service | [First service deployment](operations.md) |
| Configure commands, ports, environment variables, and permissions | [CLI and configuration reference](configuration.md) |
| Keep state across restarts | [celld Durable Objects](durable-objects.md) |
| Cache public responses in the deployment gateway | [Deployment response cache](response-cache.md) |
| Test a static site release and rollback in a browser | [Static site release test](../../examples/static-site/README.md) |
| Diagnose startup, reload, or request failures | [Troubleshooting](troubleshooting.md) |

## Choose an execution mode

| Use case | Command | Manifest mode | State and lifetime |
| --- | --- | --- | --- |
| Batch jobs and CLI tools | `oden run app.wasm` | `command` | Runs once and exits |
| Independent HTTP request handling | `oden serve app.wasm` | `http` | Creates a new instance for each request |
| HTTP apps with state or background tasks | `oden serve app.wasm --resident` | `service` | Keeps one instance from startup to shutdown |

During development, `oden dev app.json` combines building, running, and watching
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

Runtime guides cover the Rust `oden` binary and `app.json`. Deployment guides cover
`pnpm odenctl`, the control API, and the Node gateway. The standalone runtime does
not need a control-plane database. A deployment node uses standard HTTP components
and fresh instances; it does not apply a standalone application's resident lifecycle
or grant its configured filesystem/celld access.
Run commands from the repository root unless a guide says otherwise.

The execution engine is pinned to Wasmtime 48.0.2. These guides describe available
behavior and limits. Writing applications with the SDK and testing their exported
functions are covered here; repository conformance tests and design proposals
are covered by the developer documentation.

For AWS hosting, see [Standalone runtime on ECS/Fargate](../../infra/terraform/aws-standalone/README.md), including local Terraform validation with kumo.
