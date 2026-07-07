import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  applyConfiguredControlPlaneMigrations,
  checkConfiguredControlPlaneMigrations,
  type ConfiguredControlPlaneMigrationOptions,
} from "./control-plane/database.ts";
import {
  createWasip3HostArtifactValidator,
  type LocalArtifactValidator,
} from "./control-plane/artifact-validation.ts";
import {
  createDeploymentDiff,
  type DeploymentDiff,
} from "./deployment-diff.ts";
import { publishRouteSnapshot } from "./control-plane/snapshot-publisher.ts";
import {
  createConfiguredVolumeSqliteBackupCipher,
  createVolumeSqliteRegistry,
} from "./control-plane/volume-sqlite.ts";
import {
  materializeWorkerTemplate,
  WORKER_TEMPLATE_LANGUAGES,
  type WorkerTemplateInput,
  type WorkerTemplateLanguage,
  type WorkerTemplateResult,
} from "./worker-templates.ts";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  MVP_WORKER_WORLD_VERSION,
  type ApiScope,
  type CapabilityPolicy,
  type RouteSnapshot,
  type RouteSnapshotEntry,
  type RuntimeLimits,
  type RuntimeSpec,
} from "./control-plane/contracts.ts";

export interface DeployComponentInput {
  controlPlaneUrl: string;
  projectId: string;
  componentPath: string;
  host: string;
  pathPrefix?: string;
  artifactId?: string;
  deploymentId?: string;
  routeId?: string;
  runtimeVersion?: string;
  limits?: Partial<RuntimeLimits>;
  outboundAllow?: string[];
  kv?: Array<{ binding: string; namespaceId: string }>;
  secrets?: Array<{ binding: string; secretId: string }>;
  services?: Array<{ binding: string; targetProjectId: string; url: string }>;
  token?: string;
  publish?: boolean;
  diff?: boolean;
  fetch?: FetchFunction;
}

export interface DeployComponentResult {
  artifact: any;
  deployment: any;
  route: any;
  publish?: any;
  diff?: DeploymentDiff;
}

export interface DevCommandInput {
  controlPlaneUrl: string;
  runtimeUrl: string;
  projectId: string;
  componentPath: string;
  host: string;
  pathPrefix?: string;
  artifactId?: string;
  deploymentId?: string;
  previewId?: string;
  runtimeVersion?: string;
  limits?: Partial<RuntimeLimits>;
  outboundAllow?: string[];
  kv?: Array<{ binding: string; namespaceId: string }>;
  secrets?: Array<{ binding: string; secretId: string }>;
  services?: Array<{ binding: string; targetProjectId: string; url: string }>;
  environment?: Record<string, string>;
  token?: string;
  runtimeToken?: string;
  validate?: boolean;
  tailLogs?: boolean;
  hostBin?: string;
  validator?: LocalArtifactValidator;
  fetch?: FetchFunction;
}

export interface DevCommandResult {
  artifact: any;
  deployment: any;
  preview: any;
  snapshot: any;
  publish?: any;
  logs?: any;
  routePreview: {
    hostHeader: string;
    localUrl: string;
    curl: string;
  };
}

export interface MigrateCommandInput extends ConfiguredControlPlaneMigrationOptions {
  action: "apply" | "check";
}

export interface NewWorkerCommandInput extends WorkerTemplateInput {}

export type VolumeSqliteCommandAction = "ensure" | "backup" | "restore" | "gc" | "list";

export interface VolumeSqliteCommandInput {
  action: VolumeSqliteCommandAction;
  rootDir: string;
  id?: string;
  backupId?: string;
  sourcePath?: string;
  kind?: string;
  ownerId?: string;
  schemaVersion?: number;
  maxOpenDatabases?: number;
  maxPendingWritesPerDatabase?: number;
  keepLatest?: number;
  olderThanMs?: number;
}

export interface OnboardCommandInput {
  kind: "beta";
  controlPlaneUrl: string;
  token?: string;
  organizationId?: string;
  organizationName: string;
  userId?: string;
  userEmail: string;
  userName?: string;
  projectId?: string;
  projectName: string;
  role?: "owner" | "developer" | "viewer";
  apiKeyId?: string;
  apiKeyName?: string;
  scopes?: ApiScope[];
  defaultHost?: string;
  fetch?: FetchFunction;
}

export type FetchFunction = (input: string, init?: any) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

const defaultLimits: RuntimeLimits = {
  cpuMs: 50,
  memoryMb: 64,
  wallMs: 1000,
  requestBytes: 1048576,
  responseBytes: 1048576,
  subrequests: 20,
  hostCalls: 100,
};

class HttpRequestError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.status = status;
    this.bodyText = bodyText;
  }
}

export async function deployComponent(input: DeployComponentInput): Promise<DeployComponentResult> {
  const fetchImpl = input.fetch ?? fetch;
  const bytes = await readFile(input.componentPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const suffix = digest.slice("sha256:".length, "sha256:".length + 16);
  const artifactId = input.artifactId ?? `art_${suffix}`;
  const routeId = input.routeId;
  const limits = { ...defaultLimits, ...(input.limits ?? {}) };
  const runtime: RuntimeSpec = {
    backend: MVP_RUNTIME_BACKEND,
    version: input.runtimeVersion ?? "wasmtime-42",
    wasi: MVP_WASI_PROFILE,
  };
  const capabilities: CapabilityPolicy = {
    outboundHttp: {
      enabled: (input.outboundAllow ?? []).length > 0,
      allow: input.outboundAllow ?? [],
    },
    kv: input.kv ?? [],
    secrets: input.secrets ?? [],
    services: input.services ?? [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };
  const deterministicDeploymentId = `dep_${hashSuffix({
    artifactId,
    capabilities,
    limits,
    projectId: input.projectId,
    runtime,
    world: MVP_WORKER_WORLD,
  })}`;
  const deploymentId = input.deploymentId ?? deterministicDeploymentId;
  const currentSnapshot = input.diff
    ? await getJson(fetchImpl, input.controlPlaneUrl, "/snapshots/routes", input.token) as RouteSnapshot
    : undefined;

  const artifact = await postJson(fetchImpl, input.controlPlaneUrl, "/artifacts/local", input.token, {
    id: artifactId,
    projectId: input.projectId,
    bytesBase64: bytes.toString("base64"),
  });
  const deploymentRequest = {
    id: deploymentId,
    projectId: input.projectId,
    artifactId: artifact.id,
    world: MVP_WORKER_WORLD,
    runtime,
    limits,
    capabilities,
  };
  const deployment = await createDeployment(fetchImpl, input, deploymentRequest, input.deploymentId === undefined);
  const route = await putJson(fetchImpl, input.controlPlaneUrl, "/routes", input.token, {
    ...(routeId ? { id: routeId } : {}),
    projectId: input.projectId,
    host: input.host,
    pathPrefix: input.pathPrefix ?? "/",
    deploymentId: deployment.id,
  });
  const publish = input.publish === false
    ? undefined
    : await postJson(fetchImpl, input.controlPlaneUrl, "/snapshots/routes/publish", input.token, {});
  const diff = currentSnapshot
    ? createDeploymentDiff({
      before: currentSnapshot,
      after: deploymentDiffRouteEntry({
        projectId: input.projectId,
        host: input.host,
        pathPrefix: input.pathPrefix ?? "/",
        artifact,
        artifactFallback: {
          id: artifactId,
          digest,
          location: pathToFileURL(input.componentPath).href,
        },
        deployment,
        deploymentFallback: {
          id: deploymentId,
          runtime,
          limits,
          capabilities,
        },
        route,
      }),
    })
    : undefined;

  return { artifact, deployment, route, publish, diff };
}

async function createDeployment(
  fetchImpl: FetchFunction,
  input: Pick<DeployComponentInput, "controlPlaneUrl" | "token">,
  deployment: any,
  idempotentConflict: boolean,
) {
  try {
    return await postJson(fetchImpl, input.controlPlaneUrl, "/deployments", input.token, deployment);
  } catch (error) {
    if (idempotentConflict && error instanceof HttpRequestError && error.status === 409) {
      return {
        ...deployment,
        worldVersion: MVP_WORKER_WORLD_VERSION,
        reused: true,
      };
    }
    throw error;
  }
}

export async function runDevCommand(input: DevCommandInput): Promise<DevCommandResult> {
  const fetchImpl = input.fetch ?? fetch;
  const bytes = await readFile(input.componentPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const suffix = digest.slice("sha256:".length, "sha256:".length + 16);
  const artifactId = input.artifactId ?? `art_${suffix}`;
  const deploymentId = input.deploymentId ?? `dep_${suffix}`;
  const previewId = input.previewId;
  const pathPrefix = input.pathPrefix ?? "/";
  const limits = { ...defaultLimits, ...(input.limits ?? {}) };
  const runtime: RuntimeSpec = {
    backend: MVP_RUNTIME_BACKEND,
    version: input.runtimeVersion ?? "wasmtime-42",
    wasi: MVP_WASI_PROFILE,
  };
  const capabilities: CapabilityPolicy = {
    outboundHttp: {
      enabled: (input.outboundAllow ?? []).length > 0,
      allow: input.outboundAllow ?? [],
    },
    kv: input.kv ?? [],
    secrets: input.secrets ?? [],
    services: input.services ?? [],
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };

  if (input.validate !== false) {
    const validator = input.validator ?? createWasip3HostArtifactValidator({ hostBin: input.hostBin });
    await validator.validate({
      path: input.componentPath,
      digest,
      location: pathToFileURL(input.componentPath).href,
    });
  }

  const artifact = await postJson(fetchImpl, input.controlPlaneUrl, "/artifacts/local", input.token, {
    id: artifactId,
    projectId: input.projectId,
    bytesBase64: bytes.toString("base64"),
  });
  const deployment = await postJson(fetchImpl, input.controlPlaneUrl, "/deployments", input.token, {
    id: deploymentId,
    projectId: input.projectId,
    artifactId: artifact.id,
    world: MVP_WORKER_WORLD,
    runtime,
    limits,
    capabilities,
  });
  const environment = {
    ...(input.environment ?? {}),
    WASMPLANE_DEV: input.environment?.WASMPLANE_DEV ?? "1",
  };
  const preview = await postJson(fetchImpl, input.controlPlaneUrl, "/deploy-previews", input.token, {
    ...(previewId ? { id: previewId } : {}),
    projectId: input.projectId,
    deploymentId: deployment.id,
    host: input.host,
    pathPrefix,
    environment,
  });
  const snapshot = await getJson(fetchImpl, input.controlPlaneUrl, "/snapshots/routes", input.token);
  const publish = await publishRouteSnapshot(
    snapshot,
    [{ id: "local", url: input.runtimeUrl, token: input.runtimeToken }],
    fetchImpl as any,
  );
  const logs = input.tailLogs === false
    ? undefined
    : await readRuntimeLogs(fetchImpl, input, deployment.id);

  return {
    artifact,
    deployment,
    preview,
    snapshot,
    publish,
    logs,
    routePreview: routePreview(input.runtimeUrl, preview.host ?? input.host, preview.pathPrefix ?? pathPrefix),
  };
}

export function parseDeployArgs(args: string[], env: Record<string, string | undefined> = process.env): DeployComponentInput {
  const input: Partial<DeployComponentInput> = {
    controlPlaneUrl: env.WASMPLANE_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787",
    token: env.WASMPLANE_CONTROL_PLANE_TOKEN,
    pathPrefix: "/",
    outboundAllow: [],
    kv: [],
    secrets: [],
    services: [],
    publish: true,
    diff: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--control-plane-url":
        input.controlPlaneUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--project-id":
        input.projectId = requiredValue(flag, value);
        index += 1;
        break;
      case "--component":
        input.componentPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--host":
        input.host = requiredValue(flag, value);
        index += 1;
        break;
      case "--path-prefix":
        input.pathPrefix = requiredValue(flag, value);
        index += 1;
        break;
      case "--artifact-id":
        input.artifactId = requiredValue(flag, value);
        index += 1;
        break;
      case "--deployment-id":
        input.deploymentId = requiredValue(flag, value);
        index += 1;
        break;
      case "--route-id":
        input.routeId = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-version":
        input.runtimeVersion = requiredValue(flag, value);
        index += 1;
        break;
      case "--token":
        input.token = requiredValue(flag, value);
        index += 1;
        break;
      case "--outbound":
        input.outboundAllow?.push(requiredValue(flag, value));
        index += 1;
        break;
      case "--kv":
        input.kv?.push(parseBinding(requiredValue(flag, value), "namespaceId"));
        index += 1;
        break;
      case "--secret":
        input.secrets?.push(parseBinding(requiredValue(flag, value), "secretId"));
        index += 1;
        break;
      case "--service":
        input.services?.push(parseServiceBinding(requiredValue(flag, value)));
        index += 1;
        break;
      case "--limit":
        input.limits = { ...(input.limits ?? {}), ...parseLimit(requiredValue(flag, value)) };
        index += 1;
        break;
      case "--publish":
        input.publish = true;
        break;
      case "--no-publish":
        input.publish = false;
        break;
      case "--diff":
        input.diff = true;
        break;
      case "--no-diff":
        input.diff = false;
        break;
      default:
        throw new Error(`unknown deploy argument ${flag}`);
    }
  }

  if (!input.projectId) {
    throw new Error("expected --project-id <id>");
  }
  if (!input.componentPath) {
    throw new Error("expected --component <component.wasm>");
  }
  if (!input.host) {
    throw new Error("expected --host <hostname>");
  }
  return input as DeployComponentInput;
}

export function parseDevArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): DevCommandInput {
  const input: Partial<DevCommandInput> = {
    controlPlaneUrl: env.WASMPLANE_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787",
    runtimeUrl: env.WASMPLANE_RUNTIME_URL ?? "http://127.0.0.1:8788",
    token: env.WASMPLANE_CONTROL_PLANE_TOKEN,
    runtimeToken: env.WASMPLANE_RUNTIME_TOKEN,
    host: "dev.localhost",
    pathPrefix: "/",
    outboundAllow: [],
    kv: [],
    secrets: [],
    services: [],
    environment: {},
    validate: true,
    tailLogs: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--control-plane-url":
        input.controlPlaneUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-url":
        input.runtimeUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--project-id":
        input.projectId = requiredValue(flag, value);
        index += 1;
        break;
      case "--component":
        input.componentPath = requiredValue(flag, value);
        index += 1;
        break;
      case "--host":
        input.host = requiredValue(flag, value);
        index += 1;
        break;
      case "--path-prefix":
        input.pathPrefix = requiredValue(flag, value);
        index += 1;
        break;
      case "--artifact-id":
        input.artifactId = requiredValue(flag, value);
        index += 1;
        break;
      case "--deployment-id":
        input.deploymentId = requiredValue(flag, value);
        index += 1;
        break;
      case "--preview-id":
        input.previewId = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-version":
        input.runtimeVersion = requiredValue(flag, value);
        index += 1;
        break;
      case "--token":
        input.token = requiredValue(flag, value);
        index += 1;
        break;
      case "--runtime-token":
        input.runtimeToken = requiredValue(flag, value);
        index += 1;
        break;
      case "--host-bin":
        input.hostBin = requiredValue(flag, value);
        index += 1;
        break;
      case "--outbound":
        input.outboundAllow?.push(requiredValue(flag, value));
        index += 1;
        break;
      case "--kv":
        input.kv?.push(parseBinding(requiredValue(flag, value), "namespaceId"));
        index += 1;
        break;
      case "--secret":
        input.secrets?.push(parseBinding(requiredValue(flag, value), "secretId"));
        index += 1;
        break;
      case "--service":
        input.services?.push(parseServiceBinding(requiredValue(flag, value)));
        index += 1;
        break;
      case "--limit":
        input.limits = { ...(input.limits ?? {}), ...parseLimit(requiredValue(flag, value)) };
        index += 1;
        break;
      case "--env": {
        const [key, envValue] = parseEnvBinding(requiredValue(flag, value));
        input.environment = { ...(input.environment ?? {}), [key]: envValue };
        index += 1;
        break;
      }
      case "--validate":
        input.validate = true;
        break;
      case "--no-validate":
        input.validate = false;
        break;
      case "--tail-logs":
        input.tailLogs = true;
        break;
      case "--no-tail-logs":
        input.tailLogs = false;
        break;
      default:
        throw new Error(`unknown dev argument ${flag}`);
    }
  }

  if (!input.projectId) {
    throw new Error("expected --project-id <id>");
  }
  if (!input.componentPath) {
    throw new Error("expected --component <component.wasm>");
  }
  return input as DevCommandInput;
}

export function parseMigrateArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): MigrateCommandInput {
  const [action, ...rest] = args;
  if (action !== "apply" && action !== "check") {
    throw new Error("usage: wasmplane migrate <apply|check> [--sqlite <path> | --database-url <url>]");
  }
  const migrateEnv = migrationEnvFromProcess(env);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    switch (flag) {
      case "--sqlite":
        migrateEnv.WASMPLANE_DB = requiredValue(flag, value);
        delete migrateEnv.DATABASE_URL;
        delete migrateEnv.WASMPLANE_DATABASE_URL;
        index += 1;
        break;
      case "--database-url":
        migrateEnv.DATABASE_URL = requiredValue(flag, value);
        delete migrateEnv.WASMPLANE_DB;
        index += 1;
        break;
      case "--postgres-ssl":
        migrateEnv.WASMPLANE_POSTGRES_SSL = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown migrate argument ${flag}`);
    }
  }
  return { action, env: migrateEnv };
}

export async function runMigrateCommand(input: MigrateCommandInput) {
  return input.action === "apply"
    ? applyConfiguredControlPlaneMigrations({ env: input.env })
    : checkConfiguredControlPlaneMigrations({ env: input.env });
}

export function parseNewWorkerArgs(args: string[]): NewWorkerCommandInput {
  const input: Partial<NewWorkerCommandInput> = {
    language: "rust",
    force: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--language": {
        const language = requiredValue(flag, value);
        if (!isWorkerTemplateLanguage(language)) {
          throw new Error(`unknown worker template language ${language}`);
        }
        input.language = language;
        index += 1;
        break;
      }
      case "--name":
        input.name = requiredValue(flag, value);
        index += 1;
        break;
      case "--out":
      case "--out-dir":
        input.outDir = requiredValue(flag, value);
        index += 1;
        break;
      case "--force":
        input.force = true;
        break;
      default:
        throw new Error(`unknown new argument ${flag}`);
    }
  }
  if (!input.name) {
    throw new Error("expected --name <worker-name>");
  }
  input.outDir = input.outDir ?? input.name;
  return input as NewWorkerCommandInput;
}

export async function runNewWorkerCommand(input: NewWorkerCommandInput): Promise<WorkerTemplateResult> {
  return materializeWorkerTemplate(input);
}

export function parseOnboardArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): OnboardCommandInput {
  const [kind, ...rest] = args;
  if (kind !== "beta") {
    throw new Error("usage: wasmplane onboard beta --organization-name <name> --user-email <email> --project-name <name>");
  }
  const input: Partial<OnboardCommandInput> = {
    kind,
    controlPlaneUrl: env.WASMPLANE_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787",
    token: env.WASMPLANE_CONTROL_PLANE_TOKEN,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    switch (flag) {
      case "--control-plane-url":
        input.controlPlaneUrl = requiredValue(flag, value);
        index += 1;
        break;
      case "--token":
        input.token = requiredValue(flag, value);
        index += 1;
        break;
      case "--organization-id":
        input.organizationId = requiredValue(flag, value);
        index += 1;
        break;
      case "--organization-name":
        input.organizationName = requiredValue(flag, value);
        index += 1;
        break;
      case "--user-id":
        input.userId = requiredValue(flag, value);
        index += 1;
        break;
      case "--user-email":
        input.userEmail = requiredValue(flag, value);
        index += 1;
        break;
      case "--user-name":
        input.userName = requiredValue(flag, value);
        index += 1;
        break;
      case "--project-id":
        input.projectId = requiredValue(flag, value);
        index += 1;
        break;
      case "--project-name":
        input.projectName = requiredValue(flag, value);
        index += 1;
        break;
      case "--role":
        input.role = parseProjectRole(requiredValue(flag, value));
        index += 1;
        break;
      case "--api-key-id":
        input.apiKeyId = requiredValue(flag, value);
        index += 1;
        break;
      case "--api-key-name":
        input.apiKeyName = requiredValue(flag, value);
        index += 1;
        break;
      case "--scope":
        input.scopes = [...(input.scopes ?? []), parseApiScope(requiredValue(flag, value))];
        index += 1;
        break;
      case "--scopes":
        input.scopes = requiredValue(flag, value).split(",").map((scope) => parseApiScope(scope.trim()));
        index += 1;
        break;
      case "--host":
        input.defaultHost = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown onboard argument ${flag}`);
    }
  }
  if (!input.organizationName) {
    throw new Error("expected --organization-name <name>");
  }
  if (!input.userEmail) {
    throw new Error("expected --user-email <email>");
  }
  if (!input.projectName) {
    throw new Error("expected --project-name <name>");
  }
  return input as OnboardCommandInput;
}

export async function runOnboardCommand(input: OnboardCommandInput) {
  const fetchImpl = input.fetch ?? fetch;
  return postJson(fetchImpl, input.controlPlaneUrl, "/beta/onboardings", input.token, omitUndefined({
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    projectId: input.projectId,
    projectName: input.projectName,
    role: input.role,
    apiKeyId: input.apiKeyId,
    apiKeyName: input.apiKeyName,
    scopes: input.scopes,
    defaultHost: input.defaultHost,
  }));
}

export function parseVolumeSqliteArgs(args: string[]): VolumeSqliteCommandInput {
  const [action, ...rest] = args;
  if (!isVolumeSqliteAction(action)) {
    throw new Error("usage: wasmplane volume-sqlite <ensure|backup|restore|gc|list> --root <dir> [--id <database-id>]");
  }
  const input: Partial<VolumeSqliteCommandInput> = { action };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    switch (flag) {
      case "--root":
        input.rootDir = requiredValue(flag, value);
        index += 1;
        break;
      case "--id":
        input.id = requiredValue(flag, value);
        index += 1;
        break;
      case "--backup-id":
        input.backupId = requiredValue(flag, value);
        index += 1;
        break;
      case "--source":
      case "--source-path":
        input.sourcePath = requiredValue(flag, value);
        index += 1;
        break;
      case "--kind":
        input.kind = requiredValue(flag, value);
        index += 1;
        break;
      case "--owner-id":
        input.ownerId = requiredValue(flag, value);
        index += 1;
        break;
      case "--schema-version":
        input.schemaVersion = positiveIntegerOrZero(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-open":
        input.maxOpenDatabases = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-pending-writes":
        input.maxPendingWritesPerDatabase = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--keep-latest":
        input.keepLatest = positiveIntegerOrZero(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--older-than-ms":
        input.olderThanMs = positiveIntegerOrZero(requiredValue(flag, value), flag);
        index += 1;
        break;
      default:
        throw new Error(`unknown volume-sqlite argument ${flag}`);
    }
  }
  if (!input.rootDir) {
    throw new Error("expected --root <dir>");
  }
  if (action !== "list" && !input.id) {
    throw new Error(`volume-sqlite ${action} requires --id <database-id>`);
  }
  return input as VolumeSqliteCommandInput;
}

export async function runVolumeSqliteCommand(input: VolumeSqliteCommandInput) {
  const registry = createVolumeSqliteRegistry({
    rootDir: input.rootDir,
    maxOpenDatabases: input.maxOpenDatabases,
    maxPendingWritesPerDatabase: input.maxPendingWritesPerDatabase,
    backupCipher: createConfiguredVolumeSqliteBackupCipher(process.env),
  });
  try {
    switch (input.action) {
      case "ensure":
        return registry.ensureDatabase({
          id: input.id as string,
          kind: input.kind,
          ownerId: input.ownerId,
          schemaVersion: input.schemaVersion,
        });
      case "backup":
        return registry.exportDatabase({
          id: input.id as string,
          backupId: input.backupId,
        });
      case "restore":
        return registry.restoreDatabase({
          id: input.id as string,
          backupId: input.backupId,
          sourcePath: input.sourcePath,
          kind: input.kind,
          ownerId: input.ownerId,
          schemaVersion: input.schemaVersion,
        });
      case "gc":
        return registry.pruneBackups({
          id: input.id,
          keepLatest: input.keepLatest,
          olderThanMs: input.olderThanMs,
        });
      case "list":
        return {
          databases: registry.listDatabases(),
          backups: registry.listBackups(input.id),
          stats: registry.stats(),
        };
    }
  } finally {
    registry.close();
  }
}

async function postJson(
  fetchImpl: FetchFunction,
  baseUrl: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<any> {
  return requestJson(fetchImpl, baseUrl, path, "POST", token, body);
}

async function getJson(
  fetchImpl: FetchFunction,
  baseUrl: string,
  path: string,
  token: string | undefined,
): Promise<any> {
  return requestJson(fetchImpl, baseUrl, path, "GET", token, undefined);
}

async function putJson(
  fetchImpl: FetchFunction,
  baseUrl: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<any> {
  return requestJson(fetchImpl, baseUrl, path, "PUT", token, body);
}

async function requestJson(
  fetchImpl: FetchFunction,
  baseUrl: string,
  path: string,
  method: string,
  token: string | undefined,
  body: unknown,
): Promise<any> {
  const response = await fetchImpl(new URL(path, baseUrl).href, {
    method,
    headers: requestHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpRequestError(`${method} ${path} failed with ${response.status}: ${text}`, response.status, text);
  }
  return response.json();
}

function hashSuffix(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readRuntimeLogs(
  fetchImpl: FetchFunction,
  input: DevCommandInput,
  deploymentId: string,
) {
  const params = new URLSearchParams({
    projectId: input.projectId,
    deploymentId,
  });
  return requestJson(
    fetchImpl,
    input.runtimeUrl,
    `/__runtime/logs?${params.toString()}`,
    "GET",
    input.runtimeToken,
    undefined,
  );
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function routePreview(runtimeUrl: string, host: string, pathPrefix: string) {
  const localUrl = new URL(pathPrefix, runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`).href;
  return {
    hostHeader: host,
    localUrl,
    curl: `curl -H 'host: ${host}' ${localUrl}`,
  };
}

function deploymentDiffRouteEntry(input: {
  projectId: string;
  host: string;
  pathPrefix: string;
  artifact: any;
  artifactFallback: { id: string; digest: string; location: string };
  deployment: any;
  deploymentFallback: {
    id: string;
    runtime: RuntimeSpec;
    limits: RuntimeLimits;
    capabilities: CapabilityPolicy;
  };
  route: any;
}): RouteSnapshotEntry {
  const deploymentId = input.deployment.id ?? input.deploymentFallback.id;
  const runtime = input.deployment.runtime ?? input.deploymentFallback.runtime;
  const limits = input.deployment.limits ?? input.deploymentFallback.limits;
  const capabilities = input.deployment.capabilities ?? input.deploymentFallback.capabilities;
  const artifact = {
    id: input.artifact.id ?? input.artifactFallback.id,
    digest: input.artifact.digest ?? input.artifactFallback.digest,
    location: input.artifact.location ?? input.artifactFallback.location,
    ...(input.artifact.signature ? { signature: input.artifact.signature } : {}),
    ...(input.artifact.provenance ? { provenance: input.artifact.provenance } : {}),
  };
  const targets = Array.isArray(input.route.targets) && input.route.targets.length > 0
    ? input.route.targets
    : [{ deploymentId, weight: 100 }];
  return {
    host: input.route.host ?? input.host,
    pathPrefix: input.route.pathPrefix ?? input.pathPrefix,
    projectId: input.route.projectId ?? input.projectId,
    deploymentId: input.route.deploymentId ?? deploymentId,
    targets: targets.map((target: any) => ({
      deploymentId: target.deploymentId,
      weight: target.weight,
      world: input.deployment.world ?? MVP_WORKER_WORLD,
      worldVersion: input.deployment.worldVersion ?? MVP_WORKER_WORLD_VERSION,
      runtime,
      limits,
      capabilities,
      artifact,
    })),
    world: input.deployment.world ?? MVP_WORKER_WORLD,
    worldVersion: input.deployment.worldVersion ?? MVP_WORKER_WORLD_VERSION,
    runtime,
    limits,
    capabilities,
    artifact,
  };
}

function parseBinding(value: string, targetKey: "namespaceId" | "secretId") {
  const [binding, target, extra] = value.split("=");
  if (!binding || !target || extra !== undefined) {
    throw new Error("bindings must use BINDING=id syntax");
  }
  return { binding, [targetKey]: target } as any;
}

function parseServiceBinding(value: string) {
  const separator = value.indexOf("=");
  const binding = separator >= 0 ? value.slice(0, separator) : "";
  const target = separator >= 0 ? value.slice(separator + 1) : "";
  const serviceSeparator = target.indexOf("@");
  const targetProjectId = serviceSeparator >= 0 ? target.slice(0, serviceSeparator) : "";
  const url = serviceSeparator >= 0 ? target.slice(serviceSeparator + 1) : "";
  if (!binding || !targetProjectId || !url) {
    throw new Error("service bindings must use BINDING=projectId@url syntax");
  }
  return { binding, targetProjectId, url };
}

function parseLimit(value: string): Partial<RuntimeLimits> {
  const [key, raw, extra] = value.split("=");
  if (!key || !raw || extra !== undefined) {
    throw new Error("limits must use name=value syntax");
  }
  if (!isLimitKey(key)) {
    throw new Error(`unknown limit ${key}`);
  }
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`limit ${key} must be a positive integer`);
  }
  return { [key]: number };
}

function parseApiScope(value: string): ApiScope {
  if (value === "*" || value === "read" || value === "write" || value === "publish") {
    return value;
  }
  throw new Error(`unknown api scope ${value}`);
}

function parseProjectRole(value: string): "owner" | "developer" | "viewer" {
  if (value === "owner" || value === "developer" || value === "viewer") {
    return value;
  }
  throw new Error(`unknown project role ${value}`);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function parseEnvBinding(value: string): [string, string] {
  const separator = value.indexOf("=");
  const key = separator >= 0 ? value.slice(0, separator) : "";
  const envValue = separator >= 0 ? value.slice(separator + 1) : "";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error("dev environment bindings must use ENV_NAME=value syntax");
  }
  return [key, envValue];
}

function isLimitKey(key: string): key is keyof RuntimeLimits {
  return [
    "cpuMs",
    "memoryMb",
    "wallMs",
    "requestBytes",
    "responseBytes",
    "subrequests",
    "hostCalls",
  ].includes(key);
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function positiveIntegerOrZero(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a nonnegative integer`);
  }
  return parsed;
}

function printDeployResult(result: DeployComponentResult) {
  console.log(
    JSON.stringify(
      {
        artifactId: result.artifact.id,
        deploymentId: result.deployment.id,
        routeId: result.route.id,
        published: result.publish?.ok,
        ...(result.diff ? { diff: result.diff } : {}),
      },
      null,
      2,
    ),
  );
}

function printDevResult(result: DevCommandResult) {
  console.log(
    JSON.stringify(
      {
        artifactId: result.artifact.id,
        deploymentId: result.deployment.id,
        previewId: result.preview.id,
        previewUrl: result.preview.url,
        routePreview: result.routePreview,
        published: result.publish?.ok,
        logs: result.logs,
      },
      null,
      2,
    ),
  );
}

function printMigrationStatus(status: Awaited<ReturnType<typeof runMigrateCommand>>) {
  console.log(JSON.stringify(status, null, 2));
}

function printNewWorkerResult(result: WorkerTemplateResult) {
  console.log(
    JSON.stringify(
      {
        language: result.language,
        name: result.name,
        outDir: result.outDir,
        world: result.world,
        files: result.files.map((file) => file.path),
        nextSteps: result.nextSteps.map((step) => step.replace("<out-dir>", result.outDir)),
      },
      null,
      2,
    ),
  );
}

function printOnboardResult(result: Awaited<ReturnType<typeof runOnboardCommand>>) {
  console.log(JSON.stringify(result, null, 2));
}

function printVolumeSqliteResult(result: Awaited<ReturnType<typeof runVolumeSqliteCommand>>) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "deploy") {
    printDeployResult(await deployComponent(parseDeployArgs(args)));
    return;
  }
  if (command === "dev") {
    printDevResult(await runDevCommand(parseDevArgs(args)));
    return;
  }
  if (command === "migrate") {
    const input = parseMigrateArgs(args);
    const status = await runMigrateCommand(input);
    printMigrationStatus(status);
    if (input.action === "check" && !status.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "new") {
    printNewWorkerResult(await runNewWorkerCommand(parseNewWorkerArgs(args)));
    return;
  }
  if (command === "onboard") {
    printOnboardResult(await runOnboardCommand(parseOnboardArgs(args)));
    return;
  }
  if (command === "volume-sqlite") {
    printVolumeSqliteResult(await runVolumeSqliteCommand(parseVolumeSqliteArgs(args)));
    return;
  }
  throw new Error(
    "usage: wasmplane <deploy|dev|migrate|new|onboard|volume-sqlite> ...",
  );
}

function isWorkerTemplateLanguage(value: string): value is WorkerTemplateLanguage {
  return WORKER_TEMPLATE_LANGUAGES.includes(value as WorkerTemplateLanguage);
}

function isVolumeSqliteAction(value: string | undefined): value is VolumeSqliteCommandAction {
  return value === "ensure" || value === "backup" || value === "restore" || value === "gc" || value === "list";
}

function migrationEnvFromProcess(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const keys = [
    "DATABASE_URL",
    "WASMPLANE_DATABASE_URL",
    "WASMPLANE_DB",
    "WASMPLANE_POSTGRES_SSL",
    "WASMPLANE_POSTGRES_POOL_SIZE",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => env[key] ? [[key, env[key]]] : []),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
