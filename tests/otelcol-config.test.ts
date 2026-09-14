import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("OTel collector derives span metrics and exposes Prometheus metrics", async () => {
  const config = await readFile("otelcol/config.yaml", "utf8");

  assert.match(config, /connectors:\n\s+spanmetrics:/);
  assert.match(config, /namespace: oden/);
  assert.match(config, /prometheus:\n\s+endpoint: "\[::\]:9464"/);
  assert.match(config, /metrics:\n\s+receivers: \[otlp, spanmetrics\]/);
  assert.match(config, /logs:\n\s+receivers: \[otlp\]/);
  assert.match(config, /exporters: \[prometheus\]/);
});

test("OTel alert rules cover runtime error rate and p95 latency", async () => {
  const alerts = await readFile("otelcol/alerts.yaml", "utf8");

  assert.match(alerts, /OdenRuntimeHighErrorRate/);
  assert.match(alerts, /OdenRuntimeHighP95Latency/);
  assert.match(alerts, /oden_calls_total/);
  assert.match(alerts, /oden_duration_milliseconds_bucket/);
});
