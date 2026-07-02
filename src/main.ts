import {
  checkConfiguredControlPlaneMigrations,
  createConfiguredControlPlane,
} from "./control-plane/database.ts";
import { createConfiguredControlPlaneArtifactStore } from "./control-plane/artifact-store.ts";
import { createJsonlAuditSink } from "./control-plane/audit.ts";
import { parseApiTokens } from "./control-plane/authz.ts";
import { createSnapshotPublishJob } from "./control-plane/snapshot-publish-job.ts";
import { createWasip3HostArtifactValidator } from "./control-plane/artifact-validation.ts";
import { runtimeNodeTargetsFromEnv, type RouteSnapshotPublishOptions } from "./control-plane/snapshot-publisher.ts";
import { runtimePlacementPolicyFromEnv } from "./control-plane/placement.ts";
import { createVolumeSqliteBackupJob } from "./control-plane/volume-sqlite-backup-job.ts";
import { createConfiguredVolumeSqliteBackupCipher, createVolumeSqliteRegistry } from "./control-plane/volume-sqlite.ts";
import {
  billingInvoiceRetentionOrganizationsFromEnv,
  pruneBillingInvoicesForOrganizations,
} from "./control-plane/billing-retention-job.ts";
import {
  createInMemoryRouteSnapshotReplicaStore,
  routeSnapshotReplicaTargetsFromEnv,
  type RouteSnapshotReplicationOptions,
} from "./control-plane/snapshot-replication.ts";
import { createHttpApp, publishCurrentRouteSnapshot } from "./http/app.ts";
import { parseRuntimeIdentityKeys } from "./runtime/config.ts";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const artifactPublicBaseUrl = process.env.WASMPLANE_ARTIFACT_PUBLIC_BASE_URL;
const volumeSqliteRoot = process.env.WASMPLANE_VOLUME_SQLITE_ROOT;
const apiTokens = parseApiTokens(process.env);
const runtimeNodeToken = process.env.WASMPLANE_RUNTIME_TOKEN;
const runtimeIdentityKeys = parseRuntimeIdentityKeys(process.env);
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
const billingWebhookDeliveryIntervalMs = optionalPositiveInteger(
  process.env.WASMPLANE_BILLING_WEBHOOK_DELIVERY_INTERVAL_MS,
);
const billingInvoiceRetentionPruneIntervalMs = optionalPositiveInteger(
  process.env.WASMPLANE_BILLING_RETENTION_PRUNE_INTERVAL_MS,
);
const billingInvoiceRetentionOrganizations = billingInvoiceRetentionOrganizationsFromEnv(
  process.env.WASMPLANE_BILLING_RETENTION_ORGANIZATIONS,
);
const volumeSqliteBackupIntervalMs = optionalPositiveInteger(
  process.env.WASMPLANE_VOLUME_SQLITE_BACKUP_INTERVAL_MS,
);
const volumeSqliteBackupRequireEncryption =
  process.env.WASMPLANE_VOLUME_SQLITE_BACKUP_REQUIRE_ENCRYPTION !== "0";
const volumeSqliteBackupRestoreDrill =
  process.env.WASMPLANE_VOLUME_SQLITE_BACKUP_RESTORE_DRILL === "1";
const snapshotPublishOptions: RouteSnapshotPublishOptions = {
  maxAttempts: positiveInteger(process.env.WASMPLANE_SNAPSHOT_PUBLISH_MAX_ATTEMPTS, 3),
  retryDelayMs: nonnegativeInteger(process.env.WASMPLANE_SNAPSHOT_PUBLISH_RETRY_DELAY_MS, 100),
  timeoutMs: optionalPositiveInteger(process.env.WASMPLANE_SNAPSHOT_PUBLISH_TIMEOUT_MS),
};
const snapshotReplicationOptions: RouteSnapshotReplicationOptions = {
  sourceRegion: firstNonEmpty(process.env.WASMPLANE_CONTROL_REGION, process.env.FLY_REGION),
  maxAttempts: positiveInteger(process.env.WASMPLANE_SNAPSHOT_REPLICATION_MAX_ATTEMPTS, 3),
  retryDelayMs: nonnegativeInteger(process.env.WASMPLANE_SNAPSHOT_REPLICATION_RETRY_DELAY_MS, 100),
  timeoutMs: optionalPositiveInteger(process.env.WASMPLANE_SNAPSHOT_REPLICATION_TIMEOUT_MS),
};
const volumeSqliteBackupCipher = createConfiguredVolumeSqliteBackupCipher(process.env);

const controlPlane = await createConfiguredControlPlane({
  runtimeNodeActiveTtlMs,
});
const artifactStore = createConfiguredControlPlaneArtifactStore(process.env);
const volumeSqliteRegistry = volumeSqliteRoot
  ? createVolumeSqliteRegistry({
    rootDir: volumeSqliteRoot,
    maxOpenDatabases: positiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_MAX_OPEN, 64),
    maxPendingWritesPerDatabase: positiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_MAX_PENDING_WRITES, 64),
    maxBackupsPerDatabase: optionalPositiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE),
    backupRetentionMs: optionalPositiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_BACKUP_RETENTION_MS),
    backupCipher: volumeSqliteBackupCipher,
    busyTimeoutMs: positiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_BUSY_TIMEOUT_MS, 5000),
  })
  : undefined;
if (volumeSqliteBackupIntervalMs && !volumeSqliteRegistry) {
  throw new Error("WASMPLANE_VOLUME_SQLITE_BACKUP_INTERVAL_MS requires WASMPLANE_VOLUME_SQLITE_ROOT");
}
if (volumeSqliteBackupIntervalMs && volumeSqliteBackupRequireEncryption && !volumeSqliteBackupCipher) {
  throw new Error(
    "scheduled volume sqlite backups require WASMPLANE_VOLUME_SQLITE_BACKUP_KEY_BASE64 or set WASMPLANE_VOLUME_SQLITE_BACKUP_REQUIRE_ENCRYPTION=0",
  );
}
const routeSnapshotReplicaStore = createInMemoryRouteSnapshotReplicaStore();
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
  runtimeIdentityKeys,
  runtimeNodes: runtimeNodeTargetsFromEnv(process.env.WASMPLANE_RUNTIME_NODES),
  runtimePlacement: runtimePlacementPolicyFromEnv(process.env),
  snapshotPublish: snapshotPublishOptions,
  volumeSqliteRegistry,
  routeSnapshotReplicaStore,
  routeSnapshotReplicas: routeSnapshotReplicaTargetsFromEnv(
    process.env.WASMPLANE_ROUTE_SNAPSHOT_REPLICAS,
    process.env.WASMPLANE_ROUTE_SNAPSHOT_REPLICA_TOKEN,
  ),
  snapshotReplication: snapshotReplicationOptions,
};
const app = createHttpApp(appOptions);

await app.listen({ port, host });
const schemaStatus = await checkConfiguredControlPlaneMigrations({ env: process.env });
if (snapshotPublishIntervalMs) {
  createSnapshotPublishJob({
    intervalMs: snapshotPublishIntervalMs,
    publish: () => publishCurrentRouteSnapshot(appOptions),
    isSuccess(result) {
      return (result as { ok?: boolean }).ok === true;
    },
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`snapshot publish job failed: ${message}`);
    },
  }).start();
}
if (billingWebhookDeliveryIntervalMs) {
  createSnapshotPublishJob({
    intervalMs: billingWebhookDeliveryIntervalMs,
    publish: () => controlPlane.deliverPendingBillingWebhooks(),
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`billing webhook delivery job failed: ${message}`);
    },
  }).start();
}
if (billingInvoiceRetentionPruneIntervalMs && billingInvoiceRetentionOrganizations.length === 0) {
  throw new Error(
    "WASMPLANE_BILLING_RETENTION_PRUNE_INTERVAL_MS requires WASMPLANE_BILLING_RETENTION_ORGANIZATIONS",
  );
}
if (billingInvoiceRetentionPruneIntervalMs) {
  createSnapshotPublishJob({
    intervalMs: billingInvoiceRetentionPruneIntervalMs,
    publish: async () => {
      const report = await pruneBillingInvoicesForOrganizations({
        controlPlane,
        organizationIds: billingInvoiceRetentionOrganizations,
      });
      const summary = [
        `ok=${report.ok}`,
        `organizations=${report.organizations}`,
        `scanned=${report.scanned}`,
        `deleted=${report.deleted}`,
        `retained=${report.retained}`,
      ].join(" ");
      if (report.ok) {
        console.log(`billing invoice retention prune ${summary}`);
      } else {
        console.error(`billing invoice retention prune ${summary}`);
        for (const error of report.errors) {
          console.error(`billing invoice retention prune ${error.organizationId} failed: ${error.message}`);
        }
        throw new Error(`billing invoice retention prune failed for ${report.errors.length} organizations`);
      }
      return report;
    },
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`billing invoice retention prune job failed: ${message}`);
    },
  }).start();
}
if (volumeSqliteBackupIntervalMs && volumeSqliteRegistry) {
  createVolumeSqliteBackupJob({
    intervalMs: volumeSqliteBackupIntervalMs,
    registry: volumeSqliteRegistry,
    requireEncrypted: volumeSqliteBackupRequireEncryption,
    restoreDrill: { enabled: volumeSqliteBackupRestoreDrill },
    retention: {
      keepLatest: optionalPositiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_MAX_BACKUPS_PER_DATABASE),
      olderThanMs: optionalPositiveInteger(process.env.WASMPLANE_VOLUME_SQLITE_BACKUP_RETENTION_MS),
    },
    onReport(report) {
      const summary = [
        `ok=${report.ok}`,
        `databases=${report.databases}`,
        `backups=${report.backups.length}`,
        `restoreDrills=${report.restoreDrills.length}`,
        `deleted=${report.gc.deleted.length}`,
      ].join(" ");
      if (report.ok) {
        console.log(`volume sqlite scheduled backup ${summary}`);
      } else {
        console.error(`volume sqlite scheduled backup ${summary}`);
        for (const error of report.errors) {
          console.error(`volume sqlite scheduled backup ${error.stage} failed: ${error.message}`);
        }
      }
    },
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`volume sqlite backup job failed: ${message}`);
    },
  }).start();
}
console.log(`wasmplane control plane listening on http://${host}:${port}`);
console.log(
  `control-plane schema ${schemaStatus.currentVersion ?? "none"}/${schemaStatus.latestVersion ?? "none"}`,
);

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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function nonnegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
