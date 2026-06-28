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

export function createWasip3HostBackend(options: Wasip3HostBackendOptions): RuntimeBackend {
  const hostBin = options.hostBin ?? "wasmplane-wasip3-host";
  const hostArgsPrefix = options.hostArgsPrefix ?? [];
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
        `${safePathFragment(request.deploymentId)}-${digestFragment(request.artifact.digest)}.cwasm`,
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
          "--component",
          request.component.componentPath,
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
        if (error instanceof RuntimeError && (error.code === "invoke" || error.code === "timeout")) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new RuntimeError("invoke", message);
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
  };
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
