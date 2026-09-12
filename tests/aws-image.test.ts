import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { startServiceProcess } from "../src/service-process.ts";

const host = process.env.WASMPLANE_AWS_IMAGE_HOST;
const component = process.env.WASMPLANE_AWS_IMAGE_COMPONENT;
test("AWS image manifest loads its bundled guest, serves HTTP, and drains on SIGTERM", {
  skip: !(host && component), timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasmplane-aws-image-"));
  try {
    const manifest = JSON.parse(await readFile("infra/aws-image/app.json", "utf8"));
    assert.equal(manifest.listen, "0.0.0.0:8080");
    assert.equal(manifest.mode, "service");
    assert.ok(manifest.service.shutdown_timeout_ms < 30_000);
    await copyFile(component!, join(directory, "service.wasm"));
    // Use an ephemeral loopback port for the test; preserve all guest/runtime settings.
    manifest.listen = "127.0.0.1:0";
    const path = join(directory, "app.json");
    await writeFile(path, JSON.stringify(manifest));
    const { stdout } = await promisify(execFile)(resolve(host!), ["check", path, "--json"]);
    assert.equal(JSON.parse(stdout).valid, true);
    const server = await startServiceProcess(resolve(host!), ["start", path]);
    try {
      const first = await fetch(server.url);
      assert.equal(first.status, 200);
      const a = await first.json();
      const b = await (await fetch(server.url)).json();
      assert.equal(a.starts, 1);
      assert.equal(b.count, a.count + 1);
      const stopped = await server.stop();
      assert.equal(stopped.exitCode, 0);
      assert.equal(stopped.forced, false);
      assert.equal(stopped.pidAlive, false);
    } finally { await server.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
