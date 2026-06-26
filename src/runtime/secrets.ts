import type { CapabilityPolicy } from "../control-plane/contracts.ts";
import type { RuntimeCapabilityPolicy, RuntimeSecretStore } from "./types.ts";

export interface SecretValueRepository {
  getSecretValue(secretId: string): string | undefined;
}

export function createMemorySecretStore(values: Record<string, string>): RuntimeSecretStore {
  return {
    async getSecret(secretId: string): Promise<string | undefined> {
      return values[secretId];
    },
  };
}

export function createEnvSecretStore(
  env: Record<string, string | undefined> = process.env,
  prefix = "WASMPLANE_SECRET_",
): RuntimeSecretStore {
  return {
    async getSecret(secretId: string): Promise<string | undefined> {
      return env[`${prefix}${secretId}`] ?? env[`${prefix}${envKey(secretId)}`];
    },
  };
}

export function createRepositorySecretStore(repository: SecretValueRepository): RuntimeSecretStore {
  return {
    async getSecret(secretId: string): Promise<string | undefined> {
      return repository.getSecretValue(secretId);
    },
  };
}

export async function resolveRuntimeCapabilities(
  capabilities: CapabilityPolicy,
  secretStore?: RuntimeSecretStore,
): Promise<RuntimeCapabilityPolicy> {
  if (!secretStore || capabilities.secrets.length === 0) {
    return {
      ...capabilities,
      secrets: capabilities.secrets.map((secret) => ({ ...secret })),
    };
  }
  const secrets = await Promise.all(
    capabilities.secrets.map(async (secret) => {
      const value = await secretStore.getSecret(secret.secretId);
      return value === undefined ? { ...secret } : { ...secret, value };
    }),
  );
  return { ...capabilities, secrets };
}

function envKey(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");
}
