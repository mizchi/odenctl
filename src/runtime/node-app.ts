import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type RouteSnapshot,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import { verifyRuntimeIdentityHeaders } from "./identity.ts";
import { pruneRuntimeCaches, type RuntimeCacheRetentionOptions } from "./cache-retention.ts";
import { enforceRuntimeCapabilities } from "./policy.ts";
import { resolveRuntimeCapabilities } from "./secrets.ts";
import type { RuntimeTelemetry } from "./otel.ts";
import type {
  CompiledComponent,
  InvokeComponentResponse,
  RouteMatchInput,
  RuntimeHeader,
  RuntimeInvoker,
  RuntimeSecretStore,
  RuntimeWorkerLogLine,
} from "./types.ts";

export interface RuntimeNodeAppOptions {
  supervisor: RuntimeNodeSupervisor;
  invoker?: RuntimeInvoker;
  secretStore?: RuntimeSecretStore;
  managementToken?: string;
  managementIdentityKeys?: Record<string, string>;
  maxConcurrentInvocations?: number;
  maxConcurrentInvocationsByProject?: Record<string, number>;
  requestRateLimitsByProject?: Record<string, RuntimeProjectRateLimit>;
  cacheRetention?: RuntimeCacheRetentionOptions;
  requestIdGenerator?: () => string;
  monotonicNowMs?: () => number;
  eventBufferSize?: number;
  logBufferSize?: number;
  telemetry?: RuntimeTelemetry;
  warmupOnSnapshot?: boolean;
  hostDaemonMetrics?: RuntimeHostDaemonMetricsOptions;
  now?: () => string;
}

export interface RuntimeHostDaemonMetricsOptions {
  url: string;
  fetch?: typeof fetch;
}

export interface RuntimeProjectRateLimit {
  requestsPerSecond: number;
  burst?: number;
}

export interface RuntimeNodeSupervisor {
  loadSnapshot(snapshot: RouteSnapshot): void;
  warmupSnapshot?(snapshot: RouteSnapshot): Promise<unknown>;
  preparedComponents?(): CompiledComponent[] | Promise<CompiledComponent[]>;
  prepareRoute(input: RouteMatchInput): Promise<CompiledComponent>;
}

export function createRuntimeNodeApp(options: RuntimeNodeAppOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNowMs = options.monotonicNowMs ?? (() => Date.now());
  const requestIdGenerator = options.requestIdGenerator ?? (() => randomUUID());
  const metrics = createRuntimeMetrics(now);
  const events = createRuntimeEvents(options.eventBufferSize ?? 100);
  const logs = createRuntimeLogs(options.logBufferSize ?? 100);
  const projectConcurrency = createProjectConcurrencyLimiter(options.maxConcurrentInvocationsByProject);
  const projectRateLimiter = createProjectRateLimiter(options.requestRateLimitsByProject, monotonicNowMs);
  const server = createServer(async (request, response) => {
    let workerRequest = false;
    let routeMatched = false;
    let invocationStarted = false;
    let invocationSettled = false;
    let requestStartedMs = 0;
    let requestId: string | undefined;
    let eventHost: string | undefined;
    let eventPath: string | undefined;
    let eventProjectId: string | undefined;
    let eventDeploymentId: string | undefined;
    let eventStatus: number | undefined;
    let eventErrorCode: string | undefined;
    let eventMethod: string | undefined;
    let eventTraceparent: string | undefined;
    try {
      const url = new URL(request.url ?? "/", "http://runtime.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/__runtime/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith("/__runtime/") && !authorizeRuntimeManagement(options, request.headers)) {
        writeJson(response, 401, {
          error: { code: "unauthorized", message: "missing or invalid runtime bearer token" },
        });
        return;
      }

      if (method === "GET" && url.pathname === "/__runtime/metrics") {
        const snapshot = metrics.snapshot();
        const hostDaemon = await readHostDaemonMetrics(options.hostDaemonMetrics);
        if (hostDaemon) {
          snapshot.hostDaemon = hostDaemon;
        }
        writeJson(response, 200, snapshot);
        return;
      }

      if (method === "GET" && url.pathname === "/__runtime/events") {
        writeJson(response, 200, events.snapshot());
        return;
      }

      if (method === "GET" && url.pathname === "/__runtime/logs") {
        writeJson(response, 200, logs.snapshot({
          projectId: url.searchParams.get("projectId") ?? undefined,
          deploymentId: url.searchParams.get("deploymentId") ?? undefined,
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/__runtime/cache/gc") {
        writeJson(response, 200, await runRuntimeCacheGc(options));
        return;
      }

      if (method === "PUT" && url.pathname === "/__runtime/snapshots/routes") {
        const bodyText = await readText(request);
        if (!authorizeRuntimeIdentity(options, request.headers, method, url.pathname, bodyText)) {
          writeJson(response, 401, {
            error: { code: "unauthorized", message: "missing or invalid runtime identity signature" },
          });
          return;
        }
        const snapshot = parseJson<RouteSnapshot>(bodyText);
        assertRouteSnapshot(snapshot);
        const warmup = options.warmupOnSnapshot === true;
        if (warmup) {
          if (!options.supervisor.warmupSnapshot) {
            throw new RuntimeError("validation", "runtime supervisor does not support snapshot warmup");
          }
          await options.supervisor.warmupSnapshot(snapshot);
        } else {
          options.supervisor.loadSnapshot(snapshot);
        }
        metrics.recordSnapshot(snapshot);
        writeJson(response, 200, {
          ok: true,
          snapshotId: snapshot.id,
          warmed: warmup,
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
      eventMethod = method;
      eventTraceparent = firstHeader(request.headers.traceparent);
      requestStartedMs = monotonicNowMs();
      requestId = requestIdGenerator();
      eventHost = requestHost(request.headers);
      eventPath = url.pathname;
      metrics.recordRequest();
      const prepared = await options.supervisor.prepareRoute({
        host: eventHost,
        path: url.pathname,
      });
      routeMatched = true;
      eventProjectId = prepared.projectId;
      eventDeploymentId = prepared.deploymentId;
      metrics.recordRouteMatch();
      if (!projectRateLimiter.tryConsume(prepared.projectId)) {
        throw new RuntimeError("rate_limited", "runtime node project request rate limit exceeded");
      }

      if (options.invoker) {
        const component = await withResolvedCapabilities(prepared, options.secretStore);
        enforceRuntimeCapabilities(component.capabilities);
        const projectInvocation = projectConcurrency.tryStart(component.projectId);
        if (!projectInvocation.acquired) {
          metrics.recordInvocationRejected();
          throw new RuntimeError("overloaded", "runtime node project concurrency limit exceeded");
        }
        if (!metrics.tryStartInvocation(options.maxConcurrentInvocations)) {
          projectInvocation.release();
          throw new RuntimeError("overloaded", "runtime node concurrency limit exceeded");
        }
        invocationStarted = true;
        try {
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
          logs.recordInvocationLogs({
            timestamp: now(),
            requestId,
            host: eventHost,
            path: eventPath,
            projectId: component.projectId,
            deploymentId: component.deploymentId,
            lines: invocation.logs,
            secretValues: component.capabilities?.secrets
              .map((secret) => secret.value)
              .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [],
          });
          invocationSettled = true;
          metrics.recordInvocationSuccess();
          metrics.recordResponse(invocation.status);
          eventStatus = invocation.status;
          writeInvocationResponse(response, component, invocation, requestId);
        } finally {
          metrics.recordInvocationEnd();
          projectInvocation.release();
        }
        return;
      }

      metrics.recordError("invoke_not_implemented");
      metrics.recordResponse(501);
      eventStatus = 501;
      eventErrorCode = "invoke_not_implemented";
      response.writeHead(501, {
        "content-type": "application/json; charset=utf-8",
        "x-wasmplane-request-id": requestId,
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
      eventStatus = errorResponse.status;
      eventErrorCode = errorResponse.code;
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
      }, requestId ? { "x-wasmplane-request-id": requestId } : undefined);
    } finally {
      if (workerRequest && requestId && eventHost && eventPath && eventStatus !== undefined) {
        const durationMs = Math.max(0, monotonicNowMs() - requestStartedMs);
        events.record({
          timestamp: now(),
          requestId,
          host: eventHost,
          path: eventPath,
          projectId: eventProjectId,
          deploymentId: eventDeploymentId,
          status: eventStatus,
          durationMs,
          errorCode: eventErrorCode,
        });
        if (options.telemetry && eventMethod) {
          void options.telemetry.recordWorkerRequest({
            requestId,
            method: eventMethod,
            host: eventHost,
            path: eventPath,
            projectId: eventProjectId,
            deploymentId: eventDeploymentId,
            status: eventStatus,
            durationMs,
            errorCode: eventErrorCode,
            traceparent: eventTraceparent,
          }).catch(() => undefined);
        }
      }
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
    metrics() {
      return metrics.snapshot();
    },
    logs() {
      return logs.snapshot({});
    },
  };
}

function authorizeRuntimeIdentity(
  options: RuntimeNodeAppOptions,
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string,
): boolean {
  if (!options.managementIdentityKeys || Object.keys(options.managementIdentityKeys).length === 0) {
    return true;
  }
  return verifyRuntimeIdentityHeaders({
    method,
    path,
    body,
    headers,
    keys: options.managementIdentityKeys,
  }).ok;
}

async function runRuntimeCacheGc(options: RuntimeNodeAppOptions) {
  const prepared = await options.supervisor.preparedComponents?.() ?? [];
  const activePaths = prepared.flatMap((component) => [component.componentPath, component.precompiledPath]);
  return pruneRuntimeCaches({
    ...(options.cacheRetention ?? {}),
    keepPaths: [
      ...(options.cacheRetention?.keepPaths ?? []),
      ...activePaths,
    ],
  });
}

function authorizeRuntimeManagement(
  options: RuntimeNodeAppOptions,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!options.managementToken) {
    return true;
  }
  return firstHeader(headers.authorization) === `Bearer ${options.managementToken}`;
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
    active: number;
    rejected: number;
    maxConcurrent?: number;
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
  hostDaemon?: unknown;
}

interface RuntimeEvent {
  timestamp: string;
  requestId: string;
  host: string;
  path: string;
  projectId?: string;
  deploymentId?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

interface RuntimeEventsSnapshot {
  events: RuntimeEvent[];
}

interface RuntimeLogEntry {
  timestamp: string;
  requestId: string;
  host: string;
  path: string;
  projectId?: string;
  deploymentId?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

interface RuntimeLogsSnapshot {
  logs: RuntimeLogEntry[];
}

function createRuntimeMetrics(now: () => string) {
  const metrics: RuntimeMetricsSnapshot = {
    startedAt: now(),
    requests: { total: 0, matched: 0, missed: 0 },
    invocations: { total: 0, succeeded: 0, failed: 0, active: 0, rejected: 0 },
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
    tryStartInvocation(maxConcurrent: number | undefined): boolean {
      if (maxConcurrent !== undefined) {
        metrics.invocations.maxConcurrent = maxConcurrent;
        if (metrics.invocations.active >= maxConcurrent) {
          this.recordInvocationRejected();
          return false;
        }
      }
      metrics.invocations.total += 1;
      metrics.invocations.active += 1;
      return true;
    },
    recordInvocationRejected() {
      metrics.invocations.rejected += 1;
    },
    recordInvocationEnd() {
      metrics.invocations.active = Math.max(0, metrics.invocations.active - 1);
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

function createRuntimeLogs(limit: number) {
  const entries: RuntimeLogEntry[] = [];
  const boundedLimit = Math.max(1, limit);

  return {
    snapshot(filter: { projectId?: string; deploymentId?: string }): RuntimeLogsSnapshot {
      return {
        logs: entries.filter((entry) =>
          (!filter.projectId || entry.projectId === filter.projectId)
          && (!filter.deploymentId || entry.deploymentId === filter.deploymentId)
        ),
      };
    },
    recordInvocationLogs(input: {
      timestamp: string;
      requestId: string;
      host: string;
      path: string;
      projectId?: string;
      deploymentId?: string;
      lines?: RuntimeWorkerLogLine[];
      secretValues: string[];
    }) {
      for (const line of input.lines ?? []) {
        const message = typeof line.message === "string" ? line.message : "";
        if (message.length === 0) {
          continue;
        }
        entries.push(stripUndefined({
          timestamp: input.timestamp,
          requestId: input.requestId,
          host: input.host,
          path: input.path,
          projectId: input.projectId,
          deploymentId: input.deploymentId,
          level: normalizeLogLevel(line.level),
          message: redactLogMessage(message, input.secretValues),
        }));
        while (entries.length > boundedLimit) {
          entries.shift();
        }
      }
    },
  };
}

function createRuntimeEvents(limit: number) {
  const events: RuntimeEvent[] = [];
  const boundedLimit = Math.max(1, limit);

  return {
    snapshot(): RuntimeEventsSnapshot {
      return { events: [...events] };
    },
    record(event: RuntimeEvent) {
      events.push(stripUndefined(event));
      while (events.length > boundedLimit) {
        events.shift();
      }
    },
  };
}

function normalizeLogLevel(value: RuntimeWorkerLogLine["level"]): RuntimeLogEntry["level"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function redactLogMessage(message: string, secretValues: string[]): string {
  let redacted = message;
  for (const secret of [...secretValues].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.replace(
    /\b(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|password|secret)(\s*[:=]\s*)([^,\r\n]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
  );
}

interface ProjectInvocationPermit {
  acquired: boolean;
  release(): void;
}

function createProjectConcurrencyLimiter(
  limits: Record<string, number> | undefined,
) {
  const maxByProject = new Map<string, number>();
  for (const [projectId, value] of Object.entries(limits ?? {})) {
    if (projectId.trim().length === 0 || !Number.isFinite(value) || value < 0) {
      continue;
    }
    maxByProject.set(projectId, Math.floor(value));
  }
  const activeByProject = new Map<string, number>();
  const noopPermit: ProjectInvocationPermit = { acquired: true, release() {} };

  return {
    tryStart(projectId: string | undefined): ProjectInvocationPermit {
      if (!projectId) {
        return noopPermit;
      }
      const maxConcurrent = maxByProject.get(projectId);
      if (maxConcurrent === undefined) {
        return noopPermit;
      }
      const active = activeByProject.get(projectId) ?? 0;
      if (active >= maxConcurrent) {
        return { acquired: false, release() {} };
      }
      activeByProject.set(projectId, active + 1);
      let released = false;
      return {
        acquired: true,
        release() {
          if (released) {
            return;
          }
          released = true;
          const next = Math.max(0, (activeByProject.get(projectId) ?? 1) - 1);
          if (next === 0) {
            activeByProject.delete(projectId);
            return;
          }
          activeByProject.set(projectId, next);
        },
      };
    },
  };
}

interface ProjectRateBucket {
  tokens: number;
  updatedMs: number;
}

function createProjectRateLimiter(
  limits: Record<string, RuntimeProjectRateLimit> | undefined,
  nowMs: () => number,
) {
  const maxByProject = new Map<string, { requestsPerSecond: number; burst: number }>();
  for (const [projectId, limit] of Object.entries(limits ?? {})) {
    const requestsPerSecond = limit.requestsPerSecond;
    const burst = limit.burst ?? Math.ceil(requestsPerSecond);
    if (
      projectId.trim().length === 0
      || !Number.isFinite(requestsPerSecond)
      || requestsPerSecond < 0
      || !Number.isFinite(burst)
      || burst < 0
    ) {
      continue;
    }
    maxByProject.set(projectId, {
      requestsPerSecond,
      burst: Math.floor(burst),
    });
  }
  const buckets = new Map<string, ProjectRateBucket>();

  return {
    tryConsume(projectId: string | undefined): boolean {
      if (!projectId) {
        return true;
      }
      const limit = maxByProject.get(projectId);
      if (!limit) {
        return true;
      }
      const now = nowMs();
      const bucket = buckets.get(projectId) ?? { tokens: limit.burst, updatedMs: now };
      const elapsedMs = Math.max(0, now - bucket.updatedMs);
      bucket.tokens = Math.min(
        limit.burst,
        bucket.tokens + (elapsedMs * limit.requestsPerSecond) / 1000,
      );
      bucket.updatedMs = now;
      if (bucket.tokens < 1) {
        buckets.set(projectId, bucket);
        return false;
      }
      bucket.tokens -= 1;
      buckets.set(projectId, bucket);
      return true;
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function increment(record: Record<string, number>, key: string) {
  record[key] = (record[key] ?? 0) + 1;
}

async function readHostDaemonMetrics(
  options: RuntimeHostDaemonMetricsOptions | undefined,
): Promise<unknown | undefined> {
  if (!options) {
    return undefined;
  }
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.url.replace(/\/+$/, "")}/stats`;
  try {
    const response = await fetchImpl(url);
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: text,
      };
    }
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
  return parseJson(await readText(request));
}

function parseJson<T>(text: string): T {
  if (text.trim().length === 0) {
    throw new RuntimeError("validation", "request body must be JSON");
  }
  return JSON.parse(text) as T;
}

async function readText(request: any): Promise<string> {
  return Buffer.from(await readBody(request)).toString("utf8");
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
  if (error instanceof RuntimeError && error.code === "cpu_limit") {
    return { status: 503, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && error.code === "validation") {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && error.code === "overloaded") {
    return { status: 503, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeError && error.code === "rate_limited") {
    return { status: 429, code: error.code, message: error.message };
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

function writeJson(response: any, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
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
  if (snapshot.id !== undefined) {
    stringValue(snapshot.id, "route snapshot.id");
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
  assertWorldVersion(route.worldVersion, `${field}.worldVersion`);
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
  assertWorldVersion(target.worldVersion, `${field}.worldVersion`);
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

function assertWorldVersion(value: unknown, field: string) {
  if (value !== MVP_WORKER_WORLD_VERSION) {
    throw new RuntimeError("validation", `${field} must be ${MVP_WORKER_WORLD_VERSION}`);
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
  if (!/^(oci|s3|file|https?):\/\//.test(location)) {
    throw new RuntimeError(
      "validation",
      `${field} must use oci://, s3://, file://, http://, or https://`,
    );
  }
  return location;
}

function writeInvocationResponse(
  response: any,
  prepared: CompiledComponent,
  invocation: InvokeComponentResponse,
  requestId?: string,
) {
  const headers: Record<string, string> = {
    "x-wasmplane-deployment": prepared.deploymentId,
    "x-wasmplane-precompiled": prepared.precompiledPath,
  };
  if (requestId) {
    headers["x-wasmplane-request-id"] = requestId;
  }
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
