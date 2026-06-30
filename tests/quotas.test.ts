import assert from "node:assert/strict";
import { test } from "node:test";
import { projectQuotasFromEnv } from "../src/control-plane/quotas.ts";

test("project quotas parse control-plane environment limits", () => {
  assert.deepEqual(projectQuotasFromEnv({
    WASMPLANE_QUOTA_MAX_ARTIFACTS: "10",
    WASMPLANE_QUOTA_MAX_DEPLOYMENTS: "20",
    WASMPLANE_QUOTA_MAX_ROUTES: "30",
    WASMPLANE_QUOTA_MAX_SECRETS: "40",
    WASMPLANE_QUOTA_MAX_KV_NAMESPACES: "50",
  }), {
    maxArtifacts: 10,
    maxDeployments: 20,
    maxRoutes: 30,
    maxSecrets: 40,
    maxKvNamespaces: 50,
  });
});

test("project quotas are disabled when no environment limits are configured", () => {
  assert.equal(projectQuotasFromEnv({}), undefined);
});

