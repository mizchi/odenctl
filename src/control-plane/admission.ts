import type {
  Artifact,
  CapabilityPolicy,
  RuntimeSpec,
} from "./contracts.ts";
import { ControlPlaneError } from "./errors.ts";

export interface ControlPlaneAdmissionPolicy {
  requireArtifactSignature?: boolean;
  allowedArtifactSignatureKeyIds?: string[];
  maxArtifactSizeBytes?: number;
  allowedWorlds?: string[];
  allowedWorldVersions?: string[];
  allowedOutboundHttpPrefixes?: string[];
  allowedKvNamespaceIds?: string[];
  allowedDurableObjectNamespaceIds?: string[];
  allowedSecretIds?: string[];
  allowedServiceProjectIds?: string[];
  allowedServiceUrlPrefixes?: string[];
}

export interface DeploymentAdmissionInput {
  artifact: Artifact;
  world: string;
  worldVersion: string;
  runtime: RuntimeSpec;
  capabilities: CapabilityPolicy;
}

export function admissionPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): ControlPlaneAdmissionPolicy | undefined {
  const policy: ControlPlaneAdmissionPolicy = {};
  if (truthy(env.WASMPLANE_ADMISSION_REQUIRE_ARTIFACT_SIGNATURE)) {
    policy.requireArtifactSignature = true;
  }
  const signatureKeyIds = csv(env.WASMPLANE_ADMISSION_ARTIFACT_SIGNATURE_KEY_IDS);
  if (signatureKeyIds.length > 0) {
    policy.allowedArtifactSignatureKeyIds = signatureKeyIds;
  }
  const maxArtifactSizeBytes = positiveInteger(env.WASMPLANE_ADMISSION_MAX_ARTIFACT_SIZE_BYTES);
  if (maxArtifactSizeBytes) {
    policy.maxArtifactSizeBytes = maxArtifactSizeBytes;
  }
  const worlds = csv(env.WASMPLANE_ADMISSION_ALLOWED_WORLDS);
  if (worlds.length > 0) {
    policy.allowedWorlds = worlds;
  }
  const worldVersions = csv(env.WASMPLANE_ADMISSION_ALLOWED_WORLD_VERSIONS);
  if (worldVersions.length > 0) {
    policy.allowedWorldVersions = worldVersions;
  }
  const outboundPrefixes = csv(env.WASMPLANE_ADMISSION_OUTBOUND_HTTP_PREFIXES);
  if (outboundPrefixes.length > 0) {
    policy.allowedOutboundHttpPrefixes = outboundPrefixes;
  }
  const kvNamespaceIds = csv(env.WASMPLANE_ADMISSION_KV_NAMESPACE_IDS);
  if (kvNamespaceIds.length > 0) {
    policy.allowedKvNamespaceIds = kvNamespaceIds;
  }
  const durableObjectNamespaceIds = csv(env.WASMPLANE_ADMISSION_DURABLE_OBJECT_NAMESPACE_IDS);
  if (durableObjectNamespaceIds.length > 0) {
    policy.allowedDurableObjectNamespaceIds = durableObjectNamespaceIds;
  }
  const secretIds = csv(env.WASMPLANE_ADMISSION_SECRET_IDS);
  if (secretIds.length > 0) {
    policy.allowedSecretIds = secretIds;
  }
  const serviceProjectIds = csv(env.WASMPLANE_ADMISSION_SERVICE_PROJECT_IDS);
  if (serviceProjectIds.length > 0) {
    policy.allowedServiceProjectIds = serviceProjectIds;
  }
  const serviceUrlPrefixes = csv(env.WASMPLANE_ADMISSION_SERVICE_URL_PREFIXES);
  if (serviceUrlPrefixes.length > 0) {
    policy.allowedServiceUrlPrefixes = serviceUrlPrefixes;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function enforceArtifactAdmissionPolicy(
  policy: ControlPlaneAdmissionPolicy | undefined,
  artifact: Artifact,
): void {
  if (!policy) {
    return;
  }
  if (policy.requireArtifactSignature && !artifact.signature) {
    throw new ControlPlaneError("validation", `artifact ${artifact.id} signature is required`);
  }
  if (policy.allowedArtifactSignatureKeyIds !== undefined) {
    const keyId = artifact.signature?.keyId;
    if (!keyId || !policy.allowedArtifactSignatureKeyIds.includes(keyId)) {
      throw new ControlPlaneError("validation", `artifact ${artifact.id} signature key is not allowed`);
    }
  }
  if (policy.maxArtifactSizeBytes !== undefined && artifact.sizeBytes > policy.maxArtifactSizeBytes) {
    throw new ControlPlaneError(
      "validation",
      `artifact size ${artifact.sizeBytes} exceeds admission limit ${policy.maxArtifactSizeBytes}`,
    );
  }
}

export function enforceDeploymentAdmissionPolicy(
  policy: ControlPlaneAdmissionPolicy | undefined,
  input: DeploymentAdmissionInput,
): void {
  if (!policy) {
    return;
  }
  enforceArtifactAdmissionPolicy(policy, input.artifact);
  if (policy.allowedWorlds !== undefined && !policy.allowedWorlds.includes(input.world)) {
    throw new ControlPlaneError("validation", `deployment world ${input.world} is not allowed`);
  }
  if (
    policy.allowedWorldVersions !== undefined
    && !policy.allowedWorldVersions.includes(input.worldVersion)
  ) {
    throw new ControlPlaneError(
      "validation",
      `deployment worldVersion ${input.worldVersion} is not allowed`,
    );
  }
  enforceOutboundHttpPolicy(policy, input.capabilities);
  enforceKvPolicy(policy, input.capabilities);
  enforceDurableObjectPolicy(policy, input.capabilities);
  enforceSecretPolicy(policy, input.capabilities);
  enforceServicePolicy(policy, input.capabilities);
}

function enforceOutboundHttpPolicy(
  policy: ControlPlaneAdmissionPolicy,
  capabilities: CapabilityPolicy,
) {
  const prefixes = policy.allowedOutboundHttpPrefixes;
  if (prefixes === undefined) {
    return;
  }
  for (const allowed of capabilities.outboundHttp.allow) {
    if (!prefixes.some((prefix) => urlPrefixAllows(prefix, allowed))) {
      throw new ControlPlaneError("validation", `outbound HTTP allow ${allowed} is not allowed`);
    }
  }
}

function enforceKvPolicy(policy: ControlPlaneAdmissionPolicy, capabilities: CapabilityPolicy) {
  const allowed = policy.allowedKvNamespaceIds;
  if (allowed === undefined) {
    return;
  }
  for (const binding of capabilities.kv) {
    if (!allowed.includes(binding.namespaceId)) {
      throw new ControlPlaneError("validation", `kv namespace ${binding.namespaceId} is not allowed`);
    }
  }
}

function enforceDurableObjectPolicy(policy: ControlPlaneAdmissionPolicy, capabilities: CapabilityPolicy) {
  const allowed = policy.allowedDurableObjectNamespaceIds;
  if (allowed === undefined) {
    return;
  }
  for (const binding of capabilities.durableObjects) {
    if (!allowed.includes(binding.namespaceId)) {
      throw new ControlPlaneError(
        "validation",
        `durable object namespace ${binding.namespaceId} is not allowed`,
      );
    }
  }
}

function enforceSecretPolicy(policy: ControlPlaneAdmissionPolicy, capabilities: CapabilityPolicy) {
  const allowed = policy.allowedSecretIds;
  if (allowed === undefined) {
    return;
  }
  for (const binding of capabilities.secrets) {
    if (!allowed.includes(binding.secretId)) {
      throw new ControlPlaneError("validation", `secret ${binding.secretId} is not allowed`);
    }
  }
}

function enforceServicePolicy(policy: ControlPlaneAdmissionPolicy, capabilities: CapabilityPolicy) {
  const allowedProjects = policy.allowedServiceProjectIds;
  const allowedUrlPrefixes = policy.allowedServiceUrlPrefixes;
  if (allowedProjects === undefined && allowedUrlPrefixes === undefined) {
    return;
  }
  for (const binding of capabilities.services) {
    if (allowedProjects !== undefined && !allowedProjects.includes(binding.targetProjectId)) {
      throw new ControlPlaneError(
        "validation",
        `service project ${binding.targetProjectId} is not allowed`,
      );
    }
    if (
      allowedUrlPrefixes !== undefined
      && !allowedUrlPrefixes.some((prefix) => urlPrefixAllows(prefix, binding.url))
    ) {
      throw new ControlPlaneError("validation", `service url ${binding.url} is not allowed`);
    }
  }
}

function urlPrefixAllows(prefix: string, value: string): boolean {
  let allowed: URL;
  let requested: URL;
  try {
    allowed = new URL(prefix);
    requested = new URL(value);
  } catch {
    return false;
  }
  if (allowed.protocol !== requested.protocol || allowed.host !== requested.host) {
    return false;
  }
  if (allowed.pathname === "/" || allowed.pathname === "") {
    return true;
  }
  const allowedPath = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
  return requested.pathname === allowed.pathname || requested.pathname.startsWith(allowedPath);
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "require";
}

function csv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
