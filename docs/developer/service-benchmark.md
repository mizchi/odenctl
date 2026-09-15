# Service Benchmarks

[User guide](../user/README.md) / Service benchmarks

Run the same Wasm component in `fresh` mode, which creates a Store for each request,
and `resident` mode, which retains one Store. Node.js sends HTTP requests to the
local Rust runtime, measuring through response body consumption. Requires `ps`
on macOS or Linux.

## Run the benchmark

```sh
just service-bench --iterations 1000 --warmup 20 --concurrency 1,8 \
  --output perf-results/service-bench.json
```

This builds the runtime and Rust service example in release mode before measuring.
To measure an existing component or configuration, invoke the harness directly:

```sh
node --experimental-strip-types crates/odenctl/src/service-bench.ts \
  --host-bin target/release/oden --component path/to/app.wasm \
  --mode resident --config path/to/runtime.json --path / \
  --iterations 1000 --output perf-results/my-app.json
```

Throughput counts successful requests only; latency includes all requests, including
failures. Non-2xx responses, transport failures, RSS sampling errors, or failures
to shut down and reap a process cause exit code 1 after saving the report.
Overload 503s are also treated as errors.

## Report fields

| Field | Meaning |
| --- | --- |
| `environment` | Runtime build information, Node version, OS, and CPU |
| `componentSha256` / `configSha256` | Input identifiers; configuration values and credentials are not saved |
| `startupMs` | Process launch to listener readiness, including compilation and resident start |
| `firstRequestMs` | First request after readiness, measured separately before the load phase |
| `requests` / `errors` / `statusCounts` | Completed requests, non-2xx/transport failures, and counts by status |
| `successRps` | Successful requests divided by the load phase's elapsed seconds |
| `latency` | p50 / p95 / p99 / max through body consumption; approximate values from a fixed-size histogram |
| `rss` | Post-warmup baseline, peak, final value, growth, sample count, and sampling errors; sizes in bytes |
| `shutdown` | Shutdown duration, exit code, forced termination flag, and whether the PID remains alive |

RSS samples cover only the runtime child process and are taken with `ps` roughly
every 100 ms, so brief peaks may be missed. Allocator/JIT behavior and OS reclamation
also affect RSS; growth alone does not establish a leak. Latency is observed at the
client; the harness does not measure the runtime's internal queue length.

`fresh` does not call lifecycle hooks; `resident` calls start and stop. The bundled
example runs its idle timer only in resident mode. The harness runs the runtime
first to obtain its version, so startup measurements do not represent a cold OS
cache. Depending on an app's initialization requirements, the two modes may not
be directly comparable; choose modes that match your component's contract.

## Sustained load and restarts

```sh
just service-soak 600000 3
```

This measures each mode/concurrency combination for ten minutes and repeats the
full process lifecycle three times. The defaults use two modes, concurrency 1 and
8, and three cycles, for 120 minutes of load in total. Results are saved to
`perf-results/service-soak.json`. Use `just service-soak 60000 2` for an eight-minute run.

A positive `--duration-ms` stops load by elapsed time instead of request count;
`--iterations` is then ignored. At the deadline, the harness stops issuing new
requests, drains in-flight work, and shuts down. Latency and RSS retain aggregates
only, without arrays that grow with run duration. Ctrl-C also stops and reaps the
runtime processes owned by the harness.

`just service-bench-test` checks short sustained runs, repeated startup/shutdown,
503s at the queue admission limit, and cleanup after cancellation. Long soak runs
are separate from normal CI.

## Local measurements (2026-09-12)

Measured on Apple M5 / macOS (Darwin 25.5.0) / Node v24.21.0 / Wasmtime 48.0.2,
using the bundled Rust example in release mode with no concurrent builds or tests.
Each condition ran for ten seconds twice after 20 warmup calls. Values show the
range across the two runs.

| Mode | Concurrency | Successful RPS | p95 (ms) | Peak RSS (MiB) |
| --- | --- | --- | --- | --- |
| fresh | 1 | 6698–8796 | 0.226–0.278 | 44.2–45.9 |
| fresh | 8 | 15448–18528 | 0.659–0.907 | 49.2–49.8 |
| resident | 1 | 13287–14830 | 0.119–0.143 | 44.1–45.4 |
| resident | 8 | 26652–27091 | 0.578–0.590 | 46.1–47.0 |

All 1,313,329 requests succeeded, and all eight processes exited normally and were
reaped. These measurements include the Node HTTP client and local OS load; they
do not establish the runtime's standalone throughput ceiling.

A separate soak ran each condition for 60 seconds twice, totaling eight minutes:
6,571,315 requests, zero errors, peak RSS 49.4 MiB, and normal shutdown and reaping
of every process. That run overlapped development builds and tests, so it is a
stability record rather than a performance comparison.

To reproduce the shorter measurement, run the following. Reports are saved under
`perf-results`, which is excluded from Git.

```sh
just service-bench --duration-ms 10000 --cycles 2 --concurrency 1,8 \
  --output perf-results/service-benchmark.json
```
