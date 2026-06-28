import { createHash } from "node:crypto";
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
}

export type FetchArtifactFunction = (input: string) => Promise<FetchArtifactResponse>;

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
      if (url.protocol !== "http:" && url.protocol !== "https:") {
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

      const response = await fetchImpl(artifact.location);
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

function parseLocation(location: string): URL {
  try {
    return new URL(location);
  } catch {
    throw new RuntimeError("artifact", `invalid artifact location ${location}`);
  }
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
