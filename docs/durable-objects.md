# celld Durable Objects

[User guide](README.md) / celld Durable Objects

Store state that must survive application restarts in a separate celld process.
Wasm applications open named objects through the `wasmplane:durable/objects@0.1.0`
WIT interface and call them with asynchronous `fetch`.

The Wasm app runs on wasmplane, while the Durable Object itself runs as JavaScript
on celld. This does not persist Wasm memory directly.

## Try the Counter

In addition to the runtime from the [Quickstart](getting-started.md), make Node.js
24 or later, pnpm 10.33.0, and celld 0.4.1 available on PATH. Run the following from
the repository root:

```sh
pnpm install --frozen-lockfile
celld --version
```

On first use, create a local configuration containing gateway credentials.
Skip this command if already configured; it fails rather than overwriting an existing file.

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const dir = 'examples/celld-gateway';
const config = JSON.parse(await readFile(`${dir}/wrangler.jsonc`, 'utf8'));
config.vars.WASMPLANE_GATEWAY_TOKEN = randomBytes(32).toString('hex');
await writeFile(`${dir}/wrangler.local.json`, JSON.stringify(config, null, 2), {
  mode: 0o600, flag: 'wx',
});
JS
```

`wrangler.local.json` and celld's local `.celld/` data are excluded from Git.
Start the gateway. `pnpm exec` runs the installed celld and resolves esbuild for its build.

```sh
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --port 9876 --no-watch
```

In another terminal, go to the repository root and give the host the same credentials:

```sh
export WASMPLANE_GATEWAY_TOKEN="$(node -p 'require("./examples/celld-gateway/wrangler.local.json").vars.WASMPLANE_GATEWAY_TOKEN')"
just durable-counter-build
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm \
  --config examples/durable-counter/runtime.example.json -- counter docs-counter increment-1
```

A new object returns `{"n":1}`. Repeating the same command returns the saved result
for that request ID without incrementing twice. Change the last argument to
`increment-2` for a new update. Omit the request ID to read the current value:

```sh
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm \
  --config examples/durable-counter/runtime.example.json -- counter docs-counter
```

The value survives stopping celld with Ctrl-C and restarting it with the same
configuration and local data. The [Counter example](../examples/durable-counter/README.md)
also demonstrates calling the adapter directly from WAT.

## Call it from your application

Import the [Durable Object WIT](../wit/durable/objects.wit), get a handle with
`open("counter", "docs-counter")`, and call `fetch`. See the
[Rust example](../examples/durable-counter/src/lib.rs) for binding generation and calls.
The service SDK combines open, fetch, and handle release in Rust's
`wasmplane_service_sdk::durable::fetch` and MoonBit's `@service.durable_fetch`.
See the [Shared I/O SDK](sdk-io.md#durable-objects) for types and examples.

On the host, add the following to the manifest's `runtime` field. The same object
can also be saved as runtime configuration for `--config`.

```json
{
  "durable": {
    "counter": {
      "endpoint": "http://127.0.0.1:9876",
      "namespace": "COUNTER",
      "token_env": "WASMPLANE_GATEWAY_TOKEN"
    }
  }
}
```

| Name | Purpose |
| --- | --- |
| `counter` | Binding name passed to `open` by the Wasm app |
| `docs-counter` | App-selected object name; the same binding and name address the same object |
| `endpoint` | Gateway endpoint |
| `namespace` | Durable Object binding registered with the gateway; `COUNTER` in this example |
| `token_env` | Host environment variable containing the authentication token |

The token is read from the host environment using `token_env`; it does not need to
be passed to the guest through `runtime.env`. The `durable` configuration authorizes
gateway access without an `outbound_origins` entry. Use separate gateway or namespace
assignments when applications need isolated state.

## Retrying updates and limits

If the response is lost after dispatch, a call may return `outcome-unknown`: the
update may already have committed. The runtime does not retry automatically.
Retries require an object-side deduplication contract. The example Counter stores
the request ID and result in the same transaction as the update. Adding a request
ID alone does not make arbitrary objects deduplicate requests.

Each request and response body is limited to the smaller of `runtime.max_body_bytes`
and 1 MiB. Connection deadlines and concurrent calls use the runtime configuration.
Local persistence, concurrent updates, and retry deduplication have been tested.
Alarms, WebSockets, fleet ownership transfer, and durability in remote storage are
outside this guide's scope.

Run `WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test` to verify behavior,
and see the [benchmark guide](celld-benchmark.md) for performance measurements.
