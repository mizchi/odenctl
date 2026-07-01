import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePerfBudgets,
  formatPerfRegressionMarkdown,
  parsePerfRegressionArgs,
  type PerfBudgetConfig,
} from "../src/perf-regression.ts";

test("perf budget evaluator passes reports within budgets", () => {
  const report = evaluatePerfBudgets([sampleBenchReport(), sampleClusterReport()], {
    schemaVersion: 1,
    benchmarkBudgets: [
      { name: "host.invoke.cwasm", concurrency: 1, maxP95Ms: 50, minThroughputRps: 100, maxErrors: 0 },
      { name: "cluster.http.cwasm", nodes: 2, concurrency: 4, maxP95Ms: 25, minThroughputRps: 200, maxErrors: 0 },
    ],
    clusterSwitchBudgets: [
      { name: "cluster.switch.cold", nodes: 2, requireOk: true, maxTotalMs: 100, maxErrors: 0 },
    ],
    clusterPlacementBudgets: [
      { name: "cluster.placement.region", nodes: 2, requireOk: true, maxTotalMs: 100, maxErrors: 0 },
    ],
    clusterAutoscalingBudgets: [
      { name: "cluster.autoscale.scale_up_warm", nodes: 2, requireOk: true, maxTotalMs: 100, maxErrors: 0 },
    ],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.checked.length, 5);
});

test("perf budget evaluator reports benchmark and cluster regressions", () => {
  const budget: PerfBudgetConfig = {
    schemaVersion: 1,
    benchmarkBudgets: [
      { name: "host.invoke.cwasm", maxP95Ms: 5, minThroughputRps: 1000, maxErrors: 0 },
      { name: "runtime.http", maxP95Ms: 5 },
    ],
    clusterSwitchBudgets: [
      { name: "cluster.switch.cold", requireOk: true, maxTotalMs: 10, maxErrors: 0 },
    ],
  };

  const report = evaluatePerfBudgets([sampleBenchReport(), sampleClusterReport({ switchOk: false })], budget);

  assert.equal(report.ok, false);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /host\.invoke\.cwasm p95Ms/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /host\.invoke\.cwasm throughputRps/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /runtime\.http is missing/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /cluster\.switch\.cold ok/);
});

test("perf regression markdown summarizes pass and fail results", () => {
  const report = evaluatePerfBudgets([sampleBenchReport()], {
    schemaVersion: 1,
    benchmarkBudgets: [
      { name: "host.invoke.cwasm", maxP95Ms: 5 },
    ],
  });

  const markdown = formatPerfRegressionMarkdown(report);

  assert.match(markdown, /# wasmplane perf regression/);
  assert.match(markdown, /status: fail/);
  assert.match(markdown, /host\.invoke\.cwasm p95Ms/);
});

test("perf trend evaluator reports regressions against historical medians", () => {
  const report = evaluatePerfBudgets(
    [sampleBenchReport(), sampleClusterReport()],
    {
      schemaVersion: 1,
      trend: {
        minHistorySamples: 2,
        maxP95IncreaseRatio: 1.2,
        minThroughputRatio: 0.9,
        maxTotalIncreaseRatio: 1.2,
      },
    },
    {
      historyReports: [
        sampleBenchReport({ p95Ms: 7, throughputRps: 220 }),
        sampleBenchReport({ p95Ms: 8, throughputRps: 200 }),
        sampleClusterReport({ switchTotalMs: 12 }),
        sampleClusterReport({ switchTotalMs: 14 }),
      ],
    },
  );

  assert.equal(report.ok, false);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /host\.invoke\.cwasm p95Ms/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /historical median/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /host\.invoke\.cwasm throughputRps/);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /cluster\.switch\.cold totalMs/);
});

test("perf regression CLI args parse budget, inputs, and output", () => {
  assert.deepEqual(
    parsePerfRegressionArgs([
      "--budget",
      "perf/budgets.json",
      "--input",
      "perf-results/bench.json",
      "--input",
      "perf-results/cluster.json",
      "--history",
      "perf-history/bench-previous.json",
      "--output",
      "perf-results/report.md",
    ]),
    {
      budgetPath: "perf/budgets.json",
      inputPaths: ["perf-results/bench.json", "perf-results/cluster.json"],
      historyPaths: ["perf-history/bench-previous.json"],
      outputPath: "perf-results/report.md",
    },
  );
});

function sampleBenchReport(options: { p95Ms?: number; throughputRps?: number } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    environment: {
      node: "v24.0.0",
      platform: "linux",
      arch: "x64",
      cpus: 4,
    },
    results: [
      {
        name: "host.invoke.cwasm",
        iterations: 10,
        concurrency: 1,
        count: 10,
        errors: 0,
        elapsedMs: 100,
        throughputRps: options.throughputRps ?? 100,
        minMs: 5,
        avgMs: 8,
        p50Ms: 8,
        p95Ms: options.p95Ms ?? 10,
        p99Ms: 10,
        maxMs: 10,
      },
    ],
  };
}

function sampleClusterReport(options: { switchOk?: boolean; switchTotalMs?: number } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    environment: {
      node: "v24.0.0",
      platform: "linux",
      arch: "x64",
      cpus: 4,
    },
    throughput: [
      {
        name: "cluster.http.cwasm",
        nodes: 2,
        iterations: 10,
        concurrency: 4,
        count: 10,
        errors: 0,
        elapsedMs: 40,
        throughputRps: 250,
        minMs: 4,
        avgMs: 8,
        p50Ms: 8,
        p95Ms: 12,
        p99Ms: 12,
        maxMs: 12,
      },
    ],
    switches: [
      {
        name: "cluster.switch.cold",
        nodes: 2,
        ok: options.switchOk ?? true,
        publishMs: 5,
        visibleAfterPublishMs: 20,
        totalMs: options.switchTotalMs ?? 25,
        attempts: 2,
        errors: options.switchOk === false ? 1 : 0,
      },
    ],
    placements: [
      {
        name: "cluster.placement.region",
        nodes: 2,
        region: "nrt",
        selectedNodes: 1,
        skippedNodes: 1,
        ok: true,
        publishMs: 4,
        selectedVisibleMs: 12,
        skippedVerifiedMs: 1,
        totalMs: 17,
        errors: 0,
      },
    ],
    autoscaling: [
      {
        name: "cluster.autoscale.scale_up_warm",
        action: "scale_up",
        nodes: 2,
        fromNodes: 1,
        toNodes: 2,
        ok: true,
        publishMs: 6,
        visibleMs: 18,
        totalMs: 24,
        errors: 0,
      },
    ],
  };
}
