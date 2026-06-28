import { MVP_WASI_PROFILE } from "../control-plane/contracts.ts";
import { createSqliteRepository } from "../control-plane/repository.ts";
import { createRuntimeArtifactStore } from "./artifacts.ts";
import { startRuntimeHeartbeat } from "./heartbeat.ts";
import { createRuntimeNodeApp } from "./node-app.ts";
import { createEnvSecretStore, createRepositorySecretStore } from "./secrets.ts";
import { createRuntimeSupervisor } from "./supervisor.ts";
import { createWasip3HostBackend, createWasip3HostInvoker } from "./wasip3-host.ts";

const port = Number.parseInt(process.env.RUNTIME_PORT ?? "8788", 10);
const host = process.env.RUNTIME_HOST ?? "127.0.0.1";
const cacheDir = process.env.WASMPLANE_CACHE_DIR ?? ".wasmplane/cache";
const artifactCacheDir = process.env.WASMPLANE_ARTIFACT_CACHE_DIR ?? ".wasmplane/runtime-artifacts";
const kvStoreDir = process.env.WASMPLANE_KV_STORE_DIR ?? ".wasmplane/kv";
const hostBin = process.env.WASMPLANE_WASIP3_HOST_BIN ?? "target/debug/wasmplane-wasip3-host";
const publicUrl = process.env.RUNTIME_PUBLIC_URL ?? `http://${host}:${port}`;
const runtimeNodeId =
  process.env.RUNTIME_NODE_ID ?? `rt_${host.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${port}`;
const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? process.env.WASMPLANE_CONTROL_PLANE_URL;
const secretDbPath = process.env.WASMPLANE_SECRET_DB;
const runtimeConcurrency = Number.parseInt(process.env.RUNTIME_CONCURRENCY ?? "128", 10);

const supervisor = createRuntimeSupervisor({
  snapshot: {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    routes: [],
  },
  artifactStore: createRuntimeArtifactStore({ cacheDir: artifactCacheDir }),
  backend: createWasip3HostBackend({ cacheDir, hostBin }),
});

const app = createRuntimeNodeApp({
  supervisor,
  invoker: createWasip3HostInvoker({ hostBin, kvStoreDir }),
  maxConcurrentInvocations: runtimeConcurrency,
  secretStore: secretDbPath
    ? createRepositorySecretStore(createSqliteRepository(secretDbPath))
    : createEnvSecretStore(),
});
await app.listen({ port, host });
if (controlPlaneUrl) {
  startRuntimeHeartbeat({
    controlPlaneUrl,
    runtimeNodeId,
    publicUrl,
    version: "wasmplane-runtime/0.1.0",
    capacity: {
      concurrentRequests: runtimeConcurrency,
      memoryMb: Number.parseInt(process.env.RUNTIME_MEMORY_MB ?? "4096", 10),
    },
    intervalMs: Number.parseInt(process.env.RUNTIME_HEARTBEAT_INTERVAL_MS ?? "30000", 10),
  });
}
console.log(`wasmplane ${MVP_WASI_PROFILE} runtime node listening on http://${host}:${port}`);
