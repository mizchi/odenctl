import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { startServiceProcess } from "../src/service-process.ts";

test("real WASI P3 guest runs behind the response cache gateway", {
  skip: process.env.ODEN_RESPONSE_CACHE_E2E !== "1",
  timeout: 40_000,
}, async (t) => {
  const server = await startServiceProcess(process.execPath, [
    "--experimental-strip-types",
    resolve("examples/response-cache/server.ts"),
  ], { ...process.env, RESPONSE_CACHE_PORT: "0" });
  t.after(() => server.stop());
  const headers = { "x-forwarded-host": "cache.example.local" };
  const get = (extra = {}) =>
    fetch(server.url + "/public/bytes", { headers: { ...headers, ...extra } });
  const first = await get();
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get("x-oden-cache"), "MISS");
  assert.deepEqual(
    [...new Uint8Array(await first.arrayBuffer())],
    Array.from({ length: 256 }, (_, i) => i),
  );
  const second = await get();
  assert.equal(second.headers.get("x-oden-cache"), "HIT");
  assert.deepEqual(
    [...new Uint8Array(await second.arrayBuffer())],
    Array.from({ length: 256 }, (_, i) => i),
  );
  assert.equal(
    (await get({ cookie: "session=private" })).headers.get("x-oden-cache"),
    "BYPASS",
  );
  const admin = { authorization: "Bearer local-cache-demo" };
  const metrics =
    await (await fetch(server.url + "/__runtime/metrics", { headers: admin }))
      .json();
  assert.equal(metrics.requests.total, 3);
  assert.equal(metrics.invocations.total, 2);
  const purge = await fetch(server.url + "/__runtime/response-cache/purge", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ projectId: "prj_cache_demo" }),
  });
  assert.equal(purge.status, 200);
  assert.equal((await get()).headers.get("x-oden-cache"), "MISS");
  const stopped = await server.stop();
  assert.equal(stopped.forced, false);
  assert.equal(stopped.exitCode, 0);
});
