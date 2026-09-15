import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("pnpm exposes two product workspaces with deployment dependencies isolated", () => {
  const projects = JSON.parse(run("pnpm", ["list", "-r", "--depth", "-1", "--json"]));
  const products = projects.filter((project: { path: string }) => project.path !== process.cwd());
  assert.deepEqual(products.map((project: { name: string }) => project.name).sort(), ["@mizchi/oden", "@mizchi/odenctl"]);
  assert.deepEqual(products.map((project: { path: string }) => project.path).sort(), [resolve("crates/oden"), resolve("crates/odenctl")]);
  const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest("package.json").dependencies?.pg, undefined);
  assert.deepEqual(manifest("crates/oden/package.json").dependencies ?? {}, {});
  assert.ok(manifest("crates/odenctl/package.json").dependencies.pg);
});

test("standalone and deployment host are independent Cargo packages sharing runtime-core", () => {
  const metadata = JSON.parse(run("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
  for (const [name, directory] of [["oden", "crates/oden"], ["oden-host", "crates/odenctl"]]) {
    const pkg = metadata.packages.find((pkg: { name: string }) => pkg.name === name);
    assert.ok(pkg, `missing Cargo package ${name}`);
    assert.equal(pkg.manifest_path, resolve(directory, "Cargo.toml"));
    assert.deepEqual(pkg.targets.filter((target: { kind: string[] }) => target.kind.includes("bin")).map((target: { name: string }) => target.name), [name]);
    const dependencies = pkg.dependencies.map((dependency: { name: string }) => dependency.name);
    assert.ok(dependencies.includes("oden-runtime-core"));
    assert.ok(!dependencies.includes(name === "oden" ? "oden-host" : "oden"));
  }
});

test("management CLI can run directly through its pnpm workspace", () => {
  const output = run("pnpm", ["--silent", "--filter", "@mizchi/odenctl", "cli", "--help"]);
  assert.match(output, /odenctl <deploy\|dev\|migrate\|new\|onboard\|volume-sqlite>/);
});
