import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";
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
  const decryptKeys = (options.decryptKeys ?? []).map((key) => normalizeDataKey(key, "decrypt secret key"));
  return {
    current() {
      return { keyId: primaryKey.keyId, key: Buffer.from(primaryKey.key) };
    },
    keys() {
      return [
        { keyId: primaryKey.keyId, key: Buffer.from(primaryKey.key) },
        ...decryptKeys.map((key) => ({ keyId: key.keyId, key: Buffer.from(key.key) })),
      ];
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

export function createConfiguredSecretCipher(
  env: Record<string, string | undefined> = process.env,
): SecretCipher | undefined {
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

export function isEncryptedSecretValue(value: string): boolean {
  return value.startsWith(envelopePrefix);
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
