import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { MVP_RUNTIME_BACKEND, MVP_WASI_PROFILE, type RuntimeNodeHostInfo } from "../control-plane/contracts.ts";
import { createConfiguredSecretCipherAsync } from "../control-plane/secret-encryption.ts";
import { createSqliteRepository } from "../control-plane/repository.ts";
import {
  createRuntimeArtifactStore,
  runtimeOciArtifactOptionsFromEnv,
  runtimeS3ArtifactOptionsFromEnv,
} from "./artifacts.ts";
import { startRuntimeHeartbeat } from "./heartbeat.ts";
import {
  parseProjectConcurrencyLimits,
  parseProjectRateLimits,
  parseRuntimeCacheGcIntervalMs,
  parseRuntimeCacheRetentionPolicy,
  parseRuntimeIdentityKeys,
  parseRuntimeLabels,
  resolveRuntimeIdentity,
  resolveRuntimeMemoryMb,
  resolveRuntimeNodeId,
  resolveRuntimePublicUrl,
  resolveRuntimeRegion,
} from "./config.ts";
import { createRuntimeNodeApp } from "./node-app.ts";
import { createOtlpHttpTraceExporter, parseOtlpHeaders } from "./otel.ts";
import { createEnvSecretStore, createRepositorySecretStore } from "./secrets.ts";
import { createRuntimeSupervisor } from "./supervisor.ts";
import {
  createWasip3HostBackend,
  createWasip3HostDaemonInvoker,
  createWasip3HostInvoker,
  wasip3HostDaemonPoolingRuntimeArgsFromEnv,
  wasip3HostDaemonRuntimeArgsFromEnv,
} from "./wasip3-host.ts";

const port = Number.parseInt(process.env.RUNTIME_PORT ?? "8788", 10);
const host = process.env.RUNTIME_HOST ?? "127.0.0.1";
const cacheDir = process.env.WASMPLANE_CACHE_DIR ?? ".wasmplane/cache";
const artifactCacheDir = process.env.WASMPLANE_ARTIFACT_CACHE_DIR ?? ".wasmplane/runtime-artifacts";
const kvStoreDir = process.env.WASMPLANE_KV_STORE_DIR ?? ".wasmplane/kv";
const hostBin = process.env.WASMPLANE_WASIP3_HOST_BIN ?? "target/debug/wasmplane-wasip3-host";
const hostDaemonEnabled = process.env.WASMPLANE_WASIP3_HOST_DAEMON === "1";
const hostDaemonPort = Number.parseInt(process.env.WASMPLANE_WASIP3_HOST_DAEMON_PORT ?? "8790", 10);
const hostDaemonUrl = process.env.WASMPLANE_WASIP3_HOST_DAEMON_URL
  ?? (hostDaemonEnabled ? `http://127.0.0.1:${hostDaemonPort}` : undefined);
const publicUrl = resolveRuntimePublicUrl(process.env, host, port);
const runtimeNodeId = resolveRuntimeNodeId(process.env, host, port);
const runtimeRegion = resolveRuntimeRegion(process.env);
const runtimeLabels = parseRuntimeLabels(process.env);
const runtimeIdentity = resolveRuntimeIdentity(process.env);
const runtimeIdentityKeys = parseRuntimeIdentityKeys(process.env);
const runtimeCacheRetention = parseRuntimeCacheRetentionPolicy(process.env);
const runtimeCacheGcIntervalMs = parseRuntimeCacheGcIntervalMs(process.env);
const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? process.env.WASMPLANE_CONTROL_PLANE_URL;
const controlPlaneToken = process.env.CONTROL_PLANE_TOKEN ?? process.env.WASMPLANE_CONTROL_PLANE_TOKEN;
const runtimeManagementToken = process.env.WASMPLANE_RUNTIME_TOKEN;
const secretDbPath = process.env.WASMPLANE_SECRET_DB;
const secretCipher = await createConfiguredSecretCipherAsync({ env: process.env });
const runtimeConcurrency = Number.parseInt(process.env.RUNTIME_CONCURRENCY ?? "128", 10);
const projectConcurrencyLimits = parseProjectConcurrencyLimits(process.env);
const projectRateLimits = parseProjectRateLimits(process.env);
const warmupOnSnapshot = process.env.RUNTIME_SNAPSHOT_WARMUP === "1";
const warmupConcurrency = Number.parseInt(process.env.RUNTIME_SNAPSHOT_WARMUP_CONCURRENCY ?? "4", 10);
const otlpTraceEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const hostDaemonPoolingArgs = wasip3HostDaemonPoolingRuntimeArgsFromEnv(process.env);
const hostDaemonServeArgs = wasip3HostDaemonRuntimeArgsFromEnv(process.env, hostDaemonPoolingArgs);
const precompiledCompileArgs = hostDaemonUrl ? hostDaemonPoolingArgs : [];
const runtimeVersion = "wasmplane-runtime/0.1.0";
const runtimeHostVersion = process.env.WASMPLANE_WASIP3_HOST_VERSION ?? "wasmplane-wasip3-host";
const runtimeEngineVariant = engineCacheVariant([
  runtimeHostVersion,
  await hostBinaryCacheKey(hostBin),
  ...precompiledCompileArgs,
]);
const runtimeHostInfo: RuntimeNodeHostInfo = {
  backend: MVP_RUNTIME_BACKEND,
  wasi: MVP_WASI_PROFILE,
  runtimeVersion,
  hostVersion: runtimeHostVersion,
  engineVariant: runtimeEngineVariant,
};

const supervisor = createRuntimeSupervisor({
  snapshot: {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    routes: [],
  },
  artifactStore: createRuntimeArtifactStore({
    cacheDir: artifactCacheDir,
    s3: runtimeS3ArtifactOptionsFromEnv(process.env),
    oci: runtimeOciArtifactOptionsFromEnv(process.env),
  }),
  warmupConcurrency: Number.isFinite(warmupConcurrency) && warmupConcurrency > 0 ? warmupConcurrency : 4,
  backend: createWasip3HostBackend({
    cacheDir,
    hostBin,
    compileArgs: precompiledCompileArgs.length > 0 ? precompiledCompileArgs : undefined,
    cacheVariant: runtimeEngineVariant,
  }),
});

if (hostDaemonEnabled) {
  await startWasip3HostDaemon({
    hostBin,
    port: hostDaemonPort,
    kvStoreDir,
    runtimeArgs: hostDaemonServeArgs,
  });
}

const app = createRuntimeNodeApp({
  supervisor,
  invoker: hostDaemonUrl
    ? createWasip3HostDaemonInvoker({ url: hostDaemonUrl })
    : createWasip3HostInvoker({ hostBin, kvStoreDir }),
  managementToken: runtimeManagementToken,
  managementIdentityKeys: runtimeIdentityKeys,
  maxConcurrentInvocations: runtimeConcurrency,
  maxConcurrentInvocationsByProject: projectConcurrencyLimits,
  requestRateLimitsByProject: projectRateLimits,
  cacheRetention: {
    artifactCacheDir,
    precompiledCacheDir: cacheDir,
    ...runtimeCacheRetention,
  },
  precompiledCacheEngineVariant: runtimeEngineVariant,
  cacheRetentionIntervalMs: runtimeCacheGcIntervalMs,
  warmupOnSnapshot,
  telemetry: otlpTraceEndpoint
    ? createOtlpHttpTraceExporter({
      endpoint: otlpTraceEndpoint,
      serviceName: process.env.OTEL_SERVICE_NAME ?? "wasmplane-runtime",
      serviceInstanceId: runtimeNodeId,
      headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    })
    : undefined,
  hostDaemonMetrics: hostDaemonUrl ? { url: hostDaemonUrl } : undefined,
  secretStore: secretDbPath
    ? createRepositorySecretStore(createSqliteRepository(secretDbPath), { secretCipher })
    : createEnvSecretStore(),
});
await app.listen({ port, host });
if (controlPlaneUrl) {
  startRuntimeHeartbeat({
    controlPlaneUrl,
    runtimeNodeId,
    publicUrl,
    token: controlPlaneToken,
    version: runtimeVersion,
    region: runtimeRegion,
    labels: runtimeLabels,
    identity: runtimeIdentity,
    host: runtimeHostInfo,
    capacity: {
      concurrentRequests: runtimeConcurrency,
      memoryMb: resolveRuntimeMemoryMb(process.env, 4096),
    },
    load: () => ({ activeRequests: app.metrics().invocations.active }),
    intervalMs: Number.parseInt(process.env.RUNTIME_HEARTBEAT_INTERVAL_MS ?? "30000", 10),
  });
}
console.log(`wasmplane ${MVP_WASI_PROFILE} runtime node listening on http://${host}:${port}`);

async function startWasip3HostDaemon(input: {
  hostBin: string;
  port: number;
  kvStoreDir: string;
  runtimeArgs: string[];
}): Promise<ChildProcess> {
  const child = spawn(input.hostBin, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--kv-store-dir",
    input.kvStoreDir,
    ...input.runtimeArgs,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  process.once("exit", () => child.kill());
  await waitForWasip3HostDaemon(`http://127.0.0.1:${input.port}`, child);
  return child;
}

function engineCacheVariant(args: string[]): string {
  const digest = createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 16);
  return `engine-${digest}`;
}

async function hostBinaryCacheKey(hostBin: string): Promise<string> {
  try {
    const info = await stat(hostBin);
    return `${hostBin}:${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch {
    return hostBin;
  }
}

async function waitForWasip3HostDaemon(url: string, child: ChildProcess): Promise<void> {
  const baseUrl = url.replace(/\/+$/, "");
  const deadline = Date.now() + 5000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`wasip3 host daemon did not become ready: ${lastError}`);
}
