import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("project tooling keeps Wasm E2E portable", async () => {
  const justfile = await readFile("justfile", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const ciTestJob = workflow.slice(workflow.indexOf("  test:"), workflow.indexOf("  wac-migration-report:"));
  const ciWacJob = workflow.slice(workflow.indexOf("  wac-migration-report:"));
  const rustMoonbitWorkflow = await readFile(".github/workflows/rust-moonbit-smoke.yml", "utf8");
  const rustMoonbitReleaseWorkflow = await readFile(".github/workflows/rust-moonbit-release.yml", "utf8");
  const perfWorkflow = await readFile(".github/workflows/perf.yml", "utf8");
  const flyControl = await readFile("fly.control.toml", "utf8");
  const flyRuntime = await readFile("fly.runtime.toml", "utf8");
  const flyCollector = await readFile("fly.collector.toml", "utf8");
  const readme = await readFile("README.md", "utf8");
  await readFile("pnpm-lock.yaml", "utf8");

  assert.match(justfile, /^set shell := \["bash", "-cu"\]/m);
  assert.doesNotMatch(justfile, /^set shell := \["zsh"/m);
  assert.match(justfile, /node_modules\/@bytecodealliance\/jco\/lib\/wasi_snapshot_preview1\.reactor\.wasm/);
  assert.match(justfile, /^db-migrate-check:/m);
  assert.match(justfile, /^db-migrate-apply:/m);
  assert.match(justfile, /^release-check:/m);
  assert.match(justfile, /just tofu-validate/);
  assert.match(justfile, /^volume-sqlite-bench:/m);
  assert.match(justfile, /^fly-volume-sqlite-bench:/m);
  assert.match(justfile, /fly_control_app := env_var_or_default\("FLY_CONTROL_APP", "mz-wasmplane-control"\)/);
  assert.match(justfile, /fly_runtime_app := env_var_or_default\("FLY_RUNTIME_APP", "mz-wasmplane-runtime"\)/);
  assert.match(justfile, /fly_collector_app := env_var_or_default\("FLY_COLLECTOR_APP", "mz-wasmplane-otel-collector"\)/);
  assert.match(justfile, /^fly-smoke:/m);
  assert.match(justfile, /^fly-smoke-production:/m);
  assert.match(justfile, /^fly-alarm-demo:/m);
  assert.match(justfile, /^fly-scale-eval:/m);
  assert.match(justfile, /^fly-scale-eval-execute:/m);
  assert.match(justfile, /^cloudflare-control-smoke:/m);
  assert.match(justfile, /^rust-daemon-bench:/m);
  assert.match(justfile, /^coverage: node-coverage rust-coverage/m);
  assert.match(justfile, /^node-coverage:/m);
  assert.match(justfile, /^rust-coverage:/m);
  assert.match(justfile, /rustup run stable cargo llvm-cov --workspace --summary-only/);
  assert.doesNotMatch(justfile, /\/Users\//);
  assert.match(packageJson.scripts["ops-smoke"], /src\/ops-smoke\.ts/);
  assert.match(packageJson.scripts["alarm-demo-smoke"], /src\/alarm-demo-smoke\.ts/);
  assert.match(packageJson.scripts["cloudflare-control-smoke"], /src\/cloudflare-control-smoke\.ts/);
  assert.match(packageJson.scripts["fly-scale-eval"], /src\/fly-scale-eval\.ts/);
  assert.match(packageJson.scripts["rust-daemon-bench"], /src\/rust-daemon-bench\.ts/);
  assert.match(packageJson.scripts.coverage, /--experimental-test-coverage/);
  assert.match(packageJson.scripts["volume-sqlite-bench"], /src\/volume-sqlite-bench\.ts/);
  assert.equal(packageJson.devDependencies["@bytecodealliance/jco"], "1.15.4");
  for (const githubWorkflow of [workflow, rustMoonbitWorkflow, rustMoonbitReleaseWorkflow, perfWorkflow]) {
    assert.match(githubWorkflow, /actions\/checkout@v7/);
    assert.match(githubWorkflow, /pnpm\/action-setup@v6/);
    assert.match(githubWorkflow, /actions\/setup-node@v6/);
    assert.match(githubWorkflow, /extractions\/setup-just@v4/);
    assert.match(githubWorkflow, /actions\/upload-artifact@v7/);
    assert.doesNotMatch(
      githubWorkflow,
      /actions\/checkout@v4|pnpm\/action-setup@v4|actions\/setup-node@v4|extractions\/setup-just@v3|actions\/upload-artifact@v4/,
    );
  }
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /rustup target add wasm32-wasip1/);
  assert.match(workflow, /just test/);
  assert.match(workflow, /just e2e/);
  assert.match(workflow, /wac-migration-report:/);
  assert.match(workflow, /hustcer\/setup-moonbit@v1/);
  assert.match(workflow, /bytecodealliance\/actions\/wasmtime\/setup@v1/);
  assert.match(ciTestJob, /Setup Wasmtime/);
  assert.match(ciTestJob, /bytecodealliance\/actions\/wasmtime\/setup@v1/);
  assert.doesNotMatch(workflow, /cargo install wasm-tools/);
  assert.doesNotMatch(workflow, /cargo install wit-bindgen-cli/);
  for (const githubWorkflow of [workflow, rustMoonbitWorkflow, rustMoonbitReleaseWorkflow, perfWorkflow]) {
    assert.match(githubWorkflow, /name: Cache Rust build artifacts/);
    assert.match(githubWorkflow, /actions\/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae # v5\.0\.5/);
    assert.match(githubWorkflow, /~\/\.cargo\/registry\/cache/);
    assert.match(githubWorkflow, /~\/\.cargo\/git\/db/);
    assert.match(githubWorkflow, /examples\/\*\*\/target/);
    assert.match(githubWorkflow, /hashFiles\('Cargo\.lock', '\*\*\/Cargo\.lock', '\*\*\/Cargo\.toml', 'justfile'\)/);
  }
  for (const wacWorkflow of [ciWacJob, rustMoonbitWorkflow, rustMoonbitReleaseWorkflow]) {
    assert.match(wacWorkflow, /~\/\.cargo\/bin\/wac/);
    assert.match(
      wacWorkflow,
      /\$\{\{ runner\.os \}\}-rust-wac-\$\{\{ hashFiles\('Cargo\.lock', '\*\*\/Cargo\.lock', '\*\*\/Cargo\.toml', 'justfile'\) \}\}/,
    );
  }
  for (const nonWacWorkflow of [ciTestJob, perfWorkflow]) {
    assert.doesNotMatch(nonWacWorkflow, /~\/\.cargo\/bin\/wac/);
    assert.match(
      nonWacWorkflow,
      /\$\{\{ runner\.os \}\}-rust-wasmplane-\$\{\{ github\.job \}\}-\$\{\{ hashFiles\('Cargo\.lock', '\*\*\/Cargo\.lock', '\*\*\/Cargo\.toml', 'justfile'\) \}\}/,
    );
  }
  assert.match(workflow, /just wac-install/);
  assert.match(workflow, /just sample-rust-moonbit-wac-status/);
  assert.match(workflow, /wasmplane-wac-migration/);
  assert.match(perfWorkflow, /bytecodealliance\/actions\/wasm-tools\/setup@v1/);
  assert.match(perfWorkflow, /bytecodealliance\/actions\/wit-bindgen\/setup@v1/);
  assert.doesNotMatch(perfWorkflow, /cargo install wasm-tools/);
  assert.doesNotMatch(perfWorkflow, /cargo install wit-bindgen-cli/);
  assert.match(rustMoonbitWorkflow, /workflow_dispatch:/);
  assert.match(rustMoonbitWorkflow, /just wac-install/);
  assert.match(rustMoonbitWorkflow, /just sample-rust-moonbit-smoke/);
  assert.match(rustMoonbitWorkflow, /wasmplane-rust-moonbit-smoke/);
  assert.match(rustMoonbitReleaseWorkflow, /workflow_dispatch:/);
  assert.match(rustMoonbitReleaseWorkflow, /environment: production/);
  assert.match(rustMoonbitReleaseWorkflow, /secrets\.WASMPLANE_CONTROL_PLANE_TOKEN/);
  assert.match(rustMoonbitReleaseWorkflow, /just sample-rust-moonbit-release-preflight/);
  assert.match(rustMoonbitReleaseWorkflow, /just sample-rust-moonbit-release/);
  assert.match(rustMoonbitReleaseWorkflow, /wasmplane-rust-moonbit-release/);
  assert.match(flyControl, /app = "mz-wasmplane-control"/);
  assert.match(flyControl, /WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS = "5000"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_ROOT = "\/data\/sqlite"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_OPEN = "64"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_PENDING_WRITES = "64"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE = "24"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_BACKUP_RETENTION_MS = "604800000"/);
  assert.match(flyControl, /WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS = "1000"/);
  assert.match(flyControl, /WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES = "alarm-demo"/);
  assert.match(flyControl, /WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL = "https:\/\/mz-wasmplane-control\.fly\.dev\/alarm-demo\/webhook"/);
  assert.match(readme, /WASMPLANE_VOLUME_SQLITE_BACKUP_KEY_BASE64/);
  assert.match(readme, /WASMPLANE_VOLUME_SQLITE_BACKUP_KEYS_BASE64/);
  assert.match(readme, /WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS/);
  assert.match(readme, /WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL/);
  assert.match(readme, /just fly-alarm-demo/);
  assert.match(readme, /just fly-scale-eval/);
  assert.match(readme, /pnpm cloudflare-control-smoke/);
  assert.match(readme, /just rust-daemon-bench/);
  assert.match(readme, /just fly-smoke/);
  assert.match(readme, /just coverage/);
  assert.match(justfile, /--max-pending-writes 64/);
  assert.match(flyRuntime, /app = "mz-wasmplane-runtime"/);
  assert.match(flyRuntime, /RUNTIME_HOST = "::"/);
  assert.match(flyRuntime, /RUNTIME_ROUTE_SNAPSHOT_FILE = "\/data\/route-snapshot\.json"/);
  assert.match(flyRuntime, /WASMPLANE_WASIP3_HOST_DAEMON_ROUTES = "1"/);
  assert.match(flyRuntime, /WASMPLANE_WASIP3_HOST_DAEMON_WORKER_PROXY = "1"/);
  assert.match(flyRuntime, /path = "\/__runtime\/healthz"/);
  assert.match(flyCollector, /app = "mz-wasmplane-otel-collector"/);
});

test("Rust and MoonBit interop examples share a WASI p3 component contract", async () => {
  const justfile = await readFile("justfile", "utf8");
  const cargoToml = await readFile("Cargo.toml", "utf8");
  const readme = await readFile("README.md", "utf8");
  const wit = await readFile("examples/interop/wit/world.wit", "utf8");
  const rustLib = await readFile("examples/rust-interop/src/lib.rs", "utf8");
  const rustCargo = await readFile("examples/rust-interop/Cargo.toml", "utf8");
  const moonbitStub = await readFile("examples/moonbit-interop/src/probe.mbt", "utf8");
  const moonbitJustfile = await readFile("examples/moonbit-interop/justfile", "utf8");

  assert.match(wit, /package myedge:interop@0\.1\.0/);
  assert.match(wit, /world probe-world/);
  assert.match(wit, /export ping: func\(message: string\) -> string/);
  assert.match(rustCargo, /name = "rust-interop"/);
  assert.match(rustLib, /impl Guest for Component/);
  assert.match(rustLib, /fn ping\(message: String\) -> String/);
  assert.match(moonbitStub, /pub fn ping\(message : String\) -> String/);
  assert.match(moonbitJustfile, /wit-bindgen moonbit \.\.\/interop\/wit --world probe-world/);
  assert.match(justfile, /^interop-smoke:/m);
  assert.match(justfile, /wasmtime run --invoke 'ping\("hello-rust"\)'/);
  assert.match(justfile, /wasmtime run --invoke 'ping\("hello-moonbit"\)'/);
  assert.match(cargoToml, /examples\/rust-interop/);
  assert.match(readme, /## Rust and MoonBit WASI p3 interop/);
});

test("Rust and MoonBit release sample composes a runtime worker", async () => {
  const justfile = await readFile("justfile", "utf8");
  const packageJson = await readFile("package.json", "utf8");
  const cargoToml = await readFile("Cargo.toml", "utf8");
  const readme = await readFile("README.md", "utf8");
  const sampleReadme = await readFile("examples/rust-moonbit-release/README.md", "utf8");
  const workerWit = await readFile("examples/rust-moonbit-release/wit/worker.wit", "utf8");
  const pingWit = await readFile("examples/rust-moonbit-release/wit/ping.wit", "utf8");
  const rustCargo = await readFile("examples/rust-moonbit-release/rust-worker/Cargo.toml", "utf8");
  const rustLib = await readFile("examples/rust-moonbit-release/rust-worker/src/lib.rs", "utf8");
  const wacCallerWit = await readFile("examples/rust-moonbit-release/wit/wac-caller.wit", "utf8");
  const wacCallerCargo = await readFile("examples/rust-moonbit-release/rust-wac-caller/Cargo.toml", "utf8");
  const wacCallerLib = await readFile("examples/rust-moonbit-release/rust-wac-caller/src/lib.rs", "utf8");
  const moonbitModule = await readFile("examples/rust-moonbit-release/moonbit-ping/moon.mod.json", "utf8");
  const moonbitPing = await readFile("examples/rust-moonbit-release/moonbit-ping/src/ping.mbt", "utf8");

  assert.match(justfile, /^sample-rust-moonbit-build:/m);
  assert.match(justfile, /^sample-rust-moonbit-compose-build:/m);
  assert.match(justfile, /^sample-rust-moonbit-smoke:/m);
  assert.match(justfile, /^sample-rust-moonbit-release-preflight:/m);
  assert.match(justfile, /sample-rust-moonbit-release: sample-rust-moonbit-release-preflight sample-rust-moonbit-build/);
  assert.match(justfile, /WASMPLANE_CONTROL_PLANE_TOKEN is required/);
  assert.match(justfile, /^wac-install:/m);
  assert.match(justfile, /command -v wac/);
  assert.match(justfile, /wac_git_url := env_var_or_default\("WASMPLANE_WAC_GIT_URL", "https:\/\/github\.com\/mizchi\/wac"\)/);
  assert.match(justfile, /wac_git_ref_arg := env_var_or_default\("WASMPLANE_WAC_GIT_REF_ARG", "--tag wasmplane-wac-0\.10\.1-p1"\)/);
  assert.match(justfile, /^sample-rust-moonbit-wac-build:/m);
  assert.match(justfile, /^sample-rust-moonbit-wac-smoke:/m);
  assert.match(justfile, /^sample-rust-moonbit-wac-status /m);
  assert.match(justfile, /^sample-rust-moonbit-wac-probe:/m);
  assert.match(justfile, /wac plug .* --plug/);
  assert.match(justfile, /sample-rust-moonbit-compose-build:[\s\S]*wasm-tools compose/);
  assert.match(packageJson, /"wac-migration-report": "node --experimental-strip-types src\/wac-migration-report\.ts"/);
  assert.match(justfile, /runtime smoke failed after/);
  assert.match(cargoToml, /examples\/rust-moonbit-release\/rust-worker/);
  assert.match(cargoToml, /examples\/rust-moonbit-release\/rust-wac-caller/);
  assert.match(readme, /## Rust \+ MoonBit release sample/);
  assert.match(sampleReadme, /just sample-rust-moonbit-wac-smoke/);
  assert.match(sampleReadme, /mizchi\/wac/);
  assert.doesNotMatch(sampleReadme, /wac currently panics/);
  assert.match(workerWit, /interface bridge/);
  assert.match(workerWit, /import bridge/);
  assert.match(workerWit, /export handle: async func\(req: request\) -> response/);
  assert.match(wacCallerWit, /world wac-caller/);
  assert.match(wacCallerWit, /import bridge/);
  assert.match(wacCallerWit, /export answer: func\(\) -> u32/);
  assert.match(pingWit, /world ping-world/);
  assert.match(pingWit, /ping: func\(value: u32\) -> u32/);
  assert.match(pingWit, /export bridge/);
  assert.match(rustCargo, /name = "rust-moonbit-release-worker"/);
  assert.match(rustLib, /bridge::ping\(35\)/);
  assert.match(wacCallerCargo, /name = "rust-moonbit-wac-caller"/);
  assert.match(wacCallerLib, /bridge::ping\(35\)/);
  assert.match(moonbitModule, /"name": "myedge\/runtime"/);
  assert.match(moonbitPing, /pub fn ping\(value : UInt\) -> UInt/);
});

test("project docs track Cloudflare smoke results and composition CI policy", async () => {
  const readme = await readFile("README.md", "utf8");
  const todo = await readFile("TODO.md", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^reports\/$/m);
  assert.match(
    todo,
    /- \[x\] Run the Cloudflare Containers smoke harness against the deployed Worker\/container pair and capture logs\/cold-start numbers\./,
  );
  assert.match(todo, /Add a WAC canary that composes the Rust socket component with the MoonBit provider/);
  assert.match(todo, /Add a WAC migration status report/);
  assert.match(todo, /Add static runtime worker WIT diagnostics/);
  assert.match(todo, /Replace deprecated `wasm-tools compose` with forked `wac` for the WASIp3 async worker world/);
  assert.match(todo, /mizchi\/wac@wasmplane-wac-0\.10\.1-p1/);
  assert.match(readme, /Latest deployed Cloudflare Containers smoke/);
  assert.match(readme, /container health.*1439ms/);
  assert.match(readme, /post-wakeup health.*135ms/);
  assert.match(readme, /## Rust \+ MoonBit CI policy/);
  assert.match(readme, /full build\s+smoke stays out of default CI/);
  assert.match(readme, /sample-rust-moonbit-wac-status/);
  assert.match(readme, /static WIT summary/);
  assert.match(readme, /mizchi\/wac/);
  assert.match(readme, /sample-rust-moonbit-compose-build/);
  assert.match(readme, /Rust MoonBit Release workflow/);
  assert.match(readme, /WASMPLANE_CONTROL_PLANE_TOKEN/);
  assert.match(todo, /Add a protected GitHub Actions release gate for the Rust \+ MoonBit sample/);
});
