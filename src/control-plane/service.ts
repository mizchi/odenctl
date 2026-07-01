import { createHash, randomUUID } from "node:crypto";
import type {
  Artifact,
  CanaryDecision,
  CapabilityPolicy,
  Deployment,
  KvNamespace,
  Project,
  RoutePointer,
  RouteSnapshot,
  RouteSnapshotPublication,
  RouteSnapshotPublicationTarget,
  RouteTarget,
  RuntimeNode,
  RuntimeNodeCapacity,
  RuntimeNodeStatus,
  RuntimeLimits,
  RuntimeSpec,
  Secret,
} from "./contracts.ts";
import {
  normalizeCapabilities,
  normalizeArtifactProvenance,
  normalizeArtifactSignature,
  normalizeDigest,
  normalizeHost,
  normalizeKvNamespaceName,
  normalizeLimits,
  normalizeLocation,
  normalizePathPrefix,
  normalizeProjectName,
  normalizeRuntime,
  normalizeRouteTargets,
  normalizeRuntimeNodeCapacity,
  normalizeRuntimeNodeHostInfo,
  normalizeRuntimeNodeIdentity,
  normalizeRuntimeNodeLabels,
  normalizeRuntimeNodeLoad,
  normalizeRuntimeNodeRegion,
  normalizeRuntimeNodeStatus,
  normalizeRuntimeNodeUrl,
  normalizeSecretName,
  normalizeSecretValue,
  normalizeSizeBytes,
  normalizeWorld,
  optionalId,
  workerWorldVersion,
} from "./contracts.ts";
import type { ControlPlaneRepository, ProjectResourceUsage } from "./repository.ts";
import { ControlPlaneError } from "./errors.ts";
import type { SecretCipher } from "./secret-encryption.ts";
import { enforceProjectQuota, type ProjectQuotaResource, type ProjectQuotas } from "./quotas.ts";
import type { ArtifactSignatureVerifier } from "./artifact-signing.ts";
import {
  analyzeCanaryEvents,
  type CanaryAnalysisThresholds,
  type CanaryMetricEvent,
} from "./canary-analysis.ts";

export interface ControlPlaneOptions {
  repository: ControlPlaneRepository;
  idGenerator?: (prefix: string) => string;
  now?: () => string;
  runtimeNodeActiveTtlMs?: number;
  secretCipher?: SecretCipher;
  projectQuotas?: ProjectQuotas;
  artifactSignatureVerifier?: ArtifactSignatureVerifier;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
}

export interface CreateArtifactInput {
  id?: string;
  projectId: string;
  digest: string;
  location: string;
  sizeBytes: number;
  signature?: unknown;
  provenance?: unknown;
}

export interface GetProjectArtifactByDigestInput {
  projectId: string;
  digest: string;
}

export interface GetProjectUsageInput {
  projectId: string;
}

export interface CreateSecretInput {
  id?: string;
  projectId: string;
  name: string;
  value: string;
}

export interface GetSecretInput {
  id: string;
}

export interface ListProjectSecretsInput {
  projectId: string;
}

export interface UpdateSecretValueInput {
  id: string;
  value: string;
}

export interface DeleteSecretInput {
  id: string;
}

export interface CreateKvNamespaceInput {
  id?: string;
  projectId: string;
  name: string;
}

export interface GetKvNamespaceInput {
  id: string;
}

export interface ListProjectKvNamespacesInput {
  projectId: string;
}

export interface DeleteKvNamespaceInput {
  id: string;
}

export interface CreateDeploymentInput {
  id?: string;
  projectId: string;
  artifactId: string;
  world: string;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: Partial<CapabilityPolicy>;
}

export interface PointRouteInput {
  id?: string;
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId?: string;
  targets?: RouteTarget[];
}

export interface StartRouteCanaryInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId: string;
  weight: number;
}

export interface RollbackRouteInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId?: string;
}

export interface AnalyzeRouteCanaryInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  candidateDeploymentId: string;
  events: CanaryMetricEvent[];
  thresholds: CanaryAnalysisThresholds;
}

export interface AnalyzeRouteCanaryOutput {
  decision: CanaryDecision;
  route: RoutePointer;
}

export interface RegisterRuntimeNodeInput {
  id?: string;
  url: string;
  status?: RuntimeNodeStatus;
  region?: string;
  labels?: Record<string, string>;
  identity?: unknown;
  host?: unknown;
}

export interface RecordRuntimeNodeHeartbeatInput {
  id: string;
  status?: RuntimeNodeStatus;
  version?: string;
  capacity?: RuntimeNodeCapacity;
  load?: RuntimeNode["load"];
  identity?: unknown;
  host?: unknown;
}

export interface UpdateRuntimeNodeStatusInput {
  id: string;
  status: RuntimeNodeStatus;
}

export interface CleanupRuntimeNodesInput {
  olderThanMs: number;
  statuses?: unknown;
}

export interface CleanupRuntimeNodesOutput {
  cutoff: string;
  removed: RuntimeNode[];
}

export interface RecordRouteSnapshotPublicationInput {
  snapshotId?: string;
  snapshotGeneratedAt: string;
  routes: number;
  ok: boolean;
  targets: RouteSnapshotPublicationTarget[];
}

export function createControlPlane(options: ControlPlaneOptions) {
  const repository = options.repository;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const now = options.now ?? (() => new Date().toISOString());
  const runtimeNodeActiveTtlMs = options.runtimeNodeActiveTtlMs;
  const secretCipher = options.secretCipher;
  const projectQuotas = options.projectQuotas;
  const artifactSignatureVerifier = options.artifactSignatureVerifier;

  function createProject(input: CreateProjectInput): Project {
    const project: Project = {
      id: optionalId(input.id, "project id") ?? idGenerator("prj"),
      name: normalizeProjectName(input.name),
      createdAt: now(),
    };
    return repository.createProject(project);
  }

  function createArtifact(input: CreateArtifactInput): Artifact {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "artifact");
    const artifact: Artifact = {
      id: optionalId(input.id, "artifact id") ?? idGenerator("art"),
      projectId: input.projectId,
      digest: normalizeDigest(input.digest),
      location: normalizeLocation(input.location),
      sizeBytes: normalizeSizeBytes(input.sizeBytes),
      signature: normalizeArtifactSignature(input.signature),
      provenance: normalizeArtifactProvenance(input.provenance),
      createdAt: now(),
    };
    return repository.createArtifact(artifact);
  }

  function getProjectArtifactByDigest(input: GetProjectArtifactByDigestInput): Artifact | undefined {
    requireProject(repository, input.projectId);
    return repository.getArtifactByProjectDigest(input.projectId, normalizeDigest(input.digest));
  }

  function getProjectUsage(input: GetProjectUsageInput): ProjectResourceUsage {
    requireProject(repository, input.projectId);
    return repository.getProjectUsage(input.projectId);
  }

  function createSecret(input: CreateSecretInput): Secret {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "secret");
    const secret: Secret = {
      id: optionalId(input.id, "secret id") ?? idGenerator("sec"),
      projectId: input.projectId,
      name: normalizeSecretName(input.name),
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createSecret(secret, encodeSecretValue(normalizeSecretValue(input.value)));
  }

  function getSecret(input: GetSecretInput): Secret {
    return requireSecret(repository, input.id);
  }

  function listProjectSecrets(input: ListProjectSecretsInput): Secret[] {
    requireProject(repository, input.projectId);
    return repository.listProjectSecrets(input.projectId);
  }

  function updateSecretValue(input: UpdateSecretValueInput): Secret {
    requireSecret(repository, input.id);
    return repository.updateSecretValue(input.id, encodeSecretValue(normalizeSecretValue(input.value)), now());
  }

  function deleteSecret(input: DeleteSecretInput): void {
    requireSecret(repository, input.id);
    repository.deleteSecret(input.id);
  }

  function createKvNamespace(input: CreateKvNamespaceInput): KvNamespace {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "kv namespace");
    const namespace: KvNamespace = {
      id: optionalId(input.id, "kv namespace id") ?? idGenerator("kv"),
      projectId: input.projectId,
      name: normalizeKvNamespaceName(input.name),
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createKvNamespace(namespace);
  }

  function getKvNamespace(input: GetKvNamespaceInput): KvNamespace {
    return requireKvNamespace(repository, input.id);
  }

  function listProjectKvNamespaces(input: ListProjectKvNamespacesInput): KvNamespace[] {
    requireProject(repository, input.projectId);
    return repository.listProjectKvNamespaces(input.projectId);
  }

  function deleteKvNamespace(input: DeleteKvNamespaceInput): void {
    requireKvNamespace(repository, input.id);
    repository.deleteKvNamespace(input.id);
  }

  function createDeployment(input: CreateDeploymentInput): Deployment {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "deployment");
    const artifact = requireArtifact(repository, input.artifactId);
    if (artifact.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "deployment artifact must belong to the same project");
    }
    artifactSignatureVerifier?.verify(artifact);
    const capabilities = normalizeCapabilities(input.capabilities);
    requireDeploymentKvNamespaces(repository, input.projectId, capabilities);
    requireDeploymentSecrets(repository, input.projectId, capabilities);

    const world = normalizeWorld(input.world);
    const deployment: Deployment = {
      id: optionalId(input.id, "deployment id") ?? idGenerator("dep"),
      projectId: input.projectId,
      artifactId: input.artifactId,
      world,
      worldVersion: workerWorldVersion(world),
      runtime: normalizeRuntime(input.runtime),
      limits: normalizeLimits(input.limits),
      capabilities,
      createdAt: now(),
    };
    return repository.createDeployment(deployment);
  }

  function pointRoute(input: PointRouteInput): RoutePointer {
    requireProject(repository, input.projectId);
    const targets = normalizeRouteTargets(input.targets, input.deploymentId);
    for (const target of targets) {
      const deployment = requireDeployment(repository, target.deploymentId);
      if (deployment.projectId !== input.projectId) {
        throw new ControlPlaneError("validation", "route deployment must belong to the same project");
      }
    }

    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    if (!repository.getRoute(input.projectId, host, pathPrefix)) {
      enforceQuota(input.projectId, "route");
    }

    const route: RoutePointer = {
      id: optionalId(input.id, "route id") ?? idGenerator("rte"),
      projectId: input.projectId,
      host,
      pathPrefix,
      deploymentId: targets[0].deploymentId,
      targets,
      updatedAt: now(),
    };
    return repository.upsertRoute(route);
  }

  function startRouteCanary(input: StartRouteCanaryInput): RoutePointer {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const candidate = requireDeployment(repository, input.deploymentId);
    if (candidate.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "canary deployment must belong to the same project");
    }
    const stableDeploymentId = existing.targets[0]?.deploymentId ?? existing.deploymentId;
    if (stableDeploymentId === candidate.id) {
      throw new ControlPlaneError("validation", "canary deployment must differ from stable deployment");
    }
    const weight = canaryWeight(input.weight);
    return repository.upsertRoute({
      ...existing,
      deploymentId: stableDeploymentId,
      targets: [
        { deploymentId: stableDeploymentId, weight: 100 - weight },
        { deploymentId: candidate.id, weight },
      ],
      updatedAt: now(),
    });
  }

  function rollbackRoute(input: RollbackRouteInput): RoutePointer {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const deploymentId = input.deploymentId ?? existing.targets[0]?.deploymentId ?? existing.deploymentId;
    const deployment = requireDeployment(repository, deploymentId);
    if (deployment.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "rollback deployment must belong to the same project");
    }
    return repository.upsertRoute({
      ...existing,
      deploymentId,
      targets: [{ deploymentId, weight: 100 }],
      updatedAt: now(),
    });
  }

  function analyzeRouteCanary(input: AnalyzeRouteCanaryInput): AnalyzeRouteCanaryOutput {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const stableDeploymentId = existing.targets[0]?.deploymentId ?? existing.deploymentId;
    const candidate = requireDeployment(repository, input.candidateDeploymentId);
    if (candidate.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "canary deployment must belong to the same project");
    }
    if (!existing.targets.some((target) => target.deploymentId === candidate.id)) {
      throw new ControlPlaneError("validation", "canary deployment is not a target of the route");
    }

    const analysis = analyzeCanaryEvents(input.events, candidate.id, input.thresholds);
    const decision = repository.createCanaryDecision({
      id: idGenerator("can"),
      projectId: input.projectId,
      host,
      pathPrefix,
      stableDeploymentId,
      candidateDeploymentId: candidate.id,
      action: analysis.action,
      reason: analysis.reason,
      metrics: analysis.metrics,
      thresholds: input.thresholds,
      createdAt: now(),
    });
    const route = analysis.action === "rollback"
      ? repository.upsertRoute({
        ...existing,
        deploymentId: stableDeploymentId,
        targets: [{ deploymentId: stableDeploymentId, weight: 100 }],
        updatedAt: now(),
      })
      : existing;
    return { decision, route };
  }

  function createRouteSnapshot(): RouteSnapshot {
    const routes = repository.listRoutes().map((route) => {
      const targets = route.targets.map((target) => routeSnapshotTarget(target));
      const primary = targets[0];
      return {
        host: route.host,
        pathPrefix: route.pathPrefix,
        projectId: route.projectId,
        deploymentId: primary.deploymentId,
        targets,
        world: primary.world,
        worldVersion: primary.worldVersion,
        runtime: primary.runtime,
        limits: primary.limits,
        capabilities: primary.capabilities,
        artifact: routeSnapshotArtifact(primary.artifact),
      };
    });

    const generatedAt = now();
    return {
      id: snapshotId(generatedAt, routes),
      schemaVersion: 1,
      generatedAt,
      routes,
    };
  }

  function registerRuntimeNode(input: RegisterRuntimeNodeInput): RuntimeNode {
    const identity = normalizeRuntimeNodeIdentity(input.identity);
    const host = normalizeRuntimeNodeHostInfo(input.host);
    const node: RuntimeNode = {
      id: optionalId(input.id, "runtime node id") ?? idGenerator("rt"),
      url: normalizeRuntimeNodeUrl(input.url),
      status: normalizeRuntimeNodeStatus(input.status),
      registeredAt: now(),
      region: normalizeRuntimeNodeRegion(input.region),
      labels: normalizeRuntimeNodeLabels(input.labels),
      ...(identity ? { identity } : {}),
      ...(host ? { host } : {}),
    };
    return repository.createRuntimeNode(node);
  }

  function recordRuntimeNodeHeartbeat(input: RecordRuntimeNodeHeartbeatInput): RuntimeNode {
    const existing = repository.getRuntimeNode(input.id);
    if (!existing) {
      throw new ControlPlaneError("not_found", `runtime node ${input.id} was not found`);
    }
    const node: RuntimeNode = {
      ...existing,
      status: normalizeRuntimeNodeStatus(input.status),
      lastSeenAt: now(),
      version: input.version ?? existing.version,
      capacity: normalizeRuntimeNodeCapacity(input.capacity) ?? existing.capacity,
      load: normalizeRuntimeNodeLoad(input.load) ?? existing.load,
      identity: normalizeRuntimeNodeIdentity(input.identity) ?? existing.identity,
      host: normalizeRuntimeNodeHostInfo(input.host) ?? existing.host,
    };
    return repository.updateRuntimeNodeHeartbeat(node);
  }

  function updateRuntimeNodeStatus(input: UpdateRuntimeNodeStatusInput): RuntimeNode {
    return repository.updateRuntimeNodeStatus(input.id, normalizeRuntimeNodeStatus(input.status));
  }

  function cleanupRuntimeNodes(input: CleanupRuntimeNodesInput): CleanupRuntimeNodesOutput {
    const olderThanMs = cleanupOlderThanMs(input.olderThanMs);
    const statuses = cleanupStatuses(input.statuses);
    const cutoffMs = Date.parse(now()) - olderThanMs;
    const cutoff = new Date(cutoffMs).toISOString();
    const removed = repository.listRuntimeNodes().filter((node) =>
      statuses.has(node.status) && runtimeNodeObservedAtMs(node) < cutoffMs
    );
    for (const node of removed) {
      repository.deleteRuntimeNode(node.id);
    }
    return { cutoff, removed };
  }

  function listRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes();
  }

  function listActiveRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes().filter((node) => isActiveRuntimeNode(node, now(), runtimeNodeActiveTtlMs));
  }

  function recordRouteSnapshotPublication(
    input: RecordRouteSnapshotPublicationInput,
  ): RouteSnapshotPublication {
    return repository.createRouteSnapshotPublication({
      id: idGenerator("pub"),
      snapshotId: input.snapshotId,
      snapshotGeneratedAt: input.snapshotGeneratedAt,
      routes: input.routes,
      ok: input.ok,
      targets: input.targets,
      createdAt: now(),
    });
  }

  function listRouteSnapshotPublications(): RouteSnapshotPublication[] {
    return repository.listRouteSnapshotPublications();
  }

  function listCanaryDecisions(): CanaryDecision[] {
    return repository.listCanaryDecisions();
  }

  return {
    createProject,
    getProjectUsage,
    createArtifact,
    getProjectArtifactByDigest,
    createSecret,
    getSecret,
    listProjectSecrets,
    updateSecretValue,
    deleteSecret,
    createKvNamespace,
    getKvNamespace,
    listProjectKvNamespaces,
    deleteKvNamespace,
    createDeployment,
    pointRoute,
    startRouteCanary,
    analyzeRouteCanary,
    rollbackRoute,
    createRouteSnapshot,
    registerRuntimeNode,
    recordRuntimeNodeHeartbeat,
    updateRuntimeNodeStatus,
    cleanupRuntimeNodes,
    listRuntimeNodes,
    listActiveRuntimeNodes,
    recordRouteSnapshotPublication,
    listRouteSnapshotPublications,
    listCanaryDecisions,
  };

  function routeSnapshotTarget(target: RouteTarget) {
    const deployment = requireDeployment(repository, target.deploymentId);
    const artifact = requireArtifact(repository, deployment.artifactId);
    return {
      deploymentId: deployment.id,
      weight: target.weight,
      world: deployment.world,
      worldVersion: deployment.worldVersion,
      runtime: deployment.runtime,
      limits: deployment.limits,
      capabilities: deployment.capabilities,
      artifact: routeSnapshotArtifact(artifact),
    };
  }

  function routeSnapshotArtifact(artifact: Artifact) {
    return {
      id: artifact.id,
      digest: artifact.digest,
      location: artifact.location,
      ...(artifact.signature ? { signature: artifact.signature } : {}),
      ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
    };
  }

  function encodeSecretValue(value: string): string {
    return secretCipher ? secretCipher.encrypt(value) : value;
  }

  function enforceQuota(projectId: string, resource: ProjectQuotaResource) {
    enforceProjectQuota(projectId, projectQuotas, repository.getProjectUsage(projectId), resource);
  }
}

function isActiveRuntimeNode(
  node: RuntimeNode,
  nowValue: string,
  activeTtlMs: number | undefined,
): boolean {
  if (node.status !== "active") {
    return false;
  }
  if (activeTtlMs === undefined || !node.lastSeenAt) {
    return !isSaturatedRuntimeNode(node);
  }
  return Date.parse(nowValue) - Date.parse(node.lastSeenAt) <= activeTtlMs && !isSaturatedRuntimeNode(node);
}

function isSaturatedRuntimeNode(node: RuntimeNode): boolean {
  return Boolean(
    node.capacity
      && node.load
      && node.load.activeRequests >= node.capacity.concurrentRequests,
  );
}

function cleanupOlderThanMs(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ControlPlaneError("validation", "runtime node cleanup olderThanMs must be a positive integer");
  }
  return value as number;
}

function cleanupStatuses(value: unknown): Set<RuntimeNodeStatus> {
  if (value === undefined) {
    return new Set(["offline"]);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlPlaneError("validation", "runtime node cleanup statuses must be a non-empty array");
  }
  return new Set(value.map((status) => normalizeRuntimeNodeStatus(status)));
}

function runtimeNodeObservedAtMs(node: RuntimeNode): number {
  return Date.parse(node.lastSeenAt ?? node.registeredAt);
}

function requireProject(repository: ControlPlaneRepository, id: string): Project {
  const project = repository.getProject(id);
  if (!project) {
    throw new ControlPlaneError("not_found", `project ${id} was not found`);
  }
  return project;
}

function requireArtifact(repository: ControlPlaneRepository, id: string): Artifact {
  const artifact = repository.getArtifact(id);
  if (!artifact) {
    throw new ControlPlaneError("not_found", `artifact ${id} was not found`);
  }
  return artifact;
}

function requireSecret(repository: ControlPlaneRepository, id: string): Secret {
  const secret = repository.getSecret(id);
  if (!secret) {
    throw new ControlPlaneError("not_found", `secret ${id} was not found`);
  }
  return secret;
}

function requireKvNamespace(repository: ControlPlaneRepository, id: string): KvNamespace {
  const namespace = repository.getKvNamespace(id);
  if (!namespace) {
    throw new ControlPlaneError("not_found", `kv namespace ${id} was not found`);
  }
  return namespace;
}

function requireDeploymentKvNamespaces(
  repository: ControlPlaneRepository,
  projectId: string,
  capabilities: CapabilityPolicy,
) {
  for (const binding of capabilities.kv) {
    const namespace = repository.getKvNamespace(binding.namespaceId);
    if (!namespace) {
      throw new ControlPlaneError("validation", `kv namespace ${binding.namespaceId} was not found`);
    }
    if (namespace.projectId !== projectId) {
      throw new ControlPlaneError(
        "validation",
        `deployment kv namespace ${binding.namespaceId} must belong to the same project`,
      );
    }
  }
}

function requireDeploymentSecrets(
  repository: ControlPlaneRepository,
  projectId: string,
  capabilities: CapabilityPolicy,
) {
  for (const binding of capabilities.secrets) {
    const secret = repository.getSecret(binding.secretId);
    if (!secret) {
      throw new ControlPlaneError("validation", `secret ${binding.secretId} was not found`);
    }
    if (secret.projectId !== projectId) {
      throw new ControlPlaneError(
        "validation",
        `deployment secret ${binding.secretId} must belong to the same project`,
      );
    }
  }
}

function requireDeployment(repository: ControlPlaneRepository, id: string): Deployment {
  const deployment = repository.getDeployment(id);
  if (!deployment) {
    throw new ControlPlaneError("not_found", `deployment ${id} was not found`);
  }
  return deployment;
}

function requireRoute(
  repository: ControlPlaneRepository,
  projectId: string,
  host: string,
  pathPrefix: string,
): RoutePointer {
  const route = repository.getRoute(projectId, host, pathPrefix);
  if (!route) {
    throw new ControlPlaneError("not_found", `route ${host}${pathPrefix} was not found`);
  }
  return route;
}

function canaryWeight(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99) {
    throw new ControlPlaneError("validation", "canary weight must be an integer between 1 and 99");
  }
  return value as number;
}

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function snapshotId(generatedAt: string, routes: RouteSnapshot["routes"]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ generatedAt, routes }))
    .digest("hex")
    .slice(0, 16);
  return `snap_${digest}`;
}
