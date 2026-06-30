import type { RouteSnapshotEntry } from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import type {
  ArtifactStore,
  CompiledComponent,
  RouteMatchInput,
  RouteSnapshot,
  RuntimeBackend,
} from "./types.ts";

export interface RouteCache {
  match(input: RouteMatchInput): RouteSnapshotEntry | undefined;
  entries(): RouteSnapshotEntry[];
}

export interface RuntimeSupervisorOptions {
  snapshot: RouteSnapshot;
  artifactStore: ArtifactStore;
  backend: RuntimeBackend;
  warmupConcurrency?: number;
}

export function createRouteCache(snapshot: RouteSnapshot): RouteCache {
  const routes = [...snapshot.routes].sort(routePrecedence);

  return {
    match(input: RouteMatchInput): RouteSnapshotEntry | undefined {
      const host = normalizeHost(input.host);
      const path = normalizePath(input.path);
      return routes.find((route) => route.host === host && pathPrefixMatches(path, route.pathPrefix));
    },
    entries(): RouteSnapshotEntry[] {
      return [...routes];
    },
  };
}

export function createRuntimeSupervisor(options: RuntimeSupervisorOptions) {
  let routeCache = createRouteCache(options.snapshot);
  const prepared = new Map<string, Promise<CompiledComponent>>();

  async function prepareRoute(input: RouteMatchInput): Promise<CompiledComponent> {
    const route = routeCache.match(input);
    if (!route) {
      throw new RuntimeError("not_found", `no route matched ${input.host}${input.path}`);
    }
    return prepareDeployment(selectRouteTarget(route, input));
  }

  async function prepareDeployment(route: CompilableRouteTarget): Promise<CompiledComponent> {
    const existing = prepared.get(route.deploymentId);
    if (existing) {
      return existing;
    }

    const promise = materializeAndCompile(route).catch((error) => {
      prepared.delete(route.deploymentId);
      throw error;
    });
    prepared.set(route.deploymentId, promise);
    return promise;
  }

  async function materializeAndCompile(route: CompilableRouteTarget): Promise<CompiledComponent> {
    const artifact = await options.artifactStore.materialize(route.artifact);
    const compiled = await options.backend.compileComponent({
      deploymentId: route.deploymentId,
      projectId: route.projectId,
      world: route.world,
      runtime: route.runtime,
      limits: route.limits,
      capabilities: route.capabilities,
      artifact,
    });
    return {
      ...compiled,
      projectId: route.projectId,
      limits: route.limits,
      capabilities: route.capabilities,
    };
  }

  function loadSnapshot(snapshot: RouteSnapshot) {
    routeCache = createRouteCache(snapshot);
    const activeDeployments = snapshotDeploymentIds(snapshot);
    for (const deploymentId of prepared.keys()) {
      if (!activeDeployments.has(deploymentId)) {
        prepared.delete(deploymentId);
      }
    }
  }

  async function warmupSnapshot(snapshot: RouteSnapshot): Promise<CompiledComponent[]> {
    loadSnapshot(snapshot);
    return mapBounded(
      snapshotCompilableTargets(snapshot),
      boundedConcurrency(options.warmupConcurrency),
      prepareDeployment,
    );
  }

  async function preparedComponents(): Promise<CompiledComponent[]> {
    const settled = await Promise.allSettled(prepared.values());
    return settled
      .filter((result): result is PromiseFulfilledResult<CompiledComponent> => result.status === "fulfilled")
      .map((result) => result.value);
  }

  return {
    matchRoute(input: RouteMatchInput): RouteSnapshotEntry | undefined {
      return routeCache.match(input);
    },
    prepareRoute,
    prepareDeployment,
    preparedComponents,
    loadSnapshot,
    warmupSnapshot,
  };
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function boundedConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor(value));
}

function snapshotDeploymentIds(snapshot: RouteSnapshot): Set<string> {
  const deploymentIds = new Set<string>();
  for (const route of snapshot.routes) {
    deploymentIds.add(route.deploymentId);
    for (const target of route.targets ?? []) {
      deploymentIds.add(target.deploymentId);
    }
  }
  return deploymentIds;
}

type CompilableRouteTarget = Pick<
  RouteSnapshotEntry,
  "deploymentId" | "projectId" | "world" | "runtime" | "limits" | "capabilities" | "artifact"
>;

function snapshotCompilableTargets(snapshot: RouteSnapshot): CompilableRouteTarget[] {
  const targets = new Map<string, CompilableRouteTarget>();
  for (const route of snapshot.routes) {
    targets.set(route.deploymentId, route);
    for (const target of route.targets ?? []) {
      targets.set(target.deploymentId, {
        projectId: route.projectId,
        deploymentId: target.deploymentId,
        world: target.world,
        runtime: target.runtime,
        limits: target.limits,
        capabilities: target.capabilities,
        artifact: target.artifact,
      });
    }
  }
  return [...targets.values()];
}

function routePrecedence(left: RouteSnapshotEntry, right: RouteSnapshotEntry): number {
  const host = left.host.localeCompare(right.host);
  if (host !== 0) {
    return host;
  }
  return right.pathPrefix.length - left.pathPrefix.length;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

function normalizePath(path: string): string {
  if (path.length === 0) {
    return "/";
  }
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path;
}

function pathPrefixMatches(path: string, prefix: string): boolean {
  if (prefix === "/") {
    return true;
  }
  if (path === prefix) {
    return true;
  }
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(normalizedPrefix);
}

function selectRouteTarget(route: RouteSnapshotEntry, input: RouteMatchInput): CompilableRouteTarget {
  if (!route.targets || route.targets.length === 0) {
    return route;
  }
  const totalWeight = route.targets.reduce((sum, target) => sum + target.weight, 0);
  if (totalWeight <= 0) {
    return route;
  }
  const slot = stableHash(`${normalizeHost(input.host)}${normalizePath(input.path)}`) % totalWeight;
  let cursor = 0;
  for (const target of route.targets) {
    cursor += target.weight;
    if (slot < cursor) {
      return {
        projectId: route.projectId,
        deploymentId: target.deploymentId,
        world: target.world,
        runtime: target.runtime,
        limits: target.limits,
        capabilities: target.capabilities,
        artifact: target.artifact,
      };
    }
  }
  return route;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
