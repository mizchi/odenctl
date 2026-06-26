import { ControlPlaneError } from "./errors.ts";

export const MVP_WORKER_WORLD = "myedge:runtime/worker@0.1.0";
export const MVP_WASI_PROFILE = "wasip3";
export const MVP_WASI_VERSION = MVP_WASI_PROFILE;
export const MVP_RUNTIME_BACKEND = "wasmtime";

export type RuntimeBackend = typeof MVP_RUNTIME_BACKEND;
export type WasiVersion = typeof MVP_WASI_VERSION;

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  digest: string;
  location: string;
  sizeBytes: number;
  createdAt: string;
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
  subrequests: number;
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

export interface CapabilityPolicy {
  outboundHttp: OutboundHttpCapability;
  kv: KvBinding[];
  secrets: SecretBinding[];
  arbitraryFilesystem: false;
  arbitrarySockets: false;
  processSpawn: false;
}

export interface Deployment {
  id: string;
  projectId: string;
  artifactId: string;
  world: typeof MVP_WORKER_WORLD;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  createdAt: string;
}

export interface RoutePointer {
  id: string;
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId: string;
  updatedAt: string;
}

export interface RouteSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  routes: RouteSnapshotEntry[];
}

export interface RouteSnapshotEntry {
  host: string;
  pathPrefix: string;
  projectId: string;
  deploymentId: string;
  world: typeof MVP_WORKER_WORLD;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  artifact: {
    id: string;
    digest: string;
    location: string;
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
  if (!/^(oci|s3|file):\/\//.test(value)) {
    throw new ControlPlaneError("validation", "artifact location must use oci://, s3://, or file://");
  }
  return value;
}

export function normalizeSizeBytes(value: unknown): number {
  return positiveInteger(value, "artifact sizeBytes");
}

export function normalizeWorld(value: unknown): typeof MVP_WORKER_WORLD {
  if (value !== MVP_WORKER_WORLD) {
    throw new ControlPlaneError("validation", `deployment world must be ${MVP_WORKER_WORLD}`);
  }
  return MVP_WORKER_WORLD;
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
    subrequests: positiveInteger(record.subrequests, "limits.subrequests"),
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
    secrets: normalizeSecretBindings(record.secrets),
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
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

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ControlPlaneError("validation", `${field} must be a positive integer`);
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
