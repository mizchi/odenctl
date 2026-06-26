import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type Artifact,
  type Deployment,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  CompileComponentRequest,
  CompiledComponent,
  RuntimeBackend,
} from "./types.ts";

export interface WasmtimeSupervisorSpec {
  backend: "wasmtime";
  componentModel: true;
  componentModelAsync: true;
  componentModelAsyncStackful: true;
  wasi: typeof MVP_WASI_PROFILE;
  component: {
    digest: string;
    location: string;
    path?: string;
  };
  worker: {
    deploymentId: string;
    world: "myedge:runtime/worker@0.1.0";
  };
  limits?: Deployment["limits"];
}

export function createWasmtimeSupervisorSpec(
  deployment: Deployment,
  artifact: Artifact,
): WasmtimeSupervisorSpec {
  return {
    backend: "wasmtime",
    componentModel: true,
    componentModelAsync: true,
    componentModelAsyncStackful: true,
    wasi: MVP_WASI_PROFILE,
    component: {
      digest: artifact.digest,
      location: artifact.location,
    },
    worker: {
      deploymentId: deployment.id,
      world: deployment.world,
    },
    limits: deployment.limits,
  };
}

export interface WasmtimeCliBackendOptions {
  cacheDir: string;
  wasmtimeBin?: string;
  wasmToolsBin?: string;
  witPath?: string;
  world?: typeof MVP_WORKER_WORLD;
  validateWorld?: boolean;
  commandRunner?: CommandRunner;
}

export function createWasmtimeCliBackend(options: WasmtimeCliBackendOptions): RuntimeBackend {
  const wasmtimeBin = options.wasmtimeBin ?? "wasmtime";
  const wasmToolsBin = options.wasmToolsBin ?? "wasm-tools";
  const witPath = options.witPath ?? join(process.cwd(), "wit/myedge-runtime.wit");
  const world = options.world ?? MVP_WORKER_WORLD;
  const validateWorld = options.validateWorld ?? true;
  const commandRunner = options.commandRunner ?? createSpawnCommandRunner();

  return {
    async compileComponent(request: CompileComponentRequest): Promise<CompiledComponent> {
      if (request.runtime.backend !== "wasmtime") {
        throw new RuntimeError("unsupported", `unsupported runtime backend ${request.runtime.backend}`);
      }
      if (request.runtime.wasi !== MVP_WASI_PROFILE) {
        throw new RuntimeError("unsupported", `unsupported WASI profile ${request.runtime.wasi}`);
      }
      if (request.world !== world) {
        throw new RuntimeError("unsupported", `unsupported worker world ${request.world}`);
      }

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
          wasmtimeBin,
          [
            "compile",
            "-W",
            "component-model=y",
            "-W",
            "component-model-async=y",
            "-W",
            "component-model-async-stackful=y",
            "-o",
            tmpPath,
            request.artifact.path,
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

export function createWasmtimeSupervisorSpecFromRequest(
  request: CompileComponentRequest,
): WasmtimeSupervisorSpec {
  return {
    backend: "wasmtime",
    componentModel: true,
    componentModelAsync: true,
    componentModelAsyncStackful: true,
    wasi: MVP_WASI_PROFILE,
    component: {
      digest: request.artifact.digest,
      location: request.artifact.location,
      path: request.artifact.path,
    },
    worker: {
      deploymentId: request.deploymentId,
      world: request.world,
    },
    limits: request.limits,
  };
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

export function createSpawnCommandRunner(): CommandRunner {
  return {
    run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timeout: NodeJS.Timeout | undefined;

        if (options.timeoutMs) {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new RuntimeError("compile", `${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs);
        }

        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.on("error", (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(new RuntimeError("compile", `${command} failed to start: ${error.message}`));
        });
        child.on("close", (code) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          const result = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
          if (code === 0) {
            resolve(result);
            return;
          }
          reject(new RuntimeError("compile", `${command} exited with ${code}: ${result.stderr}`));
        });
      });
    },
  };
}
