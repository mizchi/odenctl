import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const binary = process.env.WASMPLANE_SERVICE_BIN;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (
  const [language, component] of [
    ["rust", process.env.WASMPLANE_SERVICE_RUST],
    ["moonbit", process.env.WASMPLANE_SERVICE_MOONBIT],
  ] as const
) {
  test(
    `${language}: resident tasks, HTTP and durable calls propagate independent traces through OTLP`,
    { skip: !(binary && component), timeout: 60_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "wasmplane-telemetry-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const records: { path: string; data: any }[] = [];
      const outgoing: { parent: string; state: string; durable: boolean }[] =
        [];
      const collector = httpServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        records.push({ path: req.url!, data });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      collector.listen(0, "127.0.0.1");
      await once(collector, "listening");
      t.after(() => {
        collector.closeAllConnections();
        collector.close();
      });
      const peer = httpServer(async (req, res) => {
        const durable = req.url?.includes("/objects/") ?? false;
        const parent = String(req.headers.traceparent ?? "");
        outgoing.push({
          parent,
          state: String(req.headers.tracestate ?? ""),
          durable,
        });
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (durable) {
          assert.equal(req.headers.authorization, "Bearer private-secret");
          const wire = JSON.parse(Buffer.concat(chunks).toString());
          assert.deepEqual(
            wire.headers.find(([key]: [string]) => key === "traceparent"),
            ["traceparent", parent],
          );
          res.end(
            JSON.stringify({
              status: 200,
              headers: [],
              body: Buffer.from("{}").toString("base64"),
            }),
          );
        } else res.end("ok");
      });
      peer.listen(0, "127.0.0.1");
      await once(peer, "listening");
      t.after(() => {
        peer.closeAllConnections();
        peer.close();
      });
      const authority = `127.0.0.1:${(peer.address() as AddressInfo).port}`;
      const config = join(dir, "runtime.json");
      await writeFile(
        config,
        JSON.stringify({
          timeout_ms: 5000,
          env: { TELEMETRY_UPSTREAM: authority, TELEMETRY_DURABLE: "1" },
          outbound_origins: [`http://${authority}`],
          durable: {
            counter: {
              endpoint: `http://${authority}`,
              namespace: "COUNTER",
              token_env: "TEST_GATEWAY_TOKEN",
            },
          },
          telemetry: {
            endpoint: `http://127.0.0.1:${
              (collector.address() as AddressInfo).port
            }`,
            interval_ms: 30,
            service_name: "telemetry-test",
          },
        }),
      );
      const child = spawn(resolve(binary!), [
        "serve",
        resolve(component!),
        "--resident",
        "--addr",
        "127.0.0.1:0",
        "--config",
        config,
      ], {
        env: {
          ...process.env,
          TEST_GATEWAY_TOKEN: "private-secret",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
        },
      });
      let output = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => output += chunk);
      const exited = once(child, "exit");
      t.after(async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      });
      let url = "";
      // stderr may deliver the address in separate chunks; wait for the whole line.
      for (let i = 0; i < 1200; i++) {
        url = /listening on (http:\/\/\S+)\r?\n/.exec(output)?.[1] ?? "";
        if (url) break;
        if (child.exitCode !== null) throw new Error(output);
        await pause(25);
      }
      assert.ok(url, output);
      const ids = ["a".repeat(32), "b".repeat(32)];
      for (const id of ids) {
        const response = await fetch(url + "/telemetry", {
          headers: {
            traceparent: `00-${id}-${"c".repeat(16)}-01`,
            tracestate: "test=value",
            authorization: "Bearer must-not-be-recorded",
          },
        });
        assert.equal(response.status, 200, output);
        assert.deepEqual(await response.json(), { ok: true });
      }
      await pause(200);
      // An unsampled parent still updates request metrics but emits no trace spans.
      await (await fetch(url + "/", {
        headers: { traceparent: `00-${"d".repeat(32)}-${"e".repeat(16)}-00` },
      })).text();
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null], output);
      const spans = records.flatMap((r) => r.data.resourceSpans ?? []).flatMap(
        (r) => r.scopeSpans ?? [],
      ).flatMap((s) => s.spans ?? []);
      const logs = records.flatMap((r) => r.data.resourceLogs ?? []).flatMap(
        (r) => r.scopeLogs ?? [],
      ).flatMap((s) => s.logRecords ?? []);
      for (const traceId of ids) {
        const work = spans.find((s) =>
          s.traceId === traceId && s.name === "example.work"
        );
        assert.ok(work, JSON.stringify(spans));
        const foreground = logs.find((l) =>
          l.traceId === traceId && l.body.stringValue === "example.foreground"
        );
        const background = logs.find((l) =>
          l.traceId === traceId && l.body.stringValue === "example.background"
        );
        assert.equal(foreground?.spanId, work.spanId);
        assert.equal(background?.spanId, work.spanId);
        const detached = spans.find((s) =>
          s.name === "example.detached" &&
          s.links.some((link: any) => link.spanId === work.spanId)
        );
        assert.ok(detached);
        assert.notEqual(detached.traceId, traceId);
        for (const durable of [false, true]) {
          const wire = outgoing.find((v) =>
            v.parent.includes(traceId) && v.durable === durable
          );
          assert.ok(wire);
          const span = spans.find((s) =>
            s.traceId === traceId && s.spanId === wire.parent.split("-")[2]
          );
          assert.equal(span?.parentSpanId, work.spanId);
          assert.equal(wire.state, "test=value");
        }
      }
      assert.ok(!spans.some((s) => s.traceId === "d".repeat(32)));
      const metrics = records.flatMap((r) => r.data.resourceMetrics ?? [])
        .flatMap((r) => r.scopeMetrics ?? []).flatMap((s) => s.metrics ?? []);
      const http = metrics.filter((m) =>
        m.name === "http.server.request.duration"
      ).at(-1);
      assert.equal(
        http.histogram.dataPoints.reduce(
          (n: number, p: any) => n + Number(p.count),
          0,
        ),
        3,
      );
      assert.equal(
        new Set(spans.map((s) => s.spanId)).size,
        spans.length,
        "every span ends once",
      );
      assert.ok(!JSON.stringify(records).includes("private-secret"));
      assert.ok(!JSON.stringify(records).includes("must-not-be-recorded"));
      assert.ok(spans.some((s) => s.name === "lifecycle.stop"));
    },
  );
}
