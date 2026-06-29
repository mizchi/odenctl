import { createControlPlane } from "./service.ts";
import { createSqliteRepository } from "./repository.ts";

export type ControlPlaneDatabaseConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string; ssl: boolean; maxConnections?: number };

export interface CreateConfiguredControlPlaneOptions {
  env?: Record<string, string | undefined>;
  runtimeNodeActiveTtlMs?: number;
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
    return createAsyncControlPlane({
      repository,
      runtimeNodeActiveTtlMs: options.runtimeNodeActiveTtlMs,
    });
  }
  return createControlPlane({
    repository: createSqliteRepository(config.path),
    runtimeNodeActiveTtlMs: options.runtimeNodeActiveTtlMs,
  });
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
