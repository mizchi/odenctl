# Call celld Durable Objects through WIT

Import [`wasmplane:durable/objects@0.1.0`](../../wit/durable/objects.wit), then call celld's Counter with
`open("counter", name)` → `object.fetch(request)`.
WIT defines the guest–host contract. The [Rust host implementation](../../crates/runtime-core/src/durable.rs)
converts calls to authenticated HTTP, and the [celld gateway](../celld-gateway/index.js) forwards them to the target actor.
The actor runs as JavaScript in celld; Wasm runs in the standalone runtime.

## Start the gateway

Run from the repository root. Requires Rust, Node.js 24+, pnpm, just, and celld 0.4.1.
Put `celld` on PATH and run `pnpm install --frozen-lockfile` and `just rust-build` first.
celld resolves esbuild through `pnpm exec`.

On the first run, generate local gateway configuration containing a token.
This file and celld's `.celld/` directory are ignored by Git. Existing configuration is reused.

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
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --port 9876 --no-watch
```

In another terminal, read the host token from the same configuration. It does not need to be passed to the guest environment.

```sh
export WASMPLANE_GATEWAY_TOKEN="$(node -p 'require("./examples/celld-gateway/wrangler.local.json").vars.WASMPLANE_GATEWAY_TOKEN')"
```

## Run WAT directly

```sh
just run examples/durable-counter/counter.wat --config examples/durable-counter/runtime.example.json
echo $? # 0
```

[`counter.wat`](counter.wat) uses binding `counter` and object name `wat-counter`, sending
`POST /increment` with request ID `wat-request-1`. Repeated runs do not apply the same update again.
Success produces no output and exits with code `0`; adapter errors or actor responses other than HTTP 200 exit with code `1`.
The name and request ID are fixed in the WAT data segment.

This sample exports an asynchronous WASI CLI 0.3 entry point. It combines stackful async with synchronous
canonical lowering to await the host's asynchronous `fetch`. The WAT type declarations represent the WIT contract above.
Memory is fixed at 64 KiB to keep the example small. No prior `.wasm` conversion or wasm-tools installation is required.

## Call the same WIT interface from Rust

[`src/lib.rs`](src/lib.rs) calls the wit-bindgen-generated `objects::open` and `object.fetch(...).await`.
The binding, object name, and request ID can be passed as arguments.

```sh
just durable-counter-build
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config examples/durable-counter/runtime.example.json -- counter wat-counter
# {"n":1} — Value updated by WAT. Without a request ID, sends GET /.

target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config examples/durable-counter/runtime.example.json -- counter room-1 increment-1
# {"n":1} — A new ID applies an update; the same ID returns the stored result.
```

A lost response after dispatch is reported as `outcome-unknown`. Requests are not automatically retried;
deduplication follows the actor's contract. This Counter stores the request ID and result in the same SQLite transaction as the update.

## Integration tests

```sh
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test
```

Starts real celld in a temporary environment and verifies WIT calls from WAT and Rust, concurrent updates,
binding/object isolation, persistence after restart, and unknown outcomes and deduplication after a lost response.
Coverage includes `open` / `fetch`. Alarms, WebSockets, fleet migration, and remote durability have not been verified.

## Benchmarks

```sh
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8,32 \
  --output perf-results/celld.json
```

Builds a dedicated guest in release mode and compares direct HTTP and WIT reads and updates against real celld in a temporary environment.
See the [benchmark guide](../../docs/celld-benchmark.md) for concurrency, object counts, measurement scope, and interpretation.
