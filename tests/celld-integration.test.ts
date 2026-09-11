import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const binary = process.env.WASMPLANE_STANDALONE_BIN;
const component = process.env.WASMPLANE_DURABLE_COMPONENT;
const celld = process.env.WASMPLANE_CELLD_BIN;

test("WIT calls reach real celld objects with persistence, namespace isolation and retry deduplication", {
  skip: !(binary && component && celld), timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wasmplane-celld-"));
  await copyFile("examples/celld-gateway/index.js", join(directory, "index.js"));
  const token = randomBytes(32).toString("hex");
  const config = JSON.parse(await readFile("examples/celld-gateway/wrangler.jsonc", "utf8"));
  config.vars.WASMPLANE_GATEWAY_TOKEN = token;
  config.vars.WASMPLANE_BINDINGS = "COUNTER,OTHER";
  config.durable_objects.bindings.push({ name: "OTHER", class_name: "OtherCounter" });
  config.migrations[0].new_sqlite_classes.push("OtherCounter");
  const source = await readFile(join(directory, "index.js"), "utf8");
  await writeFile(join(directory, "index.js"), `${source}\nexport class OtherCounter extends Counter {}\n`);
  await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(config));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const runtimeConfig = join(directory, "runtime.json");
  const hostConfig = { timeout_ms: 10_000, durable: {
    counter: { endpoint, namespace: "COUNTER", token_env: "TEST_GATEWAY_TOKEN" },
    other: { endpoint, namespace: "OTHER", token_env: "TEST_GATEWAY_TOKEN" },
  } };
  await writeFile(runtimeConfig, JSON.stringify(hostConfig));
  let child: ReturnType<typeof spawn> | undefined;
  let logs = "";
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer); child = undefined;
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    logs = "";
    child = spawn(celld!, ["dev", directory, "--port", String(port), "--no-watch", "--logs"], {
      env: { ...process.env, PATH: `${resolve("node_modules/.bin")}${delimiter}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (v) => logs += v);
    child.stderr!.on("data", (v) => logs += v);
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(endpoint, { signal: AbortSignal.timeout(300) })).status === 401) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`celld did not become ready: ${logs}`);
  }
  async function run(binding: string, name: string, id?: string) {
    const { stdout } = await promisify(execFile)(resolve(binary!), ["run", resolve(component!), "--config", runtimeConfig, "--", binding, name, ...(id ? [id] : [])], {
      env: { ...process.env, TEST_GATEWAY_TOKEN: token }, timeout: 20_000,
    });
    return JSON.parse(stdout.trim());
  }
  await start();
  await t.test("component WAT calls the durable WIT directly and deduplicates retries", async () => {
    const args = ["run", resolve("examples/durable-counter/counter.wat"), "--config", runtimeConfig];
    for (let attempt = 0; attempt < 2; attempt++) {
      await promisify(execFile)(resolve(binary!), args, {
        env: { ...process.env, TEST_GATEWAY_TOKEN: token }, timeout: 20_000,
      });
      assert.equal((await run("counter", "wat-counter")).n, 1);
    }
  });
  await t.test("component WAT returns failure for denied bindings and gateway authentication", async () => {
    const args = ["run", resolve("examples/durable-counter/counter.wat")];
    // WIT errors become Err(()) with exit 1, rather than a Wasm trap on stderr.
    const failedCommand = { code: 1, stdout: "", stderr: "" };
    await assert.rejects(promisify(execFile)(resolve(binary!), args, { timeout: 20_000 }), failedCommand);
    await assert.rejects(promisify(execFile)(resolve(binary!), [...args, "--config", runtimeConfig], {
      env: { ...process.env, TEST_GATEWAY_TOKEN: "invalid-token" }, timeout: 20_000,
    }), failedCommand);
    assert.equal((await run("counter", "wat-counter")).n, 1);
  });
  assert.equal((await run("counter", "one", "retry-1")).n, 1);
  assert.equal((await run("counter", "one", "retry-1")).n, 1);
  const values = await Promise.all(Array.from({ length: 6 }, (_, i) => run("counter", "one", `concurrent-${i}`)));
  assert.deepEqual(values.map((v) => v.n).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  assert.equal((await run("counter", "two")).n, 0);
  assert.equal((await run("other", "one")).n, 0);
  await assert.rejects(run("unbound", "one"), /BindingDenied/);
  // Drop only the reply, after the real actor has committed the update.
  let dispatches = 0;
  let loseReply = true;
  const proxy = createHttpServer(async (request, response) => {
    dispatches++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const reply = await fetch(`${endpoint}${request.url}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(10_000),
      });
      const body = await reply.text();
      if (loseReply) { loseReply = false; response.destroy(); }
      else { response.writeHead(reply.status); response.end(body); }
    } catch { response.destroy(); }
  });
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as import("node:net").AddressInfo).port;
  hostConfig.durable.counter.endpoint = `http://127.0.0.1:${proxyPort}`;
  await writeFile(runtimeConfig, JSON.stringify(hostConfig));
  await assert.rejects(run("counter", "部屋/lost", "lost-1"), /OutcomeUnknown/);
  assert.equal(dispatches, 1, "the adapter must not retry an unknown outcome");
  assert.equal((await run("counter", "部屋/lost", "lost-1")).n, 1);
  assert.equal((await run("counter", "部屋/lost")).n, 1);
  hostConfig.durable.counter.endpoint = endpoint;
  await writeFile(runtimeConfig, JSON.stringify(hostConfig));
  await stop(); await start();
  assert.equal((await run("counter", "wat-counter")).n, 1);
  assert.equal((await run("counter", "one")).n, 7);
  assert.equal((await run("counter", "one", "retry-1")).n, 1);
  assert.equal((await run("counter", "部屋/lost")).n, 1);
});
