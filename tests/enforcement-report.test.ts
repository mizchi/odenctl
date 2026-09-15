import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEnforcementPoliciesFromEnv } from "../crates/odenctl/src/control-plane/enforcement-report.ts";

test("project enforcement policies parse control-plane environment limits", () => {
  assert.deepEqual(projectEnforcementPoliciesFromEnv({
    ODENCTL_ENFORCEMENT_CPU_MS_LIMITS: "prj_a=100, prj_b=200",
    ODENCTL_ENFORCEMENT_MEMORY_MB_MS_LIMITS: "prj_a=4096",
    ODENCTL_ENFORCEMENT_STORAGE_BYTES_LIMITS: "prj_a=1024, prj_b=2048",
    ODENCTL_ENFORCEMENT_CONCURRENCY_LIMITS: "prj_a=8",
    ODENCTL_ENFORCEMENT_RATE_LIMITS: "prj_a=50:100, prj_b=25",
  }), {
    prj_a: {
      cpuMs: 100,
      memoryMbMs: 4096,
      storageBytes: 1024,
      concurrency: 8,
      rate: { requestsPerSecond: 50, burst: 100 },
    },
    prj_b: {
      cpuMs: 200,
      storageBytes: 2048,
      rate: { requestsPerSecond: 25 },
    },
  });
});

test("project enforcement policies are disabled when no environment limits are configured", () => {
  assert.equal(projectEnforcementPoliciesFromEnv({}), undefined);
});
