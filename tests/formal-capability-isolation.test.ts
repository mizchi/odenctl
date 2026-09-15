import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runCapabilityIsolationModel,
} from "../tools/formal/capability-isolation.model.ts";

test("capability isolation formal model reports no current spec-level counterexamples", () => {
  const report = runCapabilityIsolationModel();

  assert.deepEqual(report.findings, []);
});

test("capability isolation formal model locks service access regressions", () => {
  const report = runCapabilityIsolationModel();

  assert.deepEqual(
    report.sanity.map((check) => [check.id, check.ok]),
    [
      ["regression-service-binding-required", true],
      ["sanity-service-binding-allows-explicit-cross-project-call", true],
      ["regression-outbound-http-is-not-service-access", true],
      ["regression-state-bindings-remain-project-scoped", true],
      ["regression-privileged-process-capabilities-denied", true],
    ],
  );
});
