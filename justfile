set shell := ["bash", "-cu"]
export WIT_BINDGEN := env_var_or_default("WIT_BINDGEN", justfile_directory() + "/target/telemetry-tools/bin/wit-bindgen")

wac_git_url := env_var_or_default("WASMPLANE_WAC_GIT_URL", "https://github.com/mizchi/wac")
wac_git_ref_arg := env_var_or_default("WASMPLANE_WAC_GIT_REF_ARG", "--tag wasmplane-wac-0.10.1-p1")
wasi_adapter := env_var_or_default("WASI_PREVIEW1_ADAPTER", "node_modules/@bytecodealliance/jco/lib/wasi_snapshot_preview1.reactor.wasm")
guest_component := "examples/hello-worker/target/wasm32-wasip2/debug/hello_worker.wasm"
rust_interop_wasm := "examples/rust-interop/target/wasm32-wasip1/debug/rust_interop.wasm"
rust_interop_component := "examples/rust-interop/target/wasm32-wasip1/debug/rust_interop.component.wasm"
moonbit_interop_component := "examples/moonbit-interop/target/moonbit-interop.component.wasm"
sample_rust_moonbit_dir := "examples/rust-moonbit-release"
sample_rust_moonbit_rust_wasm := sample_rust_moonbit_dir + "/rust-worker/target/wasm32-wasip2/release/rust_moonbit_release_worker.wasm"
sample_rust_moonbit_rust_component := sample_rust_moonbit_dir + "/target/rust-worker.component.wasm"
sample_rust_moonbit_wac_caller_wasm := sample_rust_moonbit_dir + "/rust-wac-caller/target/wasm32-wasip1/release/rust_moonbit_wac_caller.wasm"
sample_rust_moonbit_wac_caller_component := sample_rust_moonbit_dir + "/target/rust-wac-caller.component.wasm"
sample_rust_moonbit_moonbit_core := sample_rust_moonbit_dir + "/moonbit-ping/_build/wasm/release/build/gen/gen.wasm"
sample_rust_moonbit_moonbit_embedded := sample_rust_moonbit_dir + "/target/moonbit-ping.embedded.wasm"
sample_rust_moonbit_moonbit_component := sample_rust_moonbit_dir + "/target/moonbit-ping.wasm"
sample_rust_moonbit_component := sample_rust_moonbit_dir + "/target/rust-moonbit-release.component.wasm"
sample_rust_moonbit_wac_component := sample_rust_moonbit_dir + "/target/rust-moonbit-wac.component.wasm"
fly_control_app := env_var_or_default("FLY_CONTROL_APP", "mz-wasmplane-control")
fly_runtime_app := env_var_or_default("FLY_RUNTIME_APP", "mz-wasmplane-runtime")
fly_collector_app := env_var_or_default("FLY_COLLECTOR_APP", "mz-wasmplane-otel-collector")
fly_region := env_var_or_default("FLY_REGION", "nrt")
fly_control_url := env_var_or_default("WASMPLANE_CONTROL_PLANE_URL", "https://mz-wasmplane-control.fly.dev")
fly_runtime_url := env_var_or_default("WASMPLANE_RUNTIME_URL", "https://mz-wasmplane-runtime.fly.dev")
sample_rust_moonbit_project := env_var_or_default("WASMPLANE_SAMPLE_PROJECT_ID", "prj_rust_moonbit_release")
sample_rust_moonbit_host := env_var_or_default("WASMPLANE_SAMPLE_HOST", "rust-moonbit.sample.wasmplane.local")
perf_iterations := env_var_or_default("WASMPLANE_PERF_ITERATIONS", "20")
perf_warmup := env_var_or_default("WASMPLANE_PERF_WARMUP", "2")
perf_concurrency := env_var_or_default("WASMPLANE_PERF_CONCURRENCY", "1,4")
perf_nodes := env_var_or_default("WASMPLANE_PERF_NODES", "1,2")
perf_history := env_var_or_default("WASMPLANE_PERF_HISTORY", "")
perf_history_arg := if perf_history == "" { "" } else { "--history " + perf_history }

test:
    pnpm test
    cargo test --workspace

release-check:
    git diff --check
    just actions-pin-check
    pnpm test
    cargo test --workspace
    just tofu-fmt-check
    just tofu-validate

actions-pin-check:
    pnpm actions-pin-check

actions-pin-verify:
    pnpm actions-pin-verify

actions-pin-update:
    pnpm actions-pin-update

formal-check:
    pnpm formal:route-placement
    node --experimental-strip-types --test tests/formal-route-snapshot-placement.test.ts
    pnpm formal:capability-isolation
    node --experimental-strip-types --test tests/formal-capability-isolation.test.ts

coverage: node-coverage rust-coverage

node-coverage:
    pnpm coverage

rust-coverage:
    rustup run stable cargo llvm-cov --workspace --summary-only

e2e: rust-build guest-build
    WASMPLANE_E2E_COMPONENT="{{ guest_component }}" WASMPLANE_E2E_HOST_BIN="target/debug/wasmplane-wasip3-host" node --experimental-strip-types --test tests/full-flow.test.ts

worker-async-test: rust-build guest-build standalone-http-p3-build
    WASMPLANE_STANDARD_COMPONENT="{{justfile_directory()}}/examples/standard-http-p3/target/wasm32-wasip2/debug/standalone_http_p3_example.wasm" WASMPLANE_WORKER_COMPONENT="{{justfile_directory()}}/{{ guest_component }}" cargo test -p wasmplane-runtime-core --test standard_node -- --ignored
    WASMPLANE_WORKER_HOST_BIN=target/debug/wasmplane-wasip3-host WASMPLANE_WORKER_COMPONENT="{{ guest_component }}" node --experimental-strip-types --test tests/worker-daemon-async.test.ts

deps:
    pnpm install --frozen-lockfile

rust-test:
    cargo test --workspace

rust-build:
    cargo build -p wasmplane-wasip3-host

# Standard WASI component, independent of the control plane.
standalone-http-build:
    rustup target add wasm32-wasip2
    cargo build --manifest-path examples/standard-http/Cargo.toml --target wasm32-wasip2

standalone-http-p3-build:
    rustup target add wasm32-wasip2
    cargo build --manifest-path examples/standard-http-p3/Cargo.toml --target wasm32-wasip2

standalone-test: rust-build standalone-http-build standalone-http-p3-build
    WASMPLANE_STANDALONE_BIN=target/debug/wasmplane WASMPLANE_STANDALONE_HTTP_COMPONENT=examples/standard-http/target/wasm32-wasip2/debug/standalone_http_example.wasm WASMPLANE_STANDALONE_HTTP_P3_COMPONENT=examples/standard-http-p3/target/wasm32-wasip2/debug/standalone_http_p3_example.wasm node --experimental-strip-types --test tests/standalone-runtime.test.ts

# One WIT lifecycle contract, two guest SDKs, shared conformance tests.
service-rust-build:
    rustup target add wasm32-wasip2
    cargo build --locked --manifest-path examples/service-rust/Cargo.toml --target wasm32-wasip2

service-moonbit-build: telemetry-bindgen-install
    node scripts/build-service-moonbit.mjs

# Pin generators locally; leave the user's global tools untouched.
telemetry-bindgen-install:
    if ! "$WIT_BINDGEN" --version 2>/dev/null | rg -q '0\.62\.0'; then cargo install --root target/telemetry-tools --locked wit-bindgen-cli --version 0.62.0; fi

telemetry-tools: telemetry-bindgen-install
    if ! target/telemetry-tools/bin/wac --version >/dev/null 2>&1; then cargo install --root target/telemetry-tools --git "{{ wac_git_url }}" {{ wac_git_ref_arg }} --locked wac-cli; fi

telemetry-moonbit-build: telemetry-bindgen-install
    node scripts/build-telemetry-moonbit.mjs

telemetry-compose-build: telemetry-tools telemetry-moonbit-build
    cargo build --locked --manifest-path examples/telemetry-composition/provider/Cargo.toml --target wasm32-wasip2 --target-dir target/telemetry-example
    cargo build --locked --manifest-path examples/telemetry-composition/app/Cargo.toml --target wasm32-wasip2 --target-dir target/telemetry-example

telemetry-compose provider interface output *args: telemetry-tools
    WAC="{{justfile_directory()}}/target/telemetry-tools/bin/wac" node scripts/compose-telemetry.mjs --provider {{quote(provider)}} --interface {{quote(interface)}} --output {{quote(output)}} {{args}}

telemetry-test: rust-build service-rust-build service-moonbit-build telemetry-compose-build
    cargo test -p wasmplane-runtime-core --test telemetry
    WAC="{{justfile_directory()}}/target/telemetry-tools/bin/wac" WASMPLANE_SERVICE_BIN=target/debug/wasmplane WASMPLANE_SERVICE_RUST=examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm WASMPLANE_SERVICE_MOONBIT=examples/service-moonbit/target/service.wasm WASMPLANE_TELEMETRY_PROVIDER=target/telemetry-example/wasm32-wasip2/debug/telemetry_provider.wasm WASMPLANE_TELEMETRY_APP=target/telemetry-example/wasm32-wasip2/debug/telemetry_composed_app.wasm WASMPLANE_TELEMETRY_MOONBIT_PROVIDER=examples/telemetry-composition/moonbit/provider/target/provider.wasm WASMPLANE_TELEMETRY_MOONBIT_APP=examples/telemetry-composition/moonbit/app/target/service.wasm node --experimental-strip-types --test tests/telemetry-runtime.test.ts tests/telemetry-composition.test.ts

service-test: rust-build service-rust-build service-moonbit-build
    WASMPLANE_SERVICE_BIN=target/debug/wasmplane WASMPLANE_SERVICE_RUST=examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm WASMPLANE_SERVICE_MOONBIT=examples/service-moonbit/target/service.wasm node --experimental-strip-types --test tests/service-runtime.test.ts tests/app-manifest.test.ts

# Standalone tooling, packaged SDKs and common I/O conformance.
sdk-pack:
    node scripts/package-sdks.mjs

sdk-test: rust-build service-rust-build service-moonbit-build sdk-pack
    WASMPLANE_SDK_BIN=target/debug/wasmplane WASMPLANE_SDK_PACKAGES=target/sdk-packages node --experimental-strip-types --test tests/sdk-project.test.ts tests/component-check.test.ts
    WASMPLANE_SERVICE_BIN=target/debug/wasmplane WASMPLANE_SERVICE_RUST=examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm WASMPLANE_SERVICE_MOONBIT=examples/service-moonbit/target/service.wasm node --experimental-strip-types --test tests/sdk-io.test.ts

sdk-celld-test: rust-build service-rust-build service-moonbit-build
    WASMPLANE_CELLD_BIN="${WASMPLANE_CELLD_BIN:-celld}" WASMPLANE_SERVICE_BIN=target/debug/wasmplane WASMPLANE_SERVICE_RUST=examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm WASMPLANE_SERVICE_MOONBIT=examples/service-moonbit/target/service.wasm node --experimental-strip-types --test tests/sdk-io.test.ts

service-bench-build:
    cargo build --release -p wasmplane-wasip3-host --bin wasmplane
    rustup target add wasm32-wasip2
    cargo build --locked --release --manifest-path examples/service-rust/Cargo.toml --target wasm32-wasip2

service-bench *args: service-bench-build
    node --experimental-strip-types src/service-bench.ts {{args}}

service-bench-test: rust-build service-rust-build
    WASMPLANE_SERVICE_BIN=target/debug/wasmplane WASMPLANE_SERVICE_RUST=examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm node --experimental-strip-types --test tests/service-bench.test.ts

# Ten minutes per mode and concurrency, with three complete process lifecycles.
service-soak duration_ms="600000" cycles="3": service-bench-build
    node --experimental-strip-types src/service-bench.ts --duration-ms {{quote(duration_ms)}} --cycles {{quote(cycles)}} --output perf-results/service-soak.json

app-build manifest: rust-build
    target/debug/wasmplane build {{quote(manifest)}}

app-start manifest: rust-build
    target/debug/wasmplane start {{quote(manifest)}}

app-dev manifest="examples/service-rust/app.json": rust-build
    target/debug/wasmplane dev {{quote(manifest)}}

durable-counter-build:
    rustup target add wasm32-wasip2
    mkdir -p examples/durable-counter/wit/deps/durable
    cp wit/durable/objects.wit examples/durable-counter/wit/deps/durable/objects.wit
    cargo build --manifest-path examples/durable-counter/Cargo.toml --target wasm32-wasip2

celld-test: rust-build durable-counter-build
    test -n "${WASMPLANE_CELLD_BIN:-}" || (echo "WASMPLANE_CELLD_BIN must point to celld 0.4.1" >&2; exit 1)
    WASMPLANE_STANDALONE_BIN=target/debug/wasmplane WASMPLANE_DURABLE_COMPONENT=examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm node --experimental-strip-types --test tests/celld-integration.test.ts

# Build a separate guest so benchmarking never replaces the normal counter example.
celld-bench-build:
    cargo build --release -p wasmplane-wasip3-host --bin wasmplane
    rustup target add wasm32-wasip2
    mkdir -p examples/durable-counter/wit/deps/durable
    cp wit/durable/objects.wit examples/durable-counter/wit/deps/durable/objects.wit
    cargo build --manifest-path examples/durable-counter/Cargo.toml --target wasm32-wasip2 --release --features benchmark --target-dir examples/durable-counter/target/benchmark

# Run against disposable local celld; pass --output to save a JSON report.
celld-bench *args: celld-bench-build
    node --experimental-strip-types src/celld-bench.ts {{args}}

celld-bench-test: celld-bench-build
    WASMPLANE_CELLD_BIN="${WASMPLANE_CELLD_BIN:-celld}" WASMPLANE_BENCH_HOST_BIN=target/release/wasmplane node --experimental-strip-types --test tests/celld-bench.test.ts

run component *args:
    cargo run -p wasmplane-wasip3-host --bin wasmplane -- run {{quote(component)}} {{args}}

serve component *args:
    cargo run -p wasmplane-wasip3-host --bin wasmplane -- serve {{quote(component)}} {{args}}

# Minimal CLI components: handwritten WAT and a three-line MoonBit implementation.
minimal-wat-build:
    mkdir -p examples/minimal-command/target
    wasm-tools parse examples/minimal-command/command.wat -o examples/minimal-command/target/wat.wasm
    wasm-tools validate examples/minimal-command/target/wat.wasm

minimal-moonbit-build:
    wit-bindgen moonbit examples/minimal-command/command.wit --world command --out-dir examples/minimal-command/target/moonbit
    cp examples/minimal-command/command.mbt examples/minimal-command/target/moonbit/gen/interface/wasi/cli/run/implementation.mbt
    cd examples/minimal-command/target/moonbit && moon build --target wasm --release
    wasm-tools component embed examples/minimal-command/command.wit examples/minimal-command/target/moonbit/_build/wasm/release/build/gen/gen.wasm --world command --encoding utf16 -o examples/minimal-command/target/moonbit.embedded.wasm
    wasm-tools component new examples/minimal-command/target/moonbit.embedded.wasm -o examples/minimal-command/target/moonbit.wasm
    wasm-tools validate examples/minimal-command/target/moonbit.wasm

minimal-smoke: rust-build minimal-wat-build minimal-moonbit-build
    WASMPLANE_MINIMAL_BIN=target/debug/wasmplane node --experimental-strip-types --test tests/minimal-command.test.ts

wac-install:
    if command -v wac >/dev/null 2>&1; then wac --version; else cargo install --git "{{ wac_git_url }}" {{ wac_git_ref_arg }} --locked wac-cli; fi

guest-build:
    rustup target add wasm32-wasip2
    cargo build --manifest-path examples/hello-worker/Cargo.toml --target wasm32-wasip2
    wasm-tools component wit "{{ guest_component }}" >/dev/null

guest-invoke: rust-build guest-build
    target/debug/wasmplane-wasip3-host invoke --component "{{ guest_component }}" --method GET --uri http://hello.example.dev/ --body ''

interop-rust-bindings:
    wit-bindgen rust examples/interop/wit --world probe-world --out-dir /tmp/wasmplane-rust-interop-wbg
    cp /tmp/wasmplane-rust-interop-wbg/probe_world.rs examples/rust-interop/src/bindings.rs

interop-rust-build: interop-rust-bindings
    RUSTC=$(rustup which rustc --toolchain stable) rustup run stable cargo build --manifest-path examples/rust-interop/Cargo.toml --target wasm32-wasip1
    test -f "{{ wasi_adapter }}"
    wasm-tools component new "{{ rust_interop_wasm }}" --adapt "{{ wasi_adapter }}" -o "{{ rust_interop_component }}"
    wasm-tools component wit "{{ rust_interop_component }}" >/dev/null

interop-moonbit-build:
    just -f examples/moonbit-interop/justfile build

interop-smoke: interop-rust-build interop-moonbit-build
    wasmtime run --invoke 'ping("hello-rust")' "{{ rust_interop_component }}" | grep '"hello-rust"'
    wasmtime run --invoke 'ping("hello-moonbit")' "{{ moonbit_interop_component }}" | grep '"hello-moonbit"'

sample-rust-moonbit-rust-build:
    rustup target add wasm32-wasip2
    cargo build --manifest-path "{{ sample_rust_moonbit_dir }}/rust-worker/Cargo.toml" --target wasm32-wasip2 --release
    mkdir -p "{{ sample_rust_moonbit_dir }}/target"
    cp "{{ sample_rust_moonbit_rust_wasm }}" "{{ sample_rust_moonbit_rust_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_rust_component }}" >/dev/null

sample-rust-moonbit-moonbit-bindings:
    rm -f "{{ sample_rust_moonbit_dir }}/moonbit-ping/gen/gen_interface_wasmplane_sample_bridge_export.mbt" "{{ sample_rust_moonbit_dir }}/moonbit-ping/gen/world_ping_world_export.mbt"
    cd "{{ sample_rust_moonbit_dir }}/moonbit-ping" && wit-bindgen moonbit ../wit/ping.wit --world ping-world --out-dir . --derive-show --derive-eq
    cp "{{ sample_rust_moonbit_dir }}/moonbit-ping/src/ping.mbt" "{{ sample_rust_moonbit_dir }}/moonbit-ping/gen/interface/wasmplane/sample/bridge/stub.mbt"

sample-rust-moonbit-moonbit-build: sample-rust-moonbit-moonbit-bindings
    cd "{{ sample_rust_moonbit_dir }}/moonbit-ping" && moon build --target wasm --release
    mkdir -p "{{ sample_rust_moonbit_dir }}/target"
    wasm-tools component embed "{{ sample_rust_moonbit_dir }}/wit/ping.wit" "{{ sample_rust_moonbit_moonbit_core }}" --encoding utf16 --output "{{ sample_rust_moonbit_moonbit_embedded }}"
    wasm-tools component new "{{ sample_rust_moonbit_moonbit_embedded }}" --output "{{ sample_rust_moonbit_moonbit_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_moonbit_component }}" >/dev/null

sample-rust-moonbit-build: sample-rust-moonbit-rust-build sample-rust-moonbit-moonbit-build
    wac plug "{{ sample_rust_moonbit_rust_component }}" --plug "{{ sample_rust_moonbit_moonbit_component }}" -o "{{ sample_rust_moonbit_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_component }}" >/dev/null
    wasm-tools validate --features cm-async "{{ sample_rust_moonbit_component }}"

sample-rust-moonbit-compose-build: sample-rust-moonbit-rust-build sample-rust-moonbit-moonbit-build
    wasm-tools compose "{{ sample_rust_moonbit_rust_component }}" -d "{{ sample_rust_moonbit_moonbit_component }}" -o "{{ sample_rust_moonbit_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_component }}" >/dev/null

sample-rust-moonbit-wac-caller-bindings:
    wit-bindgen rust "{{ sample_rust_moonbit_dir }}/wit/wac-caller.wit" --world wac-caller --out-dir /tmp/wasmplane-rust-moonbit-wac-caller-wbg
    cp /tmp/wasmplane-rust-moonbit-wac-caller-wbg/wac_caller.rs "{{ sample_rust_moonbit_dir }}/rust-wac-caller/src/bindings.rs"

sample-rust-moonbit-wac-caller-build: sample-rust-moonbit-wac-caller-bindings
    RUSTC=$(rustup which rustc --toolchain stable) rustup run stable cargo build --manifest-path "{{ sample_rust_moonbit_dir }}/rust-wac-caller/Cargo.toml" --target wasm32-wasip1 --release
    test -f "{{ wasi_adapter }}"
    mkdir -p "{{ sample_rust_moonbit_dir }}/target"
    wasm-tools component new "{{ sample_rust_moonbit_wac_caller_wasm }}" --adapt "{{ wasi_adapter }}" -o "{{ sample_rust_moonbit_wac_caller_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_wac_caller_component }}" >/dev/null

sample-rust-moonbit-wac-build: sample-rust-moonbit-wac-caller-build sample-rust-moonbit-moonbit-build
    wac plug "{{ sample_rust_moonbit_wac_caller_component }}" --plug "{{ sample_rust_moonbit_moonbit_component }}" -o "{{ sample_rust_moonbit_wac_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_wac_component }}" >/dev/null

sample-rust-moonbit-wac-smoke: sample-rust-moonbit-wac-build
    wasmtime run --invoke 'answer()' "{{ sample_rust_moonbit_wac_component }}" | grep '42'

sample-rust-moonbit-wac-status output="reports/wac-migration.md" format="markdown":
    pnpm wac-migration-report --format "{{ format }}" --output "{{ output }}"

sample-rust-moonbit-wac-probe: sample-rust-moonbit-rust-build sample-rust-moonbit-moonbit-build
    wac plug "{{ sample_rust_moonbit_rust_component }}" --plug "{{ sample_rust_moonbit_moonbit_component }}" -o "{{ sample_rust_moonbit_dir }}/target/rust-moonbit-release.wac-probe.component.wasm"
    wasm-tools component wit "{{ sample_rust_moonbit_dir }}/target/rust-moonbit-release.wac-probe.component.wasm" >/dev/null
    wasm-tools validate --features cm-async "{{ sample_rust_moonbit_dir }}/target/rust-moonbit-release.wac-probe.component.wasm"

sample-rust-moonbit-smoke: rust-build sample-rust-moonbit-build
    target/debug/wasmplane-wasip3-host compile --component "{{ sample_rust_moonbit_component }}" --out "{{ sample_rust_moonbit_dir }}/target/rust-moonbit-release.cwasm"
    target/debug/wasmplane-wasip3-host invoke --component "{{ sample_rust_moonbit_component }}" --method GET --uri "https://{{ sample_rust_moonbit_host }}/sample" --body '' --cpu-ms 1000 --wall-ms 5000 --memory-mb 128 | grep 'moonbit=42'

sample-rust-moonbit-release-preflight:
    test -n "${WASMPLANE_CONTROL_PLANE_TOKEN:-}" || (echo "WASMPLANE_CONTROL_PLANE_TOKEN is required" >&2; exit 1)
    wac --version
    wasm-tools --version >/dev/null
    wit-bindgen --version >/dev/null
    wasmtime --version >/dev/null

sample-rust-moonbit-release: sample-rust-moonbit-release-preflight sample-rust-moonbit-build
    body=$(mktemp); http_status=$(curl -sS -o "$body" -w "%{http_code}" -X POST "{{ fly_control_url }}/projects" -H "authorization: Bearer $WASMPLANE_CONTROL_PLANE_TOKEN" -H "content-type: application/json" -d '{"id":"{{ sample_rust_moonbit_project }}","name":"Rust MoonBit release sample"}'); if [[ "$http_status" != "201" && "$http_status" != "409" ]]; then cat "$body"; exit 1; fi
    pnpm wasmplane deploy --control-plane-url "{{ fly_control_url }}" --project-id "{{ sample_rust_moonbit_project }}" --component "{{ sample_rust_moonbit_component }}" --host "{{ sample_rust_moonbit_host }}" --path-prefix / --limit cpuMs=1000 --limit wallMs=5000 --limit memoryMb=128 --diff
    for attempt in {1..30}; do body=$(mktemp); http_status=$(curl -sS -o "$body" -w "%{http_code}" -H "Host: {{ sample_rust_moonbit_host }}" "{{ fly_runtime_url }}/sample" || true); if [[ "$http_status" == "200" ]] && grep -q 'moonbit=42' "$body"; then cat "$body"; exit 0; fi; if [[ "$attempt" == "30" ]]; then echo "runtime smoke failed after $attempt attempts: status=$http_status"; cat "$body"; exit 1; fi; sleep 2; done

bench: rust-build guest-build
    pnpm bench all --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --iterations 30 --warmup 3 --concurrency 1,2,4

cluster-bench: rust-build guest-build
    pnpm cluster-bench --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --nodes 1,2,4 --iterations 30 --warmup 2 --concurrency 1,4,16

cluster-bench-daemon: rust-build guest-build
    pnpm cluster-bench --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --host-daemon-url http://127.0.0.1:8790 --pooling-total-component-instances 64 --pooling-total-core-instances 256 --pooling-total-memories 64 --pooling-total-tables 128 --pooling-memory-mb 64 --nodes 1,2,4 --iterations 30 --warmup 2 --concurrency 1,4,16

rust-daemon-bench: rust-build guest-build
    pnpm rust-daemon-bench --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --iterations 300 --warmup 10 --concurrency 1,8,32,64 --http-workers 64 --pooling-total-component-instances 64 --pooling-total-core-instances 256 --pooling-total-memories 64 --pooling-total-tables 128 --pooling-memory-mb 64

volume-sqlite-bench:
    pnpm volume-sqlite-bench --root .wasmplane/volume-sqlite-bench --databases 1000 --max-open 64 --max-pending-writes 64 --schema-version 1 --write-iterations 1000 --write-concurrency 1,4,16

fly-volume-sqlite-bench:
    fly ssh console -a "{{ fly_control_app }}" -C "sh -lc 'cd /app && pnpm volume-sqlite-bench --root /data/sqlite-bench --databases 1000 --max-open 64 --max-pending-writes 64 --schema-version 1 --write-iterations 1000 --write-concurrency 1,4,16 --format json --output /data/sqlite-bench/report.json'"

perf-regression: rust-build guest-build
    mkdir -p perf-results
    pnpm bench all --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --iterations "{{ perf_iterations }}" --warmup "{{ perf_warmup }}" --concurrency "{{ perf_concurrency }}" --format json --output perf-results/bench.json
    pnpm cluster-bench --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --nodes "{{ perf_nodes }}" --iterations "{{ perf_iterations }}" --warmup "{{ perf_warmup }}" --concurrency "{{ perf_concurrency }}" --placement --autoscaling --format json --output perf-results/cluster-bench.json
    pnpm perf-check --budget perf/budgets.json --input perf-results/bench.json --input perf-results/cluster-bench.json {{ perf_history_arg }} --output perf-results/perf-regression.md

db-migrate-check:
    pnpm wasmplane migrate check

db-migrate-apply:
    pnpm wasmplane migrate apply

pg-migrate: db-migrate-apply

pg-backup output="backups/wasmplane.dump":
    test -n "$DATABASE_URL"
    mkdir -p "$(dirname "{{ output }}")"
    pg_dump "$DATABASE_URL" --format=custom --file "{{ output }}"

pg-restore input:
    test -n "$DATABASE_URL"
    pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "{{ input }}"

fly-create-volumes:
    fly volumes create wasmplane_control_data -a "{{ fly_control_app }}" -r "{{ fly_region }}" -s 1 --yes
    fly volumes create wasmplane_runtime_data -a "{{ fly_runtime_app }}" -r "{{ fly_region }}" -s 1 --yes

fly-deploy-control:
    fly deploy -c fly.control.toml -a "{{ fly_control_app }}"

fly-deploy-runtime:
    fly deploy -c fly.runtime.toml -a "{{ fly_runtime_app }}"

fly-deploy-collector:
    fly deploy -c fly.collector.toml -a "{{ fly_collector_app }}"

fly-logs-collector:
    fly logs -a "{{ fly_collector_app }}"

fly-status:
    fly status -a "{{ fly_control_app }}"
    fly status -a "{{ fly_runtime_app }}"
    fly status -a "{{ fly_collector_app }}"

fly-smoke:
    pnpm ops-smoke

fly-smoke-production:
    pnpm ops-smoke -- --require-external-db --min-runtime-nodes 2

fly-smoke-rust-forward:
    pnpm ops-smoke -- --require-external-db --min-runtime-nodes 2 --require-rust-forward

fly-alarm-demo:
    pnpm alarm-demo-smoke

fly-scale-eval:
    pnpm fly-scale-eval

fly-scale-eval-execute:
    pnpm fly-scale-eval -- --execute

fly-otel-evidence:
    pnpm fly-otel-evidence

tofu-fmt-check:
    tofu fmt -check -recursive infra/terraform

tofu-validate: aws-standalone-validate
    tofu -chdir=infra/terraform/aws init -backend=false
    tofu -chdir=infra/terraform/aws validate
    tofu -chdir=infra/terraform/gcp init -backend=false
    tofu -chdir=infra/terraform/gcp validate

# Standalone runtime on AWS; kumo checks never use real AWS credentials.
kumo-install:
    node scripts/install-kumo.mjs

aws-kumo-test: kumo-install
    node --experimental-strip-types --test tests/kumo-drift.test.ts
    node scripts/aws-kumo-smoke.mjs

aws-standalone-validate:
    tofu -chdir=infra/terraform/aws-standalone init -backend=false -input=false
    tofu -chdir=infra/terraform/aws-standalone validate
    tofu -chdir=infra/terraform/aws-standalone-kumo init -backend=false -input=false
    tofu -chdir=infra/terraform/aws-standalone-kumo test

aws-standalone-plan:
    tofu -chdir=infra/terraform/aws-standalone init -input=false
    tofu -chdir=infra/terraform/aws-standalone plan -out=plan.tfplan

aws-image-test: service-bench-build
    WASMPLANE_AWS_IMAGE_HOST=target/release/wasmplane WASMPLANE_AWS_IMAGE_COMPONENT=examples/service-rust/target/wasm32-wasip2/release/service_rust.wasm node --experimental-strip-types --test tests/aws-image.test.ts

aws-image-build image="wasmplane-service:local" platform="linux/arm64":
    docker buildx build --platform {{quote(platform)}} --load -f Dockerfile.standalone -t {{quote(image)}} .

aws-terraform-plan:
    terraform -chdir=infra/terraform/aws init
    terraform -chdir=infra/terraform/aws plan

gcp-terraform-plan:
    terraform -chdir=infra/terraform/gcp init
    terraform -chdir=infra/terraform/gcp plan

cloudflare-control-dev:
    cd cloudflare/containers-control && pnpm dev

cloudflare-control-deploy:
    cd cloudflare/containers-control && pnpm deploy

cloudflare-control-smoke:
    pnpm cloudflare-control-smoke

dev:
    pnpm start

runtime: rust-build
    pnpm runtime

host-daemon: rust-build
    target/debug/wasmplane-wasip3-host serve --host 127.0.0.1 --port 8790 --max-prepared-components 512 --max-concurrent-invocations 64 --pooling-total-component-instances 64 --pooling-total-core-instances 256 --pooling-total-memories 64 --pooling-total-tables 128 --pooling-memory-mb 64
