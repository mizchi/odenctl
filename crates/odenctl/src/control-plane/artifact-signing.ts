import { createHmac, timingSafeEqual } from "node:crypto";
import type { Artifact, ArtifactSignature } from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export interface ArtifactSignatureVerifier {
  verify(artifact: Artifact): void;
}

export interface HmacArtifactSignatureVerifierOptions {
  keys: Record<string, string | Buffer | Uint8Array>;
}

export function createHmacArtifactSignatureVerifier(
  options: HmacArtifactSignatureVerifierOptions,
): ArtifactSignatureVerifier {
  const keys = new Map(Object.entries(options.keys).map(([keyId, key]) => [keyId, Buffer.from(key)]));
  return {
    verify(artifact) {
      const signature = artifact.signature;
      if (!signature) {
        throw new ControlPlaneError("validation", `artifact ${artifact.id} is missing a signature`);
      }
      if (signature.algorithm !== "sha256-hmac") {
        throw new ControlPlaneError("validation", `artifact ${artifact.id} uses unsupported signature algorithm`);
      }
      const key = keys.get(signature.keyId);
      if (!key) {
        throw new ControlPlaneError("validation", `artifact ${artifact.id} signature key is not configured`);
      }
      const expected = signArtifactDigest(artifact.digest, { algorithm: signature.algorithm, keyId: signature.keyId }, key);
      if (!constantTimeEqual(signature.value, expected.value)) {
        throw new ControlPlaneError("validation", `artifact ${artifact.id} signature verification failed`);
      }
    },
  };
}

export function signArtifactDigest(
  digest: string,
  signature: Pick<ArtifactSignature, "algorithm" | "keyId">,
  key: string | Buffer | Uint8Array,
): ArtifactSignature {
  if (signature.algorithm !== "sha256-hmac") {
    throw new ControlPlaneError("validation", "unsupported artifact signature algorithm");
  }
  return {
    algorithm: signature.algorithm,
    keyId: signature.keyId,
    value: createHmac("sha256", key).update(digest).digest("hex"),
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}
