import { randomUUID } from "node:crypto";
import type {
  Artifact,
  CapabilityPolicy,
  Deployment,
  Project,
  RoutePointer,
  RouteSnapshot,
  RuntimeLimits,
  RuntimeSpec,
} from "./contracts.ts";
import {
  MVP_WORKER_WORLD,
  normalizeCapabilities,
  normalizeDigest,
  normalizeHost,
  normalizeLimits,
  normalizeLocation,
  normalizePathPrefix,
  normalizeProjectName,
  normalizeRuntime,
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
  deploymentId: string;
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

  function createDeployment(input: CreateDeploymentInput): Deployment {
    requireProject(repository, input.projectId);
    const artifact = requireArtifact(repository, input.artifactId);
    if (artifact.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "deployment artifact must belong to the same project");
    }

    const deployment: Deployment = {
      id: optionalId(input.id, "deployment id") ?? idGenerator("dep"),
      projectId: input.projectId,
      artifactId: input.artifactId,
      world: normalizeWorld(input.world),
      runtime: normalizeRuntime(input.runtime),
      limits: normalizeLimits(input.limits),
      capabilities: normalizeCapabilities(input.capabilities),
      createdAt: now(),
    };
    return repository.createDeployment(deployment);
  }

  function pointRoute(input: PointRouteInput): RoutePointer {
    requireProject(repository, input.projectId);
    const deployment = requireDeployment(repository, input.deploymentId);
    if (deployment.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "route deployment must belong to the same project");
    }

    const route: RoutePointer = {
      id: optionalId(input.id, "route id") ?? idGenerator("rte"),
      projectId: input.projectId,
      host: normalizeHost(input.host),
      pathPrefix: normalizePathPrefix(input.pathPrefix),
      deploymentId: input.deploymentId,
      updatedAt: now(),
    };
    return repository.upsertRoute(route);
  }

  function createRouteSnapshot(): RouteSnapshot {
    const routes = repository.listRoutes().map((route) => {
      const deployment = requireDeployment(repository, route.deploymentId);
      const artifact = requireArtifact(repository, deployment.artifactId);
      return {
        host: route.host,
        pathPrefix: route.pathPrefix,
        projectId: route.projectId,
        deploymentId: deployment.id,
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
    });

    return {
      schemaVersion: 1,
      generatedAt: now(),
      routes,
    };
  }

  return {
    createProject,
    createArtifact,
    createDeployment,
    pointRoute,
    createRouteSnapshot,
  };
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
