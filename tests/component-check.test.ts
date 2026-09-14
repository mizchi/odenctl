import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const binary = process.env.ODEN_SDK_BIN && resolve(process.env.ODEN_SDK_BIN);
const command = resolve("examples/minimal-command/command.wat");
test("inspect reports the component contract without calling an entry point", { skip: !binary }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const component = join(dir, "loop.wat");
  await writeFile(component, `(component (core module $m (func (export "run") (result i32) (loop $l br $l) i32.const 0))
  (core instance $i (instantiate $m)) (func $f (result (result)) (canon lift (core func $i "run")))
  (instance $c (export "run" (func $f))) (export "wasi:cli/run@0.2.0" (instance $c)))`);
  const result = spawnSync(binary!, ["inspect", component, "--json"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.compatible_modes, ["command"]);
  assert.ok(report.exports.some((item: { name: string }) => item.name === "wasi:cli/run@0.2.0"));
  assert.equal(report.sha256.length, 64);
});
test("check validates mode, imports and grants without leaking environment values", { skip: !binary }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = join(dir, "app.json");
  for (const mode of ["command", "service"]) {
    await writeFile(manifest, JSON.stringify({ version: 1, component: command, mode, runtime: { env: { SECRET: "must-not-appear" } } }));
    const result = spawnSync(binary!, ["check", manifest, "--json"], { encoding: "utf8" });
    assert.equal(result.status, mode === "command" ? 0 : 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, mode === "command");
    assert.ok(!result.stdout.includes("must-not-appear"));
    assert.deepEqual(report.grants.env, ["SECRET"]);
    if (mode === "service") assert.match(report.errors.join(" "), /service/);
  }
  const unsupported = join(dir, "unsupported.wat");
  await writeFile(unsupported, '(component (import "unknown:pkg/api@1.0.0" (instance (export "required" (func)))))');
  await writeFile(manifest, JSON.stringify({ version: 1, component: unsupported, mode: "command" }));
  const result = spawnSync(binary!, ["check", manifest, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /unknown:pkg/);
});
