# celld / WIT Benchmarks

Compare direct HTTP requests to the gateway with WIT calls from Wasm against a real celld process.
`just` builds the host and dedicated guest in **release** mode, then starts celld in a temporary directory.
No existing gateway or token configuration is required. Processes and temporary data are cleaned up on exit or failure.

```sh
pnpm install --frozen-lockfile
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-bench

# 1000 measured requests and 100 warmup requests per case, concurrency 1 / 8 / 32
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8,32 \
  --output perf-results/celld-single-object.json

# Distribute the same load across 8 objects
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8 --objects 8 \
  --output perf-results/celld-eight-objects.json
```

Requires celld 0.4.1, Rust (`wasm32-wasip2`), Node.js 24+, pnpm, and just.
The first Wasmtime release build takes time. Build time and celld startup time are excluded from measurements.

## Cases

| Name | Path | Operation |
| --- | --- | --- |
| `gateway.read` | Node.js fetch → gateway → actor | `GET /`, read the value |
| `wit.read` | Wasm → WIT → Rust host → gateway → actor | The same read |
| `gateway.increment` | Node.js fetch → gateway → actor | `POST /increment`, update in a transaction |
| `wit.increment` | Wasm → WIT → Rust host → gateway → actor | The same update |

All cases use the same `COUNTER` namespace, authentication, JSON/base64 envelope, and empty request body.
Each case gets new object names. `--objects 1` concentrates traffic on one actor;
`--objects N` distributes requests across N objects in index order. Concurrency is the maximum number of
outstanding calls, including queued calls. This is a closed-loop load: each completed request allows the
next one to start, rather than maintaining a fixed arrival rate. Warmup counts apply to the entire case, not each object.

Mutation request IDs are unique to the case, phase (warmup or measurement), and request index.
The cost of writing deduplication records is included. At the end, the benchmark reads each object's
value and verifies that all warmup and measured updates took effect.
HTTP/WIT errors, invalid responses, or count mismatches fail the benchmark.
Failures return exit code `1` with error details and no success report. Requests are not automatically retried.

## Timing scope

- p50/p95/p99, mean, minimum, and maximum: from request construction through JSON validation of the actor response body.
  WIT uses the guest's `Instant`; direct HTTP uses Node.js `performance.now()`.
  WIT handles are opened before the batch and reused. Percentiles use nearest rank and are displayed to three decimal places.
- RPS: successful measured requests divided by the batch's elapsed seconds, not an estimate multiplied by concurrency.
  Excludes warmup and final state verification.
- `warmupElapsedMs`: elapsed time for the warmup batch, excluded from p50 and other request statistics.
- `processElapsedMs` / `CLI total ms` in the table: total process time for a WIT case.
  Includes startup, engine creation, component loading/compilation, instantiation, warmup, measurement,
  state verification, standard output, and shutdown. This is neither pure startup time nor per-request latency.

Each WIT case starts Wasm once and runs multiple async `fetch` calls within that process.
It does not start the CLI or recompile the component for each call.
The guest measurement loop is in [benchmark.rs](../../examples/durable-counter/src/benchmark.rs);
aggregation and orchestration are in [celld-bench.ts](../../crates/odenctl/src/celld-bench.ts).

Direct HTTP uses Node.js fetch, while the WIT host uses reqwest. Differences therefore include HTTP client
behavior, guest JSON processing, and clock calls. **These measurements do not isolate WIT overhead.**
They also use local SQLite in celld dev mode and do not cover fleet operation, remote durability, or performance during failures.

On 2026-09-11, celld 0.4.1 on macOS arm64 returned HTTP 503 `cell request limit reached` twice for
`wit.read` with 8 objects, concurrency 32, 100 warmup requests, and 1000 measured requests.
The celld logs reported `cell_overload_refused` / `in_flight=64, limit=64`.
Why celld reached a count of 64 at client concurrency 32 has not been investigated in this benchmark.
Scores under those conditions are excluded and treated separately from successful single-object results.

## Options and reports

| Option | Default | Description |
| --- | --- | --- |
| `--iterations` | `100` | Measured requests per case |
| `--warmup` | `10` | Excluded warmup calls per case; `0` is allowed |
| `--concurrency` | `1,8` | List of concurrency levels |
| `--objects` | `1` | Objects per case |
| `--timeout-ms` | `60000` | Deadline per case; the WIT process monitor allows another 30 seconds for startup |
| `--format` | `markdown` | Standard output format: `markdown` or `json` |
| `--output` | None | JSON report destination, independent of the standard output format |
| `--celld-bin` | Environment variable or `celld` | celld executable |
| `--host-bin` | `target/release/oden` | Host executable |
| `--component` | Dedicated release guest | Component built with the benchmark feature |

JSON reports use schemaVersion `1`. They record measurement conditions, request and error counts,
statistics, Node / Wasmtime / celld versions, CPU/OS, the host path, and the guest SHA-256. Tokens are omitted.
`perf-results/` is ignored by Git.

The regular Counter sample remains usable as is. The benchmark variant enables the Cargo feature
`benchmark` and builds separately under `examples/durable-counter/target/benchmark/`.
Once built, it can also be run with `pnpm celld-bench ...`.

## Tests

```sh
# Aggregation, input validation, HTTP errors, and warmup/mutation IDs
node --experimental-strip-types --test tests/celld-bench.test.ts

# Small runs of all cases with real celld + Wasm (no duration thresholds)
ODEN_CELLD_BIN=/absolute/path/to/celld just celld-bench-test
```
