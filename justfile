set shell := ["zsh", "-cu"]

wasi_adapter := env_var_or_default("WASI_PREVIEW1_ADAPTER", "node_modules/@bytecodealliance/jco/lib/wasi_snapshot_preview1.reactor.wasm")
guest_wasm := "examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.wasm"
guest_component := "examples/hello-worker/target/wasm32-wasip1/debug/hello_worker.component.wasm"

test:
    pnpm test
    cargo test --workspace

e2e: rust-build guest-build
    WASMPLANE_E2E_COMPONENT="{{ guest_component }}" WASMPLANE_E2E_HOST_BIN="target/debug/wasmplane-wasip3-host" node --experimental-strip-types --test tests/full-flow.test.ts

deps:
    pnpm install --frozen-lockfile

rust-test:
    cargo test --workspace

rust-build:
    cargo build -p wasmplane-wasip3-host

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

bench: rust-build guest-build
    pnpm bench all --component "{{ guest_component }}" --host-bin target/debug/wasmplane-wasip3-host --iterations 30 --warmup 3 --concurrency 1,2,4

dev:
    pnpm start

runtime: rust-build
    pnpm runtime
