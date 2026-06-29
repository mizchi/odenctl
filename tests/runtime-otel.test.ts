import assert from "node:assert/strict";
import { test } from "node:test";
import { createOtlpHttpTraceExporter, parseOtlpHeaders } from "../src/runtime/otel.ts";

test("OTLP HTTP trace exporter sends worker request spans as OTLP JSON", async () => {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const exporter = createOtlpHttpTraceExporter({
    endpoint: "http://collector.local:4318",
    serviceName: "wasmplane-runtime",
    serviceInstanceId: "rt_machine",
    headers: { "x-api-key": "redacted" },
    nowMs: () => 1_782_740_000_500,
    idGenerator: (bytes) => (bytes === 16 ? "1".repeat(32) : "2".repeat(16)),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    },
  });

  await exporter.recordWorkerRequest({
    requestId: "req_1",
    method: "GET",
    host: "hello.example.dev",
    path: "/",
    projectId: "prj_hello",
    deploymentId: "dep_hello",
    status: 200,
    durationMs: 25,
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://collector.local:4318/v1/traces");
  assert.equal(calls[0]?.init.headers["content-type"], "application/json");
  assert.equal(calls[0]?.init.headers["x-api-key"], "redacted");
  const span = calls[0]?.body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(calls[0]?.body.resourceSpans[0].resource.attributes[0].key, "service.name");
  assert.equal(span.traceId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(span.parentSpanId, "bbbbbbbbbbbbbbbb");
  assert.equal(span.spanId, "2222222222222222");
  assert.equal(span.name, "GET /");
  assert.equal(span.kind, 2);
  assert.equal(span.status.code, 1);
  assert.equal(span.startTimeUnixNano, "1782740000475000000");
  assert.equal(span.endTimeUnixNano, "1782740000500000000");
  assert.deepEqual(
    span.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]),
    [
      ["http.request.method", "GET"],
      ["server.address", "hello.example.dev"],
      ["url.path", "/"],
      ["http.response.status_code", "200"],
      ["wasmplane.request_id", "req_1"],
      ["wasmplane.project_id", "prj_hello"],
      ["wasmplane.deployment_id", "dep_hello"],
    ],
  );
});

test("OTLP header parser accepts comma separated key value pairs", () => {
  assert.deepEqual(parseOtlpHeaders("x-api-key=secret,authorization=Bearer token"), {
    "x-api-key": "secret",
    authorization: "Bearer token",
  });
});
