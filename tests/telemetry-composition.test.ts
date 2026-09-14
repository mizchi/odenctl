import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compose, generateWrapper } from "../scripts/compose-telemetry.mjs";

test("boundary generation rejects resource and streaming lifetimes before compilation", () => {
  for (
    const kind of [{ resource: {} }, { handle: { own: 0 } }, { stream: "u8" }, {
      future: "u8",
    }, { flags: { flags: [] } }]
  ) {
    const graph = {
      packages: [{ name: "example:boundary@0.1.0" }],
      interfaces: [{
        name: "operations",
        package: 0,
        functions: {
          call: {
            name: "call",
            kind: "freestanding",
            params: [{ name: "input", type: 0 }],
            result: null,
          },
        },
      }],
      types: [{ name: "unsupported", owner: { interface: 0 }, kind }],
    };
    assert.throws(
      () => generateWrapper(graph, "example:boundary/operations@0.1.0", ""),
      /value types only/,
    );
  }
});

const binary = process.env.ODEN_SERVICE_BIN;
const providers = [
  ["Rust", process.env.ODEN_TELEMETRY_PROVIDER],
  ["MoonBit", process.env.ODEN_TELEMETRY_MOONBIT_PROVIDER],
] as const;
const apps = [
  ["Rust", process.env.ODEN_TELEMETRY_APP],
  ["MoonBit", process.env.ODEN_TELEMETRY_MOONBIT_APP],
] as const;
for (const [providerLanguage, provider] of providers) {
  for (const [appLanguage, app] of apps) {
    test(
      `${appLanguage} app → ${providerLanguage} provider: WIT wrapper preserves values, errors and trace context`,
      { skip: !(binary && provider && app), timeout: 180_000 },
      async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "odenctl-compose-trace-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const output = join(dir, "composed.wasm");
        compose({
          provider,
          app,
          interface: "example:boundary/operations@0.1.0",
          output,
        });
        const payloads: any[] = [];
        const collector = createServer(async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
          res.end("{}");
        });
        collector.listen(0, "127.0.0.1");
        await once(collector, "listening");
        t.after(() => {
          collector.closeAllConnections();
          collector.close();
        });
        const config = join(dir, "config.json");
        await writeFile(
          config,
          JSON.stringify({
            telemetry: {
              endpoint: `http://127.0.0.1:${
                (collector.address() as AddressInfo).port
              }`,
              interval_ms: 30,
            },
          }),
        );
        const child = spawn(resolve(binary!), [
          "serve",
          output,
          "--resident",
          "--addr",
          "127.0.0.1:0",
          "--config",
          config,
        ]);
        let stderr = "";
        child.stdout.resume();
        child.stderr.on("data", (c) => stderr += c);
        const exited = once(child, "exit");
        t.after(async () => {
          if (child.exitCode === null) child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
          await exited;
          clearTimeout(timer);
        });
        let url = "";
        for (let i = 0; i < 1200; i++) {
          url = /listening on (http:\/\/\S+)\r?\n/.exec(stderr)?.[1] ?? "";
          if (url) break;
          if (child.exitCode !== null) throw new Error(stderr);
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(url, stderr);
        const traceId = "f".repeat(32),
          headers = {
            traceparent: `00-${traceId}-${"a".repeat(16)}-01`,
            tracestate: "example=composed",
          };
        assert.deepEqual(await (await fetch(url, { headers })).json(), {
          value: 42,
          label: "roundtrip 日本語 🦀",
        });
        assert.deepEqual(
          await (await fetch(url + "/error", { headers })).json(),
          {
            error: true,
            message: "zero is rejected",
          },
        );
        child.kill("SIGTERM");
        assert.deepEqual(await exited, [0, null], stderr);
        const spans = payloads.flatMap((p) => p.resourceSpans ?? []).flatMap((
          p,
        ) => p.scopeSpans ?? []).flatMap((p) => p.spans ?? []);
        const logs = payloads.flatMap((p) => p.resourceLogs ?? []).flatMap((
          p,
        ) => p.scopeLogs ?? []).flatMap((p) => p.logRecords ?? []);
        const calls = spans.filter((s) =>
          s.name === "example:boundary/operations@0.1.0#work"
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((s) => s.status.code).sort(), [0, 2]);
        for (const call of calls) {
          assert.equal(call.traceId, traceId);
          assert.equal(call.traceState, "example=composed");
          assert.ok(
            spans.some((s) => s.spanId === call.parentSpanId && s.kind === 2),
          );
          assert.ok(
            logs.some((l) =>
              l.spanId === call.spanId && l.traceId === traceId &&
              l.body.stringValue === "composed.provider"
            ),
          );
        }
        assert.equal(
          spans.filter((s) => s.name.endsWith("#echo")).length,
          2,
        );
      },
    );
  }
}
