import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startServiceProcess } from "../src/service-process.ts";

const binary = process.env.ODEN_SDK_BIN && resolve(process.env.ODEN_SDK_BIN);
for (const language of ["rust", "moonbit"]) {
  test(`init creates a self-contained ${language} project outside the runtime repository`, { skip: !binary, timeout: 180_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "oden-sdk-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const app = join(dir, "app with spaces");
    const init = spawnSync(binary!, ["init", app, "--language", language], { encoding: "utf8", cwd: dir });
    assert.equal(init.status, 0, init.stderr);
    const manifest = JSON.parse(await readFile(join(app, "app.json"), "utf8"));
    assert.equal(manifest.mode, "service");
    const repeat = spawnSync(binary!, ["init", app, "--language", language], { encoding: "utf8" });
    assert.notEqual(repeat.status, 0, "init must not overwrite an existing project");
    if (process.env.ODEN_SDK_PACKAGES) {
      const packages = resolve(process.env.ODEN_SDK_PACKAGES);
      const archive = join(packages, language === "rust" ? "oden-service-sdk-0.1.0.crate" : "oden-moonbit-service-sdk-0.1.0.tgz");
      const extracted = join(dir, "extracted"); await mkdir(extracted);
      const unpacked = spawnSync("tar", ["xzf", archive, "-C", extracted], { encoding: "utf8" });
      assert.equal(unpacked.status, 0, unpacked.stderr);
      const vendor = join(app, "vendor/oden-sdk");
      await rm(vendor, { recursive: true });
      await cp(join(extracted, language === "rust" ? "oden-service-sdk-0.1.0" : "package"), vendor, { recursive: true });
    }
    const built = spawnSync(binary!, ["build", join(app, "app.json")], {
      cwd: dir, encoding: "utf8", timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: undefined },
    });
    assert.equal(built.status, 0, built.stderr);
    assert.ok((await readFile(join(app, manifest.component))).length > 8);
    const inspected = spawnSync(binary!, ["inspect", join(app, manifest.component), "--json"], { encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.ok(JSON.parse(inspected.stdout).compatible_modes.includes("service"));
    const server = await startServiceProcess(binary!, ["serve", join(app, manifest.component), "--resident", "--addr", "127.0.0.1:0"]);
    try {
      for (const count of [1, 2]) assert.deepEqual(await (await fetch(server.url)).json(), { count });
    } finally {
      const shutdown = await server.stop();
      assert.equal(shutdown.exitCode, 0, server.logs());
      assert.equal(shutdown.pidAlive, false);
    }
    // Neither the build script nor SDK refers back to this repository.
    const path = language === "rust" ? "vendor/oden-sdk/Cargo.toml" : "vendor/oden-sdk/build.mjs";
    assert.ok(!(await readFile(join(app, path), "utf8")).includes(process.cwd()));
  });
}

test("init rejects unknown languages without creating a project", { skip: !binary }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-init-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "keep.txt"), "keep");
  const result = spawnSync(binary!, ["init", dir, "--language", "unknown"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "keep");
});
