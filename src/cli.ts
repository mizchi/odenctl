import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
  type CapabilityPolicy,
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
  publish?: boolean;
  fetch?: FetchFunction;
}

export interface DeployComponentResult {
  artifact: any;
  deployment: any;
  route: any;
  publish?: any;
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

export async function deployComponent(input: DeployComponentInput): Promise<DeployComponentResult> {
  const fetchImpl = input.fetch ?? fetch;
  const bytes = await readFile(input.componentPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const suffix = digest.slice("sha256:".length, "sha256:".length + 16);
  const artifactId = input.artifactId ?? `art_${suffix}`;
  const deploymentId = input.deploymentId ?? `dep_${suffix}`;
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
    arbitraryFilesystem: false,
    arbitrarySockets: false,
    processSpawn: false,
  };

  const artifact = await postJson(fetchImpl, input.controlPlaneUrl, "/artifacts/local", {
    id: artifactId,
    projectId: input.projectId,
    bytesBase64: bytes.toString("base64"),
  });
  const deployment = await postJson(fetchImpl, input.controlPlaneUrl, "/deployments", {
    id: deploymentId,
    projectId: input.projectId,
    artifactId: artifact.id,
    world: MVP_WORKER_WORLD,
    runtime,
    limits,
    capabilities,
  });
  const route = await putJson(fetchImpl, input.controlPlaneUrl, "/routes", {
    ...(routeId ? { id: routeId } : {}),
    projectId: input.projectId,
    host: input.host,
    pathPrefix: input.pathPrefix ?? "/",
    deploymentId: deployment.id,
  });
  const publish = input.publish === false
    ? undefined
    : await postJson(fetchImpl, input.controlPlaneUrl, "/snapshots/routes/publish", {});

  return { artifact, deployment, route, publish };
}

export function parseDeployArgs(args: string[], env: Record<string, string | undefined> = process.env): DeployComponentInput {
  const input: Partial<DeployComponentInput> = {
    controlPlaneUrl: env.WASMPLANE_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787",
    pathPrefix: "/",
    outboundAllow: [],
    kv: [],
    secrets: [],
    publish: true,
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

async function postJson(fetchImpl: FetchFunction, baseUrl: string, path: string, body: unknown): Promise<any> {
  return requestJson(fetchImpl, baseUrl, path, "POST", body);
}

async function putJson(fetchImpl: FetchFunction, baseUrl: string, path: string, body: unknown): Promise<any> {
  return requestJson(fetchImpl, baseUrl, path, "PUT", body);
}

async function requestJson(
  fetchImpl: FetchFunction,
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
): Promise<any> {
  const response = await fetchImpl(new URL(path, baseUrl).href, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  return response.json();
}

function parseBinding(value: string, targetKey: "namespaceId" | "secretId") {
  const [binding, target, extra] = value.split("=");
  if (!binding || !target || extra !== undefined) {
    throw new Error("bindings must use BINDING=id syntax");
  }
  return { binding, [targetKey]: target } as any;
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

function printDeployResult(result: DeployComponentResult) {
  console.log(
    JSON.stringify(
      {
        artifactId: result.artifact.id,
        deploymentId: result.deployment.id,
        routeId: result.route.id,
        published: result.publish?.ok,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "deploy") {
    throw new Error("usage: wasmplane deploy --project-id <id> --component <component.wasm> --host <host>");
  }
  printDeployResult(await deployComponent(parseDeployArgs(args)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
