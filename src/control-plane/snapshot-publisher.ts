import type { RouteSnapshot } from "./contracts.ts";

export interface RuntimeNodeTarget {
  id?: string;
  url: string;
  token?: string;
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
  routes?: number;
  generatedAt?: string;
  snapshotId?: string;
  error?: string;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
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
): Promise<RouteSnapshotPublishReport> {
  const results = await Promise.all(
    targets.map((target) => publishToRuntimeNode(snapshot, target, fetchImpl)),
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
): Promise<RouteSnapshotPublishTargetResult> {
  try {
    const response = await fetchImpl(snapshotEndpoint(target.url), {
      method: "PUT",
      headers: publishHeaders(target),
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) {
      return withTarget(target, {
        ok: false,
        status: response.status,
        error: await response.text(),
      });
    }
    const ack = objectRecord(await response.json());
    return withTarget(target, {
      ok: true,
      status: response.status,
      routes: numberOrDefault(ack.routes, snapshot.routes.length),
      generatedAt: stringOrDefault(ack.generatedAt, snapshot.generatedAt),
      snapshotId: stringOrUndefined(ack.snapshotId, snapshot.id),
    });
  } catch (error) {
    return withTarget(target, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function publishHeaders(target: RuntimeNodeTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
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
