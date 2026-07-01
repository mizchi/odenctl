import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { ControlPlaneError } from "./errors.ts";

export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface SecretDataKey {
  keyId: string;
  key: Buffer | Uint8Array;
}

export interface SecretKeyProvider {
  current(): SecretDataKey;
  keys(): SecretDataKey[];
}

export interface AesGcmSecretCipherOptions {
  key: Buffer | Uint8Array;
  keyId?: string;
  randomBytes?: (size: number) => Buffer | Uint8Array;
}

export interface KeyringSecretCipherOptions {
  primaryKey: SecretDataKey;
  decryptKeys?: SecretDataKey[];
  randomBytes?: (size: number) => Buffer | Uint8Array;
}

export interface CommandSecretKeyProviderOptions {
  command: string;
  args?: string[];
  runCommand?: (command: string, args: string[]) => string | Buffer;
}

export interface AwsKmsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsKmsWrappedSecretDataKey {
  keyId: string;
  ciphertext: Buffer | Uint8Array;
  kmsKeyId?: string;
  encryptionContext?: Record<string, string>;
}

export interface AwsKmsSecretKeyProviderOptions {
  region: string;
  wrappedKeys: AwsKmsWrappedSecretDataKey[];
  primaryKeyId?: string;
  endpoint?: string;
  credentials?: AwsKmsCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface GcpKmsWrappedSecretDataKey {
  keyId: string;
  ciphertext: Buffer | Uint8Array;
  cryptoKeyName: string;
  additionalAuthenticatedData?: Buffer | Uint8Array;
}

export interface GcpKmsSecretKeyProviderOptions {
  wrappedKeys: GcpKmsWrappedSecretDataKey[];
  primaryKeyId?: string;
  endpoint?: string;
  accessToken?: string;
  getAccessToken?: () => string | Promise<string>;
  fetch?: typeof fetch;
}

export interface AzureKeyVaultWrappedSecretDataKey {
  keyId: string;
  ciphertext: Buffer | Uint8Array;
  vaultUrl: string;
  keyName: string;
  keyVersion: string;
  algorithm: string;
  aad?: Buffer | Uint8Array;
  iv?: Buffer | Uint8Array;
  tag?: Buffer | Uint8Array;
}

export interface AzureKeyVaultSecretKeyProviderOptions {
  wrappedKeys: AzureKeyVaultWrappedSecretDataKey[];
  primaryKeyId?: string;
  apiVersion?: string;
  accessToken?: string;
  getAccessToken?: () => string | Promise<string>;
  fetch?: typeof fetch;
}

export interface ConfiguredSecretCipherOptions {
  env?: Record<string, string | undefined>;
  awsKms?: Partial<Pick<AwsKmsSecretKeyProviderOptions, "credentials" | "endpoint" | "fetch" | "now">>;
  gcpKms?: Partial<Pick<GcpKmsSecretKeyProviderOptions, "accessToken" | "endpoint" | "fetch" | "getAccessToken">>;
  azureKeyVault?: Partial<
    Pick<AzureKeyVaultSecretKeyProviderOptions, "accessToken" | "apiVersion" | "fetch" | "getAccessToken">
  >;
}

const envelopePrefix = "wasmplane:v1:aes-256-gcm:";
const ivBytes = 12;

export function createAesGcmSecretCipher(options: AesGcmSecretCipherOptions): SecretCipher {
  return createKeyringSecretCipher({
    primaryKey: {
      keyId: options.keyId ?? "local",
      key: options.key,
    },
    randomBytes: options.randomBytes,
  });
}

export function createKeyringSecretCipher(options: KeyringSecretCipherOptions): SecretCipher {
  const primaryKey = normalizeDataKey(options.primaryKey, "primary secret key");
  const keys = new Map<string, Buffer>();
  addDataKey(keys, primaryKey, "primary secret key");
  for (const key of options.decryptKeys ?? []) {
    addDataKey(keys, normalizeDataKey(key, "decrypt secret key"), "decrypt secret key");
  }
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  return {
    encrypt(plaintext: string): string {
      const iv = Buffer.from(randomBytes(ivBytes));
      if (iv.byteLength !== ivBytes) {
        throw new ControlPlaneError("validation", "secret cipher IV generator returned invalid size");
      }
      const cipher = createCipheriv("aes-256-gcm", primaryKey.key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        envelopePrefix.slice(0, -1),
        encodePart(primaryKey.keyId),
        base64url(iv),
        base64url(tag),
        base64url(ciphertext),
      ].join(":");
    },

    decrypt(ciphertext: string): string {
      const envelope = parseSecretEnvelope(ciphertext);
      const key = keys.get(envelope.keyId);
      if (!key) {
        throw new ControlPlaneError(
          "validation",
          `secret envelope key id ${envelope.keyId} is not configured`,
        );
      }
      const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
      decipher.setAuthTag(envelope.tag);
      try {
        return Buffer.concat([
          decipher.update(envelope.ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new ControlPlaneError("validation", "secret envelope could not be decrypted");
      }
    },
  };
}

export function createStaticSecretKeyProvider(options: KeyringSecretCipherOptions): SecretKeyProvider {
  const primaryKey = normalizeDataKey(options.primaryKey, "primary secret key");
  const keys = new Map<string, Buffer>();
  addDataKey(keys, primaryKey, "primary secret key");
  for (const key of options.decryptKeys ?? []) {
    addDataKey(keys, normalizeDataKey(key, "decrypt secret key"), "decrypt secret key");
  }
  return {
    current() {
      return { keyId: primaryKey.keyId, key: Buffer.from(primaryKey.key) };
    },
    keys() {
      return [...keys.entries()].map(([keyId, key]) => ({ keyId, key: Buffer.from(key) }));
    },
  };
}

export function createSecretCipherFromKeyProvider(
  provider: SecretKeyProvider,
  options: Pick<KeyringSecretCipherOptions, "randomBytes"> = {},
): SecretCipher {
  return createKeyringSecretCipher({
    primaryKey: provider.current(),
    decryptKeys: provider.keys(),
    randomBytes: options.randomBytes,
  });
}

export function createCommandSecretKeyProvider(options: CommandSecretKeyProviderOptions): SecretKeyProvider {
  const args = options.args ?? [];
  let stdout: string | Buffer;
  try {
    stdout = options.runCommand
      ? options.runCommand(options.command, args)
      : execFileSync(options.command, args, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlPlaneError("validation", `secret KMS key provider command failed: ${message}`);
  }
  return createStaticSecretKeyProvider(parseCommandSecretKeyProviderOutput(stdout));
}

export async function createAwsKmsSecretKeyProvider(
  options: AwsKmsSecretKeyProviderOptions,
): Promise<SecretKeyProvider> {
  const region = nonEmptyString(options.region, "AWS KMS region");
  if (options.wrappedKeys.length === 0) {
    throw new ControlPlaneError("validation", "AWS KMS secret key provider requires wrapped keys");
  }
  const credentials = normalizeAwsCredentials(options.credentials);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new ControlPlaneError("validation", "AWS KMS secret key provider requires fetch");
  }
  const keys: SecretDataKey[] = [];
  for (const wrappedKey of options.wrappedKeys) {
    const keyId = nonEmptyString(wrappedKey.keyId, "AWS KMS wrapped key id");
    const key = await decryptAwsKmsDataKey({
      region,
      endpoint: options.endpoint,
      credentials,
      fetch: fetchImpl,
      now: options.now,
      wrappedKey: {
        keyId,
        ciphertext: Buffer.from(wrappedKey.ciphertext),
        kmsKeyId: wrappedKey.kmsKeyId,
        encryptionContext: wrappedKey.encryptionContext,
      },
    });
    keys.push({ keyId, key });
  }
  const primaryKeyId = options.primaryKeyId?.trim();
  const primaryKey = primaryKeyId
    ? keys.find((key) => key.keyId === primaryKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError("validation", `AWS KMS primary key ${primaryKeyId} was not returned`);
  }
  return createStaticSecretKeyProvider({ primaryKey, decryptKeys: keys });
}

export async function createGcpKmsSecretKeyProvider(
  options: GcpKmsSecretKeyProviderOptions,
): Promise<SecretKeyProvider> {
  if (options.wrappedKeys.length === 0) {
    throw new ControlPlaneError("validation", "GCP KMS secret key provider requires wrapped keys");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new ControlPlaneError("validation", "GCP KMS secret key provider requires fetch");
  }
  const accessToken = await resolveAccessToken(
    options.accessToken,
    options.getAccessToken,
    "GCP KMS",
  );
  const keys: SecretDataKey[] = [];
  for (const wrappedKey of options.wrappedKeys) {
    const keyId = nonEmptyString(wrappedKey.keyId, "GCP KMS wrapped key id");
    const key = await decryptGcpKmsDataKey({
      endpoint: options.endpoint,
      accessToken,
      fetch: fetchImpl,
      wrappedKey: {
        keyId,
        ciphertext: Buffer.from(wrappedKey.ciphertext),
        cryptoKeyName: nonEmptyString(wrappedKey.cryptoKeyName, `GCP KMS wrapped key ${keyId} cryptoKeyName`),
        additionalAuthenticatedData: wrappedKey.additionalAuthenticatedData
          ? Buffer.from(wrappedKey.additionalAuthenticatedData)
          : undefined,
      },
    });
    keys.push({ keyId, key });
  }
  const primaryKeyId = options.primaryKeyId?.trim();
  const primaryKey = primaryKeyId
    ? keys.find((key) => key.keyId === primaryKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError("validation", `GCP KMS primary key ${primaryKeyId} was not returned`);
  }
  return createStaticSecretKeyProvider({ primaryKey, decryptKeys: keys });
}

export async function createAzureKeyVaultSecretKeyProvider(
  options: AzureKeyVaultSecretKeyProviderOptions,
): Promise<SecretKeyProvider> {
  if (options.wrappedKeys.length === 0) {
    throw new ControlPlaneError("validation", "Azure Key Vault secret key provider requires wrapped keys");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new ControlPlaneError("validation", "Azure Key Vault secret key provider requires fetch");
  }
  const accessToken = await resolveAccessToken(
    options.accessToken,
    options.getAccessToken,
    "Azure Key Vault",
  );
  const keys: SecretDataKey[] = [];
  for (const wrappedKey of options.wrappedKeys) {
    const keyId = nonEmptyString(wrappedKey.keyId, "Azure Key Vault wrapped key id");
    const key = await decryptAzureKeyVaultDataKey({
      apiVersion: options.apiVersion ?? "2025-07-01",
      accessToken,
      fetch: fetchImpl,
      wrappedKey: {
        keyId,
        ciphertext: Buffer.from(wrappedKey.ciphertext),
        vaultUrl: nonEmptyString(wrappedKey.vaultUrl, `Azure Key Vault wrapped key ${keyId} vaultUrl`),
        keyName: nonEmptyString(wrappedKey.keyName, `Azure Key Vault wrapped key ${keyId} keyName`),
        keyVersion: nonEmptyString(wrappedKey.keyVersion, `Azure Key Vault wrapped key ${keyId} keyVersion`),
        algorithm: nonEmptyString(wrappedKey.algorithm, `Azure Key Vault wrapped key ${keyId} algorithm`),
        aad: wrappedKey.aad ? Buffer.from(wrappedKey.aad) : undefined,
        iv: wrappedKey.iv ? Buffer.from(wrappedKey.iv) : undefined,
        tag: wrappedKey.tag ? Buffer.from(wrappedKey.tag) : undefined,
      },
    });
    keys.push({ keyId, key });
  }
  const primaryKeyId = options.primaryKeyId?.trim();
  const primaryKey = primaryKeyId
    ? keys.find((key) => key.keyId === primaryKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError("validation", `Azure Key Vault primary key ${primaryKeyId} was not returned`);
  }
  return createStaticSecretKeyProvider({ primaryKey, decryptKeys: keys });
}

export function createConfiguredSecretCipher(
  env: Record<string, string | undefined> = process.env,
): SecretCipher | undefined {
  if (isCloudKmsConfigured(env)) {
    throw new ControlPlaneError(
      "validation",
      "cloud KMS secret providers require createConfiguredSecretCipherAsync",
    );
  }
  const command = firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_PROVIDER_COMMAND);
  if (command) {
    return createSecretCipherFromKeyProvider(createCommandSecretKeyProvider({
      command,
      args: parseCommandArgs(firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_PROVIDER_ARGS)),
    }));
  }

  const keyring = configuredLocalKeyring(env);
  if (keyring) {
    return createKeyringSecretCipher(keyring);
  }
  return undefined;
}

export async function createConfiguredSecretCipherAsync(
  options: Record<string, string | undefined> | ConfiguredSecretCipherOptions = { env: process.env },
): Promise<SecretCipher | undefined> {
  const resolved = resolveConfiguredSecretCipherOptions(options);
  const env = resolved.env ?? process.env;
  const cloudProvider = configuredCloudKmsProvider(env);
  if (cloudProvider === "aws") {
    const provider = await createConfiguredAwsKmsSecretKeyProvider(env, resolved.awsKms);
    return createSecretCipherFromKeyProvider(provider);
  }
  if (cloudProvider === "gcp") {
    const provider = await createConfiguredGcpKmsSecretKeyProvider(env, resolved.gcpKms);
    return createSecretCipherFromKeyProvider(provider);
  }
  if (cloudProvider === "azure") {
    const provider = await createConfiguredAzureKeyVaultSecretKeyProvider(env, resolved.azureKeyVault);
    return createSecretCipherFromKeyProvider(provider);
  }
  return createConfiguredSecretCipher(env);
}

export function isEncryptedSecretValue(value: string): boolean {
  return value.startsWith(envelopePrefix);
}

async function createConfiguredAwsKmsSecretKeyProvider(
  env: Record<string, string | undefined>,
  overrides: ConfiguredSecretCipherOptions["awsKms"] = {},
): Promise<SecretKeyProvider> {
  const provider = firstNonEmpty(env.WASMPLANE_SECRET_KMS_PROVIDER)?.toLowerCase();
  if (provider && provider !== "aws") {
    throw new ControlPlaneError("validation", `unsupported secret KMS provider ${provider}`);
  }
  const parsed = parseAwsKmsWrappedKeysEnv(firstNonEmpty(env.WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS));
  const region = firstNonEmpty(
    env.WASMPLANE_SECRET_KMS_AWS_REGION,
    env.AWS_REGION,
    env.AWS_DEFAULT_REGION,
  );
  if (!region) {
    throw new ControlPlaneError("validation", "AWS KMS secret key provider requires a region");
  }
  return createAwsKmsSecretKeyProvider({
    region,
    primaryKeyId: firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_ID, parsed.primaryKeyId),
    endpoint: overrides.endpoint ?? firstNonEmpty(env.WASMPLANE_SECRET_KMS_AWS_ENDPOINT),
    credentials: overrides.credentials ?? awsKmsCredentialsFromEnv(env),
    fetch: overrides.fetch,
    now: overrides.now,
    wrappedKeys: parsed.keys,
  });
}

async function createConfiguredGcpKmsSecretKeyProvider(
  env: Record<string, string | undefined>,
  overrides: ConfiguredSecretCipherOptions["gcpKms"] = {},
): Promise<SecretKeyProvider> {
  const parsed = parseGcpKmsWrappedKeysEnv(firstNonEmpty(env.WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS));
  return createGcpKmsSecretKeyProvider({
    primaryKeyId: firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_ID, parsed.primaryKeyId),
    endpoint: overrides.endpoint ?? firstNonEmpty(env.WASMPLANE_SECRET_KMS_GCP_ENDPOINT),
    accessToken: overrides.accessToken ?? firstNonEmpty(env.WASMPLANE_SECRET_KMS_GCP_ACCESS_TOKEN),
    getAccessToken: overrides.getAccessToken,
    fetch: overrides.fetch,
    wrappedKeys: parsed.keys,
  });
}

async function createConfiguredAzureKeyVaultSecretKeyProvider(
  env: Record<string, string | undefined>,
  overrides: ConfiguredSecretCipherOptions["azureKeyVault"] = {},
): Promise<SecretKeyProvider> {
  const parsed = parseAzureKeyVaultWrappedKeysEnv(firstNonEmpty(env.WASMPLANE_SECRET_KMS_AZURE_WRAPPED_KEYS));
  return createAzureKeyVaultSecretKeyProvider({
    primaryKeyId: firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_ID, parsed.primaryKeyId),
    apiVersion: overrides.apiVersion ?? firstNonEmpty(env.WASMPLANE_SECRET_KMS_AZURE_API_VERSION),
    accessToken: overrides.accessToken ?? firstNonEmpty(env.WASMPLANE_SECRET_KMS_AZURE_ACCESS_TOKEN),
    getAccessToken: overrides.getAccessToken,
    fetch: overrides.fetch,
    wrappedKeys: parsed.keys,
  });
}

function configuredLocalKeyring(
  env: Record<string, string | undefined>,
): KeyringSecretCipherOptions | undefined {
  const base64Key = firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_BASE64);
  const passphraseKey = firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY);
  const extraKeys = parseKeyringEnv(firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEYS_BASE64));
  if (!base64Key && !passphraseKey && extraKeys.length === 0) {
    return undefined;
  }
  const configuredKeyId = firstNonEmpty(env.WASMPLANE_SECRET_KMS_KEY_ID);
  const keys: SecretDataKey[] = [];
  if (base64Key || passphraseKey) {
    const key = base64Key
      ? Buffer.from(base64Key, "base64")
      : createHash("sha256").update(passphraseKey as string).digest();
    keys.push({ keyId: configuredKeyId ?? "local", key });
  }
  keys.push(...extraKeys);
  const primaryKey = configuredKeyId
    ? keys.find((key) => key.keyId === configuredKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError(
      "validation",
      `primary secret key id ${configuredKeyId ?? "<first>"} is not configured`,
    );
  }
  return {
    primaryKey,
    decryptKeys: keys,
  };
}

function encodePart(value: string): string {
  return base64url(Buffer.from(value, "utf8"));
}

function decodePart(value: string, name: string): string {
  const decoded = fromBase64url(value, name).toString("utf8");
  if (decoded.trim().length === 0) {
    throw new ControlPlaneError("validation", `${name} is empty`);
  }
  return decoded;
}

function base64url(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function parseSecretEnvelope(value: string) {
  if (!isEncryptedSecretValue(value)) {
    throw new ControlPlaneError("validation", "secret value is not an encrypted wasmplane envelope");
  }
  const parts = value.split(":");
  if (parts.length !== 7) {
    throw new ControlPlaneError("validation", "secret envelope is malformed");
  }
  return {
    keyId: decodePart(parts[3], "secret envelope key id"),
    iv: fromBase64url(parts[4], "secret envelope iv"),
    tag: fromBase64url(parts[5], "secret envelope auth tag"),
    ciphertext: fromBase64url(parts[6], "secret envelope ciphertext"),
  };
}

function fromBase64url(value: string, name: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength === 0) {
      throw new Error("empty");
    }
    return decoded;
  } catch {
    throw new ControlPlaneError("validation", `${name} is malformed`);
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new ControlPlaneError("validation", `${name} is required`);
  }
  return value.trim();
}

function normalizeDataKey(key: SecretDataKey, name: string): { keyId: string; key: Buffer } {
  if (!key.keyId || key.keyId.trim().length === 0) {
    throw new ControlPlaneError("validation", `${name} id is required`);
  }
  const normalized = Buffer.from(key.key);
  if (normalized.byteLength !== 32) {
    throw new ControlPlaneError("validation", `${name} must be 32 bytes`);
  }
  return { keyId: key.keyId.trim(), key: normalized };
}

function addDataKey(keys: Map<string, Buffer>, key: { keyId: string; key: Buffer }, name: string) {
  const existing = keys.get(key.keyId);
  if (existing && !existing.equals(key.key)) {
    throw new ControlPlaneError("validation", `${name} id ${key.keyId} is configured more than once`);
  }
  keys.set(key.keyId, key.key);
}

function resolveConfiguredSecretCipherOptions(
  options: Record<string, string | undefined> | ConfiguredSecretCipherOptions,
): ConfiguredSecretCipherOptions {
  if ("env" in options || "awsKms" in options || "gcpKms" in options || "azureKeyVault" in options) {
    return options as ConfiguredSecretCipherOptions;
  }
  return { env: options as Record<string, string | undefined> };
}

function isCloudKmsConfigured(env: Record<string, string | undefined>): boolean {
  return configuredCloudKmsProvider(env) !== undefined;
}

function configuredCloudKmsProvider(env: Record<string, string | undefined>): "aws" | "gcp" | "azure" | undefined {
  const provider = firstNonEmpty(env.WASMPLANE_SECRET_KMS_PROVIDER)?.toLowerCase();
  const supported = ["aws", "gcp", "azure", "command", "env", "local"];
  if (provider && !supported.includes(provider)) {
    throw new ControlPlaneError("validation", `unsupported secret KMS provider ${provider}`);
  }
  if (provider === "aws" || provider === "gcp" || provider === "azure") {
    return provider;
  }
  const inferred = [
    firstNonEmpty(env.WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS) ? "aws" as const : undefined,
    firstNonEmpty(env.WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS) ? "gcp" as const : undefined,
    firstNonEmpty(env.WASMPLANE_SECRET_KMS_AZURE_WRAPPED_KEYS) ? "azure" as const : undefined,
  ].filter((value): value is "aws" | "gcp" | "azure" => value !== undefined);
  if (inferred.length > 1) {
    throw new ControlPlaneError("validation", "multiple cloud KMS wrapped key configs are set");
  }
  return inferred[0];
}

function awsKmsCredentialsFromEnv(env: Record<string, string | undefined>): AwsKmsCredentials {
  return normalizeAwsCredentials({
    accessKeyId: firstNonEmpty(env.AWS_ACCESS_KEY_ID),
    secretAccessKey: firstNonEmpty(env.AWS_SECRET_ACCESS_KEY),
    sessionToken: firstNonEmpty(env.AWS_SESSION_TOKEN),
  });
}

function normalizeAwsCredentials(credentials: AwsKmsCredentials | undefined): AwsKmsCredentials {
  if (!credentials?.accessKeyId || credentials.accessKeyId.trim().length === 0) {
    throw new ControlPlaneError("validation", "AWS KMS credentials require AWS_ACCESS_KEY_ID");
  }
  if (!credentials.secretAccessKey || credentials.secretAccessKey.trim().length === 0) {
    throw new ControlPlaneError("validation", "AWS KMS credentials require AWS_SECRET_ACCESS_KEY");
  }
  return {
    accessKeyId: credentials.accessKeyId.trim(),
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken?.trim() || undefined,
  };
}

function parseAwsKmsWrappedKeysEnv(value: string | undefined): {
  primaryKeyId?: string;
  keys: AwsKmsWrappedSecretDataKey[];
} {
  if (!value) {
    throw new ControlPlaneError("validation", "AWS KMS secret key provider requires wrapped keys");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlPlaneError("validation", "WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS must be valid JSON");
  }
  const record = Array.isArray(parsed)
    ? { keys: parsed }
    : objectRecord(parsed, "AWS KMS wrapped key config");
  if (!Array.isArray(record.keys)) {
    throw new ControlPlaneError("validation", "AWS KMS wrapped key config must include keys");
  }
  const primaryKeyId = typeof record.primaryKeyId === "string" ? record.primaryKeyId.trim() : undefined;
  const keys = record.keys.map((item, index) => {
    const key = objectRecord(item, `AWS KMS wrapped key ${index}`);
    if (typeof key.keyId !== "string" || typeof key.ciphertextBase64 !== "string") {
      throw new ControlPlaneError(
        "validation",
        `AWS KMS wrapped key ${index} must include keyId and ciphertextBase64`,
      );
    }
    return {
      keyId: key.keyId,
      ciphertext: fromBase64(key.ciphertextBase64, `AWS KMS wrapped key ${key.keyId} ciphertext`),
      kmsKeyId: typeof key.kmsKeyId === "string" ? key.kmsKeyId : undefined,
      encryptionContext: parseAwsKmsEncryptionContext(key.encryptionContext, `AWS KMS wrapped key ${key.keyId}`),
    };
  });
  return { primaryKeyId, keys };
}

function parseGcpKmsWrappedKeysEnv(value: string | undefined): {
  primaryKeyId?: string;
  keys: GcpKmsWrappedSecretDataKey[];
} {
  if (!value) {
    throw new ControlPlaneError("validation", "GCP KMS secret key provider requires wrapped keys");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlPlaneError("validation", "WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS must be valid JSON");
  }
  const record = Array.isArray(parsed)
    ? { keys: parsed }
    : objectRecord(parsed, "GCP KMS wrapped key config");
  if (!Array.isArray(record.keys)) {
    throw new ControlPlaneError("validation", "GCP KMS wrapped key config must include keys");
  }
  const primaryKeyId = typeof record.primaryKeyId === "string" ? record.primaryKeyId.trim() : undefined;
  const keys = record.keys.map((item, index) => {
    const key = objectRecord(item, `GCP KMS wrapped key ${index}`);
    if (
      typeof key.keyId !== "string" ||
      typeof key.ciphertextBase64 !== "string" ||
      typeof key.cryptoKeyName !== "string"
    ) {
      throw new ControlPlaneError(
        "validation",
        `GCP KMS wrapped key ${index} must include keyId, ciphertextBase64, and cryptoKeyName`,
      );
    }
    return {
      keyId: key.keyId,
      ciphertext: fromBase64(key.ciphertextBase64, `GCP KMS wrapped key ${key.keyId} ciphertext`),
      cryptoKeyName: key.cryptoKeyName,
      additionalAuthenticatedData: typeof key.additionalAuthenticatedDataBase64 === "string"
        ? fromBase64(
          key.additionalAuthenticatedDataBase64,
          `GCP KMS wrapped key ${key.keyId} additionalAuthenticatedData`,
        )
        : undefined,
    };
  });
  return { primaryKeyId, keys };
}

function parseAzureKeyVaultWrappedKeysEnv(value: string | undefined): {
  primaryKeyId?: string;
  keys: AzureKeyVaultWrappedSecretDataKey[];
} {
  if (!value) {
    throw new ControlPlaneError("validation", "Azure Key Vault secret key provider requires wrapped keys");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlPlaneError("validation", "WASMPLANE_SECRET_KMS_AZURE_WRAPPED_KEYS must be valid JSON");
  }
  const record = Array.isArray(parsed)
    ? { keys: parsed }
    : objectRecord(parsed, "Azure Key Vault wrapped key config");
  if (!Array.isArray(record.keys)) {
    throw new ControlPlaneError("validation", "Azure Key Vault wrapped key config must include keys");
  }
  const primaryKeyId = typeof record.primaryKeyId === "string" ? record.primaryKeyId.trim() : undefined;
  const keys = record.keys.map((item, index) => {
    const key = objectRecord(item, `Azure Key Vault wrapped key ${index}`);
    if (
      typeof key.keyId !== "string" ||
      typeof key.ciphertextBase64 !== "string" ||
      typeof key.vaultUrl !== "string" ||
      typeof key.keyName !== "string" ||
      typeof key.keyVersion !== "string" ||
      typeof key.algorithm !== "string"
    ) {
      throw new ControlPlaneError(
        "validation",
        `Azure Key Vault wrapped key ${index} must include keyId, ciphertextBase64, vaultUrl, keyName, keyVersion, and algorithm`,
      );
    }
    return {
      keyId: key.keyId,
      ciphertext: fromBase64(key.ciphertextBase64, `Azure Key Vault wrapped key ${key.keyId} ciphertext`),
      vaultUrl: key.vaultUrl,
      keyName: key.keyName,
      keyVersion: key.keyVersion,
      algorithm: key.algorithm,
      aad: typeof key.aadBase64 === "string"
        ? fromBase64(key.aadBase64, `Azure Key Vault wrapped key ${key.keyId} aad`)
        : undefined,
      iv: typeof key.ivBase64 === "string"
        ? fromBase64(key.ivBase64, `Azure Key Vault wrapped key ${key.keyId} iv`)
        : undefined,
      tag: typeof key.tagBase64 === "string"
        ? fromBase64(key.tagBase64, `Azure Key Vault wrapped key ${key.keyId} tag`)
        : undefined,
    };
  });
  return { primaryKeyId, keys };
}

function parseAwsKmsEncryptionContext(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, `${name} encryptionContext`);
  const context: Record<string, string> = {};
  for (const [key, contextValue] of Object.entries(record)) {
    if (typeof contextValue !== "string") {
      throw new ControlPlaneError("validation", `${name} encryptionContext values must be strings`);
    }
    context[key] = contextValue;
  }
  return context;
}

function fromBase64(value: string, name: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0) {
      throw new Error("empty");
    }
    return decoded;
  } catch {
    throw new ControlPlaneError("validation", `${name} must be base64`);
  }
}

function parseKeyringEnv(value: string | undefined): SecretDataKey[] {
  if (!value) {
    return [];
  }
  return value.split(",").filter((entry) => entry.trim().length > 0).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new ControlPlaneError("validation", "WASMPLANE_SECRET_KMS_KEYS_BASE64 entries must be keyId=base64");
    }
    const keyId = entry.slice(0, separator).trim();
    const keyBase64 = entry.slice(separator + 1).trim();
    return { keyId, key: Buffer.from(keyBase64, "base64") };
  });
}

function parseCommandArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("not a string array");
    }
    return parsed;
  } catch {
    throw new ControlPlaneError("validation", "WASMPLANE_SECRET_KMS_KEY_PROVIDER_ARGS must be a JSON string array");
  }
}

function parseCommandSecretKeyProviderOutput(value: string | Buffer): KeyringSecretCipherOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  } catch {
    throw new ControlPlaneError("validation", "secret KMS key provider command returned invalid JSON");
  }
  const record = objectRecord(parsed, "secret KMS key provider output");
  const keys = parseCommandKeys(record);
  if (keys.length === 0) {
    throw new ControlPlaneError("validation", "secret KMS key provider command returned no keys");
  }
  const primaryKeyId = typeof record.primaryKeyId === "string" ? record.primaryKeyId.trim() : undefined;
  const primaryKey = primaryKeyId
    ? keys.find((key) => key.keyId === primaryKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError("validation", `secret KMS primary key ${primaryKeyId} was not returned`);
  }
  return { primaryKey, decryptKeys: keys };
}

function parseCommandKeys(record: Record<string, unknown>): SecretDataKey[] {
  if (Array.isArray(record.keys)) {
    return record.keys.map((item, index) => {
      const key = objectRecord(item, `secret KMS key ${index}`);
      if (typeof key.keyId !== "string" || typeof key.keyBase64 !== "string") {
        throw new ControlPlaneError("validation", `secret KMS key ${index} must include keyId and keyBase64`);
      }
      return { keyId: key.keyId, key: Buffer.from(key.keyBase64, "base64") };
    });
  }
  if (record.keysBase64 && typeof record.keysBase64 === "object" && !Array.isArray(record.keysBase64)) {
    return Object.entries(record.keysBase64 as Record<string, unknown>).map(([keyId, keyBase64]) => {
      if (typeof keyBase64 !== "string") {
        throw new ControlPlaneError("validation", `secret KMS key ${keyId} must be base64`);
      }
      return { keyId, key: Buffer.from(keyBase64, "base64") };
    });
  }
  throw new ControlPlaneError("validation", "secret KMS key provider output must include keys or keysBase64");
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneError("validation", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function decryptAwsKmsDataKey(options: {
  region: string;
  endpoint?: string;
  credentials: AwsKmsCredentials;
  fetch: typeof fetch;
  now?: () => Date;
  wrappedKey: {
    keyId: string;
    ciphertext: Buffer;
    kmsKeyId?: string;
    encryptionContext?: Record<string, string>;
  };
}): Promise<Buffer> {
  const endpoint = new URL(options.endpoint ?? `https://kms.${options.region}.amazonaws.com/`);
  const payload: Record<string, unknown> = {
    CiphertextBlob: options.wrappedKey.ciphertext.toString("base64"),
  };
  if (options.wrappedKey.kmsKeyId) {
    payload.KeyId = options.wrappedKey.kmsKeyId;
  }
  if (options.wrappedKey.encryptionContext) {
    payload.EncryptionContext = options.wrappedKey.encryptionContext;
  }
  const body = JSON.stringify(payload);
  const headers = signAwsKmsJsonRequest({
    body,
    credentials: options.credentials,
    now: options.now?.() ?? new Date(),
    region: options.region,
    target: "TrentService.Decrypt",
    url: endpoint,
  });
  const response = await options.fetch(endpoint, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    const message = text.trim().slice(0, 500);
    throw new ControlPlaneError(
      "validation",
      `AWS KMS decrypt failed for secret key ${options.wrappedKey.keyId}: ${response.status} ${message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlPlaneError("validation", "AWS KMS decrypt returned invalid JSON");
  }
  const record = objectRecord(parsed, "AWS KMS decrypt response");
  if (typeof record.Plaintext !== "string") {
    throw new ControlPlaneError("validation", "AWS KMS decrypt response must include Plaintext");
  }
  return fromBase64(record.Plaintext, `AWS KMS plaintext for secret key ${options.wrappedKey.keyId}`);
}

async function decryptGcpKmsDataKey(options: {
  endpoint?: string;
  accessToken: string;
  fetch: typeof fetch;
  wrappedKey: {
    keyId: string;
    ciphertext: Buffer;
    cryptoKeyName: string;
    additionalAuthenticatedData?: Buffer;
  };
}): Promise<Buffer> {
  const baseUrl = (options.endpoint ?? "https://cloudkms.googleapis.com").replace(/\/+$/, "");
  const endpoint = new URL(`${baseUrl}/v1/${encodeResourcePath(options.wrappedKey.cryptoKeyName)}:decrypt`);
  const payload: Record<string, unknown> = {
    ciphertext: options.wrappedKey.ciphertext.toString("base64"),
  };
  if (options.wrappedKey.additionalAuthenticatedData) {
    payload.additionalAuthenticatedData = options.wrappedKey.additionalAuthenticatedData.toString("base64");
  }
  const response = await options.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = text.trim().slice(0, 500);
    throw new ControlPlaneError(
      "validation",
      `GCP KMS decrypt failed for secret key ${options.wrappedKey.keyId}: ${response.status} ${message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlPlaneError("validation", "GCP KMS decrypt returned invalid JSON");
  }
  const record = objectRecord(parsed, "GCP KMS decrypt response");
  if (typeof record.plaintext !== "string") {
    throw new ControlPlaneError("validation", "GCP KMS decrypt response must include plaintext");
  }
  return fromBase64(record.plaintext, `GCP KMS plaintext for secret key ${options.wrappedKey.keyId}`);
}

async function decryptAzureKeyVaultDataKey(options: {
  apiVersion: string;
  accessToken: string;
  fetch: typeof fetch;
  wrappedKey: {
    keyId: string;
    ciphertext: Buffer;
    vaultUrl: string;
    keyName: string;
    keyVersion: string;
    algorithm: string;
    aad?: Buffer;
    iv?: Buffer;
    tag?: Buffer;
  };
}): Promise<Buffer> {
  const endpoint = azureKeyVaultDecryptUrl(options.wrappedKey, options.apiVersion);
  const payload: Record<string, unknown> = {
    alg: options.wrappedKey.algorithm,
    value: options.wrappedKey.ciphertext.toString("base64url"),
  };
  if (options.wrappedKey.aad) {
    payload.aad = options.wrappedKey.aad.toString("base64url");
  }
  if (options.wrappedKey.iv) {
    payload.iv = options.wrappedKey.iv.toString("base64url");
  }
  if (options.wrappedKey.tag) {
    payload.tag = options.wrappedKey.tag.toString("base64url");
  }
  const response = await options.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = text.trim().slice(0, 500);
    throw new ControlPlaneError(
      "validation",
      `Azure Key Vault decrypt failed for secret key ${options.wrappedKey.keyId}: ${response.status} ${message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlPlaneError("validation", "Azure Key Vault decrypt returned invalid JSON");
  }
  const record = objectRecord(parsed, "Azure Key Vault decrypt response");
  if (typeof record.value !== "string") {
    throw new ControlPlaneError("validation", "Azure Key Vault decrypt response must include value");
  }
  return fromBase64url(record.value, `Azure Key Vault plaintext for secret key ${options.wrappedKey.keyId}`);
}

async function resolveAccessToken(
  accessToken: string | undefined,
  getAccessToken: (() => string | Promise<string>) | undefined,
  providerName: string,
): Promise<string> {
  const token = accessToken ?? await getAccessToken?.();
  if (!token || token.trim().length === 0) {
    throw new ControlPlaneError("validation", `${providerName} secret key provider requires an access token`);
  }
  return token.trim();
}

function encodeResourcePath(value: string): string {
  return value.split("/").map((part) => encodeRfc3986(part)).join("/");
}

function azureKeyVaultDecryptUrl(
  wrappedKey: {
    vaultUrl: string;
    keyName: string;
    keyVersion: string;
  },
  apiVersion: string,
): URL {
  const baseUrl = wrappedKey.vaultUrl.replace(/\/+$/, "");
  const url = new URL(
    `${baseUrl}/keys/${encodeRfc3986(wrappedKey.keyName)}/${encodeRfc3986(wrappedKey.keyVersion)}/decrypt`,
  );
  url.searchParams.set("api-version", apiVersion);
  return url;
}

function signAwsKmsJsonRequest(options: {
  body: string;
  credentials: AwsKmsCredentials;
  now: Date;
  region: string;
  target: string;
  url: URL;
}): Record<string, string> {
  const amzDate = awsAmzDate(options.now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(options.body);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: options.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": options.target,
  };
  if (options.credentials.sessionToken) {
    headers["x-amz-security-token"] = options.credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}`)
    .join("\n") + "\n";
  const canonicalRequest = [
    "POST",
    options.url.pathname || "/",
    canonicalQuery(options.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${options.region}/kms/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    awsSigningKey(options.credentials.secretAccessKey, dateStamp, options.region, "kms"),
    stringToSign,
  );
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function awsAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  return params.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = hmacBuffer(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, service);
  return hmacBuffer(serviceKey, "aws4_request");
}

function hmacBuffer(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
