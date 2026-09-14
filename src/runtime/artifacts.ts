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
  oci?: RuntimeOciArtifactOptions;
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

export interface RuntimeOciArtifactOptions {
  registries?: Record<string, RuntimeOciRegistryOptions>;
  defaultScheme?: "http" | "https";
}

export interface RuntimeOciRegistryOptions {
  scheme?: "http" | "https";
  username?: string;
  password?: string;
  bearerToken?: string;
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
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "s3:" && url.protocol !== "oci:") {
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

      const bytes = url.protocol === "oci:"
        ? await fetchOciArtifact({
          url,
          originalLocation: artifact.location,
          artifact,
          oci: options.oci,
          fetch: fetchImpl,
        })
        : await fetchRemoteArtifact({
          url,
          originalLocation: artifact.location,
          artifact,
          s3: options.s3,
          fetch: fetchImpl,
        });
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

export function runtimeOciArtifactOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeOciArtifactOptions | undefined {
  const registries: Record<string, RuntimeOciRegistryOptions> = {};
  const json = firstNonEmpty(env.ODENCTL_OCI_REGISTRIES_JSON);
  if (json) {
    for (const [registry, config] of Object.entries(parseOciRegistriesJson(json))) {
      registries[registry] = config;
    }
  }

  const registry = firstNonEmpty(env.ODENCTL_OCI_REGISTRY);
  if (registry) {
    registries[registry] = compactOciRegistryOptions({
      scheme: normalizeOciScheme(firstNonEmpty(env.ODENCTL_OCI_REGISTRY_SCHEME)),
      username: firstNonEmpty(env.ODENCTL_OCI_REGISTRY_USERNAME),
      password: firstNonEmpty(env.ODENCTL_OCI_REGISTRY_PASSWORD),
      bearerToken: firstNonEmpty(env.ODENCTL_OCI_REGISTRY_TOKEN),
    });
  }

  const defaultScheme = normalizeOciScheme(firstNonEmpty(env.ODENCTL_OCI_DEFAULT_SCHEME));
  const result: RuntimeOciArtifactOptions = {};
  if (Object.keys(registries).length > 0) {
    result.registries = registries;
  }
  if (defaultScheme) {
    result.defaultScheme = defaultScheme;
  }
  return result.registries || result.defaultScheme ? result : undefined;
}

export function runtimeS3ArtifactOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeS3ArtifactOptions | undefined {
  const endpoint = firstNonEmpty(env.ODENCTL_ARTIFACT_ENDPOINT);
  const bucket = firstNonEmpty(env.ODENCTL_ARTIFACT_BUCKET);
  const accessKeyId = firstNonEmpty(
    env.ODENCTL_ARTIFACT_ACCESS_KEY_ID,
    env.AWS_ACCESS_KEY_ID,
  );
  const secretAccessKey = firstNonEmpty(
    env.ODENCTL_ARTIFACT_SECRET_ACCESS_KEY,
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
    region: firstNonEmpty(env.ODENCTL_ARTIFACT_REGION, env.AWS_REGION),
    accessKeyId,
    secretAccessKey,
    sessionToken: firstNonEmpty(env.ODENCTL_ARTIFACT_SESSION_TOKEN, env.AWS_SESSION_TOKEN),
  };
}

async function fetchRemoteArtifact(input: {
  url: URL;
  originalLocation: string;
  artifact: ArtifactReference;
  s3: RuntimeS3ArtifactOptions | undefined;
  fetch: FetchArtifactFunction;
}): Promise<Buffer> {
  const request = artifactFetchRequest(input.url, input.originalLocation, input.s3);
  const response = await input.fetch(request.url, request.init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RuntimeError(
      "artifact",
      `artifact ${input.artifact.id} fetch failed with ${response.status}${text ? `: ${text}` : ""}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchOciArtifact(input: {
  url: URL;
  originalLocation: string;
  artifact: ArtifactReference;
  oci: RuntimeOciArtifactOptions | undefined;
  fetch: FetchArtifactFunction;
}): Promise<Buffer> {
  const reference = parseOciReference(input.url, input.originalLocation);
  const registryOptions = input.oci?.registries?.[reference.registry];
  const scheme = registryOptions?.scheme ?? input.oci?.defaultScheme ?? "https";
  if (isSha256Digest(reference.reference) && reference.reference.toLowerCase() === input.artifact.digest) {
    return fetchOciBlob({
      ...input,
      reference,
      registryOptions,
      scheme,
      digest: reference.reference.toLowerCase(),
    });
  }

  const manifestBytes = await fetchOciUrl({
    fetch: input.fetch,
    artifact: input.artifact,
    url: ociRegistryApiUrl(reference, scheme, "manifests", reference.reference),
    registryOptions,
    accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/json",
    kind: "manifest",
  });
  if (isSha256Digest(reference.reference)) {
    const actualManifestDigest = sha256Digest(manifestBytes);
    if (actualManifestDigest !== reference.reference.toLowerCase()) {
      throw new RuntimeError(
        "artifact",
        `OCI artifact manifest digest mismatch: expected ${reference.reference.toLowerCase()}, got ${actualManifestDigest}`,
      );
    }
  }
  const manifest = parseOciManifest(manifestBytes, input.originalLocation);
  const layer = selectOciLayer(manifest, input.artifact);
  return fetchOciBlob({
    ...input,
    reference,
    registryOptions,
    scheme,
    digest: layer.digest,
  });
}

async function fetchOciBlob(input: {
  fetch: FetchArtifactFunction;
  artifact: ArtifactReference;
  reference: OciReference;
  registryOptions: RuntimeOciRegistryOptions | undefined;
  scheme: "http" | "https";
  digest: string;
}): Promise<Buffer> {
  return fetchOciUrl({
    fetch: input.fetch,
    artifact: input.artifact,
    url: ociRegistryApiUrl(input.reference, input.scheme, "blobs", input.digest),
    registryOptions: input.registryOptions,
    accept: "application/wasm, application/octet-stream, */*",
    kind: "blob",
  });
}

async function fetchOciUrl(input: {
  fetch: FetchArtifactFunction;
  artifact: ArtifactReference;
  url: string;
  registryOptions: RuntimeOciRegistryOptions | undefined;
  accept: string;
  kind: string;
}): Promise<Buffer> {
  const response = await input.fetch(input.url, {
    method: "GET",
    headers: ociRequestHeaders(input.registryOptions, input.accept),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RuntimeError(
      "artifact",
      `OCI artifact ${input.artifact.id} ${input.kind} fetch failed with ${response.status}${text ? `: ${text}` : ""}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseLocation(location: string): URL {
  try {
    return new URL(location);
  } catch {
    throw new RuntimeError("artifact", `invalid artifact location ${location}`);
  }
}

interface OciReference {
  registry: string;
  repository: string;
  reference: string;
}

interface OciManifest {
  layers: Array<{ digest: string; mediaType?: string; size?: number }>;
}

function parseOciReference(url: URL, originalLocation: string): OciReference {
  const registry = url.host;
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!registry || !path) {
    throw new RuntimeError("artifact", `invalid OCI artifact location ${originalLocation}`);
  }
  const at = path.lastIndexOf("@");
  if (at > 0 && at < path.length - 1) {
    return {
      registry,
      repository: path.slice(0, at),
      reference: path.slice(at + 1),
    };
  }
  const lastSlash = path.lastIndexOf("/");
  const tag = path.lastIndexOf(":");
  if (tag > lastSlash && tag < path.length - 1) {
    return {
      registry,
      repository: path.slice(0, tag),
      reference: path.slice(tag + 1),
    };
  }
  throw new RuntimeError("artifact", `OCI artifact location must include a tag or digest: ${originalLocation}`);
}

function parseOciManifest(bytes: Buffer, originalLocation: string): OciManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RuntimeError("artifact", `OCI artifact manifest is not valid JSON: ${originalLocation}`);
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as any).layers)) {
    throw new RuntimeError("artifact", `OCI artifact manifest has no layers: ${originalLocation}`);
  }
  return {
    layers: (value as any).layers
      .filter((layer: any) => layer && typeof layer.digest === "string")
      .map((layer: any) => ({
        digest: layer.digest.toLowerCase(),
        mediaType: typeof layer.mediaType === "string" ? layer.mediaType : undefined,
        size: typeof layer.size === "number" ? layer.size : undefined,
      })),
  };
}

function selectOciLayer(manifest: OciManifest, artifact: ArtifactReference) {
  const expectedDigest = artifact.digest.toLowerCase();
  const layer = manifest.layers.find((candidate) => candidate.digest === expectedDigest);
  if (!layer) {
    throw new RuntimeError(
      "artifact",
      `OCI artifact manifest does not reference expected digest ${expectedDigest}`,
    );
  }
  return layer;
}

function ociRegistryApiUrl(
  reference: OciReference,
  scheme: "http" | "https",
  kind: "manifests" | "blobs",
  value: string,
): string {
  return `${scheme}://${reference.registry}/v2/${encodePath(reference.repository)}/${kind}/${encodeOciReference(value)}`;
}

function ociRequestHeaders(
  registryOptions: RuntimeOciRegistryOptions | undefined,
  accept: string,
): Headers {
  const headers = new Headers({ accept });
  if (registryOptions?.bearerToken) {
    headers.set("authorization", `Bearer ${registryOptions.bearerToken}`);
    return headers;
  }
  if (registryOptions?.username || registryOptions?.password) {
    if (!registryOptions.username || !registryOptions.password) {
      throw new RuntimeError("artifact", "OCI registry basic auth requires username and password");
    }
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${registryOptions.username}:${registryOptions.password}`).toString("base64")}`,
    );
  }
  return headers;
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

function encodeOciReference(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":");
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

function parseOciRegistriesJson(value: string): Record<string, RuntimeOciRegistryOptions> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RuntimeError("artifact", "ODENCTL_OCI_REGISTRIES_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeError("artifact", "ODENCTL_OCI_REGISTRIES_JSON must be an object");
  }
  const registries: Record<string, RuntimeOciRegistryOptions> = {};
  for (const [registry, config] of Object.entries(parsed)) {
    if (!registry || !config || typeof config !== "object" || Array.isArray(config)) {
      continue;
    }
    const record = config as Record<string, unknown>;
    registries[registry] = compactOciRegistryOptions({
      scheme: normalizeOciScheme(stringValue(record.scheme)),
      username: stringValue(record.username),
      password: stringValue(record.password),
      bearerToken: stringValue(record.bearerToken ?? record.token),
    });
  }
  return registries;
}

function compactOciRegistryOptions(input: RuntimeOciRegistryOptions): RuntimeOciRegistryOptions {
  const output: RuntimeOciRegistryOptions = {};
  if (input.scheme) {
    output.scheme = input.scheme;
  }
  if (input.bearerToken) {
    output.bearerToken = input.bearerToken;
  }
  if (input.username || input.password) {
    if (!input.username || !input.password) {
      throw new RuntimeError("artifact", "OCI registry basic auth requires username and password");
    }
    output.username = input.username;
    output.password = input.password;
  }
  return output;
}

function normalizeOciScheme(value: string | undefined): "http" | "https" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "http" || value === "https") {
    return value;
  }
  throw new RuntimeError("artifact", "OCI registry scheme must be http or https");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[a-fA-F0-9]{64}$/.test(value);
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
