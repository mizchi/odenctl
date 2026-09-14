import { createControlPlane } from "./service.ts";
import { createSqliteRepository } from "./repository.ts";
import { createConfiguredSecretCipherAsync } from "./secret-encryption.ts";
import { projectEnforcementPoliciesFromEnv } from "./enforcement-report.ts";
import { projectUsageQuotasFromEnv } from "./usage-quota.ts";
import { projectBillingRatesFromEnv } from "./billing-statement.ts";
import { projectBillingBudgetsFromEnv } from "./billing-budget.ts";
import { billingInvoiceExportSignerFromEnv } from "./billing-export.ts";
import { projectQuotasFromEnv } from "./quotas.ts";
import { admissionPolicyFromEnv } from "./admission.ts";
import {
  createCloudflareWorkersApiDeployer,
  createMockCloudflareWorkerDeployer,
  type EdgeWorkerDeployer,
} from "./edge-worker-deployer.ts";
import {
  applyControlPlaneMigrations,
  checkControlPlaneMigrations,
  type ControlPlaneMigrationStatus,
} from "./migrations.ts";

export type ControlPlaneDatabaseConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string; ssl: boolean; maxConnections?: number };

export interface CreateConfiguredControlPlaneOptions {
  env?: Record<string, string | undefined>;
  runtimeNodeActiveTtlMs?: number;
}

export interface ConfiguredControlPlaneMigrationOptions {
  env?: Record<string, string | undefined>;
}

export function resolveControlPlaneDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): ControlPlaneDatabaseConfig {
  const postgresUrl = firstNonEmpty(env.DATABASE_URL, env.ODENCTL_DATABASE_URL);
  if (postgresUrl) {
    const maxConnections = positiveInteger(env.ODENCTL_POSTGRES_POOL_SIZE);
    return {
      kind: "postgres",
      url: postgresUrl,
      ssl: resolvePostgresSsl(postgresUrl, env.ODENCTL_POSTGRES_SSL),
      ...(maxConnections ? { maxConnections } : {}),
    };
  }
  return {
    kind: "sqlite",
    path: firstNonEmpty(env.ODENCTL_DB) ?? "odenctl.sqlite",
  };
}

export async function createConfiguredControlPlane(
  options: CreateConfiguredControlPlaneOptions = {},
) {
  const env = options.env ?? process.env;
  const config = resolveControlPlaneDatabaseConfig(env);
  const secretCipher = await createConfiguredSecretCipherAsync({ env });
  const projectQuotas = projectQuotasFromEnv(env);
  const projectEnforcementPolicies = projectEnforcementPoliciesFromEnv(env);
  const projectUsageQuotas = projectUsageQuotasFromEnv(env);
  const projectBillingRates = projectBillingRatesFromEnv(env);
  const projectBillingBudgets = projectBillingBudgetsFromEnv(env);
  const billingRateCardVersion = firstNonEmpty(env.ODENCTL_BILLING_RATE_CARD_VERSION);
  const billingInvoiceExportSigner = billingInvoiceExportSignerFromEnv(env);
  const billingWebhookTargetUrl = firstNonEmpty(env.ODENCTL_BILLING_WEBHOOK_URL);
  const billingWebhookMaxAttempts = positiveInteger(env.ODENCTL_BILLING_WEBHOOK_MAX_ATTEMPTS);
  const billingWebhookRetryDelayMs = positiveInteger(env.ODENCTL_BILLING_WEBHOOK_RETRY_DELAY_MS);
  const admissionPolicy = admissionPolicyFromEnv(env);
  const edgeWorkerDeployer = edgeWorkerDeployerFromEnv(env);
  if (config.kind === "postgres") {
    const [{ createAsyncControlPlane }, { createPostgresRepository }] = await Promise.all([
      import("./async-service.ts"),
      import("./postgres-repository.ts"),
    ]);
    const repository = await createPostgresRepository({
      connectionString: config.url,
      ssl: config.ssl,
      max: config.maxConnections,
    });
    const controlPlane = createAsyncControlPlane({
      repository,
      runtimeNodeActiveTtlMs: options.runtimeNodeActiveTtlMs,
      secretCipher,
      projectQuotas,
      projectEnforcementPolicies,
      projectUsageQuotas,
      projectBillingRates,
      projectBillingBudgets,
      billingRateCardVersion,
      billingInvoiceExportSigner,
      billingWebhookTargetUrl,
      billingWebhookMaxAttempts,
      billingWebhookRetryDelayMs,
      admissionPolicy,
      edgeWorkerDeployer,
    });
    assertMigrationStatus(await checkControlPlaneMigrations(config));
    return controlPlane;
  }
  const controlPlane = createControlPlane({
    repository: createSqliteRepository(config.path),
    runtimeNodeActiveTtlMs: options.runtimeNodeActiveTtlMs,
    secretCipher,
    projectQuotas,
    projectEnforcementPolicies,
    projectUsageQuotas,
    projectBillingRates,
    projectBillingBudgets,
    billingRateCardVersion,
    billingInvoiceExportSigner,
    billingWebhookTargetUrl,
    billingWebhookMaxAttempts,
    billingWebhookRetryDelayMs,
    admissionPolicy,
    edgeWorkerDeployer,
  });
  assertMigrationStatus(await checkControlPlaneMigrations(config));
  return controlPlane;
}

export function edgeWorkerDeployerFromEnv(
  env: Record<string, string | undefined> = process.env,
): EdgeWorkerDeployer | undefined {
  const mode = firstNonEmpty(env.ODENCTL_EDGE_WORKER_DEPLOYER, env.ODENCTL_EDGE_WORKER_MODE);
  const workersDevSubdomain = firstNonEmpty(
    env.ODENCTL_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN,
    env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN,
  );
  if (!mode) {
    return undefined;
  }
  const normalized = mode.toLowerCase();
  if (normalized === "mock") {
    return createMockCloudflareWorkerDeployer({ workersDevSubdomain });
  }
  if (normalized === "cloudflare-api" || normalized === "api") {
    const accountId = firstNonEmpty(env.ODENCTL_CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ACCOUNT_ID);
    const apiToken = firstNonEmpty(env.ODENCTL_CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
    if (!accountId || !apiToken) {
      throw new Error(
        "Cloudflare edge worker deployer requires ODENCTL_CLOUDFLARE_ACCOUNT_ID and ODENCTL_CLOUDFLARE_API_TOKEN",
      );
    }
    return createCloudflareWorkersApiDeployer({
      accountId,
      apiToken,
      workersDevSubdomain,
    });
  }
  throw new Error("ODENCTL_EDGE_WORKER_DEPLOYER must be mock, cloudflare-api, or api");
}

export async function applyConfiguredControlPlaneMigrations(
  options: ConfiguredControlPlaneMigrationOptions = {},
): Promise<ControlPlaneMigrationStatus> {
  return applyControlPlaneMigrations(resolveControlPlaneDatabaseConfig(options.env));
}

export async function checkConfiguredControlPlaneMigrations(
  options: ConfiguredControlPlaneMigrationOptions = {},
): Promise<ControlPlaneMigrationStatus> {
  return checkControlPlaneMigrations(resolveControlPlaneDatabaseConfig(options.env));
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolvePostgresSsl(url: string, override: string | undefined): boolean {
  const normalized = override?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "require") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "disable") {
    return false;
  }
  try {
    const parsed = new URL(url);
    const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
    return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
  } catch {
    return false;
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function assertMigrationStatus(status: ControlPlaneMigrationStatus) {
  if (status.ok) {
    return;
  }
  const parts = [
    status.pending.length ? `pending: ${status.pending.join(", ")}` : "",
    status.unexpected.length ? `unexpected: ${status.unexpected.join(", ")}` : "",
  ].filter(Boolean);
  throw new Error(`control-plane schema is not current (${parts.join("; ")})`);
}
