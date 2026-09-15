import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const installer = resolve(process.env.ODEN_INSTALL_SCRIPT ?? "install.sh");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "oden-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "tools");
  const prefix = join(directory, "installed tools 'quoted'");
  await mkdir(bin);
  await writeFile(join(bin, "cargo"), `#!/bin/bash
set -eu
printf '%s\\n' "$@" > "$INSTALL_TEST_LOG"
if [[ "$INSTALL_TEST_FAIL" == 1 ]]; then exit 42; fi
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --target-dir ]]; then build_dir="$2"; shift; fi
  shift
done
mkdir -p "$build_dir/release"
for name in oden oden-host; do
  printf '#!/bin/sh\\nprintf "installed %s\\\\n"\\n' "$name" > "$build_dir/release/$name"
  chmod +x "$build_dir/release/$name"
done
`);
  await chmod(join(bin, "cargo"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_TEST_LOG: join(directory, "cargo.log"), INSTALL_TEST_FAIL: "0", ODEN_INSTALL_TARGET_DIR: join(directory, "build") };
  function run(args: string[] = [], extraEnv = {}) {
    return spawnSync("bash", [installer, "--prefix", prefix, ...args], { cwd: directory, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000 });
  }
  return { directory, prefix, env, run };
}

test("installer documents options and rejects invalid arguments before building", async (t) => {
  const f = await fixture(t);
  const help = f.run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--with-odenctl/);
  assert.notEqual(f.run(["--unknown"]).status, 0);
  assert.notEqual(f.run(["--prefix"]).status, 0);
  await assert.rejects(access(f.env.INSTALL_TEST_LOG));
});

test("installer uses locked release builds and installs a runnable command outside the checkout", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const command = spawnSync(join(f.prefix, "bin/oden"), ["--version"], { cwd: f.directory, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /installed oden/);
  const args = await readFile(f.env.INSTALL_TEST_LOG, "utf8");
  assert.match(args, /--locked\n/);
  assert.match(args, /--release\n/);
  await assert.rejects(access(join(f.prefix, "bin/odenctl")));
});

test("installer requires force to replace commands and rejects directory destinations", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.prefix, "bin"), { recursive: true });
  await writeFile(join(f.prefix, "bin/oden"), "existing installation");
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(join(f.prefix, "bin/oden"), "utf8"), "existing installation");
  await assert.rejects(access(f.env.INSTALL_TEST_LOG));
  assert.equal(f.run(["--force"]).status, 0);
  await rm(join(f.prefix, "bin/oden"));
  await mkdir(join(f.prefix, "bin/oden"));
  assert.notEqual(f.run(["--force"]).status, 0);
});

test("failed builds leave the existing installation intact", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.prefix, "bin"), { recursive: true });
  await writeFile(join(f.prefix, "bin/oden"), "existing installation");
  assert.notEqual(f.run(["--force"], { INSTALL_TEST_FAIL: "1" }).status, 0);
  assert.equal(await readFile(join(f.prefix, "bin/oden"), "utf8"), "existing installation");
});

test("installed runtime and management CLI run from outside the source checkout", {
  skip: process.env.ODEN_INSTALL_E2E !== "1",
  timeout: 900_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oden-installed-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = join(directory, "prefix with 'quotes'");
  const result = await new Promise<{ status: number | null; output: string }>((done, reject) => {
    const child = spawn("bash", [installer, "--prefix", prefix, "--with-odenctl"], {
      cwd: directory, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", status => done({ status, output }));
    t.after(() => { child.kill(); });
  });
  assert.equal(result.status, 0, result.output);
  const host = await realpath(join(prefix, "bin/oden-host"));
  const cliDirectory = resolve(host, "../../odenctl");
  const manifest = JSON.parse(await readFile(join(cliDirectory, "package.json"), "utf8"));
  assert.equal(manifest.name, "@mizchi/odenctl");
  await access(join(cliDirectory, "db/postgres/001_init.sql"));
  await access(join(cliDirectory, "node_modules/pg/package.json"));
  await assert.rejects(access(join(cliDirectory, "node_modules/@playwright/test")));
  function run(name: string, args: string[]) {
    const command = spawnSync(join(prefix, "bin", name), args, {
      cwd: directory, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(command.status, 0, command.stderr || command.stdout);
    return command.stdout;
  }
  assert.match(run("oden", ["--version"]), /Wasmtime 48\.0\.2/);
  await writeFile(join(directory, "command.wat"), await readFile("examples/minimal-command/command.wat"));
  run("oden", ["run", "command.wat"]);
  run("oden", ["init", "app", "--language", "rust"]);
  await access(join(directory, "app/vendor/oden-sdk/Cargo.toml"));
  assert.match(run("odenctl", ["--help"]), /odenctl <deploy\|dev/);
  run("odenctl", ["new", "--language", "rust", "--name", "installed-worker", "--out", "worker"]);
  await access(join(directory, "worker/Cargo.toml"));
  run("odenctl", ["migrate", "apply"]);
  run("odenctl", ["migrate", "check"]);
  await access(join(directory, "odenctl.sqlite"));
});
