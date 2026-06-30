import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAesGcmSecretCipher,
  createCommandSecretKeyProvider,
  createConfiguredSecretCipher,
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

test("configured secret cipher is disabled when no key is configured", () => {
  assert.equal(createConfiguredSecretCipher({}), undefined);
});
