import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneError } from "./errors.ts";

export interface DecodedLocalArtifactBytes {
  bytes: Buffer;
  digest: string;
  digestHex: string;
  sizeBytes: number;
}

export interface PutArtifactInput extends DecodedLocalArtifactBytes {
  publicBaseUrl?: string;
}

export interface PutArtifactResult {
  digest: string;
  digestHex: string;
  location: string;
  sizeBytes: number;
  path?: string;
  fileUrl?: string;
}

export interface ControlPlaneArtifactStore {
  kind: "file" | "s3";
  putArtifact(input: PutArtifactInput): Promise<PutArtifactResult>;
  readArtifact?(digestHex: string): Promise<Buffer>;
}

export interface FileControlPlaneArtifactStoreOptions {
  storeDir: string;
}

export interface S3ControlPlaneArtifactStoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  publicBaseUrl?: string;
  now?: () => Date;
  fetch?: typeof fetch;
}

export function decodeLocalArtifactBytes(bytesBase64: unknown): DecodedLocalArtifactBytes {
  if (typeof bytesBase64 !== "string" || bytesBase64.trim().length === 0) {
    throw new ControlPlaneError("validation", "bytesBase64 must be a non-empty base64 string");
  }
  const bytes = Buffer.from(bytesBase64, "base64");
  if (bytes.length === 0) {
    throw new ControlPlaneError("validation", "artifact bytes must not be empty");
  }
  const digestHex = sha256Hex(bytes);
  return {
    bytes,
    digest: `sha256:${digestHex}`,
    digestHex,
    sizeBytes: bytes.length,
  };
}

export function createFileControlPlaneArtifactStore(
  options: FileControlPlaneArtifactStoreOptions,
): ControlPlaneArtifactStore {
  return {
    kind: "file",
    async putArtifact(input) {
      await mkdir(options.storeDir, { recursive: true });
      const path = localArtifactPath(options.storeDir, input.digestHex);
      const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, input.bytes);
      await rename(tmpPath, path).catch((error) => {
        throw new ControlPlaneError(
          "validation",
          error instanceof Error ? error.message : String(error),
        );
      });
      const fileUrl = pathToFileURL(path).href;
      return {
        digest: input.digest,
        digestHex: input.digestHex,
        location: input.publicBaseUrl
          ? `${input.publicBaseUrl.replace(/\/+$/, "")}/artifacts/local/${input.digestHex}.wasm`
          : fileUrl,
        path,
        fileUrl,
        sizeBytes: input.sizeBytes,
      };
    },
    async readArtifact(digestHex) {
      return readFile(localArtifactPath(options.storeDir, digestHex));
    },
  };
}

export function createS3ControlPlaneArtifactStore(
  options: S3ControlPlaneArtifactStoreOptions,
): ControlPlaneArtifactStore {
  const region = options.region ?? "us-east-1";
  const fetchImpl = options.fetch ?? fetch;
  return {
    kind: "s3",
    async putArtifact(input) {
      const key = artifactObjectKey(options.prefix, input.digestHex);
      const url = s3ObjectUrl(options, region, key);
      const headers = signS3Put({
        url,
        bytes: input.bytes,
        region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
        now: options.now ?? (() => new Date()),
      });
      const response = await fetchImpl(url, {
        method: "PUT",
        headers,
        body: input.bytes,
      });
      if (!response.ok) {
        throw new ControlPlaneError(
          "validation",
          `artifact object upload failed with status ${response.status}`,
        );
      }
      return {
        digest: input.digest,
        digestHex: input.digestHex,
        location: objectLocation(options, key),
        sizeBytes: input.sizeBytes,
      };
    },
  };
}

export function createConfiguredControlPlaneArtifactStore(
  env: Record<string, string | undefined> = process.env,
): ControlPlaneArtifactStore {
  const artifactStoreKind = env.ODENCTL_ARTIFACT_STORE?.trim().toLowerCase();
  const bucket = firstNonEmpty(env.ODENCTL_ARTIFACT_BUCKET);
  if (artifactStoreKind === "s3" || bucket) {
    if (!bucket) {
      throw new ControlPlaneError("validation", "ODENCTL_ARTIFACT_BUCKET is required");
    }
    const accessKeyId = firstNonEmpty(
      env.ODENCTL_ARTIFACT_ACCESS_KEY_ID,
      env.AWS_ACCESS_KEY_ID,
    );
    const secretAccessKey = firstNonEmpty(
      env.ODENCTL_ARTIFACT_SECRET_ACCESS_KEY,
      env.AWS_SECRET_ACCESS_KEY,
    );
    if (!accessKeyId || !secretAccessKey) {
      throw new ControlPlaneError(
        "validation",
        "S3 artifact store requires access key id and secret access key",
      );
    }
    return createS3ControlPlaneArtifactStore({
      bucket,
      prefix: firstNonEmpty(env.ODENCTL_ARTIFACT_PREFIX),
      endpoint: firstNonEmpty(env.ODENCTL_ARTIFACT_ENDPOINT),
      region: firstNonEmpty(env.ODENCTL_ARTIFACT_REGION, env.AWS_REGION),
      accessKeyId,
      secretAccessKey,
      sessionToken: firstNonEmpty(env.ODENCTL_ARTIFACT_SESSION_TOKEN, env.AWS_SESSION_TOKEN),
      publicBaseUrl: fixedPublicBaseUrl(env.ODENCTL_ARTIFACT_PUBLIC_BASE_URL),
    });
  }
  return createFileControlPlaneArtifactStore({
    storeDir: firstNonEmpty(env.ODENCTL_ARTIFACT_DIR) ?? ".odenctl/artifacts",
  });
}

export function localArtifactPath(storeDir: string, digestHex: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(digestHex)) {
    throw new ControlPlaneError("validation", "artifact digest must be a 64 character hex string");
  }
  return join(storeDir, `${digestHex.toLowerCase()}.wasm`);
}

function signS3Put(input: {
  url: URL;
  bytes: Buffer;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: () => Date;
}): Headers {
  const now = input.now();
  const dateStamp = awsDateStamp(now);
  const amzDate = awsTimestamp(now);
  const payloadHash = sha256Hex(input.bytes);
  const headers = new Headers({
    "content-type": "application/wasm",
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  if (input.sessionToken) {
    headers.set("x-amz-security-token", input.sessionToken);
  }
  const signedHeaders = Array.from(headers.keys()).sort();
  const canonicalHeaders = signedHeaders
    .map((key) => `${key}:${headers.get(key)?.trim() ?? ""}\n`)
    .join("");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const canonicalRequest = [
    "PUT",
    input.url.pathname,
    input.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");
  const signingKey = awsSigningKey(input.secretAccessKey, dateStamp, input.region);
  const signature = hmacHex(signingKey, stringToSign);
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(
      ";",
    )}, Signature=${signature}`,
  );
  return headers;
}

function s3ObjectUrl(
  options: S3ControlPlaneArtifactStoreOptions,
  region: string,
  key: string,
): URL {
  const encodedKey = encodePath(key);
  if (options.endpoint) {
    return new URL(
      `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}/${encodedKey}`,
    );
  }
  return new URL(
    `https://${options.bucket}.s3.${region}.amazonaws.com/${encodedKey}`,
  );
}

function objectLocation(options: S3ControlPlaneArtifactStoreOptions, key: string): string {
  if (options.publicBaseUrl) {
    return `${options.publicBaseUrl.replace(/\/+$/, "")}/${encodePath(key)}`;
  }
  return `s3://${options.bucket}/${key}`;
}

function artifactObjectKey(prefix: string | undefined, digestHex: string): string {
  const basename = `${digestHex}.wasm`;
  if (!prefix || prefix.trim().length === 0) {
    return basename;
  }
  return `${prefix.trim().replace(/^\/+|\/+$/g, "")}/${basename}`;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function awsTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function awsDateStamp(date: Date): string {
  return awsTimestamp(date).slice(0, 8);
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function fixedPublicBaseUrl(value: string | undefined): string | undefined {
  const publicBaseUrl = firstNonEmpty(value);
  return publicBaseUrl === "auto" ? undefined : publicBaseUrl;
}
