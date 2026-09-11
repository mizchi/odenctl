import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  parseCelldBenchArgs, runGatewayCase, summarizeGuestCase, formatCelldBenchmark, runCelldBenchmark,
} from "../src/celld-bench.ts";

test("celld benchmark validates sample counts and concurrency", () => {
  const options = parseCelldBenchArgs(["--iterations", "12", "--warmup", "0", "--concurrency", "1,4", "--objects", "3"]);
  assert.equal(options.iterations, 12);
  assert.equal(options.warmup, 0);
  assert.deepEqual(options.concurrency, [1, 4]);
  assert.equal(options.objects, 3);
  for (const args of [["--iterations", "0"], ["--warmup", "-1"], ["--objects", "1.5"], ["--concurrency", "0,2"], ["--format", "csv"], ["--iterations"], ["--unknown", "1"]]) {
    assert.throws(() => parseCelldBenchArgs(args));
  }
});

test("gateway benchmark excludes warmup and writes with distinct IDs across sharded objects", async (t) => {
  const ids = new Set<string>();
  const objects = new Map<string, number>();
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const name = request.url!;
    if (input.method === "POST") {
      assert.ok(!ids.has(input.requestId), "every update must have a distinct ID");
      ids.add(input.requestId);
      objects.set(name, (objects.get(name) ?? 0) + 1);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: 200, headers: [], body: Buffer.from(JSON.stringify({ n: objects.get(name) ?? 0 })).toString("base64") }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await runGatewayCase({ endpoint: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, token: "test-token" }, {
    workload: "increment", prefix: "test", iterations: 7, warmup: 3, concurrency: 2, objects: 3, timeoutMs: 1000,
  });
  assert.equal(result.count, 7);
  assert.equal(result.errors, 0);
  assert.equal(result.warmupCount, 3);
  assert.equal(result.verifiedCount, 10);
  assert.equal(ids.size, 10);
  assert.equal(objects.size, 3);
  assert.equal([...objects.values()].reduce((a, b) => a + b, 0), 10);
});

test("guest report validates samples and retains startup separately from call latency", () => {
  const options = { workload: "read" as const, prefix: "test", iterations: 3, warmup: 1, concurrency: 1, objects: 1, timeoutMs: 1000 };
  const raw = { schemaVersion: 1, latenciesMs: [1, 2, 3], elapsedMs: 6, warmupCount: 1, warmupElapsedMs: 50, verifiedCount: 0 };
  const result = summarizeGuestCase(raw, options, 150);
  assert.equal(result.p50Ms, 2);
  assert.equal(result.p95Ms, 3);
  assert.equal(result.elapsedMs, 6);
  assert.equal(result.processElapsedMs, 150);
  assert.throws(() => summarizeGuestCase({ ...raw, latenciesMs: [1, 2] }, options, 150));
  assert.throws(() => summarizeGuestCase({ ...raw, latenciesMs: [1, -1, 3] }, options, 150));
  assert.throws(() => summarizeGuestCase({ ...raw, warmupCount: 0 }, options, 150));
  assert.throws(() => summarizeGuestCase({ ...raw, verifiedCount: 4 }, options, 150));
  assert.match(formatCelldBenchmark({ schemaVersion: 1, generatedAt: "test", environment: {}, results: [result] }), /wit\.read/);
});

test("gateway failures invalidate a benchmark instead of producing fast success metrics", async (t) => {
  const server = createServer((_, response) => { response.writeHead(401); response.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(runGatewayCase({ endpoint: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, token: "invalid" }, {
    workload: "read", prefix: "test", iterations: 2, warmup: 0, concurrency: 1, objects: 1, timeoutMs: 1000,
  }), /401/);
});

test("benchmark rejects successful replies when updates were not committed", async (t) => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    // Simulate a broken actor: every write reports success, but GET still sees 0.
    const n = JSON.parse(body).method === "POST" ? 1 : 0;
    response.end(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ n })).toString("base64") }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(runGatewayCase({ endpoint: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, token: "test" }, {
    workload: "increment", prefix: "test", iterations: 2, warmup: 1, concurrency: 1, objects: 1, timeoutMs: 1000,
  }), /committed updates/);
});

test("benchmark compares real celld and WIT with concurrent calls and verified writes", {
  skip: !(process.env.WASMPLANE_CELLD_BIN && process.env.WASMPLANE_BENCH_HOST_BIN), timeout: 120_000,
}, async () => {
  const options = parseCelldBenchArgs([
    "--host-bin", process.env.WASMPLANE_BENCH_HOST_BIN!,
    "--iterations", "6", "--warmup", "2", "--concurrency", "1,3", "--objects", "2",
  ]);
  const report = await runCelldBenchmark(options);
  assert.equal(report.results.length, 8);
  for (const row of report.results) {
    assert.equal(row.count, 6);
    assert.equal(row.errors, 0);
    assert.equal(row.verifiedCount, row.name.endsWith("increment") ? 8 : 0);
    assert.equal(row.warmupCount, 2);
    assert.ok(row.throughputRps > 0);
    if (row.name.startsWith("wit.")) assert.ok(row.processElapsedMs! > row.elapsedMs);
  }
  assert.ok(!JSON.stringify(report).includes("Bearer"));
});
