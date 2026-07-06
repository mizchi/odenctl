set shell := ["bash", "-cu"]

wac_git_url := env_var_or_default("WASMPLANE_WAC_GIT_URL", "https://github.com/mizchi/wac")
wac_git_ref_arg := env_var_or_default("WASMPLANE_WAC_GIT_REF_ARG", "--tag wasmplane-wac-0.10.1-p1")
wasi_adapter := env_var_or_default("WASI_PREVIEW1_ADAPTER", "node_modules/@bytecodealliance/jco/lib/wasi_snapshot_preview1.reactor.wasm")
guest_wasm := "examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.wasm"
guest_component := "examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm"
rust_interop_wasm := "examples/rust-interop/target/wasm32-wasip1/debug/rust_interop.wasm"
rust_interop_component := "examples/rust-interop/target/wasm32-wasip1/debug/rust_interop.component.wasm"
moonbit_interop_component := "examples/moonbit-interop/target/moonbit-interop.component.wasm"
sample_rust_moonbit_dir := "examples/rust-moonbit-release"
sample_rust_moonbit_rust_wasm := sample_rust_moonbit_dir + "/rust-worker/target/wasm32-wasip1/release/rust_moonbit_release_worker.wasm"
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
    pnpm test
    cargo test --workspace
    just tofu-fmt-check
    just tofu-validate

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

deps:
    pnpm install --frozen-lockfile

rust-test:
    cargo test --workspace

rust-build:
    cargo build -p wasmplane-wasip3-host

wac-install:
    cargo install --git "{{ wac_git_url }}" {{ wac_git_ref_arg }} --locked wac-cli

guest-bindings:
    wit-bindgen rust examples/hello-worker/wit --world worker --out-dir /tmp/wasmplane-wbg --async all
    cp /tmp/wasmplane-wbg/worker.rs examples/hello-worker/src/bindings.rs

guest-build: deps guest-bindings
    RUSTC=$(rustup which rustc --toolchain stable) rustup run stable cargo build --manifest-path examples/hello-worker/Cargo.toml --target wasm32-wasip1
    test -f "{{ wasi_adapter }}"
    wasm-tools component new "{{ guest_wasm }}" --adapt "{{ wasi_adapter }}" -o "{{ guest_component }}"
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

sample-rust-moonbit-rust-bindings:
    wit-bindgen rust "{{ sample_rust_moonbit_dir }}/wit/worker.wit" --world worker --out-dir /tmp/wasmplane-rust-moonbit-worker-wbg
    cp /tmp/wasmplane-rust-moonbit-worker-wbg/worker.rs "{{ sample_rust_moonbit_dir }}/rust-worker/src/bindings.rs"

sample-rust-moonbit-rust-build: sample-rust-moonbit-rust-bindings
    RUSTC=$(rustup which rustc --toolchain stable) rustup run stable cargo build --manifest-path "{{ sample_rust_moonbit_dir }}/rust-worker/Cargo.toml" --target wasm32-wasip1 --release
    test -f "{{ wasi_adapter }}"
    mkdir -p "{{ sample_rust_moonbit_dir }}/target"
    wasm-tools component new "{{ sample_rust_moonbit_rust_wasm }}" --adapt "{{ wasi_adapter }}" -o "{{ sample_rust_moonbit_rust_component }}"
    wasm-tools component wit "{{ sample_rust_moonbit_rust_component }}" >/dev/null

sample-rust-moonbit-moonbit-bindings:
    cd "{{ sample_rust_moonbit_dir }}/moonbit-ping" && wit-bindgen moonbit ../wit/ping.wit --world ping-world --out-dir . --derive-show --derive-eq
    cp "{{ sample_rust_moonbit_dir }}/moonbit-ping/src/ping.mbt" "{{ sample_rust_moonbit_dir }}/moonbit-ping/gen/interface/myedge/runtime/bridge/stub.mbt"

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

tofu-fmt-check:
    tofu fmt -check -recursive infra/terraform

tofu-validate:
    tofu -chdir=infra/terraform/aws init -backend=false
    tofu -chdir=infra/terraform/aws validate
    tofu -chdir=infra/terraform/gcp init -backend=false
    tofu -chdir=infra/terraform/gcp validate

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
    target/debug/wasmplane-wasip3-host serve --host 127.0.0.1 --port 8790 --kv-store-dir .wasmplane/kv --max-prepared-components 512 --max-concurrent-invocations 64 --pooling-total-component-instances 64 --pooling-total-core-instances 256 --pooling-total-memories 64 --pooling-total-tables 128 --pooling-memory-mb 64
