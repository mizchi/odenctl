import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { startServiceProcess } from "../src/service-process.ts";

const host = process.env.ODENCTL_AWS_IMAGE_HOST;
const component = process.env.ODENCTL_AWS_IMAGE_COMPONENT;
const image = process.env.ODENCTL_AWS_IMAGE;
const execute = promisify(execFile);

async function checkApplication(url: string) {
  for (let i = 0; i < 3; i++) {
    const health = await fetch(url + "/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
  }
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { service: "oden", status: "ok" });
  for (const path of ["/trap", "/loop", "/slow", "/missing"]) {
    const response = await fetch(url + path, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  const head = await fetch(url + "/healthz", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(url + "/healthz", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  await post.arrayBuffer();
}

test(
  "AWS image manifest loads its bundled guest, serves HTTP, and drains on SIGTERM",
  {
    skip: !(host && component),
    timeout: 30_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "odenctl-aws-image-"));
    try {
      const manifest = JSON.parse(
        await readFile("infra/aws-image/app.json", "utf8"),
      );
      assert.equal(manifest.listen, "0.0.0.0:8080");
      assert.equal(manifest.mode, "service");
      assert.ok(manifest.service.shutdown_timeout_ms < 30_000);
      await copyFile(component!, join(directory, "service.wasm"));
      // Use an ephemeral loopback port for the test; preserve all guest/runtime settings.
      manifest.listen = "127.0.0.1:0";
      const path = join(directory, "app.json");
      await writeFile(path, JSON.stringify(manifest));
      const { stdout } = await promisify(execFile)(resolve(host!), [
        "check",
        path,
        "--json",
      ]);
      assert.equal(JSON.parse(stdout).valid, true);
      const server = await startServiceProcess(resolve(host!), ["start", path]);
      try {
        await checkApplication(server.url);
        const stopped = await server.stop();
        assert.equal(stopped.exitCode, 0);
        assert.equal(stopped.forced, false);
        assert.equal(stopped.pidAlive, false);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "release container runs without root or writable rootfs and stops gracefully across restarts",
  {
    skip: !image,
    timeout: 120_000,
  },
  async () => {
    const docker = async (...args: string[]) =>
      (await execute("docker", args, { timeout: 30_000 })).stdout.trim();
    const id = await docker(
      "run",
      "--detach",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=1g",
      "--cpus=0.5",
      "--publish",
      "127.0.0.1::8080",
      image!,
    );
    const inspect = async () => JSON.parse(await docker("inspect", id))[0];
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        if (cycle > 0) await docker("start", id);
        const state = await inspect();
        assert.equal(state.Config.User, "65532:65532");
        assert.equal(state.HostConfig.ReadonlyRootfs, true);
        const url = `http://127.0.0.1:${
          state.NetworkSettings.Ports["8080/tcp"][0].HostPort
        }`;
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            const response = await fetch(url + "/healthz", {
              signal: AbortSignal.timeout(500),
            });
            await response.arrayBuffer();
            if (response.status === 200) {
              ready = true;
              break;
            }
          } catch { /* The guest may still be compiling or starting. */ }
          if (!(await inspect()).State.Running) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(ready, (await execute("docker", ["logs", id])).stderr);
        await checkApplication(url);
        await docker("stop", "--time", "15", id);
        const stopped = (await inspect()).State;
        assert.equal(stopped.Running, false);
        assert.equal(stopped.OOMKilled, false);
        assert.equal(
          stopped.ExitCode,
          0,
          (await execute("docker", ["logs", id])).stderr,
        );
      }
    } finally {
      await docker("rm", "--force", id);
    }
  },
);
