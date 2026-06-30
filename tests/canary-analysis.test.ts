import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCanaryEvents, summarizeCanaryMetrics } from "../src/control-plane/canary-analysis.ts";

test("canary analysis summarizes candidate metrics by deployment id", () => {
  assert.deepEqual(
    summarizeCanaryMetrics([
      { deploymentId: "dep_canary", status: 200, durationMs: 10 },
      { deploymentId: "dep_canary", status: 200, durationMs: 20 },
      { deploymentId: "dep_canary", status: 503, durationMs: 30, errorCode: "overloaded" },
    ]),
    {
      requests: 3,
      errors: 1,
      rejects: 1,
      errorRate: 1 / 3,
      p95Ms: 30,
    },
  );
});

test("canary analysis continues until minimum samples are available", () => {
  assert.deepEqual(
    analyzeCanaryEvents(
      [{ deploymentId: "dep_canary", status: 500, durationMs: 100 }],
      "dep_canary",
      { minRequests: 2, errorRate: 0 },
    ),
    {
      action: "continue",
      reason: "insufficient_samples",
      metrics: {
        requests: 1,
        errors: 1,
        rejects: 0,
        errorRate: 1,
        p95Ms: 100,
      },
    },
  );
});

test("canary analysis rolls back on threshold failures", () => {
  assert.equal(
    analyzeCanaryEvents(
      [
        { deploymentId: "dep_canary", status: 200, durationMs: 100 },
        { deploymentId: "dep_canary", status: 200, durationMs: 400 },
      ],
      "dep_canary",
      { minRequests: 2, p95Ms: 250 },
    ).reason,
    "p95_latency",
  );
  assert.equal(
    analyzeCanaryEvents(
      [
        { deploymentId: "dep_canary", status: 200, durationMs: 100 },
        { deploymentId: "dep_canary", status: 500, durationMs: 100 },
      ],
      "dep_canary",
      { minRequests: 2, errorRate: 0.25 },
    ).reason,
    "error_rate",
  );
  assert.equal(
    analyzeCanaryEvents(
      [
        { deploymentId: "dep_canary", status: 200, durationMs: 100 },
        { deploymentId: "dep_canary", status: 429, durationMs: 10, errorCode: "rate_limited" },
      ],
      "dep_canary",
      { minRequests: 2, rejectCount: 0 },
    ).reason,
    "reject_count",
  );
});
