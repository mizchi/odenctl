import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RUNTIME_IDENTITY_KEY_ID_HEADER = "x-wasmplane-runtime-identity-key-id";
export const RUNTIME_IDENTITY_SIGNATURE_HEADER = "x-wasmplane-runtime-signature";
export const RUNTIME_IDENTITY_TIMESTAMP_HEADER = "x-wasmplane-runtime-signature-timestamp";
export const RUNTIME_IDENTITY_ALGORITHM_HEADER = "x-wasmplane-runtime-signature-algorithm";

export interface RuntimeIdentitySignInput {
  method: string;
  path: string;
  body: string;
  keyId: string;
  secret: string;
  timestamp?: string;
}

export interface RuntimeIdentityVerifyInput {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  keys: Record<string, string>;
  nowMs?: () => number;
  maxSkewMs?: number;
}

export type RuntimeIdentityVerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "missing" | "unknown_key" | "stale" | "invalid" };

const algorithm = "hmac-sha256";
const defaultMaxSkewMs = 5 * 60 * 1000;

export function signRuntimeIdentityHeaders(input: RuntimeIdentitySignInput): Record<string, string> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    [RUNTIME_IDENTITY_KEY_ID_HEADER]: input.keyId,
    [RUNTIME_IDENTITY_ALGORITHM_HEADER]: algorithm,
    [RUNTIME_IDENTITY_TIMESTAMP_HEADER]: timestamp,
    [RUNTIME_IDENTITY_SIGNATURE_HEADER]: runtimeIdentitySignature({
      method: input.method,
      path: input.path,
      body: input.body,
      keyId: input.keyId,
      secret: input.secret,
      timestamp,
    }),
  };
}

export function verifyRuntimeIdentityHeaders(input: RuntimeIdentityVerifyInput): RuntimeIdentityVerifyResult {
  const keyId = firstHeader(input.headers[RUNTIME_IDENTITY_KEY_ID_HEADER]);
  const signature = firstHeader(input.headers[RUNTIME_IDENTITY_SIGNATURE_HEADER]);
  const timestamp = firstHeader(input.headers[RUNTIME_IDENTITY_TIMESTAMP_HEADER]);
  const receivedAlgorithm = firstHeader(input.headers[RUNTIME_IDENTITY_ALGORITHM_HEADER]);
  if (!keyId || !signature || !timestamp || receivedAlgorithm !== algorithm) {
    return { ok: false, reason: "missing" };
  }
  const secret = input.keys[keyId];
  if (!secret) {
    return { ok: false, reason: "unknown_key" };
  }
  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return { ok: false, reason: "invalid" };
  }
  const nowMs = input.nowMs?.() ?? Date.now();
  if (Math.abs(nowMs - parsedTimestamp) > (input.maxSkewMs ?? defaultMaxSkewMs)) {
    return { ok: false, reason: "stale" };
  }
  const expected = runtimeIdentitySignature({
    method: input.method,
    path: input.path,
    body: input.body,
    keyId,
    secret,
    timestamp,
  });
  if (!constantTimeEqual(signature, expected)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, keyId };
}

function runtimeIdentitySignature(input: RuntimeIdentitySignInput & { timestamp: string }): string {
  const digest = createHash("sha256").update(input.body).digest("hex");
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    input.keyId,
    input.timestamp,
    digest,
  ].join("\n");
  return `sha256=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
