export type OperationalDatabaseKind = "sqlite" | "postgres";

export interface OperationalConfig {
  schemaVersion: 1;
  database: {
    kind: OperationalDatabaseKind;
    external: boolean;
  };
  artifactStore: {
    kind: string;
    external: boolean;
  };
  volumeSqlite: {
    enabled: boolean;
  };
  runtimeNodes: {
    staticTargets: number;
  };
  routeSnapshotReplicas: {
    configured: number;
  };
  durableObjectAlarms: {
    enabled: boolean;
    namespaces: string[];
  };
}

export function operationalConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): OperationalConfig {
  const databaseKind: OperationalDatabaseKind = firstNonEmpty(env.DATABASE_URL, env.WASMPLANE_DATABASE_URL)
    ? "postgres"
    : "sqlite";
  const artifactStoreKind = (firstNonEmpty(env.WASMPLANE_ARTIFACT_STORE) ?? "local").toLowerCase();
  const durableObjectAlarmNamespaces = csv(env.WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES);
  return {
    schemaVersion: 1,
    database: {
      kind: databaseKind,
      external: databaseKind === "postgres",
    },
    artifactStore: {
      kind: artifactStoreKind,
      external: artifactStoreKind !== "local" && artifactStoreKind !== "file",
    },
    volumeSqlite: {
      enabled: Boolean(firstNonEmpty(env.WASMPLANE_VOLUME_SQLITE_ROOT)),
    },
    runtimeNodes: {
      staticTargets: csv(env.WASMPLANE_RUNTIME_NODES).length,
    },
    routeSnapshotReplicas: {
      configured: csv(env.WASMPLANE_ROUTE_SNAPSHOT_REPLICAS).length,
    },
    durableObjectAlarms: {
      enabled: Boolean(firstNonEmpty(env.WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS))
        && durableObjectAlarmNamespaces.length > 0,
      namespaces: durableObjectAlarmNamespaces,
    },
  };
}

export function assertOperationalRequirements(
  config: OperationalConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  if (truthy(env.WASMPLANE_REQUIRE_EXTERNAL_DATABASE) && config.database.kind !== "postgres") {
    throw new Error("WASMPLANE_REQUIRE_EXTERNAL_DATABASE requires DATABASE_URL or WASMPLANE_DATABASE_URL");
  }
  if (truthy(env.WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE) && !config.artifactStore.external) {
    throw new Error("WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE requires an external artifact store");
  }
}

function csv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "require";
}
