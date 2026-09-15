import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startCelldDev } from "../crates/odenctl/src/celld-dev.ts";

const binary = process.env.ODEN_SERVICE_BIN;
for (const [language, component] of [["rust", process.env.ODEN_SERVICE_RUST], ["moonbit", process.env.ODEN_SERVICE_MOONBIT]] as const) {
  test(`${language} SDK uses granted I/O, bounds reads and releases resources across repeated calls`, { skip: !(binary && component), timeout: 40_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "odenctl-io-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.equal(req.method, "POST");
      assert.equal(req.headers["x-sdk"], "yes");
      res.writeHead(201, { "x-upstream": "yes" });
      res.end(Buffer.concat(chunks));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const authority = `127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    let deniedRequests = 0;
    const denied = createServer((req, res) => { deniedRequests++; req.resume(); res.writeHead(201); res.end("unexpected access"); });
    denied.listen(0, "127.0.0.1"); await once(denied, "listening");
    t.after(() => { denied.closeAllConnections(); denied.close(); });
    const deniedAuthority = `127.0.0.1:${(denied.address() as import("node:net").AddressInfo).port}`;
    const data = join(dir, "data");
    const { mkdir } = await import("node:fs/promises"); await mkdir(data);
    await writeFile(join(data, "input.txt"), "hello 日本語");
    await writeFile(join(dir, "outside.txt"), "outside");
    await symlink(join(dir, "outside.txt"), join(data, "escape.txt"));
    const celld = process.env.ODEN_CELLD_BIN ? await startCelldDev(process.env.ODEN_CELLD_BIN) : undefined;
    if (celld) t.after(() => celld.stop());
    const config = join(dir, "runtime.json");
    await writeFile(config, JSON.stringify({ timeout_ms: 5000, env: { IO_VALUE: "hello 日本語", IO_AUTHORITY: authority, IO_DENIED_AUTHORITY: deniedAuthority }, directories: [{ host: data, guest: "/data", write: true }, { host: data, guest: "/readonly", write: false }], outbound_origins: [`http://${authority}`], durable: celld ? { counter: { endpoint: celld.endpoint, namespace: "COUNTER", token_env: "SDK_GATEWAY_TOKEN" } } : {} }));
    const child = spawn(resolve(binary!), ["serve", resolve(component!), "--resident", "--addr", "127.0.0.1:0", "--config", config], { env: { ...process.env, SDK_GATEWAY_TOKEN: celld?.token } });
    let logs = ""; child.stdout.resume(); child.stderr.on("data", (c) => logs += c);
    const exited = once(child, "exit");
    t.after(async () => { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timer); });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(logs)), 15_000);
      child.stderr.on("data", () => { const match = /listening on (http:\/\/[^\s]+)\r?\n/.exec(logs); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
    });
    async function call(path: string) { const response = await fetch(url + path); assert.equal(response.status, 200, logs); return response.json(); }
    assert.deepEqual(await call("/io/env"), { value: "hello 日本語", missing: true });
    assert.deepEqual(await call("/io/read"), { value: "hello 日本語" });
    assert.deepEqual(await call("/io/write"), { ok: true });
    assert.equal(await readFile(join(data, "output.txt"), "utf8"), "written 日本語");
    for (const path of ["read-limit", "readonly", "escape", "parent", "missing", "ungranted", "http-denied", "http-limit", "durable-denied"]) {
      assert.deepEqual(await call(`/io/${path}`), { rejected: true }, path);
    }
    assert.equal(deniedRequests, 0, "an ungranted origin must not receive a request");
    // Repeated success and early body cancellation share one Store/resource table.
    for (let i = 0; i < 30; i++) {
      assert.deepEqual(await call("/io/fetch"), { status: 201, header: true, value: "payload 日本語" });
      assert.deepEqual(await call("/io/http-limit"), { rejected: true });
      assert.deepEqual(await call("/io/read-limit"), { rejected: true });
      assert.deepEqual(await call("/io/read"), { value: "hello 日本語" });
    }
    await t.test("SDK reaches a real celld object repeatedly through the WIT adapter", { skip: !celld }, async () => {
      for (let n = 1; n <= 20; n++) assert.deepEqual(await call("/io/durable"), { n });
    });
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], logs);
  });
}
