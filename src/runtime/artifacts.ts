import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "./errors.ts";
import type { ArtifactReference, ArtifactStore, MaterializedArtifact } from "./types.ts";

export interface FileArtifactStoreOptions {
  verifyDigest?: boolean;
}

export interface RuntimeArtifactStoreOptions extends FileArtifactStoreOptions {
  cacheDir: string;
  fetch?: FetchArtifactFunction;
  s3?: RuntimeS3ArtifactOptions;
}

export type FetchArtifactFunction = (input: string, init?: RequestInit) => Promise<FetchArtifactResponse>;

export interface RuntimeS3ArtifactOptions {
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: () => Date;
}

export interface FetchArtifactResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export function createFileArtifactStore(options: FileArtifactStoreOptions = {}): ArtifactStore {
  const verifyDigest = options.verifyDigest ?? true;

  return {
    async materialize(artifact: ArtifactReference): Promise<MaterializedArtifact> {
      const url = parseLocation(artifact.location);
      if (url.protocol !== "file:") {
        throw new RuntimeError("unsupported", `unsupported artifact location ${artifact.location}`);
      }

      const path = fileURLToPath(url);
      if (verifyDigest) {
        const bytes = await readFile(path);
        const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (actual !== artifact.digest) {
          throw new RuntimeError(
            "artifact",
            `artifact ${artifact.id} digest mismatch: expected ${artifact.digest}, got ${actual}`,
          );
        }
      }

      return {
        path,
        digest: artifact.digest,
        location: artifact.location,
        verified: verifyDigest,
      };
    },
  };
}

export function createRuntimeArtifactStore(options: RuntimeArtifactStoreOptions): ArtifactStore {
  const verifyDigest = options.verifyDigest ?? true;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async materialize(artifact: ArtifactReference): Promise<MaterializedArtifact> {
      const url = parseLocation(artifact.location);
      if (url.protocol === "file:") {
        return createFileArtifactStore({ verifyDigest }).materialize(artifact);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "s3:") {
        throw new RuntimeError("unsupported", `unsupported artifact location ${artifact.location}`);
      }

      await mkdir(options.cacheDir, { recursive: true });
      const path = join(options.cacheDir, artifactCacheName(artifact.digest));
      if (await exists(path)) {
        await verifyFileDigest(path, artifact);
        return {
          path,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      }

      const request = artifactFetchRequest(url, artifact.location, options.s3);
      const response = await fetchImpl(request.url, request.init);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new RuntimeError(
          "artifact",
          `artifact ${artifact.id} fetch failed with ${response.status}${text ? `: ${text}` : ""}`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256Digest(bytes);
      if (verifyDigest && actual !== artifact.digest) {
        throw new RuntimeError(
          "artifact",
          `artifact ${artifact.id} digest mismatch: expected ${artifact.digest}, got ${actual}`,
        );
      }

      const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmpPath, bytes);
        await rename(tmpPath, path);
      } catch (error) {
        await unlink(tmpPath).catch(() => undefined);
        throw error;
      }

      return {
        path,
        digest: artifact.digest,
        location: artifact.location,
        verified: verifyDigest,
      };
    },
  };
}

export function runtimeS3ArtifactOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeS3ArtifactOptions | undefined {
  const endpoint = firstNonEmpty(env.WASMPLANE_ARTIFACT_ENDPOINT);
  const bucket = firstNonEmpty(env.WASMPLANE_ARTIFACT_BUCKET);
  const accessKeyId = firstNonEmpty(
    env.WASMPLANE_ARTIFACT_ACCESS_KEY_ID,
    env.AWS_ACCESS_KEY_ID,
  );
  const secretAccessKey = firstNonEmpty(
    env.WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY,
    env.AWS_SECRET_ACCESS_KEY,
  );
  if (!accessKeyId && !secretAccessKey && !endpoint && !bucket) {
    return undefined;
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new RuntimeError(
      "artifact",
      "S3 artifact materialization requires access key id and secret access key",
    );
  }
  return {
    bucket,
    endpoint,
    region: firstNonEmpty(env.WASMPLANE_ARTIFACT_REGION, env.AWS_REGION),
    accessKeyId,
    secretAccessKey,
    sessionToken: firstNonEmpty(env.WASMPLANE_ARTIFACT_SESSION_TOKEN, env.AWS_SESSION_TOKEN),
  };
}

function parseLocation(location: string): URL {
  try {
    return new URL(location);
  } catch {
    throw new RuntimeError("artifact", `invalid artifact location ${location}`);
  }
}

function artifactFetchRequest(
  url: URL,
  originalLocation: string,
  s3: RuntimeS3ArtifactOptions | undefined,
): { url: string; init?: RequestInit } {
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { url: originalLocation };
  }
  if (url.protocol !== "s3:") {
    throw new RuntimeError("unsupported", `unsupported artifact location ${originalLocation}`);
  }
  if (!s3) {
    throw new RuntimeError("artifact", "S3 artifact materialization is not configured");
  }
  const bucket = url.hostname;
  if (!bucket) {
    throw new RuntimeError("artifact", `invalid S3 artifact location ${originalLocation}`);
  }
  if (s3.bucket && s3.bucket !== bucket) {
    throw new RuntimeError(
      "artifact",
      `S3 artifact bucket mismatch: expected ${s3.bucket}, got ${bucket}`,
    );
  }
  const key = url.pathname.replace(/^\/+/, "");
  if (!key) {
    throw new RuntimeError("artifact", `invalid S3 artifact location ${originalLocation}`);
  }
  const region = s3.region ?? "us-east-1";
  const objectUrl = s3ObjectUrl(bucket, key, region, s3.endpoint);
  return {
    url: objectUrl.href,
    init: {
      method: "GET",
      headers: signS3Get({
        url: objectUrl,
        region,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        sessionToken: s3.sessionToken,
        now: s3.now ?? (() => new Date()),
      }),
    },
  };
}

async function verifyFileDigest(path: string, artifact: ArtifactReference) {
  const actual = sha256Digest(await readFile(path));
  if (actual !== artifact.digest) {
    throw new RuntimeError(
      "artifact",
      `artifact ${artifact.id} digest mismatch: expected ${artifact.digest}, got ${actual}`,
    );
  }
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function signS3Get(input: {
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: () => Date;
}): Headers {
  const now = input.now();
  const dateStamp = awsDateStamp(now);
  const amzDate = awsTimestamp(now);
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const headers = new Headers({
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
    "GET",
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

function s3ObjectUrl(bucket: string, key: string, region: string, endpoint: string | undefined): URL {
  const encodedKey = encodePath(key);
  if (endpoint) {
    return new URL(`${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}/${encodedKey}`);
  }
  return new URL(`https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function awsTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function awsDateStamp(date: Date): string {
  return awsTimestamp(date).slice(0, 8);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

function artifactCacheName(digest: string): string {
  return digest.replace(":", "-").replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
