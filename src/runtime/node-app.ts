import { createServer } from "node:http";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type RouteSnapshot,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import { enforceRuntimeCapabilities } from "./policy.ts";
import { resolveRuntimeCapabilities } from "./secrets.ts";
import type {
  CompiledComponent,
  InvokeComponentResponse,
  RouteMatchInput,
  RuntimeHeader,
  RuntimeInvoker,
  RuntimeSecretStore,
} from "./types.ts";

export interface RuntimeNodeAppOptions {
  supervisor: RuntimeNodeSupervisor;
  invoker?: RuntimeInvoker;
  secretStore?: RuntimeSecretStore;
  now?: () => string;
}

export interface RuntimeNodeSupervisor {
  loadSnapshot(snapshot: RouteSnapshot): void;
  prepareRoute(input: RouteMatchInput): Promise<CompiledComponent>;
}

export function createRuntimeNodeApp(options: RuntimeNodeAppOptions) {
  const metrics = createRuntimeMetrics(options.now ?? (() => new Date().toISOString()));
  const server = createServer(async (request, response) => {
    let workerRequest = false;
    let routeMatched = false;
    let invocationStarted = false;
    let invocationSettled = false;
    try {
      const url = new URL(request.url ?? "/", "http://runtime.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/__runtime/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/__runtime/metrics") {
        writeJson(response, 200, metrics.snapshot());
        return;
      }

      if (method === "PUT" && url.pathname === "/__runtime/snapshots/routes") {
        const snapshot = await readJson<RouteSnapshot>(request);
        assertRouteSnapshot(snapshot);
        options.supervisor.loadSnapshot(snapshot);
        metrics.recordSnapshot(snapshot);
        writeJson(response, 200, {
          ok: true,
          routes: snapshot.routes.length,
          generatedAt: snapshot.generatedAt,
        });
        return;
      }

      if (url.pathname.startsWith("/__runtime/")) {
        writeJson(response, 404, { error: { code: "not_found", message: "runtime endpoint not found" } });
        return;
      }

      workerRequest = true;
      metrics.recordRequest();
      const prepared = await options.supervisor.prepareRoute({
        host: requestHost(request.headers),
        path: url.pathname,
      });
      routeMatched = true;
      metrics.recordRouteMatch();

      if (options.invoker) {
        const component = await withResolvedCapabilities(prepared, options.secretStore);
        enforceRuntimeCapabilities(component.capabilities);
        metrics.recordInvocationStart();
        invocationStarted = true;
        const invocation = await withWallTimeout(
          options.invoker.invoke({
            deploymentId: component.deploymentId,
            component,
            method,
            uri: requestUri(request.headers, url),
            headers: requestHeaders(request.headers),
            body: await readBody(request, component.limits?.requestBytes),
          }),
          component.limits?.wallMs,
        );
        enforceResponseBytes(component, invocation);
        invocationSettled = true;
        metrics.recordInvocationSuccess();
        metrics.recordResponse(invocation.status);
        writeInvocationResponse(response, component, invocation);
        return;
      }

      metrics.recordError("invoke_not_implemented");
      metrics.recordResponse(501);
      response.writeHead(501, {
        "content-type": "application/json; charset=utf-8",
        "x-wasmplane-deployment": prepared.deploymentId,
        "x-wasmplane-precompiled": prepared.precompiledPath,
      });
      response.end(
        JSON.stringify({
          error: {
            code: "invoke_not_implemented",
            message: "WASIp3 component invocation is not wired yet",
          },
          deploymentId: prepared.deploymentId,
          precompiledPath: prepared.precompiledPath,
        }),
      );
    } catch (error) {
      const errorResponse = runtimeErrorResponse(error);
      if (workerRequest) {
        if (!routeMatched && errorResponse.code === "not_found") {
          metrics.recordRouteMiss();
        }
        if (invocationStarted && !invocationSettled) {
          metrics.recordInvocationFailure();
        }
        metrics.recordError(errorResponse.code);
        metrics.recordResponse(errorResponse.status);
      }
      writeJson(response, errorResponse.status, {
        error: { code: errorResponse.code, message: errorResponse.message },
      });
    }
  });

  return {
    listen(options: { port: number; host?: string }) {
      return new Promise<typeof server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

interface RuntimeMetricsSnapshot {
  startedAt: string;
  requests: {
    total: number;
    matched: number;
    missed: number;
  };
  invocations: {
    total: number;
    succeeded: number;
    failed: number;
  };
  responses: {
    byStatus: Record<string, number>;
  };
  errors: Record<string, number>;
  snapshots: {
    loaded: number;
    routes?: number;
    generatedAt?: string;
  };
}

function createRuntimeMetrics(now: () => string) {
  const metrics: RuntimeMetricsSnapshot = {
    startedAt: now(),
    requests: { total: 0, matched: 0, missed: 0 },
    invocations: { total: 0, succeeded: 0, failed: 0 },
    responses: { byStatus: {} },
    errors: {},
    snapshots: { loaded: 0 },
  };

  return {
    snapshot(): RuntimeMetricsSnapshot {
      return {
        startedAt: metrics.startedAt,
        requests: { ...metrics.requests },
        invocations: { ...metrics.invocations },
        responses: { byStatus: { ...metrics.responses.byStatus } },
        errors: { ...metrics.errors },
        snapshots: { ...metrics.snapshots },
      };
    },
    recordRequest() {
      metrics.requests.total += 1;
    },
    recordRouteMatch() {
      metrics.requests.matched += 1;
    },
    recordRouteMiss() {
      metrics.requests.missed += 1;
    },
    recordInvocationStart() {
      metrics.invocations.total += 1;
    },
    recordInvocationSuccess() {
      metrics.invocations.succeeded += 1;
    },
    recordInvocationFailure() {
      metrics.invocations.failed += 1;
    },
    recordResponse(status: number) {
      increment(metrics.responses.byStatus, String(status));
    },
    recordError(code: string) {
      increment(metrics.errors, code);
    },
    recordSnapshot(snapshot: RouteSnapshot) {
      metrics.snapshots = {
        loaded: metrics.snapshots.loaded + 1,
        routes: snapshot.routes.length,
        generatedAt: snapshot.generatedAt,
      };
    },
  };
}

function increment(record: Record<string, number>, key: string) {
  record[key] = (record[key] ?? 0) + 1;
}

function enforceResponseBytes(prepared: CompiledComponent, invocation: InvokeComponentResponse) {
  const limit = prepared.limits?.responseBytes;
  if (limit !== undefined && invocation.body.byteLength > limit) {
    throw new RuntimeError(
      "limits",
      `responseBytes limit exceeded for ${prepared.deploymentId}: ${invocation.body.byteLength} > ${limit}`,
    );
  }
}

async function withResolvedCapabilities(
  prepared: CompiledComponent,
  secretStore?: RuntimeSecretStore,
): Promise<CompiledComponent> {
  if (!prepared.capabilities) {
    return prepared;
  }
  return {
    ...prepared,
    capabilities: await resolveRuntimeCapabilities(prepared.capabilities, secretStore),
  };
}

function withWallTimeout<T>(promise: Promise<T>, wallMs: number | undefined): Promise<T> {
  if (wallMs === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RuntimeError("timeout", `wallMs limit exceeded after ${wallMs}ms`));
    }, wallMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readJson<T>(request: any): Promise<T> {
  const body = await readBody(request);
  const text = Buffer.from(body).toString("utf8");
  if (text.trim().length === 0) {
    throw new RuntimeError("validation", "request body must be JSON");
  }
  return JSON.parse(text) as T;
}

async function readBody(request: any, maxBytes?: number): Promise<Buffer> {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new RuntimeError("limits", `requestBytes limit exceeded: ${total} > ${maxBytes}`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isRequestBytesLimit(error: RuntimeError): boolean {
  return error.code === "limits" && error.message.includes("requestBytes");
}

function runtimeErrorResponse(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof RuntimeError && error.code === "not_found") {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && error.code === "timeout") {
    return { status: 504, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && error.code === "validation") {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && isRequestBytesLimit(error)) {
    return { status: 413, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError) {
    return { status: 500, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, code: "internal", message };
}

function writeJson(response: any, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function requestHost(headers: Record<string, string | string[] | undefined>): string {
  return requiredHeader(firstHeader(headers["x-forwarded-host"]) ?? firstHeader(headers.host));
}

function requestUri(headers: Record<string, string | string[] | undefined>, url: URL): string {
  const host = requestHost(headers).replace(/:\d+$/, "");
  const proto = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}${url.pathname}${url.search}`;
}

function requestHeaders(headers: Record<string, string | string[] | undefined>): RuntimeHeader[] {
  const result: RuntimeHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.push({ name, value: item });
      }
      continue;
    }
    result.push({ name, value });
  }
  return result;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredHeader(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new RuntimeError("validation", "host or x-forwarded-host header is required");
  }
  return value;
}

function assertRouteSnapshot(value: unknown): asserts value is RouteSnapshot {
  const snapshot = objectRecord(value, "route snapshot");
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.routes)) {
    throw new RuntimeError("validation", "route snapshot must have schemaVersion 1 and routes");
  }
  stringValue(snapshot.generatedAt, "route snapshot.generatedAt");
  snapshot.routes.forEach((route, index) => assertRouteSnapshotEntry(route, `routes[${index}]`));
}

function assertRouteSnapshotEntry(value: unknown, field: string) {
  const route = objectRecord(value, field);
  dnsHost(route.host, `${field}.host`);
  pathPrefix(route.pathPrefix, `${field}.pathPrefix`);
  nonEmptyString(route.projectId, `${field}.projectId`);
  const deploymentId = nonEmptyString(route.deploymentId, `${field}.deploymentId`);
  assertWorld(route.world, `${field}.world`);
  assertRuntime(route.runtime, `${field}.runtime`);
  assertLimits(route.limits, `${field}.limits`);
  assertCapabilities(route.capabilities, `${field}.capabilities`);
  assertArtifact(route.artifact, `${field}.artifact`);
  if (!Array.isArray(route.targets) || route.targets.length === 0) {
    throw new RuntimeError("validation", `${field}.targets must be a non-empty array`);
  }
  route.targets.forEach((target, index) =>
    assertRouteSnapshotTarget(target, `${field}.targets[${index}]`),
  );
  const primary = objectRecord(route.targets[0], `${field}.targets[0]`);
  if (primary.deploymentId !== deploymentId) {
    throw new RuntimeError(
      "validation",
      `${field}.deploymentId must match ${field}.targets[0].deploymentId`,
    );
  }
}

function assertRouteSnapshotTarget(value: unknown, field: string) {
  const target = objectRecord(value, field);
  nonEmptyString(target.deploymentId, `${field}.deploymentId`);
  positiveInteger(target.weight, `${field}.weight`);
  assertWorld(target.world, `${field}.world`);
  assertRuntime(target.runtime, `${field}.runtime`);
  assertLimits(target.limits, `${field}.limits`);
  assertCapabilities(target.capabilities, `${field}.capabilities`);
  assertArtifact(target.artifact, `${field}.artifact`);
}

function assertWorld(value: unknown, field: string) {
  if (value !== MVP_WORKER_WORLD) {
    throw new RuntimeError("validation", `${field} must be ${MVP_WORKER_WORLD}`);
  }
}

function assertRuntime(value: unknown, field: string) {
  const runtime = objectRecord(value, field);
  if (runtime.backend !== MVP_RUNTIME_BACKEND) {
    throw new RuntimeError("validation", `${field}.backend must be ${MVP_RUNTIME_BACKEND}`);
  }
  if (runtime.wasi !== MVP_WASI_PROFILE) {
    throw new RuntimeError("validation", `${field}.wasi must be ${MVP_WASI_PROFILE}`);
  }
  nonEmptyString(runtime.version, `${field}.version`);
}

function assertLimits(value: unknown, field: string) {
  const limits = objectRecord(value, field);
  positiveInteger(limits.cpuMs, `${field}.cpuMs`);
  positiveInteger(limits.memoryMb, `${field}.memoryMb`);
  positiveInteger(limits.wallMs, `${field}.wallMs`);
  positiveInteger(limits.requestBytes, `${field}.requestBytes`);
  positiveInteger(limits.subrequests, `${field}.subrequests`);
  positiveInteger(limits.hostCalls, `${field}.hostCalls`);
  positiveInteger(limits.responseBytes, `${field}.responseBytes`);
}

function assertCapabilities(value: unknown, field: string) {
  const capabilities = objectRecord(value, field);
  assertOutboundHttp(capabilities.outboundHttp, `${field}.outboundHttp`);
  assertKvBindings(capabilities.kv, `${field}.kv`);
  assertSecretBindings(capabilities.secrets, `${field}.secrets`);
  falseValue(capabilities.arbitraryFilesystem, `${field}.arbitraryFilesystem`);
  falseValue(capabilities.arbitrarySockets, `${field}.arbitrarySockets`);
  falseValue(capabilities.processSpawn, `${field}.processSpawn`);
}

function assertOutboundHttp(value: unknown, field: string) {
  const outbound = objectRecord(value, field);
  if (typeof outbound.enabled !== "boolean") {
    throw new RuntimeError("validation", `${field}.enabled must be a boolean`);
  }
  const allow = stringArray(outbound.allow, `${field}.allow`);
  if (!outbound.enabled && allow.length > 0) {
    throw new RuntimeError("validation", `${field}.allow requires ${field}.enabled`);
  }
}

function assertKvBindings(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new RuntimeError("validation", `${field} must be an array`);
  }
  value.forEach((item, index) => {
    const binding = objectRecord(item, `${field}[${index}]`);
    bindingName(binding.binding, `${field}[${index}].binding`);
    nonEmptyString(binding.namespaceId, `${field}[${index}].namespaceId`);
  });
}

function assertSecretBindings(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new RuntimeError("validation", `${field} must be an array`);
  }
  value.forEach((item, index) => {
    const binding = objectRecord(item, `${field}[${index}]`);
    bindingName(binding.binding, `${field}[${index}].binding`);
    nonEmptyString(binding.secretId, `${field}[${index}].secretId`);
  });
}

function assertArtifact(value: unknown, field: string) {
  const artifact = objectRecord(value, field);
  nonEmptyString(artifact.id, `${field}.id`);
  digestValue(artifact.digest, `${field}.digest`);
  locationValue(artifact.location, `${field}.location`);
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeError("validation", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RuntimeError("validation", `${field} must be a string`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const text = stringValue(value, field).trim();
  if (text.length === 0) {
    throw new RuntimeError("validation", `${field} must be a non-empty string`);
  }
  return text;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new RuntimeError("validation", `${field} must be an array`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RuntimeError("validation", `${field} must be a positive integer`);
  }
  return value as number;
}

function falseValue(value: unknown, field: string) {
  if (value !== false) {
    throw new RuntimeError("validation", `${field} must be false`);
  }
}

function bindingName(value: unknown, field: string): string {
  const name = nonEmptyString(value, field);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new RuntimeError("validation", `${field} must be an uppercase binding name`);
  }
  return name;
}

function dnsHost(value: unknown, field: string): string {
  const host = nonEmptyString(value, field).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new RuntimeError("validation", `${field} must be a DNS host`);
  }
  return host;
}

function pathPrefix(value: unknown, field: string): string {
  const prefix = nonEmptyString(value, field);
  if (!prefix.startsWith("/")) {
    throw new RuntimeError("validation", `${field} must start with /`);
  }
  return prefix;
}

function digestValue(value: unknown, field: string): string {
  const digest = nonEmptyString(value, field);
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(digest)) {
    throw new RuntimeError("validation", `${field} must be a sha256:<64 hex chars> value`);
  }
  return digest.toLowerCase();
}

function locationValue(value: unknown, field: string): string {
  const location = nonEmptyString(value, field);
  if (!/^(oci|s3|file):\/\//.test(location)) {
    throw new RuntimeError("validation", `${field} must use oci://, s3://, or file://`);
  }
  return location;
}

function writeInvocationResponse(
  response: any,
  prepared: CompiledComponent,
  invocation: InvokeComponentResponse,
) {
  const headers: Record<string, string> = {
    "x-wasmplane-deployment": prepared.deploymentId,
    "x-wasmplane-precompiled": prepared.precompiledPath,
  };
  for (const header of invocation.headers) {
    if (isSafeResponseHeader(header.name)) {
      headers[header.name] = header.value;
    }
  }
  response.writeHead(invocation.status, headers);
  response.end(Buffer.from(invocation.body));
}

function isSafeResponseHeader(name: string): boolean {
  return !new Set([
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
