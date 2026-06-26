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
    return prepareDeployment(route);
  }

  async function prepareDeployment(route: RouteSnapshotEntry): Promise<CompiledComponent> {
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

  async function materializeAndCompile(route: RouteSnapshotEntry): Promise<CompiledComponent> {
    const artifact = await options.artifactStore.materialize(route.artifact);
    return options.backend.compileComponent({
      deploymentId: route.deploymentId,
      projectId: route.projectId,
      world: route.world,
      runtime: route.runtime,
      limits: route.limits,
      capabilities: route.capabilities,
      artifact,
    });
  }

  function loadSnapshot(snapshot: RouteSnapshot) {
    routeCache = createRouteCache(snapshot);
  }

  return {
    matchRoute(input: RouteMatchInput): RouteSnapshotEntry | undefined {
      return routeCache.match(input);
    },
    prepareRoute,
    prepareDeployment,
    loadSnapshot,
  };
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
