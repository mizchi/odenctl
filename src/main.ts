import { createConfiguredControlPlane } from "./control-plane/database.ts";
import { createConfiguredControlPlaneArtifactStore } from "./control-plane/artifact-store.ts";
import { createJsonlAuditSink } from "./control-plane/audit.ts";
import { parseApiTokens } from "./control-plane/authz.ts";
import { createSnapshotPublishJob } from "./control-plane/snapshot-publish-job.ts";
import { createWasip3HostArtifactValidator } from "./control-plane/artifact-validation.ts";
import { runtimeNodeTargetsFromEnv } from "./control-plane/snapshot-publisher.ts";
import { createHttpApp, publishCurrentRouteSnapshot } from "./http/app.ts";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const artifactPublicBaseUrl = process.env.WASMPLANE_ARTIFACT_PUBLIC_BASE_URL;
const apiTokens = parseApiTokens(process.env);
const runtimeNodeToken = process.env.WASMPLANE_RUNTIME_TOKEN;
const auditSink = process.env.WASMPLANE_AUDIT_LOG
  ? createJsonlAuditSink({ path: process.env.WASMPLANE_AUDIT_LOG })
  : undefined;
const runtimeNodeActiveTtlMs = positiveInteger(
  process.env.WASMPLANE_RUNTIME_NODE_ACTIVE_TTL_MS,
  90_000,
);
const snapshotPublishIntervalMs = optionalPositiveInteger(
  process.env.WASMPLANE_SNAPSHOT_PUBLISH_INTERVAL_MS,
);

const controlPlane = await createConfiguredControlPlane({
  runtimeNodeActiveTtlMs,
});
const artifactStore = createConfiguredControlPlaneArtifactStore(process.env);
const appOptions = {
  controlPlane,
  artifactStore,
  artifactPublicBaseUrl,
  artifactValidator:
    process.env.WASMPLANE_VALIDATE_LOCAL_ARTIFACTS === "0"
      ? undefined
      : createWasip3HostArtifactValidator({
          hostBin: process.env.WASMPLANE_WASIP3_HOST_BIN,
        }),
  apiTokens: apiTokens.length > 0 ? apiTokens : undefined,
  auditSink,
  runtimeNodeToken,
  runtimeNodes: runtimeNodeTargetsFromEnv(process.env.WASMPLANE_RUNTIME_NODES),
};
const app = createHttpApp(appOptions);

await app.listen({ port, host });
if (snapshotPublishIntervalMs) {
  createSnapshotPublishJob({
    intervalMs: snapshotPublishIntervalMs,
    publish: () => publishCurrentRouteSnapshot(appOptions),
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`snapshot publish job failed: ${message}`);
    },
  }).start();
}
console.log(`wasmplane control plane listening on http://${host}:${port}`);

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
