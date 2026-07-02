import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("project tooling keeps Wasm E2E portable", async () => {
  const justfile = await readFile("justfile", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const flyControl = await readFile("fly.control.toml", "utf8");
  const flyRuntime = await readFile("fly.runtime.toml", "utf8");
  const readme = await readFile("README.md", "utf8");
  await readFile("pnpm-lock.yaml", "utf8");

  assert.match(justfile, /node_modules\/@bytecodealliance\/jco\/lib\/wasi_snapshot_preview1\.reactor\.wasm/);
  assert.match(justfile, /^db-migrate-check:/m);
  assert.match(justfile, /^db-migrate-apply:/m);
  assert.match(justfile, /^volume-sqlite-bench:/m);
  assert.match(justfile, /^fly-volume-sqlite-bench:/m);
  assert.doesNotMatch(justfile, /\/Users\//);
  assert.match(packageJson.scripts["volume-sqlite-bench"], /src\/volume-sqlite-bench\.ts/);
  assert.equal(packageJson.devDependencies["@bytecodealliance/jco"], "1.15.4");
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /rustup target add wasm32-wasip1/);
  assert.match(workflow, /just test/);
  assert.match(workflow, /just e2e/);
  assert.match(flyControl, /WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS = "5000"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_ROOT = "\/data\/sqlite"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_OPEN = "64"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_PENDING_WRITES = "64"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE = "24"/);
  assert.match(flyControl, /WASMPLANE_VOLUME_SQLITE_BACKUP_RETENTION_MS = "604800000"/);
  assert.match(readme, /WASMPLANE_VOLUME_SQLITE_BACKUP_KEY_BASE64/);
  assert.match(readme, /WASMPLANE_VOLUME_SQLITE_BACKUP_KEYS_BASE64/);
  assert.match(readme, /WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS/);
  assert.match(readme, /WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL/);
  assert.match(justfile, /--max-pending-writes 64/);
  assert.match(flyRuntime, /RUNTIME_HOST = "::"/);
  assert.match(flyRuntime, /RUNTIME_ROUTE_SNAPSHOT_FILE = "\/data\/route-snapshot\.json"/);
  assert.match(flyRuntime, /path = "\/__runtime\/healthz"/);
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
