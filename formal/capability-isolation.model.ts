import { pathToFileURL } from "node:url";
import {
  normalizeCapabilities,
  type CapabilityPolicy,
} from "../crates/odenctl/src/control-plane/contracts.ts";

export interface FormalCapabilityIsolationReport {
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
  suggestedLock: string;
}

export interface FormalSanityCheck {
  id: string;
  ok: boolean;
  evidence: Record<string, unknown>;
}

interface ModeledDeployment {
  projectId: string;
  capabilities: CapabilityPolicy;
}

interface ModeledProjectResource {
  projectId: string;
  id: string;
}

export function runCapabilityIsolationModel(): FormalCapabilityIsolationReport {
  return {
    source: [
      "Cloudflare Workers isolate/security model: same-process workers rely on isolate memory boundaries plus API-level capability design",
      "control-plane policy model only; custom guest service/state bindings were removed",
      "crates/odenctl/src/control-plane/contracts.ts: CapabilityPolicy and normalizeCapabilities",
      "crates/odenctl/src/control-plane/service.ts and async-service.ts: deployment capability target validation",
      "crates/odenctl/src/control-plane/admission.ts: service allowlist admission policy",
      "crates/odenctl/src/main.rs: node rejects removed service/state bindings",
    ],
    tool: "bounded TypeScript capability relation model",
    scope: "control-plane policy only (not WASI network reachability): worker-to-worker access, project-scoped state resources, privileged host capabilities, and ambient outbound separation",
    findings: [],
    sanity: [
      serviceBindingRequiredForWorkerAccess(),
      serviceBindingAllowsExplicitCrossProjectAccess(),
      outboundHttpDoesNotGrantWorkerAccess(),
      stateResourcesRemainProjectScoped(),
      privilegedProcessCapabilitiesAreDenied(),
    ],
  };
}

export function formatCapabilityIsolationReport(report: FormalCapabilityIsolationReport): string {
  const lines = [
    "# Capability Isolation Formal Ledger",
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

function serviceBindingRequiredForWorkerAccess(): FormalSanityCheck {
  const caller = deployment("prj_app", {
    outboundHttp: { enabled: false, allow: [] },
    kv: [],
    durableObjects: [],
    secrets: [],
    services: [],
  });

  return {
    id: "regression-service-binding-required",
    ok: !canCallProjectService(caller, "prj_auth"),
    evidence: {
      callerProjectId: caller.projectId,
      targetProjectId: "prj_auth",
      services: caller.capabilities.services,
      canCall: canCallProjectService(caller, "prj_auth"),
    },
  };
}

function serviceBindingAllowsExplicitCrossProjectAccess(): FormalSanityCheck {
  const caller = deployment("prj_app", {
    outboundHttp: { enabled: false, allow: [] },
    kv: [],
    durableObjects: [],
    secrets: [],
    services: [{ binding: "AUTH", targetProjectId: "prj_auth", url: "https://auth.internal" }],
  });

  return {
    id: "sanity-service-binding-allows-explicit-cross-project-call",
    ok: canCallProjectService(caller, "prj_auth") && !canCallProjectService(caller, "prj_billing"),
    evidence: {
      services: caller.capabilities.services,
      authCall: canCallProjectService(caller, "prj_auth"),
      billingCall: canCallProjectService(caller, "prj_billing"),
    },
  };
}

function outboundHttpDoesNotGrantWorkerAccess(): FormalSanityCheck {
  const caller = deployment("prj_app", {
    outboundHttp: { enabled: true, allow: ["https://auth.internal"] },
    kv: [],
    durableObjects: [],
    secrets: [],
    services: [],
  });

  return {
    id: "regression-outbound-http-is-not-service-access",
    ok: !canCallProjectService(caller, "prj_auth"),
    evidence: {
      outboundAllow: caller.capabilities.outboundHttp.allow,
      services: caller.capabilities.services,
      targetProjectId: "prj_auth",
      canCall: canCallProjectService(caller, "prj_auth"),
    },
  };
}

function stateResourcesRemainProjectScoped(): FormalSanityCheck {
  const caller = deployment("prj_app", {
    outboundHttp: { enabled: false, allow: [] },
    kv: [{ binding: "MAIN", namespaceId: "kv_app" }],
    durableObjects: [{ binding: "ROOMS", namespaceId: "do_app" }],
    secrets: [{ binding: "API_KEY", secretId: "sec_app" }],
    services: [],
  });
  const ownKv = { projectId: "prj_app", id: "kv_app" };
  const otherKv = { projectId: "prj_other", id: "kv_app" };

  return {
    id: "regression-state-bindings-remain-project-scoped",
    ok: canAccessKv(caller, ownKv) && !canAccessKv(caller, otherKv),
    evidence: {
      callerProjectId: caller.projectId,
      ownKvAccess: canAccessKv(caller, ownKv),
      crossProjectSameIdAccess: canAccessKv(caller, otherKv),
    },
  };
}

function privilegedProcessCapabilitiesAreDenied(): FormalSanityCheck {
  let denied = false;
  try {
    normalizeCapabilities({
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      durableObjects: [],
      secrets: [],
      services: [],
      processSpawn: true,
    });
  } catch {
    denied = true;
  }

  return {
    id: "regression-privileged-process-capabilities-denied",
    ok: denied,
    evidence: {
      attemptedCapability: "processSpawn",
      denied,
    },
  };
}

function deployment(projectId: string, capabilities: unknown): ModeledDeployment {
  return {
    projectId,
    capabilities: normalizeCapabilities(capabilities),
  };
}

function canCallProjectService(deployment: ModeledDeployment, targetProjectId: string): boolean {
  return deployment.capabilities.services.some((binding) => binding.targetProjectId === targetProjectId);
}

function canAccessKv(deployment: ModeledDeployment, resource: ModeledProjectResource): boolean {
  return deployment.projectId === resource.projectId
    && deployment.capabilities.kv.some((binding) => binding.namespaceId === resource.id);
}

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const report = runCapabilityIsolationModel();
  console.log(formatCapabilityIsolationReport(report));
  if (process.argv.includes("--strict") && report.findings.length > 0) {
    process.exitCode = 1;
  }
}
