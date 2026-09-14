import type { RouteSnapshot } from "./contracts.ts";
import type { FetchLike } from "./snapshot-publisher.ts";

export interface RouteSnapshotReplicaTarget {
  id?: string;
  region: string;
  url: string;
  token?: string;
}

export interface RouteSnapshotReplicationReport {
  ok: boolean;
  consistent: boolean;
  snapshot: {
    id?: string;
    routes: number;
    generatedAt: string;
  };
  replicas: RouteSnapshotReplicaResult[];
}

export interface RouteSnapshotReplicaResult {
  id?: string;
  region: string;
  url: string;
  ok: boolean;
  consistent: boolean;
  status?: number;
  snapshotId?: string;
  generatedAt?: string;
  error?: string;
  attempts: number;
  elapsedMs: number;
}

export interface RouteSnapshotReplicationOptions {
  sourceRegion?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RouteSnapshotReplicaState {
  snapshot: RouteSnapshot;
  sourceRegion?: string;
  receivedAt: string;
}

export interface RouteSnapshotReplicaApplyInput {
  snapshot: RouteSnapshot;
  sourceRegion?: string;
  receivedAt: string;
}

export interface RouteSnapshotReplicaApplyResult {
  accepted: boolean;
  stale: boolean;
  snapshotId?: string;
  generatedAt: string;
  receivedAt: string;
}

export interface RouteSnapshotReplicaStore {
  apply(input: RouteSnapshotReplicaApplyInput): RouteSnapshotReplicaApplyResult;
  current(): RouteSnapshotReplicaState | undefined;
}

export async function replicateRouteSnapshot(
  snapshot: RouteSnapshot,
  targets: RouteSnapshotReplicaTarget[],
  fetchImpl: FetchLike = fetch,
  options: RouteSnapshotReplicationOptions = {},
): Promise<RouteSnapshotReplicationReport> {
  const replicationOptions = normalizeReplicationOptions(options);
  const replicas = await Promise.all(
    targets.map((target) => replicateToTarget(snapshot, target, fetchImpl, replicationOptions)),
  );
  const consistent = replicas.every((replica) => replica.ok && replica.consistent);
  return {
    ok: consistent,
    consistent,
    snapshot: {
      id: snapshot.id,
      routes: snapshot.routes.length,
      generatedAt: snapshot.generatedAt,
    },
    replicas,
  };
}

export function createInMemoryRouteSnapshotReplicaStore(): RouteSnapshotReplicaStore {
  let state: RouteSnapshotReplicaState | undefined;
  return {
    apply(input) {
      if (state && compareSnapshotFreshness(input.snapshot, state.snapshot) < 0) {
        return {
          accepted: false,
          stale: true,
          snapshotId: state.snapshot.id,
          generatedAt: state.snapshot.generatedAt,
          receivedAt: state.receivedAt,
        };
      }
      state = {
        snapshot: input.snapshot,
        sourceRegion: input.sourceRegion,
        receivedAt: input.receivedAt,
      };
      return {
        accepted: true,
        stale: false,
        snapshotId: input.snapshot.id,
        generatedAt: input.snapshot.generatedAt,
        receivedAt: input.receivedAt,
      };
    },
    current() {
      return state;
    },
  };
}

export function routeSnapshotReplicaTargetsFromEnv(
  value: string | undefined,
  token?: string,
): RouteSnapshotReplicaTarget[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item, index) => {
      const parsed = parseReplicaTarget(item, index);
      return token ? { ...parsed, token } : parsed;
    });
}

export function assertReplicatedRouteSnapshot(value: unknown): asserts value is RouteSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("route snapshot replica body must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.routes)) {
    throw new Error("route snapshot replica must have schemaVersion 1 and routes");
  }
  if (snapshot.id !== undefined && typeof snapshot.id !== "string") {
    throw new Error("route snapshot replica id must be a string");
  }
  if (typeof snapshot.generatedAt !== "string") {
    throw new Error("route snapshot replica generatedAt must be a string");
  }
}

function parseReplicaTarget(value: string, index: number): RouteSnapshotReplicaTarget {
  const separator = value.indexOf("=");
  if (separator === -1) {
    const id = `replica-${index + 1}`;
    return {
      id,
      region: id,
      url: value,
    };
  }
  const region = value.slice(0, separator).trim();
  const url = value.slice(separator + 1).trim();
  const id = region.length > 0 ? `replica-${region}` : `replica-${index + 1}`;
  return {
    id,
    region: region.length > 0 ? region : id,
    url,
  };
}

async function replicateToTarget(
  snapshot: RouteSnapshot,
  target: RouteSnapshotReplicaTarget,
  fetchImpl: FetchLike,
  options: NormalizedReplicationOptions,
): Promise<RouteSnapshotReplicaResult> {
  const startedMs = options.nowMs();
  let endpoint: string;
  try {
    endpoint = replicaEndpoint(target.url);
  } catch (error) {
    return withReplicaTiming(
      target,
      {
        ok: false,
        consistent: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
      1,
      startedMs,
      options.nowMs(),
    );
  }
  let lastResult: ReplicaAttemptResult | undefined;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    lastResult = await replicateAttempt(snapshot, target, endpoint, fetchImpl, options);
    if (lastResult.ok || !lastResult.retryable || attempt >= options.maxAttempts) {
      return withReplicaTiming(target, lastResult, attempt, startedMs, options.nowMs());
    }
    await options.sleep(options.retryDelayMs);
  }
  return withReplicaTiming(
    target,
    {
      ok: false,
      consistent: false,
      error: "snapshot replication did not run",
      retryable: false,
    },
    options.maxAttempts,
    startedMs,
    options.nowMs(),
  );
}

async function replicateAttempt(
  snapshot: RouteSnapshot,
  target: RouteSnapshotReplicaTarget,
  endpoint: string,
  fetchImpl: FetchLike,
  options: NormalizedReplicationOptions,
): Promise<ReplicaAttemptResult> {
  try {
    const body = JSON.stringify(snapshot);
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      method: "PUT",
      headers: replicaHeaders(target, body, options.sourceRegion),
      body,
    }, options.timeoutMs);
    if (!response.ok) {
      return {
        ok: false,
        consistent: false,
        status: response.status,
        error: await response.text(),
        retryable: options.retryOnStatuses.has(response.status) || response.status >= 500,
      };
    }
    const ack = objectRecord(await response.json());
    const result = replicaAck(snapshot, ack);
    return {
      ...result,
      status: response.status,
      retryable: false,
    };
  } catch (error) {
    return {
      ok: false,
      consistent: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

function replicaAck(snapshot: RouteSnapshot, ack: Record<string, unknown>): Omit<ReplicaAttemptResult, "retryable"> {
  const snapshotId = stringOrUndefined(ack.snapshotId);
  const generatedAt = stringOrUndefined(ack.generatedAt);
  if (ack.accepted === false) {
    return {
      ok: true,
      consistent: false,
      snapshotId,
      generatedAt,
      error: ack.stale === true ? "replica rejected stale snapshot" : "replica rejected snapshot",
    };
  }
  const sameId = snapshot.id === undefined || snapshotId === snapshot.id;
  const sameGeneratedAt = generatedAt === snapshot.generatedAt;
  if (!sameId || !sameGeneratedAt) {
    return {
      ok: true,
      consistent: false,
      snapshotId,
      generatedAt,
      error: "replica acknowledged a different snapshot",
    };
  }
  return {
    ok: true,
    consistent: true,
    snapshotId,
    generatedAt,
  };
}

function withReplicaTiming(
  target: RouteSnapshotReplicaTarget,
  result: ReplicaAttemptResult,
  attempts: number,
  startedMs: number,
  endedMs: number,
): RouteSnapshotReplicaResult {
  const { retryable: _retryable, ...replicaResult } = result;
  return {
    ...(target.id === undefined ? {} : { id: target.id }),
    region: target.region,
    url: target.url,
    ...replicaResult,
    attempts,
    elapsedMs: round3(Math.max(0, endedMs - startedMs)),
  };
}

function compareSnapshotFreshness(left: RouteSnapshot, right: RouteSnapshot): number {
  const generatedDelta = Date.parse(left.generatedAt) - Date.parse(right.generatedAt);
  if (Number.isFinite(generatedDelta) && generatedDelta !== 0) {
    return generatedDelta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function replicaHeaders(
  target: RouteSnapshotReplicaTarget,
  body: string,
  sourceRegion: string | undefined,
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    ...(sourceRegion ? { "x-oden-source-region": sourceRegion } : {}),
  };
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

interface ReplicaAttemptResult {
  ok: boolean;
  consistent: boolean;
  status?: number;
  snapshotId?: string;
  generatedAt?: string;
  error?: string;
  retryable: boolean;
}

interface NormalizedReplicationOptions {
  sourceRegion?: string;
  maxAttempts: number;
  retryDelayMs: number;
  timeoutMs?: number;
  retryOnStatuses: Set<number>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

function normalizeReplicationOptions(options: RouteSnapshotReplicationOptions): NormalizedReplicationOptions {
  return {
    sourceRegion: options.sourceRegion,
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

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function replicaEndpoint(baseUrl: string): string {
  new URL(baseUrl);
  return `${baseUrl.replace(/\/+$/, "")}/replication/snapshots/routes`;
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
