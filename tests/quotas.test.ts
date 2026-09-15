import assert from "node:assert/strict";
import { test } from "node:test";
import { projectQuotasFromEnv } from "../crates/odenctl/src/control-plane/quotas.ts";

test("project quotas parse control-plane environment limits", () => {
  assert.deepEqual(projectQuotasFromEnv({
    ODENCTL_QUOTA_MAX_ARTIFACTS: "10",
    ODENCTL_QUOTA_MAX_DEPLOYMENTS: "20",
    ODENCTL_QUOTA_MAX_ROUTES: "30",
    ODENCTL_QUOTA_MAX_SECRETS: "40",
    ODENCTL_QUOTA_MAX_KV_NAMESPACES: "50",
    ODENCTL_QUOTA_MAX_DURABLE_OBJECT_NAMESPACES: "60",
  }), {
    maxArtifacts: 10,
    maxDeployments: 20,
    maxRoutes: 30,
    maxSecrets: 40,
    maxKvNamespaces: 50,
    maxDurableObjectNamespaces: 60,
  });
});

test("project quotas are disabled when no environment limits are configured", () => {
  assert.equal(projectQuotasFromEnv({}), undefined);
});
