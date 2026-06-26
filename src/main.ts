import { createControlPlane } from "./control-plane/service.ts";
import { createSqliteRepository } from "./control-plane/repository.ts";
import { runtimeNodeTargetsFromEnv } from "./control-plane/snapshot-publisher.ts";
import { createHttpApp } from "./http/app.ts";

const dbPath = process.env.WASMPLANE_DB ?? "wasmplane.sqlite";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const artifactStoreDir = process.env.WASMPLANE_ARTIFACT_DIR ?? ".wasmplane/artifacts";

const controlPlane = createControlPlane({
  repository: createSqliteRepository(dbPath),
});
const app = createHttpApp({
  controlPlane,
  artifactStoreDir,
  runtimeNodes: runtimeNodeTargetsFromEnv(process.env.WASMPLANE_RUNTIME_NODES),
});

await app.listen({ port, host });
console.log(`wasmplane control plane listening on http://${host}:${port}`);
