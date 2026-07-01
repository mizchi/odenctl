import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAesGcmSecretCipher,
  createAwsKmsSecretKeyProvider,
  createCommandSecretKeyProvider,
  createConfiguredSecretCipher,
  createConfiguredSecretCipherAsync,
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

test("sync configured secret cipher asks callers to use async factory for cloud KMS", () => {
  assert.throws(
    () => createConfiguredSecretCipher({
      WASMPLANE_SECRET_KMS_PROVIDER: "aws",
      WASMPLANE_SECRET_KMS_AWS_REGION: "us-east-1",
      WASMPLANE_SECRET_KMS_AWS_WRAPPED_KEYS: JSON.stringify({ keys: [] }),
    }),
    /createConfiguredSecretCipherAsync/,
  );
});

test("configured secret cipher is disabled when no key is configured", () => {
  assert.equal(createConfiguredSecretCipher({}), undefined);
});
