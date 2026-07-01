import type { RouteSnapshot } from "./contracts.ts";
import { signRuntimeIdentityHeaders } from "../runtime/identity.ts";

export interface RuntimeNodeTarget {
  id?: string;
  url: string;
  token?: string;
  identity?: RuntimeNodeTargetIdentity;
}

export interface RuntimeNodeTargetIdentity {
  keyId: string;
  secret: string;
}

export interface RouteSnapshotPublishReport {
  ok: boolean;
  snapshot: {
    id?: string;
    routes: number;
    generatedAt: string;
  };
  targets: RouteSnapshotPublishTargetResult[];
}

export interface RouteSnapshotPublishTargetResult {
  id?: string;
  url: string;
  ok: boolean;
  status?: number;
  attempts: number;
  elapsedMs: number;
  routes?: number;
  generatedAt?: string;
  snapshotId?: string;
  error?: string;
}

export interface RouteSnapshotPublishOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export async function publishRouteSnapshot(
  snapshot: RouteSnapshot,
  targets: RuntimeNodeTarget[],
  fetchImpl: FetchLike = fetch,
  options: RouteSnapshotPublishOptions = {},
): Promise<RouteSnapshotPublishReport> {
  const publishOptions = normalizePublishOptions(options);
  const results = await Promise.all(
    targets.map((target) => publishToRuntimeNode(snapshot, target, fetchImpl, publishOptions)),
  );
  return {
    ok: results.every((result) => result.ok),
    snapshot: {
      id: snapshot.id,
      routes: snapshot.routes.length,
      generatedAt: snapshot.generatedAt,
    },
    targets: results,
  };
}

export function runtimeNodeTargetsFromEnv(value: string | undefined): RuntimeNodeTarget[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((url, index) => ({
      id: `runtime-${index + 1}`,
      url,
    }));
}

async function publishToRuntimeNode(
  snapshot: RouteSnapshot,
  target: RuntimeNodeTarget,
  fetchImpl: FetchLike,
  options: NormalizedPublishOptions,
): Promise<RouteSnapshotPublishTargetResult> {
  const startedMs = options.nowMs();
  let endpoint: string;
  try {
    endpoint = snapshotEndpoint(target.url);
  } catch (error) {
    return withTargetTiming(
      target,
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
      1,
      startedMs,
      options.nowMs(),
    );
  }
  let lastResult: AttemptResult | undefined;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    lastResult = await publishAttempt(snapshot, target, endpoint, fetchImpl, options);
    if (lastResult.ok || !lastResult.retryable || attempt >= options.maxAttempts) {
      return withTargetTiming(target, lastResult, attempt, startedMs, options.nowMs());
    }
    await options.sleep(options.retryDelayMs);
  }
  return withTargetTiming(
    target,
    lastResult ?? { ok: false, error: "snapshot publish did not run", retryable: false },
    options.maxAttempts,
    startedMs,
    options.nowMs(),
  );
}

async function publishAttempt(
  snapshot: RouteSnapshot,
  target: RuntimeNodeTarget,
  endpoint: string,
  fetchImpl: FetchLike,
  options: NormalizedPublishOptions,
): Promise<AttemptResult> {
  try {
    const body = JSON.stringify(snapshot);
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      method: "PUT",
      headers: publishHeaders(target, body),
      body,
    }, options.timeoutMs);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: await response.text(),
        retryable: options.retryOnStatuses.has(response.status) || response.status >= 500,
      };
    }
    const ack = objectRecord(await response.json());
    return {
      ok: true,
      status: response.status,
      routes: numberOrDefault(ack.routes, snapshot.routes.length),
      generatedAt: stringOrDefault(ack.generatedAt, snapshot.generatedAt),
      snapshotId: stringOrUndefined(ack.snapshotId, snapshot.id),
      retryable: false,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

function publishHeaders(target: RuntimeNodeTarget, body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    ...(target.identity
      ? signRuntimeIdentityHeaders({
        method: "PUT",
        path: "/__runtime/snapshots/routes",
        body,
        keyId: target.identity.keyId,
        secret: target.identity.secret,
      })
      : {}),
  };
}

function withTarget(
  target: RuntimeNodeTarget,
  result: Omit<RouteSnapshotPublishTargetResult, "id" | "url">,
): RouteSnapshotPublishTargetResult {
  return target.id === undefined
    ? { url: target.url, ...result }
    : { id: target.id, url: target.url, ...result };
}

function withTargetTiming(
  target: RuntimeNodeTarget,
  result: AttemptResult,
  attempts: number,
  startedMs: number,
  endedMs: number,
): RouteSnapshotPublishTargetResult {
  const { retryable: _retryable, ...publishResult } = result;
  return withTarget(target, {
    ...publishResult,
    attempts,
    elapsedMs: round3(Math.max(0, endedMs - startedMs)),
  });
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs: number | undefined,
) {
  if (timeoutMs === undefined) {
    return await fetchImpl(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface AttemptResult {
  ok: boolean;
  status?: number;
  routes?: number;
  generatedAt?: string;
  snapshotId?: string;
  error?: string;
  retryable: boolean;
}

interface NormalizedPublishOptions {
  maxAttempts: number;
  retryDelayMs: number;
  timeoutMs?: number;
  retryOnStatuses: Set<number>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

function normalizePublishOptions(options: RouteSnapshotPublishOptions): NormalizedPublishOptions {
  return {
    maxAttempts: positiveInteger(options.maxAttempts, 3),
    retryDelayMs: nonnegativeInteger(options.retryDelayMs, 100),
    timeoutMs: optionalPositiveInteger(options.timeoutMs),
    retryOnStatuses: new Set(options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504]),
    nowMs: options.nowMs ?? (() => Date.now()),
    sleep: options.sleep ?? sleep,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotEndpoint(baseUrl: string): string {
  new URL(baseUrl);
  return `${baseUrl.replace(/\/+$/, "")}/__runtime/snapshots/routes`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrUndefined(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" ? value : fallback;
}
