import { MVP_WASI_PROFILE } from "../control-plane/contracts.ts";
import { createFileArtifactStore } from "./artifacts.ts";
import { createRuntimeNodeApp } from "./node-app.ts";
import { createRuntimeSupervisor } from "./supervisor.ts";
import { createWasip3HostBackend, createWasip3HostInvoker } from "./wasip3-host.ts";

const port = Number.parseInt(process.env.RUNTIME_PORT ?? "8788", 10);
const host = process.env.RUNTIME_HOST ?? "127.0.0.1";
const cacheDir = process.env.WASMPLANE_CACHE_DIR ?? ".wasmplane/cache";
const hostBin = process.env.WASMPLANE_WASIP3_HOST_BIN ?? "target/debug/wasmplane-wasip3-host";

const supervisor = createRuntimeSupervisor({
  snapshot: {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    routes: [],
  },
  artifactStore: createFileArtifactStore(),
  backend: createWasip3HostBackend({ cacheDir, hostBin }),
});

const app = createRuntimeNodeApp({
  supervisor,
  invoker: createWasip3HostInvoker({ hostBin }),
});
await app.listen({ port, host });
console.log(`wasmplane ${MVP_WASI_PROFILE} runtime node listening on http://${host}:${port}`);
