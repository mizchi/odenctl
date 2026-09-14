import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatFlyOtelEvidenceMarkdown,
  parseFlyOtelEvidenceArgs,
  runFlyOtelEvidence,
} from "../src/fly-otel-evidence.ts";

test("fly otel evidence args default to the Fly collector app", () => {
  const parsed = parseFlyOtelEvidenceArgs([], {});

  assert.equal(parsed.collectorApp, "mz-wasmplane-otel-collector");
  assert.equal(parsed.format, "markdown");
  assert.equal(parsed.output, undefined);
});

test("fly otel evidence accepts app and output flags", () => {
  const parsed = parseFlyOtelEvidenceArgs([
    "--collector-app",
    "collector-test",
    "--output",
    "reports/production-readiness/fly-otel-evidence.md",
    "--json",
  ], {});

  assert.equal(parsed.collectorApp, "collector-test");
  assert.equal(parsed.output, "reports/production-readiness/fly-otel-evidence.md");
  assert.equal(parsed.format, "json");
});

test("fly otel evidence passes when collector logs include runtime spans", async () => {
  const report = await runFlyOtelEvidence({
    collectorApp: "collector-test",
    format: "markdown",
    commandRunner: async (command, args) => {
      assert.equal(command, "fly");
      assert.deepEqual(args, ["logs", "-a", "collector-test", "--no-tail"]);
      return {
        stdout: "ResourceSpans service.name=oden-runtime trace_id=abc oden.project_id=prj",
        stderr: "",
      };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks[0]?.ok, true);
  assert.match(formatFlyOtelEvidenceMarkdown(report), /collector logs include OTEL runtime spans/);
});

test("fly otel evidence fails without span evidence", async () => {
  const report = await runFlyOtelEvidence({
    collectorApp: "collector-test",
    format: "markdown",
    commandRunner: async () => ({ stdout: "health check only", stderr: "" }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks[0]?.ok, false);
});
