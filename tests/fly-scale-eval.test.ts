import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlyScaleEvaluationPlan,
  formatFlyScaleEvaluationMarkdown,
  parseFlyScaleEvaluationArgs,
  runFlyScaleEvaluation,
} from "../src/fly-scale-eval.ts";

test("fly scale evaluation args default to N+1 runtime and production checks", () => {
  const parsed = parseFlyScaleEvaluationArgs(["--"], {
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
    WASMPLANE_RUNTIME_TOKEN: "runtime-token",
  });

  assert.equal(parsed.controlApp, "mz-wasmplane-control");
  assert.equal(parsed.runtimeApp, "mz-wasmplane-runtime");
  assert.equal(parsed.collectorApp, "mz-wasmplane-otel-collector");
  assert.equal(parsed.region, "nrt");
  assert.equal(parsed.targetRuntimeMachines, 2);
  assert.deepEqual(parsed.concurrency, [1, 8, 32, 64, 128]);
  assert.equal(parsed.iterations, 300);
  assert.equal(parsed.requireExternalDatabase, true);
  assert.equal(parsed.failureDrill, true);
  assert.equal(parsed.execute, false);
  assert.equal(parsed.maxP95Ms, undefined);
  assert.equal(parsed.maxErrorRate, undefined);
  assert.equal(parsed.minThroughputRps, undefined);
  assert.equal(parsed.maxPublishMs, undefined);
});

test("fly scale evaluation args parse production SLO thresholds", () => {
  const parsed = parseFlyScaleEvaluationArgs([
    "--max-p95-ms",
    "750",
    "--max-error-rate",
    "0.01",
    "--min-throughput-rps",
    "25",
    "--max-publish-ms",
    "4000",
  ], {});

  assert.equal(parsed.maxP95Ms, 750);
  assert.equal(parsed.maxErrorRate, 0.01);
  assert.equal(parsed.minThroughputRps, 25);
  assert.equal(parsed.maxPublishMs, 4000);
});

test("fly scale evaluation plan covers scale, smoke, throughput, and failure drills", () => {
  const plan = buildFlyScaleEvaluationPlan(parseFlyScaleEvaluationArgs([
    "--runtime-machines",
    "3",
    "--restart-runtime-machine",
    "abc123",
    "--restart-control-machine",
    "def456",
    "--volume-sqlite-drill-id",
    "do_alarm_demo",
  ], {
    WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
    WASMPLANE_RUNTIME_TOKEN: "runtime-token",
  }));

  assert.deepEqual(plan.map((step) => step.name), [
    "scale runtime machines",
    "publish route snapshot",
    "production smoke",
    "http throughput benchmark",
    "runtime drain drill",
    "runtime activate",
    "restart runtime machine",
    "restart control machine",
    "volume sqlite backup drill",
  ]);
  assert.equal(plan[0].command, "fly scale count 3 -a mz-wasmplane-runtime -r nrt --with-new-volumes --yes");
  assert.match(plan[2].command, /--require-external-db --min-runtime-nodes 3/);
  assert.match(plan[3].command, /--concurrency 1,8,32,64,128/);
  assert.equal(plan[6].destructive, true);
  assert.equal(plan[8].destructive, true);
});

test("fly scale evaluation dry-run returns the plan without executing commands", async () => {
  let commands = 0;
  const result = await runFlyScaleEvaluation({
    ...parseFlyScaleEvaluationArgs([], {
      WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
      WASMPLANE_RUNTIME_TOKEN: "runtime-token",
    }),
    commandRunner: async () => {
      commands += 1;
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(commands, 0);
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.deepEqual(result.steps.map((step) => [step.name, step.status]), [
    ["scale runtime machines", "planned"],
    ["publish route snapshot", "planned"],
    ["production smoke", "planned"],
    ["http throughput benchmark", "planned"],
    ["runtime drain drill", "planned"],
    ["runtime activate", "planned"],
  ]);
});

test("fly scale evaluation enforces SLO checks after execution", async () => {
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (init?.method === "POST" && parsed.pathname === "/snapshots/routes/publish") {
      return jsonResponse(200, { ok: true });
    }
    if (parsed.pathname === "/healthz") {
      return jsonResponse(200, { ok: true });
    }
    if (parsed.pathname === "/__runtime/healthz") {
      return jsonResponse(200, { ok: true });
    }
    if (parsed.pathname === "/__runtime/readyz") {
      return jsonResponse(200, {
        ok: true,
        status: "active",
        checks: { snapshot: { loaded: 1 } },
      });
    }
    if (parsed.hostname === "collector.example" && parsed.pathname === "/") {
      return jsonResponse(200, { ok: true });
    }
    if (parsed.pathname === "/autoscaling/signals") {
      return jsonResponse(200, { signals: [] });
    }
    if (parsed.pathname === "/snapshots/routes") {
      return jsonResponse(200, { schemaVersion: 1, routes: [] });
    }
    if (parsed.pathname === "/ops/config") {
      return jsonResponse(200, {
        schemaVersion: 1,
        database: { kind: "postgres", external: true },
        artifactStore: { kind: "s3", external: true },
      });
    }
    if (parsed.pathname === "/runtime-nodes") {
      return jsonResponse(200, [
        { id: "rt_a", status: "active" },
        { id: "rt_b", status: "active" },
      ]);
    }
    if (parsed.pathname === "/__runtime/metrics") {
      return jsonResponse(200, {
        requests: {},
        invocations: {},
        snapshots: {},
      });
    }
    if (parsed.hostname === "runtime.example" && parsed.pathname === "/") {
      return textResponse(200, "ok");
    }
    return jsonResponse(404, { error: { code: "not_found" } });
  };
  const result = await runFlyScaleEvaluation({
    ...parseFlyScaleEvaluationArgs([
      "--execute",
      "--runtime-url",
      "https://runtime.example",
      "--control-url",
      "https://control.example",
      "--collector-url",
      "https://collector.example",
      "--runtime-machines",
      "2",
      "--skip-failure-drill",
      "--max-p95-ms",
      "100",
      "--max-error-rate",
      "0.01",
      "--min-throughput-rps",
      "50",
      "--max-publish-ms",
      "5000",
    ], {
      WASMPLANE_CONTROL_PLANE_TOKEN: "control-token",
      WASMPLANE_RUNTIME_TOKEN: "runtime-token",
    }),
    fetch: fetchImpl as typeof fetch,
    sleep: async () => {},
    commandRunner: async () => ({ stdout: "", stderr: "" }),
    benchmarkRunner: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-07-07T00:00:00.000Z",
      environment: { node: "v24.0.0", platform: "test", arch: "x64", cpus: 1 },
      results: [
        {
          name: "runtime.http",
          iterations: 10,
          concurrency: 8,
          count: 10,
          errors: 1,
          elapsedMs: 1000,
          throughputRps: 10,
          minMs: 10,
          avgMs: 50,
          p50Ms: 50,
          p95Ms: 150,
          p99Ms: 180,
          maxMs: 200,
        },
      ],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.slo?.ok, false);
  assert.deepEqual(result.slo?.checks.map((check) => [check.name, check.ok]), [
    ["route publish elapsed", true],
    ["http p95 latency", false],
    ["http error rate", false],
    ["http throughput", false],
  ]);
  assert.match(formatFlyScaleEvaluationMarkdown(result), /## SLO checks/);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}
