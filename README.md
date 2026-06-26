# wasmplane

`wasmplane` is an early control plane for a WIT-defined Wasm hosting platform.
The MVP follows the design memo in `/Users/mz/Downloads/wasi-edge-worker-platform-design.md`:

- WIT is the platform contract.
- Deployments are immutable.
- Routes are mutable pointers to deployments, so rollback is a pointer update.
- The initial runtime backend is Wasmtime with WASIp3.
- Workers do not receive arbitrary filesystem, socket, process, or env access.
- Request hot paths should consume compact route snapshots, not query the product DB.

## Run

```sh
just test
pnpm start
just runtime
```

The control plane listens on `http://127.0.0.1:8787` by default and stores state in
`wasmplane.sqlite`. Set `WASMPLANE_DB`, `HOST`, or `PORT` to override this. Set
`WASMPLANE_RUNTIME_NODES` to a comma-separated list of runtime node base URLs when using
`POST /snapshots/routes/publish`.

The runtime node listens on `http://127.0.0.1:8788` by default. Set `RUNTIME_HOST`,
`RUNTIME_PORT`, or `WASMPLANE_CACHE_DIR` to override this.

Runtime-oriented tests expect these CLIs on `PATH`:

- `wasmtime`
- `wasm-tools`
- `wit-bindgen`

The runtime supervisor code currently prepares deployments by resolving a route snapshot,
materializing `file://` artifacts, verifying their `sha256` digest, validating the component
through the Rust `wasmplane-wasip3-host` linker, and precompiling through that same host binary.
Strict `wasm-tools component targets` validation is available as an opt-in backend setting, but it
is not the default because WASI-adapted Rust components include additional WASI imports that the
host linker satisfies.

The real guest example can be rebuilt and invoked through the Rust Wasmtime host:

```sh
just guest-invoke
```

`guest-build` uses a WASI preview1 reactor adapter when turning the Rust guest's
`wasm32-wasip1` core module into a component. Override `WASI_PREVIEW1_ADAPTER` if the default
local adapter path does not exist.

Runtime node endpoints:

- `GET /__runtime/healthz`
- `PUT /__runtime/snapshots/routes`
- any other path: resolve by `x-forwarded-host` or `host`, prepare the component, then invoke it
  through `wasmplane-wasip3-host`.

## API

```sh
curl -X POST http://127.0.0.1:8787/projects \
  -H 'content-type: application/json' \
  -d '{"name":"hello"}'
```

Available endpoints:

- `POST /projects`
- `POST /artifacts`
- `POST /deployments`
- `PUT /routes`
- `GET /snapshots/routes`
- `POST /snapshots/routes/publish`
- `GET /healthz`

`POST /snapshots/routes/publish` creates a fresh compact route snapshot and pushes it to each
configured runtime node through `PUT /__runtime/snapshots/routes`. The response includes a
per-node publish result, so partial failures are visible without hiding successful updates.
