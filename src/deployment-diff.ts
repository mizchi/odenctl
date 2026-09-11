import type {
  CapabilityPolicy,
  RouteSnapshot,
  RouteSnapshotEntry,
  RouteTarget,
  RuntimeLimits,
  RuntimeSpec,
} from "./control-plane/contracts.ts";

export type DeploymentDiffAction = "create" | "update" | "unchanged";

export interface DeploymentDiffChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface DeploymentDiff {
  route: {
    action: DeploymentDiffAction;
    host: string;
    pathPrefix: string;
    beforeDeploymentId?: string;
    afterDeploymentId: string;
    beforeTargets: RouteTarget[];
    afterTargets: RouteTarget[];
  };
  changes: DeploymentDiffChange[];
}

export function createDeploymentDiff(input: {
  before?: RouteSnapshot | RouteSnapshotEntry;
  after: RouteSnapshotEntry;
}): DeploymentDiff {
  const before = beforeRoute(input.before, input.after);
  const changes: DeploymentDiffChange[] = [];
  const beforeTargets = routeTargets(before);
  const afterTargets = routeTargets(input.after);

  addChange(changes, "route.deploymentId", before?.deploymentId, input.after.deploymentId);
  addChange(changes, "route.targets", beforeTargets, afterTargets);
  addRuntimeChanges(changes, before?.runtime, input.after.runtime);
  addLimitChanges(changes, before?.limits, input.after.limits);
  addCapabilityChanges(changes, before?.capabilities, input.after.capabilities);

  return {
    route: {
      action: before ? routeAction(changes) : "create",
      host: input.after.host,
      pathPrefix: input.after.pathPrefix,
      beforeDeploymentId: before?.deploymentId,
      afterDeploymentId: input.after.deploymentId,
      beforeTargets,
      afterTargets,
    },
    changes,
  };
}

function beforeRoute(
  before: RouteSnapshot | RouteSnapshotEntry | undefined,
  after: RouteSnapshotEntry,
): RouteSnapshotEntry | undefined {
  if (!before) {
    return undefined;
  }
  if ("routes" in before) {
    return before.routes.find((route) =>
      route.projectId === after.projectId && route.host === after.host && route.pathPrefix === after.pathPrefix
    );
  }
  return before;
}

function routeAction(changes: DeploymentDiffChange[]): DeploymentDiffAction {
  return changes.some((change) => change.path === "route.deploymentId" || change.path === "route.targets")
    ? "update"
    : "unchanged";
}

function routeTargets(route: RouteSnapshotEntry | undefined): RouteTarget[] {
  return (route?.targets ?? []).map((target) => ({
    deploymentId: target.deploymentId,
    weight: target.weight,
  }));
}

function addRuntimeChanges(
  changes: DeploymentDiffChange[],
  before: RuntimeSpec | undefined,
  after: RuntimeSpec,
) {
  addChange(changes, "runtime.backend", before?.backend, after.backend);
  addChange(changes, "runtime.version", before?.version, after.version);
  addChange(changes, "runtime.wasi", before?.wasi, after.wasi);
}

function addLimitChanges(
  changes: DeploymentDiffChange[],
  before: RuntimeLimits | undefined,
  after: RuntimeLimits,
) {
  for (
    const key of [
      "cpuMs",
      "memoryMb",
      "wallMs",
      "requestBytes",
      "responseBytes",
      "subrequests",
    ] as const
  ) {
    addChange(changes, `limits.${key}`, before?.[key], after[key]);
  }
}

function addCapabilityChanges(
  changes: DeploymentDiffChange[],
  before: CapabilityPolicy | undefined,
  after: CapabilityPolicy,
) {
  addChange(changes, "capabilities.outboundHttp.enabled", before?.outboundHttp.enabled, after.outboundHttp.enabled);
  addChange(
    changes,
    "capabilities.outboundHttp.allow",
    before ? sortedStrings(before.outboundHttp.allow) : undefined,
    sortedStrings(after.outboundHttp.allow),
  );
  addChange(changes, "capabilities.kv", before ? normalizeKv(before.kv) : undefined, normalizeKv(after.kv));
  addChange(
    changes,
    "capabilities.durableObjects",
    before ? normalizeDurableObjects(before.durableObjects) : undefined,
    normalizeDurableObjects(after.durableObjects),
  );
  addChange(
    changes,
    "capabilities.secrets",
    before ? normalizeSecrets(before.secrets) : undefined,
    normalizeSecrets(after.secrets),
  );
  addChange(
    changes,
    "capabilities.services",
    before ? normalizeServices(before.services) : undefined,
    normalizeServices(after.services),
  );
  addChange(changes, "capabilities.arbitraryFilesystem", before?.arbitraryFilesystem, after.arbitraryFilesystem);
  addChange(changes, "capabilities.arbitrarySockets", before?.arbitrarySockets, after.arbitrarySockets);
  addChange(changes, "capabilities.processSpawn", before?.processSpawn, after.processSpawn);
}

function addChange(changes: DeploymentDiffChange[], path: string, before: unknown, after: unknown) {
  if (stableJson(before) === stableJson(after)) {
    return;
  }
  changes.push({ path, before, after });
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort();
}

function normalizeKv(values: CapabilityPolicy["kv"]) {
  return [...values]
    .map((value) => ({ binding: value.binding, namespaceId: value.namespaceId }))
    .sort((a, b) => `${a.binding}\0${a.namespaceId}`.localeCompare(`${b.binding}\0${b.namespaceId}`));
}

function normalizeDurableObjects(values: CapabilityPolicy["durableObjects"] | undefined) {
  return [...(values ?? [])]
    .map((value) => ({ binding: value.binding, namespaceId: value.namespaceId }))
    .sort((a, b) => `${a.binding}\0${a.namespaceId}`.localeCompare(`${b.binding}\0${b.namespaceId}`));
}

function normalizeSecrets(values: CapabilityPolicy["secrets"]) {
  return [...values]
    .map((value) => ({ binding: value.binding, secretId: value.secretId }))
    .sort((a, b) => `${a.binding}\0${a.secretId}`.localeCompare(`${b.binding}\0${b.secretId}`));
}

function normalizeServices(values: CapabilityPolicy["services"] | undefined) {
  return [...(values ?? [])]
    .map((value) => ({
      binding: value.binding,
      targetProjectId: value.targetProjectId,
      url: value.url,
    }))
    .sort((a, b) =>
      `${a.binding}\0${a.targetProjectId}\0${a.url}`.localeCompare(
        `${b.binding}\0${b.targetProjectId}\0${b.url}`,
      )
    );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
