import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type RouteSnapshot,
} from "../src/control-plane/contracts.ts";
import {
  createFileArtifactStore,
  createRuntimeArtifactStore,
  runtimeS3ArtifactOptionsFromEnv,
} from "../src/runtime/artifacts.ts";
import { createRouteCache, createRuntimeSupervisor } from "../src/runtime/supervisor.ts";
import {
  createWasip3HostBackend,
  createWasip3HostDaemonInvoker,
  createWasip3HostInvoker,
} from "../src/runtime/wasip3-host.ts";
import { createWasmtimeCliBackend } from "../src/runtime/wasmtime.ts";

const execFileAsync = promisify(execFile);

test("route cache resolves exact host with longest path prefix", () => {
  const cache = createRouteCache(
    snapshot([
      route("dep_root", "hello.example.dev", "/", digest("root"), "file:///tmp/root.wasm"),
      route("dep_api", "hello.example.dev", "/api", digest("api"), "file:///tmp/api.wasm"),
    ]),
  );

  assert.equal(cache.match({ host: "HELLO.EXAMPLE.DEV", path: "/api/users" })?.deploymentId, "dep_api");
  assert.equal(cache.match({ host: "hello.example.dev", path: "/api" })?.deploymentId, "dep_api");
  assert.equal(cache.match({ host: "hello.example.dev", path: "/apix" })?.deploymentId, "dep_root");
  assert.equal(cache.match({ host: "other.example.dev", path: "/api/users" }), undefined);
});

test("runtime supervisor materializes artifacts and compiles each deployment once", async () => {
  const calls: string[] = [];
  const artifactPath = "/tmp/hello.component.wasm";
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([
      route("dep_root", "hello.example.dev", "/", digest("root"), `file://${artifactPath}`),
      route("dep_api", "hello.example.dev", "/api", digest("api"), `file://${artifactPath}`),
    ]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: artifactPath,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        calls.push(request.deploymentId);
        assert.equal(request.world, MVP_WORKER_WORLD);
        assert.equal(request.runtime.backend, "wasmtime");
        assert.equal(request.artifact.path, artifactPath);
        assert.equal(request.capabilities.arbitrarySockets, false);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });

  const first = await supervisor.prepareRoute({ host: "hello.example.dev", path: "/api/users" });
  const second = await supervisor.prepareRoute({ host: "hello.example.dev", path: "/api/status" });

  assert.equal(first.deploymentId, "dep_api");
  assert.equal(second.deploymentId, "dep_api");
  assert.deepEqual(calls, ["dep_api"]);
});

test("runtime supervisor can warm up every deployment target in a snapshot", async () => {
  const calls: string[] = [];
  const baseRoute = route("dep_blue", "hello.example.dev", "/", digest("blue"), "file:///tmp/blue.wasm");
  baseRoute.targets = [
    snapshotTarget("dep_blue", 90, digest("blue"), "file:///tmp/blue.wasm"),
    snapshotTarget("dep_green", 10, digest("green"), "file:///tmp/green.wasm"),
  ];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: new URL(artifact.location).pathname,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        calls.push(request.deploymentId);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });

  await supervisor.warmupSnapshot(snapshot([baseRoute]));
  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/a" });
  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/b" });

  assert.deepEqual(new Set(calls), new Set(["dep_blue", "dep_green"]));
  assert.equal(calls.length, 2);
});

test("runtime supervisor limits concurrent snapshot warmup work", async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([]),
    warmupConcurrency: 2,
    artifactStore: {
      async materialize(artifact) {
        return {
          path: new URL(artifact.location).pathname,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        started.push(request.deploymentId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });

  const warming = supervisor.warmupSnapshot(snapshot([
    route("dep_1", "one.example.dev", "/", digest("one"), "file:///tmp/one.wasm"),
    route("dep_2", "two.example.dev", "/", digest("two"), "file:///tmp/two.wasm"),
    route("dep_3", "three.example.dev", "/", digest("three"), "file:///tmp/three.wasm"),
  ]));

  await waitFor(() => started.length >= 2);
  assert.equal(started.length, 2);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => started.length === 3);
  releases.splice(0).forEach((release) => release());
  await warming;

  assert.equal(maxActive, 2);
  assert.deepEqual(new Set(started), new Set(["dep_1", "dep_2", "dep_3"]));
});

test("runtime supervisor uses the latest loaded route snapshot", () => {
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([
      route("dep_v1", "hello.example.dev", "/", digest("v1"), "file:///tmp/v1.wasm"),
    ]),
    artifactStore: {
      async materialize() {
        throw new Error("not used");
      },
    },
    backend: {
      async compileComponent() {
        throw new Error("not used");
      },
    },
  });

  assert.equal(supervisor.matchRoute({ host: "hello.example.dev", path: "/" })?.deploymentId, "dep_v1");

  supervisor.loadSnapshot(
    snapshot([
      route("dep_v2", "hello.example.dev", "/", digest("v2"), "file:///tmp/v2.wasm"),
    ]),
  );

  assert.equal(supervisor.matchRoute({ host: "hello.example.dev", path: "/" })?.deploymentId, "dep_v2");
});

test("runtime supervisor prunes prepared deployments removed by a new snapshot", async () => {
  const calls: string[] = [];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([
      route("dep_v1", "hello.example.dev", "/", digest("v1"), "file:///tmp/v1.wasm"),
    ]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: new URL(artifact.location).pathname,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        calls.push(request.deploymentId);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });

  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/" });
  supervisor.loadSnapshot(
    snapshot([
      route("dep_v2", "hello.example.dev", "/", digest("v2"), "file:///tmp/v2.wasm"),
    ]),
  );
  supervisor.loadSnapshot(
    snapshot([
      route("dep_v1", "hello.example.dev", "/", digest("v1"), "file:///tmp/v1.wasm"),
    ]),
  );
  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/" });

  assert.deepEqual(calls, ["dep_v1", "dep_v1"]);
});

test("runtime supervisor selects weighted rollout targets deterministically", async () => {
  const calls: string[] = [];
  const baseRoute = route("dep_blue", "hello.example.dev", "/", digest("blue"), "file:///tmp/blue.wasm");
  baseRoute.targets = [
    snapshotTarget("dep_blue", 1, digest("blue"), "file:///tmp/blue.wasm"),
    snapshotTarget("dep_green", 1, digest("green"), "file:///tmp/green.wasm"),
  ];
  const supervisor = createRuntimeSupervisor({
    snapshot: snapshot([baseRoute]),
    artifactStore: {
      async materialize(artifact) {
        return {
          path: new URL(artifact.location).pathname,
          digest: artifact.digest,
          location: artifact.location,
          verified: true,
        };
      },
    },
    backend: {
      async compileComponent(request) {
        calls.push(request.deploymentId);
        return {
          deploymentId: request.deploymentId,
          backend: "wasmtime",
          componentPath: request.artifact.path,
          precompiledPath: `/cache/${request.deploymentId}.cwasm`,
          cached: false,
        };
      },
    },
  });

  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/a" });
  await supervisor.prepareRoute({ host: "hello.example.dev", path: "/b" });

  assert.deepEqual(new Set(calls), new Set(["dep_blue", "dep_green"]));
});

test("file artifact store verifies sha256 digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-artifact-"));
  const artifactPath = join(dir, "component.wasm");
  await writeFile(artifactPath, Buffer.from("component bytes"));
  const body = await readFile(artifactPath);
  const expectedDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const store = createFileArtifactStore();

  const materialized = await store.materialize({
    id: "art_1",
    digest: expectedDigest,
    location: pathToFileURL(artifactPath).href,
  });

  assert.equal(materialized.path, artifactPath);
  assert.equal(materialized.verified, true);

  await assert.rejects(
    () =>
      store.materialize({
        id: "art_1",
        digest: digest("wrong"),
        location: pathToFileURL(artifactPath).href,
      }),
    /digest mismatch/,
  );
});

test("runtime artifact store materializes remote HTTP artifacts into a verified cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-remote-artifact-"));
  const bytes = Buffer.from("remote component bytes");
  const artifactDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const fetches: string[] = [];
  const store = createRuntimeArtifactStore({
    cacheDir: join(dir, "cache"),
    fetch: async (url) => {
      fetches.push(url);
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return bytes.toString("utf8");
        },
      };
    },
  });

  const first = await store.materialize({
    id: "art_remote",
    digest: artifactDigest,
    location: "https://artifacts.example.dev/workers/hello.component.wasm",
  });
  const second = await store.materialize({
    id: "art_remote",
    digest: artifactDigest,
    location: "https://artifacts.example.dev/workers/hello.component.wasm",
  });

  assert.equal(first.path, second.path);
  assert.equal(first.verified, true);
  assert.equal(first.location, "https://artifacts.example.dev/workers/hello.component.wasm");
  assert.equal((await readFile(first.path)).toString("utf8"), "remote component bytes");
  assert.deepEqual(fetches, ["https://artifacts.example.dev/workers/hello.component.wasm"]);
});

test("runtime artifact store rejects remote artifacts with digest mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-remote-artifact-bad-"));
  const store = createRuntimeArtifactStore({
    cacheDir: join(dir, "cache"),
    fetch: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return Buffer.from("tampered").buffer;
      },
      async text() {
        return "tampered";
      },
    }),
  });

  await assert.rejects(
    () =>
      store.materialize({
        id: "art_remote",
        digest: digest("expected"),
        location: "https://artifacts.example.dev/workers/hello.component.wasm",
      }),
    /digest mismatch/,
  );
});

test("runtime artifact store materializes private S3 artifacts with SigV4 GET", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-s3-artifact-"));
  const bytes = Buffer.from("private s3 component bytes");
  const artifactDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = createRuntimeArtifactStore({
    cacheDir: join(dir, "cache"),
    s3: {
      endpoint: "https://r2.example.com",
      region: "auto",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      now: () => new Date("2026-06-30T10:00:00.000Z"),
    },
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return bytes.toString("utf8");
        },
      };
    },
  });

  const first = await store.materialize({
    id: "art_s3",
    digest: artifactDigest,
    location: "s3://wasmplane-artifacts/workers/hello.component.wasm",
  });
  const second = await store.materialize({
    id: "art_s3",
    digest: artifactDigest,
    location: "s3://wasmplane-artifacts/workers/hello.component.wasm",
  });

  assert.equal(first.path, second.path);
  assert.equal(first.verified, true);
  assert.equal(first.location, "s3://wasmplane-artifacts/workers/hello.component.wasm");
  assert.equal((await readFile(first.path)).toString("utf8"), "private s3 component bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://r2.example.com/wasmplane-artifacts/workers/hello.component.wasm");
  assert.equal(calls[0].init.method, "GET");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("host"), "r2.example.com");
  assert.equal(headers.get("x-amz-content-sha256"), createHash("sha256").update("").digest("hex"));
  assert.equal(headers.get("x-amz-date"), "20260630T100000Z");
  assert.match(
    headers.get("authorization") ?? "",
    /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260630\/auto\/s3\/aws4_request,/,
  );
});

test("runtime artifact store rejects S3 artifacts without matching runtime config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-s3-artifact-unconfigured-"));
  const store = createRuntimeArtifactStore({
    cacheDir: join(dir, "cache"),
  });

  await assert.rejects(
    () =>
      store.materialize({
        id: "art_s3",
        digest: digest("expected"),
        location: "s3://wasmplane-artifacts/workers/hello.component.wasm",
      }),
    /S3 artifact materialization is not configured/,
  );
});

test("runtime artifact store enforces configured S3 bucket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-s3-artifact-bucket-"));
  const store = createRuntimeArtifactStore({
    cacheDir: join(dir, "cache"),
    s3: {
      bucket: "allowed-artifacts",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
  });

  await assert.rejects(
    () =>
      store.materialize({
        id: "art_s3",
        digest: digest("expected"),
        location: "s3://other-artifacts/workers/hello.component.wasm",
      }),
    /S3 artifact bucket mismatch/,
  );
});

test("runtime S3 artifact config reads artifact and AWS environment variables", () => {
  const config = runtimeS3ArtifactOptionsFromEnv({
    WASMPLANE_ARTIFACT_BUCKET: "wasmplane-artifacts",
    WASMPLANE_ARTIFACT_ENDPOINT: "https://r2.example.com",
    WASMPLANE_ARTIFACT_REGION: "auto",
    AWS_ACCESS_KEY_ID: "aws-access-key",
    AWS_SECRET_ACCESS_KEY: "aws-secret-key",
    AWS_SESSION_TOKEN: "aws-session-token",
  });

  assert.deepEqual(config, {
    bucket: "wasmplane-artifacts",
    endpoint: "https://r2.example.com",
    region: "auto",
    accessKeyId: "aws-access-key",
    secretAccessKey: "aws-secret-key",
    sessionToken: "aws-session-token",
  });
});

test("wasmtime CLI backend precompiles async component artifacts and reuses cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-wasmtime-"));
  const componentPath = await buildAsyncWorkerComponent(dir);
  const componentBytes = await readFile(componentPath);
  const componentDigest = `sha256:${createHash("sha256").update(componentBytes).digest("hex")}`;
  const cacheDir = join(dir, "cache");
  const backend = createWasmtimeCliBackend({ cacheDir });

  const first = await backend.compileComponent({
    deploymentId: "dep_worker",
    projectId: "prj_worker",
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      path: componentPath,
      digest: componentDigest,
      location: pathToFileURL(componentPath).href,
      verified: true,
    },
  });
  const firstStat = await stat(first.precompiledPath);

  const second = await backend.compileComponent({
    deploymentId: "dep_worker",
    projectId: "prj_worker",
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      path: componentPath,
      digest: componentDigest,
      location: pathToFileURL(componentPath).href,
      verified: true,
    },
  });
  const secondStat = await stat(second.precompiledPath);

  assert.equal(first.backend, "wasmtime");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.precompiledPath, first.precompiledPath);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
});

test("wasmtime CLI backend validates components against the wasip3 worker world before compiling", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-wasip3-validation-"));
  const componentPath = join(dir, "worker.component.wasm");
  const cacheDir = join(dir, "cache");
  await writeFile(componentPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

  const backend = createWasmtimeCliBackend({
    cacheDir,
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "wasmtime") {
          const outputIndex = args.indexOf("-o") + 1;
          await writeFile(args[outputIndex], Buffer.from("compiled"));
        }
        return { stdout: "", stderr: "" };
      },
    },
  });

  await backend.compileComponent({
    deploymentId: "dep_worker",
    projectId: "prj_worker",
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      path: componentPath,
      digest: digest("component"),
      location: pathToFileURL(componentPath).href,
      verified: true,
    },
  });

  assert.equal(calls[0]?.command, "wasm-tools");
  assert.deepEqual(calls[0]?.args.slice(0, 5), [
    "component",
    "targets",
    join(process.cwd(), "wit/myedge-runtime.wit"),
    "--world",
    MVP_WORKER_WORLD,
  ]);
  assert.equal(calls[0]?.args.at(-1), componentPath);
  assert.equal(calls[1]?.command, "wasmtime");
  assert.ok(calls[1]?.args.includes("component-model-async=y"));
  assert.ok(calls[1]?.args.includes("component-model-async-stackful=y"));
});

test("wasip3 host backend delegates precompile to the Rust host by default", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-rust-host-backend-"));
  const componentPath = join(dir, "worker.component.wasm");
  const cacheDir = join(dir, "cache");
  await writeFile(componentPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

  const backend = createWasip3HostBackend({
    cacheDir,
    hostBin: "wasmplane-wasip3-host",
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "wasmplane-wasip3-host") {
          const outputIndex = args.indexOf("--out") + 1;
          await writeFile(args[outputIndex], Buffer.from("compiled by rust host"));
        }
        return { stdout: "", stderr: "" };
      },
    },
  });

  const compiled = await backend.compileComponent(compileRequest(componentPath, digest("component")));

  assert.equal(compiled.deploymentId, "dep_worker");
  assert.equal(compiled.cached, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "wasmplane-wasip3-host");
  assert.deepEqual(calls[0]?.args.slice(0, 4), ["compile", "--component", componentPath, "--out"]);
  assert.ok(calls[0]?.args[4].startsWith(`${compiled.precompiledPath}.tmp-${process.pid}-`));
});

test("wasip3 host backend can run strict WIT target validation when requested", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-rust-host-validation-"));
  const componentPath = join(dir, "worker.component.wasm");
  const cacheDir = join(dir, "cache");
  await writeFile(componentPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

  const backend = createWasip3HostBackend({
    cacheDir,
    hostBin: "wasmplane-wasip3-host",
    validateWorld: true,
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "wasmplane-wasip3-host") {
          const outputIndex = args.indexOf("--out") + 1;
          await writeFile(args[outputIndex], Buffer.from("compiled by rust host"));
        }
        return { stdout: "", stderr: "" };
      },
    },
  });

  await backend.compileComponent(compileRequest(componentPath, digest("component")));

  assert.equal(calls[0]?.command, "wasm-tools");
  assert.deepEqual(calls[0]?.args.slice(0, 5), [
    "component",
    "targets",
    join(process.cwd(), "wit/myedge-runtime.wit"),
    "--world",
    MVP_WORKER_WORLD,
  ]);
  assert.equal(calls[1]?.command, "wasmplane-wasip3-host");
});

test("wasip3 host backend includes engine variant in cache path and compile args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-wasip3-variant-"));
  const componentPath = join(dir, "worker.component.wasm");
  await writeFile(componentPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const calls: Array<{ command: string; args: string[] }> = [];
  const backend = createWasip3HostBackend({
    cacheDir: dir,
    hostBin: "wasmplane-wasip3-host",
    cacheVariant: "pooling-64x64mb",
    compileArgs: ["--pooling-total-component-instances", "64", "--pooling-memory-mb", "64"],
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        const outputIndex = args.indexOf("--out") + 1;
        await writeFile(args[outputIndex], Buffer.from("compiled by rust host"));
        return { stdout: "{}", stderr: "" };
      },
    },
  });

  const compiled = await backend.compileComponent(compileRequest(componentPath, digest("component")));

  assert.match(compiled.precompiledPath, /pooling-64x64mb\.cwasm$/);
  assert.deepEqual(calls[0]?.args.slice(-4), [
    "--pooling-total-component-instances",
    "64",
    "--pooling-memory-mb",
    "64",
  ]);
});

test("wasip3 host invoker delegates HTTP requests to the Rust host invoke command", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const invoker = createWasip3HostInvoker({
    hostBin: "wasmplane-wasip3-host",
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            status: 201,
            headers: [{ name: "content-type", value: "text/plain" }],
            body: "created",
          }),
          stderr: "",
        };
      },
    },
  });

  const response = await invoker.invoke({
    deploymentId: "dep_worker",
    component: {
      deploymentId: "dep_worker",
      backend: "wasmtime",
      componentPath: "/tmp/worker.component.wasm",
      precompiledPath: "/tmp/worker.component.cwasm",
      cached: false,
      projectId: "prj_worker",
      limits: {
        cpuMs: 50,
        memoryMb: 64,
        wallMs: 1000,
        requestBytes: 1048576,
        subrequests: 20,
        hostCalls: 100,
        responseBytes: 1048576,
      },
      capabilities: {
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [{ binding: "API_KEY", secretId: "sec_api_key", value: "super-secret" }],
        arbitraryFilesystem: false,
        arbitrarySockets: false,
        processSpawn: false,
      },
    },
    method: "POST",
    uri: "http://hello.example.dev/api",
    headers: [{ name: "content-type", value: "text/plain" }],
    body: Buffer.from("payload"),
  });

  assert.equal(response.status, 201);
  assert.equal(Buffer.from(response.body).toString("utf8"), "created");
  assert.equal(calls[0]?.command, "wasmplane-wasip3-host");
  assert.deepEqual(calls[0]?.args, [
    "invoke",
    "--precompiled",
    "/tmp/worker.component.cwasm",
    "--method",
    "POST",
    "--uri",
    "http://hello.example.dev/api",
    "--headers",
    JSON.stringify([{ name: "content-type", value: "text/plain" }]),
    "--body",
    "payload",
    "--wall-ms",
    "1000",
    "--memory-mb",
    "64",
    "--request-bytes",
    "1048576",
    "--response-bytes",
    "1048576",
    "--subrequests",
    "20",
    "--host-calls",
    "100",
    "--capabilities",
    JSON.stringify({
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key", value: "super-secret" }],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    }),
  ]);
});

test("wasip3 host daemon invoker sends requests to the embedded host service", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const invoker = createWasip3HostDaemonInvoker({
    url: "http://127.0.0.1:8790/",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        status: 202,
        headers: [{ name: "x-host", value: "daemon" }],
        body: "accepted",
      }), { status: 200 });
    },
  });

  const response = await invoker.invoke({
    deploymentId: "dep_worker",
    component: {
      deploymentId: "dep_worker",
      backend: "wasmtime",
      componentPath: "/tmp/worker.component.wasm",
      precompiledPath: "/tmp/worker.component.cwasm",
      cached: true,
      projectId: "prj_worker",
      limits: {
        cpuMs: 50,
        memoryMb: 64,
        wallMs: 1000,
        requestBytes: 1048576,
        subrequests: 20,
        hostCalls: 100,
        responseBytes: 1048576,
      },
      capabilities: {
        outboundHttp: { enabled: false, allow: [] },
        kv: [],
        secrets: [],
        arbitraryFilesystem: false,
        arbitrarySockets: false,
        processSpawn: false,
      },
    },
    method: "POST",
    uri: "http://hello.example.dev/api",
    headers: [{ name: "content-type", value: "text/plain" }],
    body: Buffer.from("payload"),
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers[0]?.value, "daemon");
  assert.equal(Buffer.from(response.body).toString("utf8"), "accepted");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8790/invoke");
  assert.deepEqual(calls[0]?.body, {
    precompiled: "/tmp/worker.component.cwasm",
    method: "POST",
    uri: "http://hello.example.dev/api",
    headers: [{ name: "content-type", value: "text/plain" }],
    body: "payload",
    limits: {
      wallMs: 1000,
      memoryMb: 64,
      requestBytes: 1048576,
      responseBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
  });
});

test("wasip3 host daemon invoker reports daemon failures as invoke errors", async () => {
  const invoker = createWasip3HostDaemonInvoker({
    url: "http://127.0.0.1:8790",
    fetch: async () =>
      new Response(JSON.stringify({
        error: { code: "invoke", message: "guest trapped" },
      }), { status: 500 }),
  });

  await assert.rejects(
    () =>
      invoker.invoke({
        deploymentId: "dep_worker",
        component: {
          deploymentId: "dep_worker",
          backend: "wasmtime",
          componentPath: "/tmp/worker.component.wasm",
          precompiledPath: "/tmp/worker.component.cwasm",
          cached: true,
        },
        method: "GET",
        uri: "http://hello.example.dev/",
        headers: [],
        body: Buffer.from(""),
      }),
    (error: any) => error?.code === "invoke" && /guest trapped/.test(error.message),
  );
});

test("wasip3 host invoker passes a persistent KV store directory", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const invoker = createWasip3HostInvoker({
    hostBin: "wasmplane-wasip3-host",
    kvStoreDir: "/tmp/wasmplane-kv",
    commandRunner: {
      async run(command, args) {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({ status: 200, headers: [], body: "ok" }),
          stderr: "",
        };
      },
    },
  });

  await invoker.invoke({
    deploymentId: "dep_worker",
    component: {
      deploymentId: "dep_worker",
      backend: "wasmtime",
      componentPath: "/tmp/worker.component.wasm",
      precompiledPath: "/tmp/worker.component.cwasm",
      cached: false,
      projectId: "prj_worker",
      limits: compileRequest("/tmp/worker.component.wasm", digest("component")).limits,
      capabilities: compileRequest("/tmp/worker.component.wasm", digest("component")).capabilities,
    },
    method: "GET",
    uri: "http://hello.example.dev/",
    headers: [],
    body: Buffer.from(""),
  });

  assert.equal(calls[0]?.command, "wasmplane-wasip3-host");
  assert.deepEqual(calls[0]?.args.slice(-2), ["--kv-store-dir", "/tmp/wasmplane-kv"]);
});

test("wasip3 host invoker reports host command failures as invoke errors", async () => {
  const invoker = createWasip3HostInvoker({
    commandRunner: {
      async run() {
        throw new Error("guest trapped");
      },
    },
  });

  await assert.rejects(
    () =>
      invoker.invoke({
        deploymentId: "dep_worker",
        component: {
          deploymentId: "dep_worker",
          backend: "wasmtime",
          componentPath: "/tmp/worker.component.wasm",
          precompiledPath: "/tmp/worker.component.cwasm",
          cached: false,
        },
        method: "GET",
        uri: "http://hello.example.dev/",
        headers: [],
        body: Buffer.from(""),
      }),
    (error: any) => error?.code === "invoke" && /guest trapped/.test(error.message),
  );
});

async function buildAsyncWorkerComponent(dir: string): Promise<string> {
  const corePath = join(dir, "worker.core.wasm");
  const componentPath = join(dir, "worker.component.wasm");
  await execFileAsync("wasm-tools", [
    "component",
    "embed",
    join(process.cwd(), "wit/myedge-runtime.wit"),
    "--world",
    "worker",
    "--dummy-names",
    "legacy",
    "--async-stackful",
    "-o",
    corePath,
  ]);
  await execFileAsync("wasm-tools", [
    "component",
    "new",
    "--skip-validation",
    corePath,
    "-o",
    componentPath,
  ]);
  return componentPath;
}

function compileRequest(componentPath: string, componentDigest: string) {
  return {
    deploymentId: "dep_worker",
    projectId: "prj_worker",
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      path: componentPath,
      digest: componentDigest,
      location: pathToFileURL(componentPath).href,
      verified: true,
    },
  };
}

function snapshot(routes: RouteSnapshot["routes"]): RouteSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes,
  };
}

function route(
  deploymentId: string,
  host: string,
  pathPrefix: string,
  artifactDigest: string,
  location: string,
): RouteSnapshot["routes"][number] {
  return {
    host,
    pathPrefix,
    projectId: "prj_hello",
    deploymentId,
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      id: `art_${deploymentId}`,
      digest: artifactDigest,
      location,
    },
  };
}

function snapshotTarget(
  deploymentId: string,
  weight: number,
  artifactDigest: string,
  location: string,
): RouteSnapshot["routes"][number]["targets"][number] {
  return {
    deploymentId,
    weight,
    world: MVP_WORKER_WORLD,
    runtime: { backend: "wasmtime", version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      secrets: [],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
    artifact: {
      id: `art_${deploymentId}`,
      digest: artifactDigest,
      location,
    },
  };
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met before timeout");
}
