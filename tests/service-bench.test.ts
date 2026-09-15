import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseServiceBenchOptions, runServiceBenchmark } from "../crates/odenctl/src/service-bench.ts";

const host = process.env.ODEN_SERVICE_BIN;
const component = process.env.ODEN_SERVICE_RUST;
test("service benchmark validates bounded workloads and rejects unknown flags", () => {
  assert.throws(() => parseServiceBenchOptions(["--duration-ms", "-1"]), /duration/);
  assert.throws(() => parseServiceBenchOptions(["--concurrency", "0"]), /concurrency/);
  assert.throws(() => parseServiceBenchOptions(["--typo", "yes"]), /unknown/);
  assert.throws(() => parseServiceBenchOptions(["--mode", "other"]), /mode/);
});
test("service benchmark measures both Store models, sustained load and cleanup over restarts", { skip: !(host && component), timeout: 50_000 }, async () => {
  const report = await runServiceBenchmark({ ...parseServiceBenchOptions([]), hostBin: resolve(host!), component: resolve(component!), iterations: 6, warmup: 2, concurrency: [2], durationMs: 200, cycles: 2 });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.componentSha256.length, 64);
  assert.equal(report.results.length, 4);
  for (const result of report.results) {
    assert.ok(result.startupMs > 0);
    assert.ok(result.firstRequestMs > 0);
    assert.ok(result.durationMs >= 200);
    assert.ok(result.requests >= 6);
    assert.equal(result.errors, 0);
    assert.ok(result.successRps > 0);
    assert.ok(result.latency.p95Ms >= result.latency.p50Ms);
    assert.ok(result.rss.samples >= 2);
    assert.ok(result.rss.peakBytes >= result.rss.baselineBytes);
    assert.equal(result.shutdown.exitCode, 0);
    assert.equal(result.shutdown.forced, false);
    assert.equal(result.shutdown.pidAlive, false);
  }
});
test("service benchmark reports queue admission failures as errors and still reaps the process", { skip: !(host && component), timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-bench-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "runtime.json");
  await writeFile(config, JSON.stringify({ max_concurrent_requests: 1 }));
  const report = await runServiceBenchmark({ ...parseServiceBenchOptions([]), hostBin: resolve(host!), component: resolve(component!), config, modes: ["resident"], path: "/slow", iterations: 8, warmup: 0, concurrency: [4] });
  assert.ok(report.results[0].statusCounts["503"] > 0);
  assert.ok(report.results[0].errors > 0);
  assert.equal(report.results[0].shutdown.pidAlive, false);
});

test("benchmark cancellation cleans up an owned resident runtime", { skip: !(host && component), timeout: 30_000 }, async () => {
  const { startServiceProcess } = await import("../crates/odenctl/src/service-process.ts");
  const abort = new AbortController();
  const server = await startServiceProcess(resolve(host!), ["serve", resolve(component!), "--resident", "--addr", "127.0.0.1:0"], process.env, abort.signal);
  abort.abort();
  const stopped = await server.stop();
  assert.equal(stopped.forced, false);
  assert.equal(stopped.pidAlive, false);
});
