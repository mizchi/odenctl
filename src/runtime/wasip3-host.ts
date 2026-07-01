import { constants } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import type {
  CommandRunner,
  CompileComponentRequest,
  CompiledComponent,
  InvokeComponentRequest,
  InvokeComponentResponse,
  RuntimeBackend,
  RuntimeInvoker,
} from "./types.ts";
import { createSpawnCommandRunner } from "./wasmtime.ts";

export interface Wasip3HostBackendOptions {
  cacheDir: string;
  hostBin?: string;
  hostArgsPrefix?: string[];
  compileArgs?: string[];
  cacheVariant?: string;
  wasmToolsBin?: string;
  witPath?: string;
  world?: typeof MVP_WORKER_WORLD;
  validateWorld?: boolean;
  commandRunner?: CommandRunner;
}

export interface Wasip3HostInvokerOptions {
  hostBin?: string;
  hostArgsPrefix?: string[];
  kvStoreDir?: string;
  commandRunner?: CommandRunner;
}

export interface Wasip3HostDaemonInvokerOptions {
  url: string;
  fetch?: typeof fetch;
}

export function wasip3HostDaemonRuntimeArgsFromEnv(
  env: Record<string, string | undefined>,
  poolingArgs: string[] = wasip3HostDaemonPoolingRuntimeArgsFromEnv(env),
): string[] {
  const args: string[] = [];
  appendOptionalArg(args, "--max-prepared-components", env.WASMPLANE_WASIP3_HOST_MAX_PREPARED_COMPONENTS);
  appendOptionalArg(args, "--max-concurrent-invocations", env.WASMPLANE_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS);
  appendOptionalArg(args, "--experimental-instance-reuse", env.WASMPLANE_WASIP3_EXPERIMENTAL_INSTANCE_REUSE);
  appendOptionalArg(args, "--instance-reuse-contract", env.WASMPLANE_WASIP3_INSTANCE_REUSE_CONTRACT);
  args.push(...poolingArgs);
  return args;
}

export function wasip3HostDaemonPoolingRuntimeArgsFromEnv(env: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  appendOptionalArg(
    args,
    "--pooling-total-component-instances",
    env.WASMPLANE_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES,
  );
  appendOptionalArg(args, "--pooling-memory-mb", env.WASMPLANE_WASIP3_POOLING_MEMORY_MB);
  appendOptionalArg(
    args,
    "--pooling-total-core-instances",
    env.WASMPLANE_WASIP3_POOLING_TOTAL_CORE_INSTANCES,
  );
  appendOptionalArg(args, "--pooling-total-memories", env.WASMPLANE_WASIP3_POOLING_TOTAL_MEMORIES);
  appendOptionalArg(args, "--pooling-total-tables", env.WASMPLANE_WASIP3_POOLING_TOTAL_TABLES);
  appendOptionalArg(args, "--pooling-table-elements", env.WASMPLANE_WASIP3_POOLING_TABLE_ELEMENTS);
  appendOptionalArg(
    args,
    "--pooling-component-instance-mb",
    env.WASMPLANE_WASIP3_POOLING_COMPONENT_INSTANCE_MB,
  );
  appendOptionalArg(args, "--pooling-core-instance-mb", env.WASMPLANE_WASIP3_POOLING_CORE_INSTANCE_MB);
  return args;
}

export function createWasip3HostBackend(options: Wasip3HostBackendOptions): RuntimeBackend {
  const hostBin = options.hostBin ?? "wasmplane-wasip3-host";
  const hostArgsPrefix = options.hostArgsPrefix ?? [];
  const compileArgs = options.compileArgs ?? [];
  const cacheVariant = options.cacheVariant ? `-${safePathFragment(options.cacheVariant)}` : "";
  const wasmToolsBin = options.wasmToolsBin ?? "wasm-tools";
  const witPath = options.witPath ?? join(process.cwd(), "wit/myedge-runtime.wit");
  const world = options.world ?? MVP_WORKER_WORLD;
  const validateWorld = options.validateWorld ?? false;
  const commandRunner = options.commandRunner ?? createSpawnCommandRunner();

  return {
    async compileComponent(request: CompileComponentRequest): Promise<CompiledComponent> {
      validateRequest(request, world);
      await mkdir(options.cacheDir, { recursive: true });

      const precompiledPath = join(
        options.cacheDir,
        `${safePathFragment(request.deploymentId)}-${digestFragment(request.artifact.digest)}${cacheVariant}.cwasm`,
      );
      if (await exists(precompiledPath)) {
        return compiledResult(request, precompiledPath, true);
      }

      const tmpPath = `${precompiledPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        if (validateWorld) {
          await commandRunner.run(
            wasmToolsBin,
            ["component", "targets", witPath, "--world", world, request.artifact.path],
            { timeoutMs: Math.max(1000, request.limits.wallMs * 2) },
          );
        }
        await commandRunner.run(
          hostBin,
          [
            ...hostArgsPrefix,
            "compile",
            "--component",
            request.artifact.path,
            "--out",
            tmpPath,
            ...compileArgs,
          ],
          { timeoutMs: Math.max(1000, request.limits.wallMs * 2) },
        );
        await rename(tmpPath, precompiledPath);
      } catch (error) {
        await unlink(tmpPath).catch(() => undefined);
        if (error instanceof RuntimeError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new RuntimeError("compile", message);
      }

      return compiledResult(request, precompiledPath, false);
    },
  };
}

export function createWasip3HostInvoker(options: Wasip3HostInvokerOptions = {}): RuntimeInvoker {
  const hostBin = options.hostBin ?? "wasmplane-wasip3-host";
  const hostArgsPrefix = options.hostArgsPrefix ?? [];
  const kvStoreDir = options.kvStoreDir;
  const commandRunner = options.commandRunner ?? createSpawnCommandRunner();

  return {
    async invoke(request: InvokeComponentRequest): Promise<InvokeComponentResponse> {
      try {
        const result = await commandRunner.run(hostBin, [
          ...hostArgsPrefix,
          "invoke",
          "--precompiled",
          request.component.precompiledPath,
          "--method",
          request.method,
          "--uri",
          request.uri,
          "--headers",
          JSON.stringify(request.headers),
          "--body",
          Buffer.from(request.body).toString("utf8"),
          ...invokePolicyArgs(request),
          ...kvStoreArgs(kvStoreDir),
        ], { timeoutMs: request.component.limits?.wallMs });
        return parseInvokeResponse(result.stdout);
      } catch (error) {
        if (
          error instanceof RuntimeError
          && (error.code === "invoke" || error.code === "timeout" || error.code === "cpu_limit")
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw classifyHostInvokeFailure(message);
      }
    },
  };
}

export function createWasip3HostDaemonInvoker(options: Wasip3HostDaemonInvokerOptions): RuntimeInvoker {
  const baseUrl = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  return {
    async invoke(request: InvokeComponentRequest): Promise<InvokeComponentResponse> {
      try {
        const response = await fetchImpl(`${baseUrl}/invoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            precompiled: request.component.precompiledPath,
            method: request.method,
            uri: request.uri,
            headers: request.headers,
            body: Buffer.from(request.body).toString("utf8"),
            limits: request.component.limits
              ? {
                wallMs: request.component.limits.wallMs,
                cpuMs: request.component.limits.cpuMs,
                memoryMb: request.component.limits.memoryMb,
                requestBytes: request.component.limits.requestBytes,
                responseBytes: request.component.limits.responseBytes,
                subrequests: request.component.limits.subrequests,
                hostCalls: request.component.limits.hostCalls,
              }
              : undefined,
            capabilities: request.component.capabilities,
          }),
        });
        const text = await response.text();
        if (!response.ok) {
          throw classifyHostInvokeFailure(daemonErrorMessage(text, response.status));
        }
        return parseInvokeResponse(text);
      } catch (error) {
        if (
          error instanceof RuntimeError
          && (error.code === "invoke" || error.code === "timeout" || error.code === "cpu_limit")
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw classifyHostInvokeFailure(message);
      }
    },
  };
}

function kvStoreArgs(kvStoreDir: string | undefined): string[] {
  return kvStoreDir ? ["--kv-store-dir", kvStoreDir] : [];
}

function invokePolicyArgs(request: InvokeComponentRequest): string[] {
  const args: string[] = [];
  if (request.component.limits) {
    args.push("--wall-ms", String(request.component.limits.wallMs));
    args.push("--cpu-ms", String(request.component.limits.cpuMs));
    args.push("--memory-mb", String(request.component.limits.memoryMb));
    args.push("--request-bytes", String(request.component.limits.requestBytes));
    args.push("--response-bytes", String(request.component.limits.responseBytes));
    args.push("--subrequests", String(request.component.limits.subrequests));
    args.push("--host-calls", String(request.component.limits.hostCalls));
  }
  if (request.component.capabilities) {
    args.push("--capabilities", JSON.stringify(request.component.capabilities));
  }
  return args;
}

function classifyHostInvokeFailure(message: string): RuntimeError {
  if (message.includes("cpuMs limit exceeded")) {
    return new RuntimeError("cpu_limit", message);
  }
  if (message.includes("wallMs limit exceeded")) {
    return new RuntimeError("timeout", message);
  }
  return new RuntimeError("invoke", message);
}

function parseInvokeResponse(stdout: string): InvokeComponentResponse {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new RuntimeError("invoke", "wasip3 host returned invalid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("invoke", "wasip3 host returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.status)) {
    throw new RuntimeError("invoke", "wasip3 host response missing integer status");
  }
  return {
    status: record.status as number,
    headers: parseHeaders(record.headers),
    body: Buffer.from(typeof record.body === "string" ? record.body : "", "utf8"),
    logs: parseLogs(record.logs),
  };
}

function parseLogs(value: unknown): InvokeComponentResponse["logs"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      ...(item.level === "debug" || item.level === "info" || item.level === "warn" || item.level === "error"
        ? { level: item.level }
        : {}),
      message: typeof item.message === "string" ? item.message : String(item.message ?? ""),
    }))
    .filter((item) => item.message.length > 0);
}

function daemonErrorMessage(text: string, status: number): string {
  try {
    const value = JSON.parse(text);
    const message = value?.error?.message;
    if (typeof message === "string") {
      return message;
    }
  } catch {
    // Fall through to the raw text/status fallback.
  }
  return `wasip3 host daemon returned ${status}${text ? `: ${text}` : ""}`;
}

function parseHeaders(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RuntimeError("invoke", "wasip3 host response headers must be an array");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new RuntimeError("invoke", "wasip3 host response header must be an object");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.value !== "string") {
      throw new RuntimeError("invoke", "wasip3 host response header must include name and value");
    }
    return { name: record.name, value: record.value };
  });
}

function validateRequest(request: CompileComponentRequest, world: typeof MVP_WORKER_WORLD) {
  if (request.runtime.backend !== "wasmtime") {
    throw new RuntimeError("unsupported", `unsupported runtime backend ${request.runtime.backend}`);
  }
  if (request.runtime.wasi !== MVP_WASI_PROFILE) {
    throw new RuntimeError("unsupported", `unsupported WASI profile ${request.runtime.wasi}`);
  }
  if (request.world !== world) {
    throw new RuntimeError("unsupported", `unsupported worker world ${request.world}`);
  }
}

function compiledResult(
  request: CompileComponentRequest,
  precompiledPath: string,
  cached: boolean,
): CompiledComponent {
  return {
    deploymentId: request.deploymentId,
    backend: "wasmtime",
    componentPath: request.artifact.path,
    precompiledPath,
    cached,
  };
}

function digestFragment(digest: string): string {
  const value = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return safePathFragment(value).slice(0, 64);
}

function safePathFragment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function appendOptionalArg(args: string[], flag: string, value: string | undefined) {
  if (value && value.trim().length > 0) {
    args.push(flag, value.trim());
  }
}
