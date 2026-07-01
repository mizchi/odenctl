import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAesGcmSecretCipher,
  createAwsKmsSecretKeyProvider,
  createAzureKeyVaultSecretKeyProvider,
  createCommandSecretKeyProvider,
  createConfiguredSecretCipher,
  createConfiguredSecretCipherAsync,
  createGcpKmsSecretKeyProvider,
  createSecretCipherFromKeyProvider,
  isEncryptedSecretValue,
} from "../src/control-plane/secret-encryption.ts";

test("AES-GCM secret cipher encrypts and decrypts envelope values", () => {
  const cipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 7),
    keyId: "local-test",
    randomBytes(size) {
      return Buffer.alloc(size, 3);
    },
  });

  const encrypted = cipher.encrypt("super-secret");

  assert.equal(isEncryptedSecretValue(encrypted), true);
  assert.notEqual(encrypted, "super-secret");
  assert.equal(encrypted.includes("super-secret"), false);
  assert.equal(cipher.decrypt(encrypted), "super-secret");
});

test("configured secret cipher reads base64 local KMS key", () => {
  const cipher = createConfiguredSecretCipher({
    WASMPLANE_SECRET_KMS_KEY_ID: "fly-local",
    WASMPLANE_SECRET_KMS_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"),
  });

  assert.ok(cipher);
  const encrypted = cipher.encrypt("runtime-secret");
  assert.match(encrypted, /^wasmplane:v1:aes-256-gcm:/);
  assert.equal(cipher.decrypt(encrypted), "runtime-secret");
});

test("configured secret cipher decrypts old key ids while encrypting with the primary key", () => {
  const oldCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 1),
    keyId: "old",
    randomBytes(size) {
      return Buffer.alloc(size, 2);
    },
  });
  const cipher = createConfiguredSecretCipher({
    WASMPLANE_SECRET_KMS_KEY_ID: "new",
    WASMPLANE_SECRET_KMS_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
    WASMPLANE_SECRET_KMS_KEYS_BASE64: `old=${Buffer.alloc(32, 1).toString("base64")}`,
  });

  assert.ok(cipher);
  assert.equal(cipher.decrypt(oldCipher.encrypt("legacy-secret")), "legacy-secret");
  const encrypted = cipher.encrypt("next-secret");
  assert.equal(cipher.decrypt(encrypted), "next-secret");
  assert.throws(() => oldCipher.decrypt(encrypted), /key id new is not configured/);
});

test("command secret key provider returns a keyring for external KMS integrations", () => {
  const provider = createCommandSecretKeyProvider({
    command: "kms-helper",
    args: ["dump-keys"],
    runCommand(command, args) {
      assert.equal(command, "kms-helper");
      assert.deepEqual(args, ["dump-keys"]);
      return JSON.stringify({
        primaryKeyId: "cmd-new",
        keys: [
          { keyId: "cmd-old", keyBase64: Buffer.alloc(32, 4).toString("base64") },
          { keyId: "cmd-new", keyBase64: Buffer.alloc(32, 5).toString("base64") },
        ],
      });
    },
  });
  const oldCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 4),
    keyId: "cmd-old",
    randomBytes(size) {
      return Buffer.alloc(size, 6);
    },
  });
  const cipher = createSecretCipherFromKeyProvider(provider, {
    randomBytes(size) {
      return Buffer.alloc(size, 7);
    },
  });

  assert.equal(cipher.decrypt(oldCipher.encrypt("legacy-command-secret")), "legacy-command-secret");
  assert.equal(cipher.decrypt(cipher.encrypt("command-secret")), "command-secret");
});

test("AWS KMS secret key provider unwraps data keys for rotation", async () => {
  const plaintextByCiphertext = new Map([
    [Buffer.from("wrapped-old").toString("base64"), Buffer.alloc(32, 8)],
    [Buffer.from("wrapped-new").toString("base64"), Buffer.alloc(32, 9)],
  ]);
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const provider = await createAwsKmsSecretKeyProvider({
    region: "us-east-1",
    primaryKeyId: "aws-new",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
    },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), headers, body });
      const plaintext = plaintextByCiphertext.get(body.CiphertextBlob);
      assert.ok(plaintext);
      return new Response(JSON.stringify({ Plaintext: plaintext.toString("base64") }), { status: 200 });
    },
    wrappedKeys: [
      {
        keyId: "aws-old",
        ciphertext: Buffer.from("wrapped-old"),
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/old",
        encryptionContext: { service: "wasmplane", stage: "test" },
      },
      {
        keyId: "aws-new",
        ciphertext: Buffer.from("wrapped-new"),
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/new",
      },
    ],
  });

  assert.equal(provider.current().keyId, "aws-new");
  assert.equal(provider.keys().length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://kms.us-east-1.amazonaws.com/");
  assert.equal(requests[0].headers.get("x-amz-target"), "TrentService.Decrypt");
  assert.equal(requests[0].headers.get("x-amz-date"), "20260102T030405Z");
  assert.equal(requests[0].headers.get("x-amz-security-token"), "token");
  assert.match(
    requests[0].headers.get("authorization") ?? "",
    /AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-east-1\/kms\/aws4_request/,
  );
  assert.deepEqual(requests[0].body.EncryptionContext, { service: "wasmplane", stage: "test" });

  const oldCipher = createAesGcmSecretCipher({
    key: Buffer.alloc(32, 8),
    keyId: "aws-old",
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    },
  });
  const cipher = createSecretCipherFromKeyProvider(provider, {
    randomBytes(size) {
      return Buffer.alloc(size, 2);
    },
  });
  assert.equal(cipher.decrypt(oldCipher.encrypt("legacy-aws-secret")), "legacy-aws-secret");
  assert.equal(cipher.decrypt(cipher.encrypt("aws-secret")), "aws-secret");
});

test("GCP KMS secret key provider unwraps data keys for rotation", async () => {
  const plaintextByCiphertext = new Map([
    [Buffer.from("gcp-wrapped-old").toString("base64"), Buffer.alloc(32, 12)],
    [Buffer.from("gcp-wrapped-new").toString("base64"), Buffer.alloc(32, 13)],
  ]);
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const provider = await createGcpKmsSecretKeyProvider({
    primaryKeyId: "gcp-new",
    accessToken: "gcp-token",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), headers, body });
      const plaintext = plaintextByCiphertext.get(body.ciphertext);
      assert.ok(plaintext);
      return new Response(JSON.stringify({ plaintext: plaintext.toString("base64") }), { status: 200 });
    },
    wrappedKeys: [
      {
        keyId: "gcp-old",
        ciphertext: Buffer.from("gcp-wrapped-old"),
        cryptoKeyName: "projects/p/locations/global/keyRings/r/cryptoKeys/old",
        additionalAuthenticatedData: Buffer.from("wasmplane"),
      },
      {
        keyId: "gcp-new",
        ciphertext: Buffer.from("gcp-wrapped-new"),
        cryptoKeyName: "projects/p/locations/global/keyRings/r/cryptoKeys/new",
      },
    ],
  });

  assert.equal(provider.current().keyId, "gcp-new");
  assert.equal(provider.keys().length, 2);
  assert.equal(requests[0].url, "https://cloudkms.googleapis.com/v1/projects/p/locations/global/keyRings/r/cryptoKeys/old:decrypt");
  assert.equal(requests[0].headers.get("authorization"), "Bearer gcp-token");
  assert.equal(requests[0].body.additionalAuthenticatedData, Buffer.from("wasmplane").toString("base64"));

  const cipher = createSecretCipherFromKeyProvider(provider, {
    randomBytes(size) {
      return Buffer.alloc(size, 3);
    },
  });
  assert.equal(cipher.decrypt(cipher.encrypt("gcp-secret")), "gcp-secret");
});

test("Azure Key Vault secret key provider unwraps data keys for rotation", async () => {
  const plaintextByCiphertext = new Map([
    [Buffer.from("azure-wrapped-old").toString("base64url"), Buffer.alloc(32, 14)],
    [Buffer.from("azure-wrapped-new").toString("base64url"), Buffer.alloc(32, 15)],
  ]);
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const provider = await createAzureKeyVaultSecretKeyProvider({
    primaryKeyId: "azure-new",
    accessToken: "azure-token",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), headers, body });
      const plaintext = plaintextByCiphertext.get(body.value);
      assert.ok(plaintext);
      return new Response(JSON.stringify({ value: plaintext.toString("base64url") }), { status: 200 });
    },
    wrappedKeys: [
      {
        keyId: "azure-old",
        ciphertext: Buffer.from("azure-wrapped-old"),
        vaultUrl: "https://wasmplane.vault.azure.net",
        keyName: "old-key",
        keyVersion: "v1",
        algorithm: "RSA-OAEP-256",
      },
      {
        keyId: "azure-new",
        ciphertext: Buffer.from("azure-wrapped-new"),
        vaultUrl: "https://wasmplane.vault.azure.net/",
        keyName: "new-key",
        keyVersion: "v2",
        algorithm: "RSA-OAEP-256",
      },
    ],
  });

  assert.equal(provider.current().keyId, "azure-new");
  assert.equal(provider.keys().length, 2);
  assert.equal(
    requests[0].url,
    "https://wasmplane.vault.azure.net/keys/old-key/v1/decrypt?api-version=2025-07-01",
  );
  assert.equal(requests[0].headers.get("authorization"), "Bearer azure-token");
  assert.equal(requests[0].body.alg, "RSA-OAEP-256");
  assert.equal(requests[0].body.value, Buffer.from("azure-wrapped-old").toString("base64url"));

  const cipher = createSecretCipherFromKeyProvider(provider, {
    randomBytes(size) {
      return Buffer.alloc(size, 4);
    },
  });
  assert.equal(cipher.decrypt(cipher.encrypt("azure-secret")), "azure-secret");
});

test("configured async secret cipher reads AWS KMS wrapped keys", async () => {
  const cipher = await createConfiguredSecretCipherAsync({
    env: {
      WASMPLANE_SECRET_KMS_PROVIDER: "aws",
      WASMPLANE_SECRET_KMS_KEY_ID: "aws-primary",
      WASMPLANE_SECRET_KMS_AWS_REGION: "ap-northeast-1",
      WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS: JSON.stringify({
        keys: [
          {
            keyId: "aws-primary",
            ciphertextBase64: Buffer.from("wrapped-primary").toString("base64"),
          },
        ],
      }),
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
    },
    awsKms: {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.CiphertextBlob, Buffer.from("wrapped-primary").toString("base64"));
        return new Response(JSON.stringify({
          Plaintext: Buffer.alloc(32, 11).toString("base64"),
        }), { status: 200 });
      },
    },
  });

  assert.ok(cipher);
  const encrypted = cipher.encrypt("cloud-secret");
  assert.equal(cipher.decrypt(encrypted), "cloud-secret");
});

test("configured async secret cipher reads GCP KMS wrapped keys", async () => {
  const cipher = await createConfiguredSecretCipherAsync({
    env: {
      WASMPLANE_SECRET_KMS_PROVIDER: "gcp",
      WASMPLANE_SECRET_KMS_KEY_ID: "gcp-primary",
      WASMPLANE_SECRET_KMS_GCP_ACCESS_TOKEN: "gcp-token",
      WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS: JSON.stringify({
        keys: [
          {
            keyId: "gcp-primary",
            ciphertextBase64: Buffer.from("wrapped-primary").toString("base64"),
            cryptoKeyName: "projects/p/locations/global/keyRings/r/cryptoKeys/k",
          },
        ],
      }),
    },
    gcpKms: {
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gcp-token");
        return new Response(JSON.stringify({
          plaintext: Buffer.alloc(32, 16).toString("base64"),
        }), { status: 200 });
      },
    },
  });

  assert.ok(cipher);
  const encrypted = cipher.encrypt("gcp-cloud-secret");
  assert.equal(cipher.decrypt(encrypted), "gcp-cloud-secret");
});

test("configured async secret cipher reads Azure Key Vault wrapped keys", async () => {
  const cipher = await createConfiguredSecretCipherAsync({
    env: {
      WASMPLANE_SECRET_KMS_PROVIDER: "azure",
      WASMPLANE_SECRET_KMS_KEY_ID: "azure-primary",
      WASMPLANE_SECRET_KMS_AZURE_ACCESS_TOKEN: "azure-token",
      WASMPLANE_SECRET_KMS_AZURE_WRAPPED_KEYS: JSON.stringify({
        keys: [
          {
            keyId: "azure-primary",
            ciphertextBase64: Buffer.from("wrapped-primary").toString("base64"),
            vaultUrl: "https://wasmplane.vault.azure.net",
            keyName: "primary",
            keyVersion: "v1",
            algorithm: "RSA-OAEP-256",
          },
        ],
      }),
    },
    azureKeyVault: {
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer azure-token");
        return new Response(JSON.stringify({
          value: Buffer.alloc(32, 17).toString("base64url"),
        }), { status: 200 });
      },
    },
  });

  assert.ok(cipher);
  const encrypted = cipher.encrypt("azure-cloud-secret");
  assert.equal(cipher.decrypt(encrypted), "azure-cloud-secret");
});

test("sync configured secret cipher asks callers to use async factory for cloud KMS", () => {
  assert.throws(
    () => createConfiguredSecretCipher({
      WASMPLANE_SECRET_KMS_PROVIDER: "gcp",
      WASMPLANE_SECRET_KMS_GCP_WRAPPED_KEYS: JSON.stringify({ keys: [] }),
    }),
    /createConfiguredSecretCipherAsync/,
  );
});

test("configured secret cipher is disabled when no key is configured", () => {
  assert.equal(createConfiguredSecretCipher({}), undefined);
});
