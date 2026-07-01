import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("project tooling keeps Wasm E2E portable", async () => {
  const justfile = await readFile("justfile", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const flyControl = await readFile("fly.control.toml", "utf8");
  const flyRuntime = await readFile("fly.runtime.toml", "utf8");
  await readFile("pnpm-lock.yaml", "utf8");

  assert.match(justfile, /node_modules\/@bytecodealliance\/jco\/lib\/wasi_snapshot_preview1\.reactor\.wasm/);
  assert.match(justfile, /^db-migrate-check:/m);
  assert.match(justfile, /^db-migrate-apply:/m);
  assert.doesNotMatch(justfile, /\/Users\//);
  assert.equal(packageJson.devDependencies["@bytecodealliance/jco"], "1.15.4");
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /rustup target add wasm32-wasip1/);
  assert.match(workflow, /just test/);
  assert.match(workflow, /just e2e/);
  assert.match(flyControl, /WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS = "5000"/);
  assert.match(flyRuntime, /RUNTIME_HOST = "0\.0\.0\.0"/);
  assert.match(flyRuntime, /RUNTIME_ROUTE_SNAPSHOT_FILE = "\/data\/route-snapshot\.json"/);
  assert.match(flyRuntime, /path = "\/__runtime\/readyz"/);
});
