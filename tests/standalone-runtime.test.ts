import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const bin = process.env.ODEN_STANDALONE_BIN;
const component = process.env.ODEN_STANDALONE_HTTP_COMPONENT;
const p3Component = process.env.ODEN_STANDALONE_HTTP_P3_COMPONENT;
const enabled = Boolean(bin && component);

async function start(config: unknown, guestComponent = component!) {
  const directory = await mkdtemp(join(tmpdir(), "odenctl-standalone-"));
  const path = join(directory, "runtime.json");
  await writeFile(path, JSON.stringify(config));
  const child = spawn(resolve(bin!), ["serve", resolve(guestComponent), "--addr", "127.0.0.1:0", "--config", path], { cwd: directory, env: { ...process.env, ODEN_TEST_PRIVATE: "host-private" } });
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /listening on (http:\/\/[^\s]+)\r?\n/.exec(stderr);
      if (match) resolve(match[1]);
    });
    child.once("exit", () => reject(new Error(stderr)));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const url = await ready;
    clearTimeout(timer);
    return { url, async stop(signalToSend: NodeJS.Signals = "SIGINT") {
      const exited = once(child, "exit");
      child.kill(signalToSend);
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code, signal] = await exited;
      clearTimeout(kill);
      await rm(directory, { recursive: true, force: true });
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
    } };
  } catch (error) {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("standalone HTTP streams before the handler finishes and cancels on shutdown", { skip: !enabled }, async () => {
  const server = await start({ timeout_ms: 2000 });
  try {
    assert.equal(await (await fetch(server.url)).text(), "hello from standalone");
    const response = await fetch(`${server.url}/stream`);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    await reader.cancel();
  } finally { await server.stop(); }
});

test("WASIp3 HTTP keeps stream producers alive after the handler returns", { skip: !(bin && p3Component) }, async () => {
  const server = await start({ timeout_ms: 3000 }, p3Component!);
  try {
    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "second\n");
    assert.equal((await reader.read()).done, true);
    const active = await fetch(server.url);
    await active.body!.cancel();
  } finally { await server.stop("SIGTERM"); }
});

test("standalone outbound requests progress concurrently and require an explicit capability", { skip: !enabled }, async (t) => {
  const pending: import("node:http").ServerResponse[] = [];
  const upstream = createServer((_req, response) => {
    pending.push(response);
    if (pending.length === 2) for (const res of pending) res.end("barrier released");
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as import("node:net").AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const allowed = await start({ env: { UPSTREAM: origin }, outbound_origins: [origin], timeout_ms: 3000 });
  t.after(() => allowed.stop());
  const denied = await start({ env: { UPSTREAM: origin }, timeout_ms: 3000 });
  t.after(() => denied.stop());
    assert.equal(await (await fetch(`${denied.url}/fetch`)).text(), "outbound denied");
    assert.equal(pending.length, 0);
    const replies = await Promise.all([1, 2].map(async () => (await fetch(`${allowed.url}/fetch`)).text()));
    assert.deepEqual(replies, ["barrier released", "barrier released"]);
});

test("filesystem and environment capabilities are explicit and read-only by default", { skip: !enabled }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odenctl-preopen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "message"), "granted file");
  const denied = await start({});
  t.after(() => denied.stop());
  assert.equal(await (await fetch(`${denied.url}/env`)).text(), "env denied");
  assert.equal(await (await fetch(`${denied.url}/file`)).text(), "file denied");
  const allowed = await start({ env: { ODEN_TEST_PRIVATE: "explicit value" }, directories: [{ host: directory, guest: "/data" }] });
  t.after(() => allowed.stop());
  assert.equal(await (await fetch(`${allowed.url}/env`)).text(), "explicit value");
  assert.equal(await (await fetch(`${allowed.url}/file`)).text(), "granted file");
  assert.equal(await (await fetch(`${allowed.url}/write`)).text(), "write denied");
});

test("stream capacity is released on cancellation and active streams stop with the server", { skip: !enabled }, async () => {
  const server = await start({ max_concurrent_requests: 1, timeout_ms: 1000 });
  try {
    const first = await fetch(`${server.url}/stream`);
    const reader = first.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    assert.equal((await fetch(server.url)).status, 503);
    await reader.cancel();
    let response: Response | undefined;
    for (let i = 0; i < 50; i++) {
      response = await fetch(server.url);
      if (response.status === 200) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(response?.status, 200);
    await response?.text();
    const active = await fetch(`${server.url}/stream`);
    await active.body!.getReader().read();
  } finally { await server.stop(); }
});

test("standalone enforces body limits and continues after a guest trap", { skip: !enabled }, async () => {
  const server = await start({ max_body_bytes: 32, timeout_ms: 1000 });
  try {
    assert.equal((await fetch(server.url, { method: "POST", body: "x".repeat(33) })).status, 413);
    assert.equal((await fetch(`${server.url}/trap`)).status, 500);
    assert.equal(await (await fetch(server.url)).text(), "hello from standalone");
  } finally { await server.stop(); }
});
