import type {
  RouteSnapshot,
  RuntimeNode,
  RuntimeNodeCapacity,
  RuntimeNodeLoad,
  RuntimeNodeStatus,
} from "./contracts.ts";
import { publishRouteSnapshot, type FetchLike } from "./snapshot-publisher.ts";

export interface RuntimeSaturationSignal {
  id: string;
  url: string;
  status: RuntimeNodeStatus;
  activeRequests: number;
  concurrentRequests: number;
  loadRatio: number;
  saturated: boolean;
}

export interface RuntimeAutoscalingPolicy {
  minNodes: number;
  maxNodes: number;
  targetLoadRatio: number;
  scaleUpThreshold?: number;
  scaleDownThreshold?: number;
  scaleUpStep?: number;
  scaleDownStep?: number;
}

export type RuntimeAutoscalingAction = "scale_up" | "scale_down" | "none";

export interface RuntimeAutoscalingDecision {
  action: RuntimeAutoscalingAction;
  reason:
    | "below_min_nodes"
    | "above_max_nodes"
    | "load_above_threshold"
    | "load_below_threshold"
    | "within_thresholds";
  currentNodes: number;
  desiredNodes: number;
  add: number;
  remove: number;
  averageLoadRatio: number;
  candidateNodeIds: string[];
}

export interface WarmAndActivateRuntimeNodeInput {
  controlPlane: {
    registerRuntimeNode(input: {
      id: string;
      url: string;
      status?: RuntimeNodeStatus;
      region?: string;
      labels?: Record<string, string>;
    }): unknown;
    recordRuntimeNodeHeartbeat(input: {
      id: string;
      status?: RuntimeNodeStatus;
      version?: string;
      capacity?: RuntimeNodeCapacity;
      load?: RuntimeNodeLoad;
    }): unknown;
  };
  runtimeNode: {
    id: string;
    url: string;
    region?: string;
    labels?: Record<string, string>;
    version?: string;
    capacity?: RuntimeNodeCapacity;
    load?: RuntimeNodeLoad;
  };
  snapshot: RouteSnapshot;
  runtimeNodeToken?: string;
  fetch?: FetchLike;
}

export function runtimeSaturationSignals(nodes: RuntimeNode[]): RuntimeSaturationSignal[] {
  return nodes.map((node) => {
    const concurrentRequests = node.capacity?.concurrentRequests ?? 0;
    const activeRequests = node.load?.activeRequests ?? 0;
    const loadRatio = concurrentRequests > 0 ? round3(activeRequests / concurrentRequests) : 0;
    return {
      id: node.id,
      url: node.url,
      status: node.status,
      activeRequests,
      concurrentRequests,
      loadRatio,
      saturated: concurrentRequests > 0 && activeRequests >= concurrentRequests,
    };
  });
}

export function decideRuntimeAutoscaling(
  nodes: RuntimeNode[],
  policy: RuntimeAutoscalingPolicy,
): RuntimeAutoscalingDecision {
  const activeNodes = nodes.filter((node) => node.status === "active");
  const currentNodes = activeNodes.length;
  const averageLoadRatio = averageSignalLoad(runtimeSaturationSignals(activeNodes));
  const minNodes = Math.max(0, policy.minNodes);
  const maxNodes = Math.max(minNodes, policy.maxNodes);
  const scaleUpStep = Math.max(1, policy.scaleUpStep ?? 1);
  const scaleDownStep = Math.max(1, policy.scaleDownStep ?? 1);
  const scaleUpThreshold = policy.scaleUpThreshold ?? policy.targetLoadRatio;
  const scaleDownThreshold = policy.scaleDownThreshold ?? policy.targetLoadRatio / 2;

  if (currentNodes < minNodes) {
    const desiredNodes = Math.min(maxNodes, minNodes);
    return decision("scale_up", "below_min_nodes", currentNodes, desiredNodes, averageLoadRatio, []);
  }
  if (currentNodes > maxNodes) {
    const desiredNodes = maxNodes;
    return decision(
      "scale_down",
      "above_max_nodes",
      currentNodes,
      desiredNodes,
      averageLoadRatio,
      scaleDownCandidates(activeNodes, currentNodes - desiredNodes),
    );
  }
  if (currentNodes < maxNodes && averageLoadRatio >= scaleUpThreshold) {
    const desiredNodes = Math.min(maxNodes, currentNodes + scaleUpStep);
    return decision("scale_up", "load_above_threshold", currentNodes, desiredNodes, averageLoadRatio, []);
  }
  if (currentNodes > minNodes && averageLoadRatio <= scaleDownThreshold) {
    const desiredNodes = Math.max(minNodes, currentNodes - scaleDownStep);
    return decision(
      "scale_down",
      "load_below_threshold",
      currentNodes,
      desiredNodes,
      averageLoadRatio,
      scaleDownCandidates(activeNodes, currentNodes - desiredNodes),
    );
  }
  return decision("none", "within_thresholds", currentNodes, currentNodes, averageLoadRatio, []);
}

export async function warmAndActivateRuntimeNode(input: WarmAndActivateRuntimeNodeInput) {
  input.controlPlane.registerRuntimeNode({
    id: input.runtimeNode.id,
    url: input.runtimeNode.url,
    status: "draining",
    region: input.runtimeNode.region,
    labels: input.runtimeNode.labels,
  });
  input.controlPlane.recordRuntimeNodeHeartbeat({
    id: input.runtimeNode.id,
    status: "draining",
    version: input.runtimeNode.version,
    capacity: input.runtimeNode.capacity,
    load: input.runtimeNode.load ?? { activeRequests: 0 },
  });
  const report = await publishRouteSnapshot(
    input.snapshot,
    [{ id: input.runtimeNode.id, url: input.runtimeNode.url, token: input.runtimeNodeToken }],
    input.fetch,
  );
  if (report.ok) {
    input.controlPlane.recordRuntimeNodeHeartbeat({
      id: input.runtimeNode.id,
      status: "active",
      version: input.runtimeNode.version,
      capacity: input.runtimeNode.capacity,
      load: input.runtimeNode.load ?? { activeRequests: 0 },
    });
  }
  return report;
}

function decision(
  action: RuntimeAutoscalingDecision["action"],
  reason: RuntimeAutoscalingDecision["reason"],
  currentNodes: number,
  desiredNodes: number,
  averageLoadRatio: number,
  candidateNodeIds: string[],
): RuntimeAutoscalingDecision {
  return {
    action,
    reason,
    currentNodes,
    desiredNodes,
    add: Math.max(0, desiredNodes - currentNodes),
    remove: Math.max(0, currentNodes - desiredNodes),
    averageLoadRatio,
    candidateNodeIds,
  };
}

function averageSignalLoad(signals: RuntimeSaturationSignal[]): number {
  if (signals.length === 0) {
    return 0;
  }
  return round3(signals.reduce((sum, signal) => sum + signal.loadRatio, 0) / signals.length);
}

function scaleDownCandidates(nodes: RuntimeNode[], count: number): string[] {
  return [...nodes]
    .sort((left, right) => loadRatio(left) - loadRatio(right) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, count))
    .map((node) => node.id);
}

function loadRatio(node: RuntimeNode): number {
  if (!node.capacity || !node.load || node.capacity.concurrentRequests <= 0) {
    return 0;
  }
  return node.load.activeRequests / node.capacity.concurrentRequests;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
