import assert from "node:assert/strict";
import { test } from "node:test";
import { projectUsageQuotasFromEnv } from "../src/control-plane/usage-quota.ts";

test("project usage quotas parse billing ledger limits from environment", () => {
  assert.deepEqual(projectUsageQuotasFromEnv({
    WASMPLANE_USAGE_QUOTA_INVOCATION_LIMITS: "prj_a=1000, prj_b=2000",
    WASMPLANE_USAGE_QUOTA_CPU_MS_LIMITS: "prj_a=5000",
    WASMPLANE_USAGE_QUOTA_WALL_MS_LIMITS: "prj_a=10000",
    WASMPLANE_USAGE_QUOTA_MEMORY_MB_MS_LIMITS: "prj_a=4096",
    WASMPLANE_USAGE_QUOTA_EGRESS_BYTES_LIMITS: "prj_a=1024",
    WASMPLANE_USAGE_QUOTA_STORAGE_BYTES_LIMITS: "prj_b=2048",
    WASMPLANE_USAGE_QUOTA_SQLITE_UNIT_LIMITS: "prj_b=8",
  }), {
    prj_a: {
      period: "calendar_month",
      invocations: 1000,
      cpuMs: 5000,
      wallMs: 10000,
      memoryMbMs: 4096,
      egressBytes: 1024,
    },
    prj_b: {
      period: "calendar_month",
      invocations: 2000,
      storageBytes: 2048,
      sqliteUnits: 8,
    },
  });
});

test("project usage quotas are disabled when no billing ledger limits are configured", () => {
  assert.equal(projectUsageQuotasFromEnv({}), undefined);
});
