import { pathToFileURL } from "node:url";
import type { RouteSnapshot, RuntimeNode } from "../../crates/odenctl/src/control-plane/contracts.ts";
import {
  planRuntimeSnapshotPlacements,
  staticRouteSnapshotForPlacement,
  type RuntimePlacementPolicy,
} from "../../crates/odenctl/src/control-plane/placement.ts";

export interface FormalRoutePlacementReport {
  source: string[];
  tool: string;
  scope: string;
  findings: FormalFinding[];
  sanity: FormalSanityCheck[];
}

export interface FormalFinding {
  id: string;
  severity: "high" | "medium" | "low";
  expectedClaim: string;
  implementationObservation: string;
  modelQuestion: string;
  machineResult: "counterexample";
  witness: Record<string, unknown>;
  domainQuestion: string;
  suggestedLock: string;
}

export interface FormalSanityCheck {
  id: string;
  ok: boolean;
  evidence: Record<string, unknown>;
}

interface StaticRuntimeTarget {
  id: string;
  url: string;
}

interface ModeledPublishTarget {
  id: string;
  url: string;
  source: "static" | "registered";
  routes: string[];
}

const generatedAt = "2026-06-26T10:00:00.000Z";

export function runRouteSnapshotPlacementModel(): FormalRoutePlacementReport {
  return {
    source: [
      "README.md: runtime node placement and production posture",
      "docs/developer/roadmap.md: runtime node placement, drain, and cross-region snapshot tasks",
      "crates/odenctl/src/http/app.ts: publishTargets",
      "crates/odenctl/src/control-plane/placement.ts: planRuntimeSnapshotPlacements and staticRouteSnapshotForPlacement",
      "crates/odenctl/src/control-plane/service.ts: isActiveRuntimeNode",
      "tests/placement.test.ts and tests/http-api.test.ts: behavioral regression locks",
    ],
    tool: "bounded TypeScript relation/state model",
    scope: "route snapshot publication target selection, placement policy, static targets, and active-node freshness",
    findings: [],
    sanity: [
      duplicateStaticTargetKeepsRegisteredSnapshot(),
      staticTargetIsFilteredByPlacementPolicy(),
      ttlModeRequiresHeartbeat(),
      maxTargetsZeroIsRejected(),
      isolatedRouteIsDeliveredWithoutStaticDuplicate(),
      drainedTenantPublishesEmptySnapshots(),
      primaryPlacementPreventsFailoverWhenPrimaryExists(),
      saturatedNodeIsExcludedByActivePredicate(),
    ],
  };
}

export function formatRouteSnapshotPlacementReport(report: FormalRoutePlacementReport): string {
  const lines = [
    "# Route Snapshot Placement Formal Ledger",
    "",
    `tool: ${report.tool}`,
    `scope: ${report.scope}`,
    "",
    "## Sources",
    ...report.source.map((source) => `- ${source}`),
    "",
    "## Findings",
  ];

  if (report.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of report.findings) {
      lines.push(
        "",
        `### ${finding.id} (${finding.severity})`,
        "",
        `expected claim: ${finding.expectedClaim}`,
        "",
        `implementation observation: ${finding.implementationObservation}`,
        "",
        `model question: ${finding.modelQuestion}`,
        "",
        `machine result: ${finding.machineResult}`,
        "",
        "witness:",
        "```json",
        JSON.stringify(finding.witness, null, 2),
        "```",
        "",
        `domain question: ${finding.domainQuestion}`,
        "",
        `lock: ${finding.suggestedLock}`,
      );
    }
  }

  lines.push("", "## Regression And Sanity Checks");
  for (const check of report.sanity) {
    lines.push(
      "",
      `- ${check.id}: ${check.ok ? "ok" : "failed"}`,
      "```json",
      JSON.stringify(check.evidence, null, 2),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

function duplicateStaticTargetKeepsRegisteredSnapshot(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_isolated"]);
  const targets = implementationPublishTargets({
    snapshot,
    nodes: [
      runtimeNode("rt_isolated", "http://runtime.local", { pool: "isolation" }),
    ],
    staticTargets: [{ id: "static-runtime", url: "http://runtime.local" }],
    policy: isolationPolicy(),
  });
  return {
    id: "regression-static-duplicate-keeps-registered-snapshot",
    ok: targets.length === 1
      && targets[0]?.id === "rt_isolated"
      && targets[0]?.source === "registered"
      && targets[0]?.routes.join(",") === "prj_isolated",
    evidence: { targets },
  };
}

function staticTargetIsFilteredByPlacementPolicy(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_place"]);
  const policy: RuntimePlacementPolicy = {
    projects: {
      prj_place: { regions: ["nrt"], labels: { pool: "default" } },
    },
  };
  const targets = implementationPublishTargets({
    snapshot,
    nodes: [
      runtimeNode("rt_nrt", "http://nrt.runtime.local", { pool: "default" }, { region: "nrt" }),
    ],
    staticTargets: [{ id: "static-iad", url: "http://iad.runtime.local" }],
    policy,
  });
  const staticTarget = targets.find((target) => target.id === "static-iad");
  return {
    id: "regression-static-target-filtered-by-placement",
    ok: staticTarget !== undefined && staticTarget.routes.length === 0,
    evidence: { targets },
  };
}

function ttlModeRequiresHeartbeat(): FormalSanityCheck {
  const node = runtimeNode("rt_registered", "http://runtime.local", {}, {
    registeredAt: "2026-06-26T10:00:00.000Z",
  });
  const now = "2026-06-26T12:00:00.000Z";
  const ttlMs = 60_000;
  return {
    id: "regression-ttl-mode-requires-heartbeat",
    ok: !implementationActiveRuntimeNode(node, now, ttlMs),
    evidence: {
      node: {
        id: node.id,
        status: node.status,
        registeredAt: node.registeredAt,
        lastSeenAt: node.lastSeenAt,
      },
      now,
      ttlMs,
      active: implementationActiveRuntimeNode(node, now, ttlMs),
    },
  };
}

function maxTargetsZeroIsRejected(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_zero"]);
  const policy: RuntimePlacementPolicy = {
    projects: {
      prj_zero: {
        regions: ["nrt"],
        maxTargets: 0,
        failover: [{ regions: ["iad"] }],
      },
    },
  };
  let error: unknown;
  try {
    implementationPublishTargets({
      snapshot,
      nodes: [
        runtimeNode("rt_nrt", "http://nrt.runtime.local", {}, { region: "nrt" }),
        runtimeNode("rt_iad", "http://iad.runtime.local", {}, { region: "iad" }),
      ],
      staticTargets: [],
      policy,
    });
  } catch (caught) {
    error = caught;
  }
  return {
    id: "regression-max-targets-zero-rejected",
    ok: error instanceof Error && /maxTargets/.test(error.message),
    evidence: {
      policy,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function isolatedRouteIsDeliveredWithoutStaticDuplicate(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_isolated"]);
  const targets = implementationPublishTargets({
    snapshot,
    nodes: [
      runtimeNode("rt_default", "http://default.runtime.local", { pool: "default" }),
      runtimeNode("rt_isolated", "http://isolated.runtime.local", { pool: "isolation" }),
    ],
    staticTargets: [],
    policy: isolationPolicy(),
  });
  return {
    id: "sanity-isolated-route-delivered",
    ok: projectsDeliveredByUrl(targets, "http://isolated.runtime.local").includes("prj_isolated"),
    evidence: { targets },
  };
}

function drainedTenantPublishesEmptySnapshots(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_drained"]);
  const targets = implementationPublishTargets({
    snapshot,
    nodes: [
      runtimeNode("rt_a", "http://a.runtime.local", { pool: "default" }),
      runtimeNode("rt_b", "http://b.runtime.local", { pool: "isolation" }),
    ],
    staticTargets: [],
    policy: { isolation: { drainedProjects: ["prj_drained"] } },
  });
  return {
    id: "sanity-drained-tenant-empty-snapshot",
    ok: targets.length === 2 && targets.every((target) => target.routes.length === 0),
    evidence: { targets },
  };
}

function primaryPlacementPreventsFailoverWhenPrimaryExists(): FormalSanityCheck {
  const snapshot = routeSnapshot(["prj_primary"]);
  const targets = implementationPublishTargets({
    snapshot,
    nodes: [
      runtimeNode("rt_nrt", "http://nrt.runtime.local", {}, { region: "nrt" }),
      runtimeNode("rt_iad", "http://iad.runtime.local", {}, { region: "iad" }),
    ],
    staticTargets: [],
    policy: {
      projects: {
        prj_primary: {
          regions: ["nrt"],
          failover: [{ regions: ["iad"] }],
        },
      },
    },
  });
  return {
    id: "sanity-primary-before-failover",
    ok: targets.map((target) => target.id).join(",") === "rt_nrt",
    evidence: { targets },
  };
}

function saturatedNodeIsExcludedByActivePredicate(): FormalSanityCheck {
  const fresh = runtimeNode("rt_room", "http://room.runtime.local", {}, {
    capacity: 2,
    activeRequests: 1,
    lastSeenAt: "2026-06-26T10:00:00.000Z",
  });
  const saturated = runtimeNode("rt_full", "http://full.runtime.local", {}, {
    capacity: 2,
    activeRequests: 2,
    lastSeenAt: "2026-06-26T10:00:00.000Z",
  });
  const now = "2026-06-26T10:00:30.000Z";
  return {
    id: "sanity-saturated-node-excluded",
    ok: implementationActiveRuntimeNode(fresh, now, 60_000)
      && !implementationActiveRuntimeNode(saturated, now, 60_000),
    evidence: {
      fresh: implementationActiveRuntimeNode(fresh, now, 60_000),
      saturated: implementationActiveRuntimeNode(saturated, now, 60_000),
    },
  };
}

function implementationPublishTargets(input: {
  snapshot: RouteSnapshot;
  nodes: RuntimeNode[];
  staticTargets: StaticRuntimeTarget[];
  policy?: RuntimePlacementPolicy;
}): ModeledPublishTarget[] {
  const placedTargets = input.policy
    ? planRuntimeSnapshotPlacements(input.nodes, input.snapshot, input.policy).map((plan) => ({
      id: plan.node.id,
      url: plan.node.url,
      source: "registered" as const,
      routes: plan.snapshot.routes.map((route) => route.projectId),
    }))
    : input.nodes.map((node) => ({
      id: node.id,
      url: node.url,
      source: "registered" as const,
      routes: input.snapshot.routes.map((route) => route.projectId),
    }));
  const staticSnapshot = staticRouteSnapshotForPlacement(input.snapshot, input.policy);
  const staticTargets = input.staticTargets.map((target) => ({
    id: target.id,
    url: normalizeUrl(target.url),
    source: "static" as const,
    routes: staticSnapshot.routes.map((route) => route.projectId),
  }));
  const seen = new Set<string>();
  return [...placedTargets, ...staticTargets].filter((target) => {
    if (seen.has(target.url)) {
      return false;
    }
    seen.add(target.url);
    return true;
  });
}

function implementationActiveRuntimeNode(node: RuntimeNode, now: string, ttlMs: number | undefined): boolean {
  if (node.status !== "active") {
    return false;
  }
  if (isSaturated(node)) {
    return false;
  }
  if (ttlMs === undefined) {
    return true;
  }
  if (!node.lastSeenAt) {
    return false;
  }
  return Date.parse(now) - Date.parse(node.lastSeenAt) <= ttlMs;
}

function projectsDeliveredByUrl(targets: ModeledPublishTarget[], url: string): string[] {
  return targets.find((target) => target.url === normalizeUrl(url))?.routes ?? [];
}

function isSaturated(node: RuntimeNode): boolean {
  return Boolean(node.capacity && node.load && node.load.activeRequests >= node.capacity.concurrentRequests);
}

function isolationPolicy(): RuntimePlacementPolicy {
  return {
    default: { labels: { pool: "default" } },
    isolation: {
      projects: {
        prj_isolated: { labels: { pool: "isolation" } },
      },
    },
  };
}

function runtimeNode(
  id: string,
  url: string,
  labels: Record<string, string>,
  overrides: {
    region?: string;
    status?: RuntimeNode["status"];
    registeredAt?: string;
    lastSeenAt?: string;
    capacity?: number;
    activeRequests?: number;
  } = {},
): RuntimeNode {
  return {
    id,
    url: normalizeUrl(url),
    status: overrides.status ?? "active",
    registeredAt: overrides.registeredAt ?? generatedAt,
    ...(overrides.lastSeenAt !== undefined ? { lastSeenAt: overrides.lastSeenAt } : {}),
    region: overrides.region ?? "nrt",
    labels,
    capacity: { concurrentRequests: overrides.capacity ?? 100, memoryMb: 1024 },
    load: { activeRequests: overrides.activeRequests ?? 0 },
  };
}

function routeSnapshot(projectIds: string[]): RouteSnapshot {
  return {
    id: `snap_${projectIds.join("_") || "empty"}`,
    schemaVersion: 1,
    generatedAt,
    routes: projectIds.map((projectId) => ({
      host: `${projectId}.example.dev`,
      pathPrefix: "/",
      projectId,
      deploymentId: `dep_${projectId}`,
      targets: [{
        deploymentId: `dep_${projectId}`,
        weight: 100,
        world: "wasi:http/service@0.3.0",
        worldVersion: "0.3.0",
        runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
        limits: limits(),
        capabilities: capabilities(),
        artifact: artifact(projectId),
      }],
      world: "wasi:http/service@0.3.0",
      worldVersion: "0.3.0",
      runtime: { backend: "wasmtime", version: "wasmtime-43", wasi: "wasip3" },
      limits: limits(),
      capabilities: capabilities(),
      artifact: artifact(projectId),
    })),
  };
}

function limits() {
  return {
    cpuMs: 50,
    memoryMb: 64,
    wallMs: 1000,
    requestBytes: 1048576,
    responseBytes: 1048576,
    subrequests: 20,
  };
}

function capabilities() {
  return {
    outboundHttp: { enabled: false, allow: [] },
    kv: [],
    secrets: [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
}

function artifact(projectId: string) {
  return {
    id: `art_${projectId}`,
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    location: "file:///tmp/worker.wasm",
  };
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const report = runRouteSnapshotPlacementModel();
  console.log(formatRouteSnapshotPlacementReport(report));
  if (process.argv.includes("--strict") && report.findings.length > 0) {
    process.exitCode = 1;
  }
}
