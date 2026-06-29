import { randomUUID } from "node:crypto";
import type {
  Artifact,
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
  MVP_WORKER_WORLD,
  normalizeCapabilities,
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
  normalizeRuntimeNodeStatus,
  normalizeRuntimeNodeUrl,
  normalizeSecretName,
  normalizeSecretValue,
  normalizeSizeBytes,
  normalizeWorld,
  optionalId,
} from "./contracts.ts";
import type { ControlPlaneRepository } from "./repository.ts";
import { ControlPlaneError } from "./errors.ts";

export interface ControlPlaneOptions {
  repository: ControlPlaneRepository;
  idGenerator?: (prefix: string) => string;
  now?: () => string;
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
}

export interface GetProjectArtifactByDigestInput {
  projectId: string;
  digest: string;
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

export interface RegisterRuntimeNodeInput {
  id?: string;
  url: string;
}

export interface RecordRuntimeNodeHeartbeatInput {
  id: string;
  status?: RuntimeNodeStatus;
  version?: string;
  capacity?: RuntimeNodeCapacity;
}

export interface RecordRouteSnapshotPublicationInput {
  snapshotGeneratedAt: string;
  routes: number;
  ok: boolean;
  targets: RouteSnapshotPublicationTarget[];
}

export function createControlPlane(options: ControlPlaneOptions) {
  const repository = options.repository;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const now = options.now ?? (() => new Date().toISOString());

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
    const artifact: Artifact = {
      id: optionalId(input.id, "artifact id") ?? idGenerator("art"),
      projectId: input.projectId,
      digest: normalizeDigest(input.digest),
      location: normalizeLocation(input.location),
      sizeBytes: normalizeSizeBytes(input.sizeBytes),
      createdAt: now(),
    };
    return repository.createArtifact(artifact);
  }

  function getProjectArtifactByDigest(input: GetProjectArtifactByDigestInput): Artifact | undefined {
    requireProject(repository, input.projectId);
    return repository.getArtifactByProjectDigest(input.projectId, normalizeDigest(input.digest));
  }

  function createSecret(input: CreateSecretInput): Secret {
    requireProject(repository, input.projectId);
    const secret: Secret = {
      id: optionalId(input.id, "secret id") ?? idGenerator("sec"),
      projectId: input.projectId,
      name: normalizeSecretName(input.name),
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createSecret(secret, normalizeSecretValue(input.value));
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
    return repository.updateSecretValue(input.id, normalizeSecretValue(input.value), now());
  }

  function deleteSecret(input: DeleteSecretInput): void {
    requireSecret(repository, input.id);
    repository.deleteSecret(input.id);
  }

  function createKvNamespace(input: CreateKvNamespaceInput): KvNamespace {
    requireProject(repository, input.projectId);
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
    const artifact = requireArtifact(repository, input.artifactId);
    if (artifact.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "deployment artifact must belong to the same project");
    }
    const capabilities = normalizeCapabilities(input.capabilities);
    requireDeploymentKvNamespaces(repository, input.projectId, capabilities);
    requireDeploymentSecrets(repository, input.projectId, capabilities);

    const deployment: Deployment = {
      id: optionalId(input.id, "deployment id") ?? idGenerator("dep"),
      projectId: input.projectId,
      artifactId: input.artifactId,
      world: normalizeWorld(input.world),
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

    const route: RoutePointer = {
      id: optionalId(input.id, "route id") ?? idGenerator("rte"),
      projectId: input.projectId,
      host: normalizeHost(input.host),
      pathPrefix: normalizePathPrefix(input.pathPrefix),
      deploymentId: targets[0].deploymentId,
      targets,
      updatedAt: now(),
    };
    return repository.upsertRoute(route);
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
        runtime: primary.runtime,
        limits: primary.limits,
        capabilities: primary.capabilities,
        artifact: {
          id: primary.artifact.id,
          digest: primary.artifact.digest,
          location: primary.artifact.location,
        },
      };
    });

    return {
      schemaVersion: 1,
      generatedAt: now(),
      routes,
    };
  }

  function registerRuntimeNode(input: RegisterRuntimeNodeInput): RuntimeNode {
    const node: RuntimeNode = {
      id: optionalId(input.id, "runtime node id") ?? idGenerator("rt"),
      url: normalizeRuntimeNodeUrl(input.url),
      status: "active",
      registeredAt: now(),
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
    };
    return repository.updateRuntimeNodeHeartbeat(node);
  }

  function listRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes();
  }

  function listActiveRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes().filter((node) => node.status === "active");
  }

  function recordRouteSnapshotPublication(
    input: RecordRouteSnapshotPublicationInput,
  ): RouteSnapshotPublication {
    return repository.createRouteSnapshotPublication({
      id: idGenerator("pub"),
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

  return {
    createProject,
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
    createRouteSnapshot,
    registerRuntimeNode,
    recordRuntimeNodeHeartbeat,
    listRuntimeNodes,
    listActiveRuntimeNodes,
    recordRouteSnapshotPublication,
    listRouteSnapshotPublications,
  };

  function routeSnapshotTarget(target: RouteTarget) {
    const deployment = requireDeployment(repository, target.deploymentId);
    const artifact = requireArtifact(repository, deployment.artifactId);
    return {
      deploymentId: deployment.id,
      weight: target.weight,
      world: MVP_WORKER_WORLD,
      runtime: deployment.runtime,
      limits: deployment.limits,
      capabilities: deployment.capabilities,
      artifact: {
        id: artifact.id,
        digest: artifact.digest,
        location: artifact.location,
      },
    };
  }
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

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
