import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "./errors.ts";
import type { ArtifactReference, ArtifactStore, MaterializedArtifact } from "./types.ts";

export interface FileArtifactStoreOptions {
  verifyDigest?: boolean;
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

function parseLocation(location: string): URL {
  try {
    return new URL(location);
  } catch {
    throw new RuntimeError("artifact", `invalid artifact location ${location}`);
  }
}
