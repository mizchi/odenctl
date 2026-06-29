import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createConfiguredControlPlaneArtifactStore,
  createFileControlPlaneArtifactStore,
  createS3ControlPlaneArtifactStore,
  decodeLocalArtifactBytes,
} from "../src/control-plane/artifact-store.ts";

test("file artifact store writes digest-addressed Wasm bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-file-artifact-store-"));
  const bytes = Buffer.from("component bytes");
  const decoded = decodeLocalArtifactBytes(bytes.toString("base64"));
  const store = createFileControlPlaneArtifactStore({ storeDir: dir });

  const artifact = await store.putArtifact({
    ...decoded,
    publicBaseUrl: "https://control.example.com",
  });

  assert.equal(
    artifact.location,
    `https://control.example.com/artifacts/local/${decoded.digestHex}.wasm`,
  );
  assert.deepEqual(await readFile(fileURLToPath(artifact.fileUrl)), bytes);
  assert.deepEqual(await store.readArtifact(decoded.digestHex), bytes);
});

test("S3 artifact store uploads with SigV4 and returns public object location", async () => {
  const bytes = Buffer.from("component bytes");
  const decoded = decodeLocalArtifactBytes(bytes.toString("base64"));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = createS3ControlPlaneArtifactStore({
    bucket: "wasmplane-artifacts",
    prefix: "workers",
    region: "auto",
    endpoint: "https://r2.example.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    publicBaseUrl: "https://cdn.example.com/artifacts",
    now: () => new Date("2026-06-30T10:00:00.000Z"),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    },
  });

  const artifact = await store.putArtifact(decoded);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://r2.example.com/wasmplane-artifacts/workers/${decoded.digestHex}.wasm`,
  );
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(calls[0].init.body, bytes);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("content-type"), "application/wasm");
  assert.equal(headers.get("x-amz-content-sha256"), createHash("sha256").update(bytes).digest("hex"));
  assert.match(
    headers.get("authorization") ?? "",
    /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260630\/auto\/s3\/aws4_request,/,
  );
  assert.equal(artifact.location, `https://cdn.example.com/artifacts/workers/${decoded.digestHex}.wasm`);
  assert.equal(artifact.sizeBytes, bytes.byteLength);
  assert.equal(artifact.digest, decoded.digest);
});

test("artifact store config selects S3 when a bucket is configured", () => {
  const store = createConfiguredControlPlaneArtifactStore({
    WASMPLANE_ARTIFACT_BUCKET: "wasmplane-artifacts",
    WASMPLANE_ARTIFACT_PREFIX: "workers",
    WASMPLANE_ARTIFACT_ENDPOINT: "https://r2.example.com",
    WASMPLANE_ARTIFACT_REGION: "auto",
    WASMPLANE_ARTIFACT_ACCESS_KEY_ID: "test-access-key",
    WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY: "test-secret-key",
  });

  assert.equal(store.kind, "s3");
});
