import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const binary = process.env.ODENCTL_WORKER_HOST_BIN;
const component = process.env.ODEN_WORKER_COMPONENT;

test("daemon serves concurrent outbound calls on one thread and cancels disconnected callers", {
  skip: !(binary && component), timeout: 30_000,
}, async (t) => {
  const pending: import("node:http").ServerResponse[] = [];
  const thirdRequest = Promise.withResolvers<import("node:http").ServerResponse>();
  const upstream = createServer((_request, response) => {
    pending.push(response);
    if (pending.length === 2) for (const reply of pending) reply.end("barrier");
    if (pending.length === 3) thirdRequest.resolve(response);
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/`;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(resolve(binary!), ["serve", "--host", "127.0.0.1", "--port", String(port), "--http-workers", "1"], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  child.stderr.on("data", (chunk) => logs += chunk);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { ready = (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(200) })).ok; } catch {}
    if (ready) break;
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(ready, logs);
  const payload = {
    component: resolve(component!), method: "GET", uri: "http://worker/fetch", body: "",
    headers: [{ name: "x-upstream-url", value: upstreamUrl }],
    limits: { wallMs: 3000 }, capabilities: { outboundHttp: { enabled: true, allow: [upstreamUrl] } },
  };
  async function invoke() {
    const reply = await fetch(`${baseUrl}/invoke`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(7000),
    }).catch((error) => { throw new Error(`${error}\n${logs}`); });
    const result = await reply.json();
    assert.equal(reply.status, 200, JSON.stringify(result));
    assert.match(result.body, /^barrier$/);
  }
  await Promise.all([invoke(), invoke()]);
  assert.equal(pending.length, 2);
  assert.equal((await fetch(`${baseUrl}/stats`)).status, 200);

  const controller = new AbortController();
  const cancelled = assert.rejects(fetch(`${baseUrl}/invoke`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal: controller.signal,
  }), /abort/i);
  const upstreamResponse = await thirdRequest.promise;
  const closed = once(upstreamResponse, "close", { signal: AbortSignal.timeout(1000) });
  controller.abort();
  await cancelled;
  await closed;
  assert.equal((await (await fetch(`${baseUrl}/stats`)).json()).activeInvocations, 0);
});
