import { createHash } from "node:crypto";
import type { RouteSnapshot, RuntimeNode } from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export interface RuntimePlacementRule {
  regions?: string[];
  labels?: Record<string, string>;
  maxTargets?: number;
  failover?: RuntimePlacementFailoverRule[];
}

export interface RuntimePlacementFailoverRule {
  regions?: string[];
  labels?: Record<string, string>;
  maxTargets?: number;
}

export interface RuntimePlacementPolicy {
  default?: RuntimePlacementRule;
  projects?: Record<string, RuntimePlacementRule>;
  isolation?: RuntimePlacementIsolationPolicy;
}

export interface RuntimePlacementIsolationPolicy {
  projects?: Record<string, RuntimePlacementRule>;
  drainedProjects?: string[];
  excludeFromDefault?: boolean;
}

export interface RuntimeSnapshotPlacementPlan {
  node: RuntimeNode;
  snapshot: RouteSnapshot;
}

export function selectRuntimeNodesForSnapshot(
  nodes: RuntimeNode[],
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): RuntimeNode[] {
  if (!policy) {
    return nodes;
  }
  if (hasTenantIsolationPolicy(policy)) {
    return planRuntimeSnapshotPlacements(nodes, snapshot, policy).map((plan) => plan.node);
  }
  const projectIds = new Set(snapshot.routes.map((route) => route.projectId));
  if (projectIds.size === 0) {
    return nodes;
  }
  const selected = new Map<string, RuntimeNode>();
  let includeAll = false;
  for (const projectId of projectIds) {
    const rule = policy.projects?.[projectId] ?? policy.default;
    if (!rule) {
      includeAll = true;
      continue;
    }
    for (const node of selectByRule(nodes, rule)) {
      selected.set(node.id, node);
    }
  }
  if (includeAll) {
    return sortByLoad(nodes);
  }
  return sortByLoad([...selected.values()]);
}

export function planRuntimeSnapshotPlacements(
  nodes: RuntimeNode[],
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): RuntimeSnapshotPlacementPlan[] {
  if (!policy) {
    return sortByLoad(nodes).map((node) => ({ node, snapshot }));
  }
  const requiresDrainPublish = snapshotRequiresTenantDrainPublish(snapshot, policy);
  const publishEmptySnapshot = snapshot.routes.length === 0;
  return sortByLoad(nodes).flatMap((node) => {
    const nodeSnapshot = routeSnapshotForRuntimeNode(nodes, snapshot, node, policy);
    if (nodeSnapshot.routes.length === 0 && !requiresDrainPublish && !publishEmptySnapshot) {
      return [];
    }
    return [{ node, snapshot: nodeSnapshot }];
  });
}

export function routeSnapshotForRuntimeNode(
  nodes: RuntimeNode[],
  snapshot: RouteSnapshot,
  node: RuntimeNode,
  policy?: RuntimePlacementPolicy,
): RouteSnapshot {
  if (!policy) {
    return snapshot;
  }
  const isolationNodeIds = selectedIsolationNodeIds(nodes, policy);
  const routes = snapshot.routes.filter((route) =>
    routeVisibleToNode(nodes, route.projectId, node, policy, isolationNodeIds)
  );
  return snapshotWithRoutes(snapshot, routes);
}

export function defaultRouteSnapshotForTenantDrain(
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): RouteSnapshot {
  if (!policy || !hasTenantIsolationPolicy(policy)) {
    return snapshot;
  }
  const drainedProjects = new Set(policy.isolation?.drainedProjects ?? []);
  const isolatedProjects = new Set(Object.keys(policy.isolation?.projects ?? {}));
  const routes = snapshot.routes.filter((route) =>
    !drainedProjects.has(route.projectId) && !isolatedProjects.has(route.projectId)
  );
  return snapshotWithRoutes(snapshot, routes);
}

export function staticRouteSnapshotForPlacement(
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): RouteSnapshot {
  if (!policy) {
    return snapshot;
  }
  const routes = snapshot.routes.filter((route) => routeVisibleToStaticTarget(route.projectId, policy));
  return snapshotWithRoutes(snapshot, routes);
}

export function snapshotRequiresTenantDrainPublish(
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): boolean {
  if (!policy || !hasTenantIsolationPolicy(policy)) {
    return false;
  }
  const drainedProjects = new Set(policy.isolation?.drainedProjects ?? []);
  const isolatedProjects = new Set(Object.keys(policy.isolation?.projects ?? {}));
  return snapshot.routes.some((route) =>
    drainedProjects.has(route.projectId) || isolatedProjects.has(route.projectId)
  );
}

export function runtimePlacementPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimePlacementPolicy | undefined {
  const projects = isolationProjectsFromEnv(env);
  const drainedProjects = commaList(env.ODENCTL_DRAINED_PROJECTS);
  if (Object.keys(projects).length === 0 && drainedProjects.length === 0) {
    return undefined;
  }
  return {
    isolation: {
      ...(Object.keys(projects).length > 0 ? { projects } : {}),
      ...(drainedProjects.length > 0 ? { drainedProjects } : {}),
    },
  };
}

function selectByRule(nodes: RuntimeNode[], rule: RuntimePlacementRule): RuntimeNode[] {
  const primary = selectByTier(nodes, rule);
  if (primary.length > 0 || !rule.failover || rule.failover.length === 0) {
    return primary;
  }
  for (const failover of rule.failover) {
    const selected = selectByTier(nodes, failover);
    if (selected.length > 0) {
      return selected;
    }
  }
  return [];
}

function selectByTier(nodes: RuntimeNode[], rule: RuntimePlacementFailoverRule): RuntimeNode[] {
  const maxTargets = validateMaxTargets(rule.maxTargets);
  const regions = new Set((rule.regions ?? []).map((region) => region.toLowerCase()));
  const labels = rule.labels ?? {};
  const filtered = nodes.filter((node) => {
    if (regions.size > 0 && (!node.region || !regions.has(node.region.toLowerCase()))) {
      return false;
    }
    for (const [key, value] of Object.entries(labels)) {
      if (node.labels?.[key] !== value) {
        return false;
      }
    }
    return true;
  });
  const sorted = sortByLoad(filtered);
  return maxTargets === undefined ? sorted : sorted.slice(0, maxTargets);
}

function sortByLoad(nodes: RuntimeNode[]): RuntimeNode[] {
  return [...nodes].sort((left, right) => {
    const loadDelta = loadRatio(left) - loadRatio(right);
    if (loadDelta !== 0) {
      return loadDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function loadRatio(node: RuntimeNode): number {
  if (!node.capacity || !node.load) {
    return 0;
  }
  return node.load.activeRequests / node.capacity.concurrentRequests;
}

function routeVisibleToNode(
  nodes: RuntimeNode[],
  projectId: string,
  node: RuntimeNode,
  policy: RuntimePlacementPolicy,
  isolationNodeIds: Set<string>,
): boolean {
  const isolationRule = policy.isolation?.projects?.[projectId];
  if (isolationRule) {
    return nodeMatchesRule(nodes, node, isolationRule);
  }
  if (policy.isolation?.drainedProjects?.includes(projectId)) {
    return false;
  }
  const rule = policy.projects?.[projectId] ?? policy.default;
  if (!rule) {
    return !excludeIsolationNodeFromDefault(policy, node, isolationNodeIds);
  }
  return nodeMatchesRule(nodes, node, rule);
}

function routeVisibleToStaticTarget(projectId: string, policy: RuntimePlacementPolicy): boolean {
  if (policy.isolation?.drainedProjects?.includes(projectId)) {
    return false;
  }
  if (policy.isolation?.projects?.[projectId]) {
    return false;
  }
  if (policy.projects?.[projectId]) {
    return false;
  }
  return !policy.default;
}

function nodeMatchesRule(nodes: RuntimeNode[], node: RuntimeNode, rule: RuntimePlacementRule): boolean {
  return selectByRule(nodes, rule).some((selected) => selected.id === node.id);
}

function validateMaxTargets(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlPlaneError("validation", "placement maxTargets must be a positive integer");
  }
  return value;
}

function selectedIsolationNodeIds(nodes: RuntimeNode[], policy: RuntimePlacementPolicy): Set<string> {
  const ids = new Set<string>();
  for (const rule of Object.values(policy.isolation?.projects ?? {})) {
    for (const node of selectByRule(nodes, rule)) {
      ids.add(node.id);
    }
  }
  return ids;
}

function excludeIsolationNodeFromDefault(
  policy: RuntimePlacementPolicy,
  node: RuntimeNode,
  isolationNodeIds: Set<string>,
): boolean {
  return policy.isolation?.excludeFromDefault !== false && isolationNodeIds.has(node.id);
}

function hasTenantIsolationPolicy(policy: RuntimePlacementPolicy): boolean {
  return Boolean(
    Object.keys(policy.isolation?.projects ?? {}).length > 0 ||
      (policy.isolation?.drainedProjects?.length ?? 0) > 0,
  );
}

function snapshotWithRoutes(snapshot: RouteSnapshot, routes: RouteSnapshot["routes"]): RouteSnapshot {
  if (routes.length === snapshot.routes.length && routes.every((route, index) => route === snapshot.routes[index])) {
    return snapshot;
  }
  return {
    ...snapshot,
    id: placedSnapshotId(snapshot.generatedAt, routes),
    routes,
  };
}

function placedSnapshotId(generatedAt: string, routes: RouteSnapshot["routes"]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ generatedAt, routes }))
    .digest("hex")
    .slice(0, 16);
  return `snap_${digest}`;
}

function isolationProjectsFromEnv(env: Record<string, string | undefined>): Record<string, RuntimePlacementRule> {
  const labelKey = env.ODENCTL_ISOLATION_POOL_LABEL_KEY?.trim() || "pool";
  const projects: Record<string, RuntimePlacementRule> = {};
  for (const [projectId, pool] of projectValues(env.ODENCTL_ISOLATION_POOL_PROJECTS)) {
    projects[projectId] = { labels: { [labelKey]: pool } };
  }
  return projects;
}

function projectValues(raw: string | undefined): Array<[string, string]> {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw.split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      return [];
    }
    const projectId = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    return projectId && value ? [[projectId, value] as [string, string]] : [];
  });
}

function commaList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
