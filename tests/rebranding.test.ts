import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseDeployArgs, parseDevArgs } from "../src/cli.ts";
import { resolveControlPlaneDatabaseConfig } from "../src/control-plane/database.ts";

test("odenctl is the management CLI and exposes its own help", () => {
  const result = spawnSync("pnpm", ["--silent", "odenctl", "--help"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /odenctl <deploy\|dev\|migrate\|new\|onboard\|volume-sqlite>/);
});

test("management and runtime settings use their respective product prefixes", () => {
  const env = {
    ODENCTL_CONTROL_PLANE_URL: "https://control.example.test",
    ODENCTL_CONTROL_PLANE_TOKEN: "control-token",
    ODEN_RUNTIME_URL: "https://runtime.example.test",
    ODEN_RUNTIME_TOKEN: "runtime-token",
    ODEN_WASIP3_HOST_BIN: "/installed/bin/oden-host",
  };
  const args = ["--project-id", "prj_site", "--component", "site.wasm", "--host", "site.example.test"];
  const deploy = parseDeployArgs(args, env);
  assert.equal(deploy.controlPlaneUrl, env.ODENCTL_CONTROL_PLANE_URL);
  assert.equal(deploy.token, env.ODENCTL_CONTROL_PLANE_TOKEN);
  const dev = parseDevArgs(args, env);
  assert.equal(dev.runtimeUrl, env.ODEN_RUNTIME_URL);
  assert.equal(dev.runtimeToken, env.ODEN_RUNTIME_TOKEN);
  assert.equal(dev.hostBin, env.ODEN_WASIP3_HOST_BIN);
  assert.deepEqual(resolveControlPlaneDatabaseConfig({ ODENCTL_DB: "/data/existing.sqlite" }), {
    kind: "sqlite", path: "/data/existing.sqlite",
  });
});

for (const entry of ["src/main.ts", "src/runtime/main.ts"]) {
  test(`${entry} rejects old environment settings before startup`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oden-rename-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const secret = "legacy-token-must-not-appear-in-errors";
    const result = spawnSync(process.execPath, [resolve(entry)], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        WASMPLANE_API_TOKEN: secret,
        HOST: "127.0.0.1", PORT: "0",
        RUNTIME_HOST: "127.0.0.1", RUNTIME_PORT: "0",
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /WASMPLANE_API_TOKEN/);
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.deepEqual(await readdir(directory), []);
  });
}
