import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionPolicyFromEnv } from "../crates/odenctl/src/control-plane/admission.ts";

test("admission policy parses production guardrails from environment", () => {
  assert.deepEqual(admissionPolicyFromEnv({
    ODENCTL_ADMISSION_REQUIRE_ARTIFACT_SIGNATURE: "1",
    ODENCTL_ADMISSION_ARTIFACT_SIGNATURE_KEY_IDS: "ci,prod",
    ODENCTL_ADMISSION_MAX_ARTIFACT_SIZE_BYTES: "1048576",
    ODENCTL_ADMISSION_ALLOWED_WORLDS: "wasi:http/service@0.3.0",
    ODENCTL_ADMISSION_ALLOWED_WORLD_VERSIONS: "0.3.0",
    ODENCTL_ADMISSION_OUTBOUND_HTTP_PREFIXES: "https://api.example.com/v1,https://auth.example.com",
    ODENCTL_ADMISSION_KV_NAMESPACE_IDS: "kv_main,kv_cache",
    ODENCTL_ADMISSION_DURABLE_OBJECT_NAMESPACE_IDS: "do_rooms,do_sessions",
    ODENCTL_ADMISSION_SECRET_IDS: "sec_api,sec_token",
    ODENCTL_ADMISSION_SERVICE_PROJECT_IDS: "prj_auth,prj_billing",
    ODENCTL_ADMISSION_SERVICE_URL_PREFIXES: "https://auth.internal,https://billing.internal/v1",
  }), {
    requireArtifactSignature: true,
    allowedArtifactSignatureKeyIds: ["ci", "prod"],
    maxArtifactSizeBytes: 1048576,
    allowedWorlds: ["wasi:http/service@0.3.0"],
    allowedWorldVersions: ["0.3.0"],
    allowedOutboundHttpPrefixes: ["https://api.example.com/v1", "https://auth.example.com"],
    allowedKvNamespaceIds: ["kv_main", "kv_cache"],
    allowedDurableObjectNamespaceIds: ["do_rooms", "do_sessions"],
    allowedSecretIds: ["sec_api", "sec_token"],
    allowedServiceProjectIds: ["prj_auth", "prj_billing"],
    allowedServiceUrlPrefixes: ["https://auth.internal", "https://billing.internal/v1"],
  });
});

test("admission policy is disabled when no guardrails are configured", () => {
  assert.equal(admissionPolicyFromEnv({}), undefined);
});
