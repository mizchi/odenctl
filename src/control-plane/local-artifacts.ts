import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneError } from "./errors.ts";

export interface LocalArtifactIngestInput {
  storeDir: string;
  bytesBase64: unknown;
  publicBaseUrl?: string;
}

export interface LocalArtifactIngestResult {
  digest: string;
  location: string;
  path: string;
  sizeBytes: number;
}

export async function ingestLocalArtifact(
  input: LocalArtifactIngestInput,
): Promise<LocalArtifactIngestResult> {
  if (typeof input.bytesBase64 !== "string" || input.bytesBase64.trim().length === 0) {
    throw new ControlPlaneError("validation", "bytesBase64 must be a non-empty base64 string");
  }
  const bytes = Buffer.from(input.bytesBase64, "base64");
  if (bytes.length === 0) {
    throw new ControlPlaneError("validation", "artifact bytes must not be empty");
  }
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${digestHex}`;
  await mkdir(input.storeDir, { recursive: true });
  const path = join(input.storeDir, `${digestHex}.wasm`);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, path).catch(async (error) => {
    throw new ControlPlaneError(
      "validation",
      error instanceof Error ? error.message : String(error),
    );
  });
  return {
    digest,
    location: input.publicBaseUrl
      ? `${input.publicBaseUrl.replace(/\/+$/, "")}/artifacts/local/${digestHex}.wasm`
      : pathToFileURL(path).href,
    path,
    sizeBytes: bytes.length,
  };
}

export function localArtifactPath(storeDir: string, digestHex: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(digestHex)) {
    throw new ControlPlaneError("validation", "artifact digest must be a 64 character hex string");
  }
  return join(storeDir, `${digestHex.toLowerCase()}.wasm`);
}
