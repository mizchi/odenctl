import { constants } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type CapabilityPolicy,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshot,
  type RuntimeLimits,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import { decodeWireBody, encodeWireBody } from "./wire-body.ts";
import type {
  CommandRunner,
  CompileComponentRequest,
  CompiledComponent,
  InvokeComponentRequest,
  InvokeComponentResponse,
  RuntimeHeader,
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
  commandRunner?: CommandRunner;
}

export interface Wasip3HostDaemonInvokerOptions {
  url: string;
  fetch?: typeof fetch;
}

export interface Wasip3HostDaemonRoutePublisherOptions {
  url: string;
  fetch?: typeof fetch;
}

export interface Wasip3HostDaemonWorkerProxyOptions {
  url: string;
  fetch?: typeof fetch;
}

export interface Wasip3HostDaemonWorkerProxyRequest {
  method: string;
  path: string;
  headers: RuntimeHeader[];
  body: Uint8Array;
}

export interface Wasip3HostDaemonRouteTablePayload {
  schemaVersion: 1;
  routes: Wasip3HostDaemonRoutePayload[];
}

export interface Wasip3HostDaemonRoutePayload {
  host: string;
  pathPrefix: string;
  projectId: string;
  deploymentId: string;
  precompiled: string;
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: { backend: "wasmtime"; version: string; wasi: typeof MVP_WASI_PROFILE };
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  targets?: Wasip3HostDaemonRouteTargetPayload[];
}

export interface Wasip3HostDaemonRouteTargetPayload {
  deploymentId: string;
  weight: number;
  precompiled: string;
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: { backend: "wasmtime"; version: string; wasi: typeof MVP_WASI_PROFILE };
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
}

export function wasip3HostDaemonRuntimeArgsFromEnv(
  env: Record<string, string | undefined>,
  poolingArgs: string[] = wasip3HostDaemonPoolingRuntimeArgsFromEnv(env),
): string[] {
  const args: string[] = [];
  appendOptionalArg(args, "--max-prepared-components", env.ODEN_WASIP3_HOST_MAX_PREPARED_COMPONENTS);
  appendOptionalArg(args, "--max-concurrent-invocations", env.ODEN_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS);
  if (env.ODEN_WASIP3_EXPERIMENTAL_INSTANCE_REUSE || env.ODEN_WASIP3_INSTANCE_REUSE_CONTRACT) {
    throw new RuntimeError("unsupported", "instance reuse was removed; standard WASI requests use a fresh Store");
  }
  args.push(...poolingArgs);
  return args;
}

export function wasip3HostDaemonPoolingRuntimeArgsFromEnv(env: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  appendOptionalArg(
    args,
    "--pooling-total-component-instances",
    env.ODEN_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES,
  );
  appendOptionalArg(args, "--pooling-memory-mb", env.ODEN_WASIP3_POOLING_MEMORY_MB);
  appendOptionalArg(
    args,
    "--pooling-total-core-instances",
    env.ODEN_WASIP3_POOLING_TOTAL_CORE_INSTANCES,
  );
  appendOptionalArg(args, "--pooling-total-memories", env.ODEN_WASIP3_POOLING_TOTAL_MEMORIES);
  appendOptionalArg(args, "--pooling-total-tables", env.ODEN_WASIP3_POOLING_TOTAL_TABLES);
  appendOptionalArg(args, "--pooling-table-elements", env.ODEN_WASIP3_POOLING_TABLE_ELEMENTS);
  appendOptionalArg(
    args,
    "--pooling-component-instance-mb",
    env.ODEN_WASIP3_POOLING_COMPONENT_INSTANCE_MB,
  );
  appendOptionalArg(args, "--pooling-core-instance-mb", env.ODEN_WASIP3_POOLING_CORE_INSTANCE_MB);
  return args;
}

export function createWasip3HostBackend(options: Wasip3HostBackendOptions): RuntimeBackend {
  const hostBin = options.hostBin ?? "oden-host";
  const hostArgsPrefix = options.hostArgsPrefix ?? [];
  const compileArgs = options.compileArgs ?? [];
  const cacheVariant = options.cacheVariant ? `-${safePathFragment(options.cacheVariant)}` : "";
  const wasmToolsBin = options.wasmToolsBin ?? "wasm-tools";
  const witPath = options.witPath ?? join(process.cwd(), "wit/standard-http");
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
            ["component", "targets", witPath, "--world", "service", request.artifact.path],
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
  const hostBin = options.hostBin ?? "oden-host";
  const hostArgsPrefix = options.hostArgsPrefix ?? [];
  const commandRunner = options.commandRunner ?? createSpawnCommandRunner();

  return {
    async invoke(request: InvokeComponentRequest): Promise<InvokeComponentResponse> {
      try {
        const body = encodeWireBody(request.body);
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
          ...(body.bodyBase64 !== undefined ? ["--body-base64", body.bodyBase64] : ["--body", body.body]),
          ...invokePolicyArgs(request),
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
            ...encodeWireBody(request.body),
            limits: request.component.limits
              ? {
                wallMs: request.component.limits.wallMs,
                cpuMs: request.component.limits.cpuMs,
                memoryMb: request.component.limits.memoryMb,
                requestBytes: request.component.limits.requestBytes,
                responseBytes: request.component.limits.responseBytes,
                subrequests: request.component.limits.subrequests,
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

export function buildWasip3HostDaemonRouteTable(
  snapshot: RouteSnapshot,
  components: CompiledComponent[],
): Wasip3HostDaemonRouteTablePayload {
  const componentsByDeployment = new Map(components.map((component) => [component.deploymentId, component]));
  return {
    schemaVersion: 1,
    routes: snapshot.routes.map((route) => {
      const component = requiredCompiledComponent(componentsByDeployment, route.deploymentId);
      const targets = route.targets?.map((target) => {
        const targetComponent = requiredCompiledComponent(componentsByDeployment, target.deploymentId);
        return {
          deploymentId: target.deploymentId,
          weight: target.weight,
          precompiled: targetComponent.precompiledPath,
          world: target.world,
          worldVersion: target.worldVersion,
          runtime: target.runtime,
          limits: target.limits,
          capabilities: target.capabilities,
        };
      });
      return {
        host: route.host,
        pathPrefix: route.pathPrefix,
        projectId: route.projectId,
        deploymentId: route.deploymentId,
        precompiled: component.precompiledPath,
        world: route.world,
        worldVersion: route.worldVersion,
        runtime: route.runtime,
        limits: route.limits,
        capabilities: route.capabilities,
        ...(targets && targets.length > 0 ? { targets } : {}),
      };
    }),
  };
}

export async function publishWasip3HostDaemonRoutes(input: {
  snapshot: RouteSnapshot;
  components: CompiledComponent[];
  url: string;
  fetch?: typeof fetch;
}): Promise<unknown> {
  const fetchImpl = input.fetch ?? fetch;
  const payload = buildWasip3HostDaemonRouteTable(input.snapshot, input.components);
  const response = await fetchImpl(`${input.url.replace(/\/+$/, "")}/routes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RuntimeError("invoke", daemonErrorMessage(text, response.status));
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

export async function proxyWasip3HostDaemonWorkerRequest(
  options: Wasip3HostDaemonWorkerProxyOptions,
  request: Wasip3HostDaemonWorkerProxyRequest,
): Promise<InvokeComponentResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${options.url.replace(/\/+$/, "")}${request.path}`, {
    method: request.method,
    headers: requestHeadersInit(request.headers),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.from(request.body),
  });
  return {
    status: response.status,
    headers: responseHeaders(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function requiredCompiledComponent(
  componentsByDeployment: Map<string, CompiledComponent>,
  deploymentId: string,
): CompiledComponent {
  const component = componentsByDeployment.get(deploymentId);
  if (!component) {
    throw new RuntimeError("validation", `compiled component is missing for deployment ${deploymentId}`);
  }
  return component;
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
    body: decodeWireBody(record),
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

function requestHeadersInit(headers: RuntimeHeader[]): Headers {
  const result = new Headers();
  let host: string | undefined;
  let hasForwardedHost = false;
  for (const header of headers) {
    if (header.name.toLowerCase() === "host" && !host) {
      host = header.value;
    }
    if (header.name.toLowerCase() === "x-forwarded-host") {
      hasForwardedHost = true;
    }
    if (!hopByHopHeader(header.name)) {
      result.append(header.name, header.value);
    }
  }
  if (!hasForwardedHost && host) {
    result.set("x-forwarded-host", host);
  }
  return result;
}

function responseHeaders(headers: Headers): RuntimeHeader[] {
  const result: RuntimeHeader[] = [];
  headers.forEach((value, name) => {
    if (!hopByHopHeader(name)) {
      result.push({ name, value });
    }
  });
  return result;
}

function hopByHopHeader(name: string): boolean {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]).has(name.toLowerCase());
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
