import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlyScaleEvaluationPlan,
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
