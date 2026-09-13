import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const host = process.env.WASMPLANE_TEST_BIN;
for (const language of ["rust", "moonbit"]) {
  test(`exported ${language} tests drive async I/O with explicit permissions`, {
    skip: !host,
    timeout: 30_000,
  }, async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "wasmplane-tests-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let calls = 0;
    let respond = true;
    const peer = createServer((request, response) => {
      calls++;
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/greeting");
      if (!respond) return;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("hello 日本語");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    t.after(() =>
      new Promise<void>((resolve) => {
        peer.closeAllConnections();
        peer.close(() => resolve());
      })
    );
    const address = peer.address();
    assert(address && typeof address === "object");
    const authority = `127.0.0.1:${address.port}`;
    const config = resolve(directory, "runtime.json");
    const grants = {
      env: { UPSTREAM_AUTHORITY: authority, EXAMPLE_GREETING: "hello 日本語" },
      outbound_origins: [`http://${authority}`],
      timeout_ms: 2_000,
    };
    await writeFile(config, JSON.stringify(grants));
    const component = resolve(
      "examples/testing",
      language,
      language === "rust"
        ? "target/wasm32-wasip2/debug/exported_tests.wasm"
        : "target/tests.wasm",
    );
    const args = ["test", component, "--json", "--config", config];
    const result = await exec(resolve(host!), args, { timeout: 20_000 });
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, 7);
    assert.equal(report.failed, 0);
    assert.equal(
      report.tests.filter((test: { asynchronous: boolean }) =>
        test.asynchronous
      ).length,
      3,
    );
    assert.equal(calls, 1);

    const listed = await exec(resolve(host!), [...args, "--list"]);
    assert.equal(JSON.parse(listed.stdout).tests.length, 7);
    assert.equal(calls, 1, "listing must not send HTTP requests");

    await writeFile(
      config,
      JSON.stringify({ ...grants, outbound_origins: [] }),
    );
    await assert.rejects(
      exec(resolve(host!), [...args, "--filter", "http-test"]),
      (error: any) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.failed, 1);
        assert.match(report.tests[0].error, /outbound HTTP failed/);
        return true;
      },
    );
    assert.equal(calls, 1, "ungranted origins must never be contacted");

    // A suspended P3 HTTP call must be cancelled by the per-test deadline.
    await writeFile(config, JSON.stringify(grants));
    respond = false;
    await assert.rejects(
      exec(resolve(host!), [
        ...args,
        "--filter",
        "http-test",
        "--timeout-ms",
        "500",
      ], { timeout: 20_000 }),
      (error: any) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.failed, 1);
        assert.match(report.tests[0].error, /deadline/);
        return true;
      },
    );
    assert.equal(
      calls,
      2,
      "the async test reached the server before timing out",
    );
  });
}
