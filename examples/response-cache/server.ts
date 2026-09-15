import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshot,
} from "../../crates/odenctl/src/control-plane/contracts.ts";
import { createRuntimeArtifactStore } from "../../crates/odenctl/src/runtime/artifacts.ts";
import { createRuntimeNodeApp } from "../../crates/odenctl/src/runtime/node-app.ts";
import { parseResponseCacheConfig } from "../../crates/odenctl/src/runtime/response-cache-policy.ts";
import { createRuntimeSupervisor } from "../../crates/odenctl/src/runtime/supervisor.ts";
import {
  createWasip3HostBackend,
  createWasip3HostInvoker,
} from "../../crates/odenctl/src/runtime/wasip3-host.ts";

const componentPath = fileURLToPath(
  new URL(
    "target/wasm32-wasip2/debug/response_cache_example.wasm",
    import.meta.url,
  ),
);
const digest = "sha256:" +
  createHash("sha256").update(await readFile(componentPath)).digest("hex");
const cachePolicy = parseResponseCacheConfig(
  JSON.parse(await readFile(new URL("cache.json", import.meta.url), "utf8")),
);
const hostBin = resolve(
  process.env.ODEN_WASIP3_HOST_BIN ?? "target/debug/oden-host",
);
const directory = await mkdtemp(join(tmpdir(), "odenctl-response-cache-"));
const target: Omit<
  RouteSnapshot["routes"][number],
  "host" | "pathPrefix" | "projectId" | "targets"
> = {
  deploymentId: "dep_cache_demo",
  world: MVP_WORKER_WORLD,
  worldVersion: MVP_WORKER_WORLD_VERSION,
  runtime: {
    backend: "wasmtime" as const,
    version: "48.0.2",
    wasi: MVP_WASI_PROFILE,
  },
  limits: {
    cpuMs: 5000,
    wallMs: 5000,
    memoryMb: 64,
    requestBytes: 1024,
    responseBytes: 1024,
    subrequests: 1,
  },
  capabilities: {
    outboundHttp: { enabled: false, allow: [] },
    secrets: [],
    kv: [],
    durableObjects: [],
    services: [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  },
  artifact: {
    id: "art_cache_demo",
    digest,
    location: pathToFileURL(componentPath).href,
  },
};
const snapshot: RouteSnapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  routes: [{
    ...target,
    host: "cache.example.local",
    pathPrefix: "/",
    projectId: "prj_cache_demo",
    targets: [{ ...target, weight: 100 }],
  }],
};
const supervisor = createRuntimeSupervisor({
  snapshot,
  artifactStore: createRuntimeArtifactStore({
    cacheDir: join(directory, "artifacts"),
  }),
  backend: createWasip3HostBackend({
    cacheDir: join(directory, "compiled"),
    hostBin,
  }),
});
const app = createRuntimeNodeApp({
  supervisor,
  initialRouteSnapshot: snapshot,
  responseCache: cachePolicy,
  invoker: createWasip3HostInvoker({ hostBin }),
  managementToken: process.env.ODEN_RUNTIME_TOKEN ?? "local-cache-demo",
});
try {
  await supervisor.warmupSnapshot(snapshot);
  const server = await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.RESPONSE_CACHE_PORT ?? 8080),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing listener address");
  }
  process.stderr.write(`listening on http://127.0.0.1:${address.port}\n`);
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
