import { createControlPlane } from "./service.ts";
import { createSqliteRepository } from "./repository.ts";
import { createConfiguredSecretCipherAsync } from "./secret-encryption.ts";
import { projectEnforcementPoliciesFromEnv } from "./enforcement-report.ts";
import { projectQuotasFromEnv } from "./quotas.ts";
import { admissionPolicyFromEnv } from "./admission.ts";
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
  const postgresUrl = firstNonEmpty(env.DATABASE_URL, env.WASMPLANE_DATABASE_URL);
  if (postgresUrl) {
    const maxConnections = positiveInteger(env.WASMPLANE_POSTGRES_POOL_SIZE);
    return {
      kind: "postgres",
      url: postgresUrl,
      ssl: resolvePostgresSsl(postgresUrl, env.WASMPLANE_POSTGRES_SSL),
      ...(maxConnections ? { maxConnections } : {}),
    };
  }
  return {
    kind: "sqlite",
    path: firstNonEmpty(env.WASMPLANE_DB) ?? "wasmplane.sqlite",
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
  const admissionPolicy = admissionPolicyFromEnv(env);
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
      admissionPolicy,
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
    admissionPolicy,
  });
  assertMigrationStatus(await checkControlPlaneMigrations(config));
  return controlPlane;
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
