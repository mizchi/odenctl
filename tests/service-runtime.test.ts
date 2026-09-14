import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const binary = process.env.ODEN_SERVICE_BIN;
const rust = process.env.ODEN_SERVICE_RUST;
const moonbit = process.env.ODEN_SERVICE_MOONBIT;

async function start(component: string, overrides: Record<string, unknown> = {}, service?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-service-"));
  const config = join(dir, "runtime.json");
  await writeFile(config, JSON.stringify({ timeout_ms: 2000, directories: [{ host: dir, guest: "/data", write: true }], ...overrides }));
  const manifest = join(dir, "app.json");
  await writeFile(manifest, JSON.stringify({ version: 1, mode: "service", component: resolve(component), listen: "127.0.0.1:0", runtime: { timeout_ms: 2000, ...overrides }, service }));
  const child = spawn(resolve(binary!), service ? ["start", manifest] : ["serve", resolve(component), "--resident", "--addr", "127.0.0.1:0", "--config", config]);
  let logs = "";
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exit = once(child, "exit");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout: ${logs}`)), 15_000);
      child.stderr.on("data", () => {
        const match = /listening on (http:\/\/[^\s]+)\r?\n/.exec(logs);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
    });
    return { url, dir, child, exit, logs: () => logs, output: () => output, async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { return await exit; } finally { clearTimeout(kill); }
    }, async cleanup() { await rm(dir, { recursive: true, force: true }); } };
  } catch (error) {
    child.kill("SIGKILL");
    await exit;
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

for (const [language, component] of [["rust", rust], ["moonbit", moonbit]] as const) {
  test(`${language} resident service initializes once, retains state, drives idle tasks and stops`, {
    skip: !(binary && component), timeout: 30_000,
  }, async (t) => {
    const server = await start(component!);
    t.after(async () => { await server.stop(); await server.cleanup(); });
    const first = await (await fetch(server.url)).json();
    const second = await (await fetch(server.url)).json();
    assert.equal(first.starts, 1);
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const third = await (await fetch(server.url)).json();
    assert.ok(third.ticks > first.ticks, "background tasks must run while the service is idle");
    const pending = fetch(`${server.url}/slow`, {
      method: "POST", duplex: "half",
      body: new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode("part"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        controller.close();
      } }),
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stopped = server.stop();
    assert.equal((await pending).count, 4, "shutdown must drain an accepted request even while its body is still arriving");
    assert.deepEqual(await stopped, [0, null], server.logs());
    assert.equal(server.output().trim(), "lifecycle:start\nlifecycle:stop");
  });

  test(`${language} resident service stops after a trap or request deadline`, {
    skip: !(binary && component), timeout: 30_000,
  }, async () => {
    for (const path of ["/trap", "/loop"]) {
      const server = await start(component!, { timeout_ms: 150 });
      try {
        const result = await fetch(`${server.url}${path}`).catch(() => undefined);
        if (result) { assert.equal(result.status, 500); await result.body?.cancel(); }
        const kill = setTimeout(() => server.child.kill("SIGKILL"), 5000);
        const [code, signal] = await server.exit;
        clearTimeout(kill);
        assert.equal(signal, null, server.logs());
        assert.notEqual(code, 0);
        if (path === "/loop") assert.match(server.logs(), /deadline exceeded/);
        assert.ok(!server.output().includes("lifecycle:stop"), "a failed Store must not be reused for stop");
      } finally { await server.stop(); await server.cleanup(); }
    }
  });

  test(`${language} resident service serializes requests and bounds request admission`, { skip: !(binary && component), timeout: 30_000 }, async (t) => {
    const server = await start(component!, { max_concurrent_requests: 2, max_body_bytes: 128 });
    t.after(async () => { await server.stop(); await server.cleanup(); });
    const large = await fetch(server.url, { method: "POST", body: "x".repeat(129) });
    assert.equal(large.status, 413); await large.body?.cancel();
    const slow = fetch(`${server.url}/slow`).then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const queued = fetch(server.url).then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const excess = await fetch(server.url);
    assert.equal(excess.status, 503); await excess.body?.cancel();
    assert.equal((await slow).count, 1, "the second request must wait for the first handler");
    assert.equal((await queued).count, 2);
    assert.equal((await (await fetch(server.url)).json()).count, 3);
  });
}

test("startup errors, startup CPU loops and shutdown CPU loops terminate within their deadlines", { skip: !(binary && rust), timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ["error", "loop"]) {
    const path = join(dir, "app.json");
    await writeFile(path, JSON.stringify({ version: 1, mode: "service", component: resolve(rust!), listen: "127.0.0.1:0", runtime: { env: { SERVICE_START: mode } }, service: { startup_timeout_ms: 100 } }));
    const result = spawnSync(resolve(binary!), ["start", path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, mode === "error" ? /requested startup failure/ : /deadline exceeded/);
    assert.ok(!result.stderr.includes("listening on"));
  }
  const server = await start(rust!, { env: { SERVICE_STOP: "loop" } }, { shutdown_timeout_ms: 100 });
  try {
    assert.deepEqual(await server.stop(), [1, null], server.logs());
    assert.match(server.logs(), /deadline exceeded/);
  } finally { await server.cleanup(); }
});
