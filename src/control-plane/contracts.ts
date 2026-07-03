import { ControlPlaneError } from "./errors.ts";

export const MVP_WORKER_WORLD = "myedge:runtime/worker@0.1.0";
export const MVP_WORKER_WORLD_VERSION = "0.1.0";
export const MVP_WASI_PROFILE = "wasip3";
export const MVP_WASI_VERSION = MVP_WASI_PROFILE;
export const MVP_RUNTIME_BACKEND = "wasmtime";

export type RuntimeBackend = typeof MVP_RUNTIME_BACKEND;
export type WasiVersion = typeof MVP_WASI_VERSION;
export type ApiScope = "*" | "read" | "write" | "publish";
export type ProjectRole = "owner" | "developer" | "viewer";
export const USAGE_METRIC_NAMES = [
  "invocation",
  "cpu_ms",
  "wall_ms",
  "memory_mb_ms",
  "egress_bytes",
  "storage_bytes",
  "sqlite_unit",
] as const;
export type UsageMetricName = (typeof USAGE_METRIC_NAMES)[number];

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  organizationId?: string;
  name: string;
  createdAt: string;
}

export interface ProjectMembership {
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  organizationId?: string;
  projectId?: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export type UsageDimensions = Record<string, string | number | boolean>;

export interface UsageEvent {
  id: string;
  organizationId?: string;
  projectId: string;
  metric: UsageMetricName;
  quantity: number;
  dimensions?: UsageDimensions;
  recordedAt: string;
}

export interface ProjectUsageSummary {
  projectId: string;
  organizationId?: string;
  from?: string;
  to?: string;
  totals: {
    invocations: number;
    cpuMs: number;
    wallMs: number;
    memoryMbMs: number;
    egressBytes: number;
    storageBytes: number;
    sqliteUnits: number;
  };
}

export type CustomDomainStatus =
  | "pending_verification"
  | "verified"
  | "tls_pending"
  | "active"
  | "tls_failed";
export type CustomDomainTlsStatus = "none" | "pending" | "provisioned" | "failed";

export interface CustomDomain {
  id: string;
  projectId: string;
  host: string;
  status: CustomDomainStatus;
  verificationToken: string;
  verificationRecordName: string;
  verificationRecordValue: string;
  tlsStatus: CustomDomainTlsStatus;
  tlsProvider?: string;
  tlsRequestId?: string;
  tlsError?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  tlsProvisionedAt?: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  digest: string;
  location: string;
  sizeBytes: number;
  signature?: ArtifactSignature;
  provenance?: ArtifactProvenance;
  createdAt: string;
}

export interface ArtifactSignature {
  algorithm: "sha256-hmac";
  keyId: string;
  value: string;
}

export interface ArtifactProvenance {
  builder?: string;
  source?: string;
  revision?: string;
  buildId?: string;
}

export interface Secret {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface KvNamespace {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurableObjectNamespace {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSpec {
  backend: RuntimeBackend;
  version: string;
  wasi: WasiVersion;
}

export interface RuntimeLimits {
  cpuMs: number;
  memoryMb: number;
  wallMs: number;
  requestBytes: number;
  subrequests: number;
  hostCalls: number;
  responseBytes: number;
}

export interface OutboundHttpCapability {
  enabled: boolean;
  allow: string[];
}

export interface KvBinding {
  binding: string;
  namespaceId: string;
}

export interface SecretBinding {
  binding: string;
  secretId: string;
}

export interface DurableObjectBinding {
  binding: string;
  namespaceId: string;
}

export interface ServiceBinding {
  binding: string;
  targetProjectId: string;
  url: string;
}

export interface CapabilityPolicy {
  outboundHttp: OutboundHttpCapability;
  kv: KvBinding[];
  durableObjects: DurableObjectBinding[];
  secrets: SecretBinding[];
  services: ServiceBinding[];
  arbitraryFilesystem: false;
  arbitrarySockets: false;
  processSpawn: false;
}

export interface Deployment {
  id: string;
  projectId: string;
  artifactId: string;
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  createdAt: string;
}

export type EdgeWorkerProvider = "cloudflare-workers";
export type EdgeWorkerReleaseMode = "mock" | "api";
export type EdgeWorkerReleaseStatus = "creating" | "active" | "deleting" | "deleted" | "failed";
export type EdgeWorkerReleaseOperationAction = "delete";
export type EdgeWorkerReleaseOperationStatus = "pending" | "succeeded" | "failed";

export interface EdgeWorkerRelease {
  id: string;
  projectId: string;
  deploymentId: string;
  provider: EdgeWorkerProvider;
  mode: EdgeWorkerReleaseMode;
  status: EdgeWorkerReleaseStatus;
  scriptName: string;
  scriptDigest: string;
  scriptModule: string;
  artifact: {
    id: string;
    digest: string;
    location: string;
  };
  createdAt: string;
  updatedAt: string;
  versionId?: string;
  externalDeploymentId?: string;
  url?: string;
  deletedAt?: string;
  lastError?: string;
}

export interface EdgeWorkerReleaseOperation {
  id: string;
  releaseId: string;
  action: EdgeWorkerReleaseOperationAction;
  status: EdgeWorkerReleaseOperationStatus;
  attempts: number;
  nextAttemptAt: string;
  deleteProvider: boolean;
  forceProviderDelete: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface RoutePointer {
  id: string;
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId: string;
  targets: RouteTarget[];
  updatedAt: string;
}

export interface RouteTarget {
  deploymentId: string;
  weight: number;
}

export type DeployPreviewStatus = "active" | "rolled_back";
export type DeployPreviewEnvironment = Record<string, string>;

export interface DeployPreviewPreviousRoute {
  id: string;
  deploymentId: string;
  targets: RouteTarget[];
  updatedAt: string;
}

export interface DeployPreview {
  id: string;
  projectId: string;
  deploymentId: string;
  host: string;
  pathPrefix: string;
  url: string;
  environment: DeployPreviewEnvironment;
  status: DeployPreviewStatus;
  createdAt: string;
  updatedAt: string;
  previousRoute?: DeployPreviewPreviousRoute;
  rolledBackAt?: string;
}

export type RuntimeNodeStatus = "active" | "draining" | "offline";

export interface RuntimeNodeCapacity {
  concurrentRequests: number;
  memoryMb: number;
}

export interface RuntimeNodeLoad {
  activeRequests: number;
}

export interface RuntimeNodeIdentity {
  keyId: string;
  certificateSha256?: string;
}

export interface RuntimeNodeHostInfo {
  backend: string;
  wasi: string;
  runtimeVersion?: string;
  hostVersion?: string;
  engineVariant?: string;
}

export interface RuntimeNode {
  id: string;
  url: string;
  status: RuntimeNodeStatus;
  registeredAt: string;
  lastSeenAt?: string;
  version?: string;
  capacity?: RuntimeNodeCapacity;
  region?: string;
  labels?: Record<string, string>;
  load?: RuntimeNodeLoad;
  identity?: RuntimeNodeIdentity;
  host?: RuntimeNodeHostInfo;
}

export interface RouteSnapshotPublication {
  id: string;
  snapshotId?: string;
  snapshotGeneratedAt: string;
  routes: number;
  ok: boolean;
  targets: RouteSnapshotPublicationTarget[];
  createdAt: string;
}

export interface RouteSnapshotPublicationTarget {
  id?: string;
  url: string;
  ok: boolean;
  status?: number;
  attempts?: number;
  elapsedMs?: number;
  routes?: number;
  generatedAt?: string;
  error?: string;
}

export type CanaryDecisionAction = "continue" | "rollback";
export type CanaryDecisionReason =
  | "within_thresholds"
  | "insufficient_samples"
  | "p95_latency"
  | "error_rate"
  | "reject_count";

export interface CanaryDecision {
  id: string;
  projectId: string;
  host: string;
  pathPrefix: string;
  stableDeploymentId: string;
  candidateDeploymentId: string;
  action: CanaryDecisionAction;
  reason: CanaryDecisionReason;
  metrics: {
    requests: number;
    errors: number;
    rejects: number;
    errorRate: number;
    p95Ms: number;
  };
  thresholds: {
    minRequests?: number;
    p95Ms?: number;
    errorRate?: number;
    rejectCount?: number;
  };
  createdAt: string;
}

export interface RouteSnapshot {
  id?: string;
  schemaVersion: 1;
  generatedAt: string;
  routes: RouteSnapshotEntry[];
}

export interface RouteSnapshotEntry {
  host: string;
  pathPrefix: string;
  projectId: string;
  deploymentId: string;
  targets: RouteSnapshotTarget[];
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  artifact: {
    id: string;
    digest: string;
    location: string;
    signature?: ArtifactSignature;
    provenance?: ArtifactProvenance;
  };
}

export interface RouteSnapshotTarget {
  deploymentId: string;
  weight: number;
  world: typeof MVP_WORKER_WORLD;
  worldVersion: typeof MVP_WORKER_WORLD_VERSION;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  artifact: {
    id: string;
    digest: string;
    location: string;
    signature?: ArtifactSignature;
    provenance?: ArtifactProvenance;
  };
}

export function normalizeProjectName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "project name must be a string");
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    throw new ControlPlaneError("validation", "project name must be between 1 and 80 characters");
  }
  return name;
}

export function normalizeOrganizationName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "organization name must be a string");
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ControlPlaneError("validation", "organization name must be between 1 and 120 characters");
  }
  return name;
}

export function normalizeUserEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "user email must be a string");
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ControlPlaneError("validation", "user email must be an email address");
  }
  return email;
}

export function normalizeUserName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = nonEmptyString(value, "user name");
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlPlaneError("validation", "user name must be a printable string up to 120 characters");
  }
  return name;
}

export function normalizeProjectRole(value: unknown): ProjectRole {
  if (value === "owner" || value === "developer" || value === "viewer") {
    return value;
  }
  throw new ControlPlaneError("validation", "project membership role must be owner, developer, or viewer");
}

export function normalizeApiKeyName(value: unknown): string {
  const name = nonEmptyString(value, "api key name");
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlPlaneError("validation", "api key name must be between 1 and 120 printable characters");
  }
  return name;
}

export function normalizeApiScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlPlaneError("validation", "api key scopes must be a non-empty array");
  }
  const scopes: ApiScope[] = [];
  for (const item of value) {
    if (item !== "*" && item !== "read" && item !== "write" && item !== "publish") {
      throw new ControlPlaneError("validation", "api key scopes must be read, write, publish, or *");
    }
    if (!scopes.includes(item)) {
      scopes.push(item);
    }
  }
  return scopes;
}

export function normalizeUsageMetricName(value: unknown): UsageMetricName {
  if (USAGE_METRIC_NAMES.includes(value as UsageMetricName)) {
    return value as UsageMetricName;
  }
  throw new ControlPlaneError(
    "validation",
    `usage metric must be one of ${USAGE_METRIC_NAMES.join(", ")}`,
  );
}

export function normalizeUsageQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ControlPlaneError("validation", "usage quantity must be a positive finite number");
  }
  return value;
}

export function normalizeUsageDimensions(value: unknown): UsageDimensions | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "usage dimensions");
  const dimensions: UsageDimensions = {};
  for (const [key, dimensionValue] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(key)) {
      throw new ControlPlaneError("validation", "usage dimension keys must be dimension ids");
    }
    if (
      typeof dimensionValue !== "string"
      && typeof dimensionValue !== "number"
      && typeof dimensionValue !== "boolean"
    ) {
      throw new ControlPlaneError("validation", `usage dimension ${key} must be a scalar value`);
    }
    if (typeof dimensionValue === "number" && !Number.isFinite(dimensionValue)) {
      throw new ControlPlaneError("validation", `usage dimension ${key} must be finite`);
    }
    dimensions[key] = dimensionValue;
  }
  return dimensions;
}

export function normalizeUsageTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", `${field} must be an ISO timestamp`);
  }
  const timestamp = value.trim();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("validation", `${field} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(value)) {
    throw new ControlPlaneError("validation", "artifact digest must be a sha256:<64 hex chars> value");
  }
  return value.toLowerCase();
}

export function normalizeLocation(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new ControlPlaneError("validation", "artifact location must be a non-empty string");
  }
  if (!/^(oci|s3|file|https?):\/\//.test(value)) {
    throw new ControlPlaneError(
      "validation",
      "artifact location must use oci://, s3://, file://, http://, or https://",
    );
  }
  return value;
}

export function normalizeSizeBytes(value: unknown): number {
  return positiveInteger(value, "artifact sizeBytes");
}

export function normalizeArtifactSignature(value: unknown): ArtifactSignature | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "artifact signature");
  if (record.algorithm !== "sha256-hmac") {
    throw new ControlPlaneError("validation", "artifact signature algorithm must be sha256-hmac");
  }
  const keyId = nonEmptyString(record.keyId, "artifact signature.keyId");
  const signatureValue = nonEmptyString(record.value, "artifact signature.value");
  if (!/^[a-f0-9]{64}$/i.test(signatureValue)) {
    throw new ControlPlaneError("validation", "artifact signature.value must be a sha256 hex digest");
  }
  return { algorithm: "sha256-hmac", keyId, value: signatureValue.toLowerCase() };
}

export function normalizeArtifactProvenance(value: unknown): ArtifactProvenance | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "artifact provenance");
  const provenance: ArtifactProvenance = {};
  for (const key of ["builder", "source", "revision", "buildId"] as const) {
    if (record[key] !== undefined) {
      provenance[key] = nonEmptyString(record[key], `artifact provenance.${key}`);
    }
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

export function normalizeSecretName(value: unknown): string {
  const name = nonEmptyString(value, "secret name");
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlPlaneError(
      "validation",
      "secret name must be between 1 and 120 printable characters",
    );
  }
  return name;
}

export function normalizeSecretValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlPlaneError("validation", "secret value must be a non-empty string");
  }
  if (value.length > 65536) {
    throw new ControlPlaneError("validation", "secret value must be at most 65536 characters");
  }
  return value;
}

export function normalizeKvNamespaceName(value: unknown): string {
  const name = nonEmptyString(value, "kv namespace name");
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlPlaneError(
      "validation",
      "kv namespace name must be between 1 and 120 printable characters",
    );
  }
  return name;
}

export function normalizeDurableObjectNamespaceName(value: unknown): string {
  const name = nonEmptyString(value, "durable object namespace name");
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlPlaneError(
      "validation",
      "durable object namespace name must be between 1 and 120 printable characters",
    );
  }
  return name;
}

export function normalizeWorld(value: unknown): typeof MVP_WORKER_WORLD {
  if (value !== MVP_WORKER_WORLD) {
    throw new ControlPlaneError("validation", `deployment world must be ${MVP_WORKER_WORLD}`);
  }
  return MVP_WORKER_WORLD;
}

export function workerWorldVersion(world: typeof MVP_WORKER_WORLD): typeof MVP_WORKER_WORLD_VERSION {
  const version = /@([^@]+)$/.exec(world)?.[1];
  if (version !== MVP_WORKER_WORLD_VERSION) {
    throw new ControlPlaneError("validation", `deployment world version must be ${MVP_WORKER_WORLD_VERSION}`);
  }
  return MVP_WORKER_WORLD_VERSION;
}

export function normalizeWorkerWorldVersion(value: unknown): typeof MVP_WORKER_WORLD_VERSION {
  if (value !== MVP_WORKER_WORLD_VERSION) {
    throw new ControlPlaneError("validation", `deployment worldVersion must be ${MVP_WORKER_WORLD_VERSION}`);
  }
  return MVP_WORKER_WORLD_VERSION;
}

export function normalizeRuntime(value: unknown): RuntimeSpec {
  const record = objectRecord(value, "runtime");
  const backend = record.backend;
  if (backend !== MVP_RUNTIME_BACKEND) {
    throw new ControlPlaneError("validation", "MVP runtime backend must be wasmtime");
  }
  const wasi = record.wasi;
  if (wasi !== MVP_WASI_PROFILE) {
    throw new ControlPlaneError("validation", "MVP WASI profile must be wasip3");
  }
  const version = nonEmptyString(record.version, "runtime version");
  return { backend: MVP_RUNTIME_BACKEND, version, wasi: MVP_WASI_PROFILE };
}

export function normalizeLimits(value: unknown): RuntimeLimits {
  const record = objectRecord(value, "limits");
  return {
    cpuMs: positiveInteger(record.cpuMs, "limits.cpuMs"),
    memoryMb: positiveInteger(record.memoryMb, "limits.memoryMb"),
    wallMs: positiveInteger(record.wallMs, "limits.wallMs"),
    requestBytes: positiveInteger(record.requestBytes, "limits.requestBytes"),
    subrequests: positiveInteger(record.subrequests, "limits.subrequests"),
    hostCalls: positiveInteger(record.hostCalls, "limits.hostCalls"),
    responseBytes: positiveInteger(record.responseBytes, "limits.responseBytes"),
  };
}

export function normalizeCapabilities(value: unknown): CapabilityPolicy {
  const record = objectRecord(value, "capabilities");
  rejectPrivilegedCapability(record, "arbitraryFilesystem");
  rejectPrivilegedCapability(record, "arbitrarySockets");
  rejectPrivilegedCapability(record, "processSpawn");

  return {
    outboundHttp: normalizeOutboundHttp(record.outboundHttp),
    kv: normalizeKvBindings(record.kv),
    durableObjects: normalizeDurableObjectBindings(record.durableObjects),
    secrets: normalizeSecretBindings(record.secrets),
    services: normalizeServiceBindings(record.services),
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
}

export function normalizeEdgeWorkerProvider(value: unknown): EdgeWorkerProvider {
  if (value === undefined || value === "cloudflare-workers") {
    return "cloudflare-workers";
  }
  throw new ControlPlaneError("validation", "edge worker provider must be cloudflare-workers");
}

export function normalizeEdgeWorkerReleaseMode(value: unknown): EdgeWorkerReleaseMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "mock" || value === "api") {
    return value;
  }
  throw new ControlPlaneError("validation", "edge worker release mode must be mock or api");
}

export function normalizeEdgeWorkerScriptName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = nonEmptyString(value, "edge worker scriptName").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new ControlPlaneError(
      "validation",
      "edge worker scriptName must be a DNS-safe name of 1-63 lowercase letters, digits, or hyphens",
    );
  }
  return name;
}

export function normalizeHost(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "route host must be a string");
  }
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new ControlPlaneError("validation", "route host must be a DNS host");
  }
  return host;
}

export function normalizePathPrefix(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "route pathPrefix must be a string");
  }
  const pathPrefix = value.trim();
  if (!pathPrefix.startsWith("/")) {
    throw new ControlPlaneError("validation", "route pathPrefix must start with /");
  }
  return pathPrefix;
}

export function normalizeRuntimeNodeUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", "runtime node url must be a string");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ControlPlaneError("validation", "runtime node url must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ControlPlaneError("validation", "runtime node url must be an http(s) URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname.length === 0) {
    url.pathname = "/";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function normalizeRuntimeNodeStatus(value: unknown): RuntimeNodeStatus {
  if (value === undefined) {
    return "active";
  }
  if (value === "active" || value === "draining" || value === "offline") {
    return value;
  }
  throw new ControlPlaneError("validation", "runtime node status must be active, draining, or offline");
}

export function normalizeRuntimeNodeCapacity(value: unknown): RuntimeNodeCapacity | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "runtime node capacity");
  return {
    concurrentRequests: positiveInteger(
      record.concurrentRequests,
      "runtime node capacity.concurrentRequests",
    ),
    memoryMb: positiveInteger(record.memoryMb, "runtime node capacity.memoryMb"),
  };
}

export function normalizeRuntimeNodeRegion(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const region = nonEmptyString(value, "runtime node region").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(region)) {
    throw new ControlPlaneError("validation", "runtime node region must be a region id");
  }
  return region;
}

export function normalizeRuntimeNodeLabels(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "runtime node labels");
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key)) {
      throw new ControlPlaneError("validation", "runtime node label keys must be label ids");
    }
    if (typeof labelValue !== "string") {
      throw new ControlPlaneError("validation", `runtime node label ${key} must be a string`);
    }
    labels[key] = labelValue;
  }
  return labels;
}

export function normalizeRuntimeNodeLoad(value: unknown): RuntimeNodeLoad | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "runtime node load");
  return {
    activeRequests: nonnegativeInteger(record.activeRequests, "runtime node load.activeRequests"),
  };
}

export function normalizeRuntimeNodeIdentity(value: unknown): RuntimeNodeIdentity | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "runtime node identity");
  const keyId = nonEmptyString(record.keyId, "runtime node identity.keyId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(keyId)) {
    throw new ControlPlaneError("validation", "runtime node identity.keyId must be a key id");
  }
  const certificateSha256 = optionalSha256(record.certificateSha256, "runtime node identity.certificateSha256");
  return {
    keyId,
    ...(certificateSha256 ? { certificateSha256 } : {}),
  };
}

export function normalizeRuntimeNodeHostInfo(value: unknown): RuntimeNodeHostInfo | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectRecord(value, "runtime node host");
  const backend = hostInfoToken(record.backend, "runtime node host.backend");
  const wasi = hostInfoToken(record.wasi, "runtime node host.wasi");
  const runtimeVersion = optionalHostInfoToken(record.runtimeVersion, "runtime node host.runtimeVersion");
  const hostVersion = optionalHostInfoToken(record.hostVersion, "runtime node host.hostVersion");
  const engineVariant = optionalEngineVariant(record.engineVariant, "runtime node host.engineVariant");
  return {
    backend,
    wasi,
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(hostVersion ? { hostVersion } : {}),
    ...(engineVariant ? { engineVariant } : {}),
  };
}

function optionalSha256(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const digest = nonEmptyString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ControlPlaneError("validation", `${field} must be a sha256 hex digest`);
  }
  return digest;
}

function optionalHostInfoToken(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return hostInfoToken(value, field);
}

function hostInfoToken(value: unknown, field: string): string {
  const token = nonEmptyString(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/.test(token)) {
    throw new ControlPlaneError("validation", `${field} must be a runtime host token`);
  }
  return token;
}

function optionalEngineVariant(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const variant = nonEmptyString(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(variant)) {
    throw new ControlPlaneError("validation", `${field} must be an engine variant id`);
  }
  return variant;
}

export function normalizeRouteTargets(value: unknown, fallbackDeploymentId?: string): RouteTarget[] {
  if (value === undefined) {
    if (!fallbackDeploymentId) {
      throw new ControlPlaneError("validation", "route deploymentId or targets are required");
    }
    return [{ deploymentId: nonEmptyString(fallbackDeploymentId, "route deploymentId"), weight: 100 }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlPlaneError("validation", "route targets must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = objectRecord(item, `route targets[${index}]`);
    const deploymentId = nonEmptyString(record.deploymentId, `route targets[${index}].deploymentId`);
    if (seen.has(deploymentId)) {
      throw new ControlPlaneError("validation", `route target ${deploymentId} is duplicated`);
    }
    seen.add(deploymentId);
    return {
      deploymentId,
      weight: positiveInteger(record.weight, `route targets[${index}].weight`),
    };
  });
}

export function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return nonEmptyString(value, field);
}

function normalizeOutboundHttp(value: unknown): OutboundHttpCapability {
  if (value === undefined) {
    return { enabled: false, allow: [] };
  }
  const record = objectRecord(value, "capabilities.outboundHttp");
  const enabled = booleanValue(record.enabled, "capabilities.outboundHttp.enabled");
  const allow = stringArray(record.allow ?? [], "capabilities.outboundHttp.allow");
  if (!enabled && allow.length > 0) {
    throw new ControlPlaneError("validation", "outbound allowlist requires outboundHttp.enabled");
  }
  return { enabled, allow };
}

function normalizeKvBindings(value: unknown): KvBinding[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", "capabilities.kv must be an array");
  }
  return value.map((item, index) => {
    const record = objectRecord(item, `capabilities.kv[${index}]`);
    return {
      binding: bindingName(record.binding, `capabilities.kv[${index}].binding`),
      namespaceId: nonEmptyString(record.namespaceId, `capabilities.kv[${index}].namespaceId`),
    };
  });
}

function normalizeDurableObjectBindings(value: unknown): DurableObjectBinding[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", "capabilities.durableObjects must be an array");
  }
  return value.map((item, index) => {
    const record = objectRecord(item, `capabilities.durableObjects[${index}]`);
    return {
      binding: bindingName(record.binding, `capabilities.durableObjects[${index}].binding`),
      namespaceId: nonEmptyString(record.namespaceId, `capabilities.durableObjects[${index}].namespaceId`),
    };
  });
}

function normalizeSecretBindings(value: unknown): SecretBinding[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", "capabilities.secrets must be an array");
  }
  return value.map((item, index) => {
    const record = objectRecord(item, `capabilities.secrets[${index}]`);
    return {
      binding: bindingName(record.binding, `capabilities.secrets[${index}].binding`),
      secretId: nonEmptyString(record.secretId, `capabilities.secrets[${index}].secretId`),
    };
  });
}

function normalizeServiceBindings(value: unknown): ServiceBinding[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", "capabilities.services must be an array");
  }
  return value.map((item, index) => {
    const record = objectRecord(item, `capabilities.services[${index}]`);
    return {
      binding: bindingName(record.binding, `capabilities.services[${index}].binding`),
      targetProjectId: nonEmptyString(
        record.targetProjectId,
        `capabilities.services[${index}].targetProjectId`,
      ),
      url: serviceUrl(record.url, `capabilities.services[${index}].url`),
    };
  });
}

function rejectPrivilegedCapability(record: Record<string, unknown>, key: string) {
  if (record[key] === true) {
    throw new ControlPlaneError("validation", `${key} is not exposed to workers`);
  }
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("validation", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlPlaneError("validation", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function bindingName(value: unknown, field: string): string {
  const name = nonEmptyString(value, field);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new ControlPlaneError("validation", `${field} must be an uppercase binding name`);
  }
  return name;
}

function serviceUrl(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ControlPlaneError("validation", `${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ControlPlaneError("validation", `${field} must be an absolute http(s) URL`);
  }
  if (url.hash) {
    throw new ControlPlaneError("validation", `${field} must not include a fragment`);
  }
  if (url.search) {
    throw new ControlPlaneError("validation", `${field} must not include a query`);
  }
  return url.toString();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ControlPlaneError("validation", `${field} must be a positive integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ControlPlaneError("validation", `${field} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ControlPlaneError("validation", `${field} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", `${field} must be an array`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}
