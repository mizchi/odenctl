import type { RouteSnapshot, RuntimeNode } from "./contracts.ts";

export interface RuntimePlacementRule {
  regions?: string[];
  labels?: Record<string, string>;
  maxTargets?: number;
}

export interface RuntimePlacementPolicy {
  default?: RuntimePlacementRule;
  projects?: Record<string, RuntimePlacementRule>;
}

export function selectRuntimeNodesForSnapshot(
  nodes: RuntimeNode[],
  snapshot: RouteSnapshot,
  policy?: RuntimePlacementPolicy,
): RuntimeNode[] {
  if (!policy) {
    return nodes;
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

function selectByRule(nodes: RuntimeNode[], rule: RuntimePlacementRule): RuntimeNode[] {
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
  return rule.maxTargets === undefined ? sorted : sorted.slice(0, Math.max(0, rule.maxTargets));
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
