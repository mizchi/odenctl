import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface CloudflareControlSmokeInput {
  controlUrl: string;
  token?: string;
  projectId: string;
  artifactId: string;
  deploymentId: string;
  scriptName: string;
  releaseMode?: "mock" | "api";
  requireLocalSqlite: boolean;
  deleteRelease: boolean;
  deleteProvider: boolean;
  forceProviderDelete: boolean;
  jsonOutput?: string;
  markdownOutput?: string;
  logsUrl?: string;
  wakeDelayMs: number;
  maxContainerHealthMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

export interface CloudflareControlSmokeCheck {
  name: string;
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  detail?: string;
}

export interface CloudflareControlSmokeResult {
  ok: boolean;
  summary: CloudflareControlSmokeSummary;
  checks: CloudflareControlSmokeCheck[];
}

export interface CloudflareControlSmokeSummary {
  controlUrl: string;
  projectId: string;
  artifactId: string;
  deploymentId: string;
  scriptName: string;
  releaseId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface CloudflareControlSmokeEnv {
  WASMPLANE_CLOUDFLARE_CONTROL_URL?: string;
  CLOUDFLARE_CONTROL_URL?: string;
  WASMPLANE_CONTROL_PLANE_TOKEN?: string;
  CONTROL_PLANE_TOKEN?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_PROJECT_ID?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_ARTIFACT_ID?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_DEPLOYMENT_ID?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_SCRIPT_NAME?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_RELEASE_MODE?: string;
  WASMPLANE_CLOUDFLARE_SMOKE_LOGS_URL?: string;
}

export function parseCloudflareControlSmokeArgs(
  args: string[],
  env: CloudflareControlSmokeEnv = process.env,
): CloudflareControlSmokeInput {
  const flags = parseFlags(args);
  const suffix = Date.now().toString(36);
  const projectId = nonEmpty(flags["project-id"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_PROJECT_ID)
    ?? `prj_cf_smoke_${suffix}`;
  return {
    controlUrl: normalizeBaseUrl(
      required(
        flags["control-url"] ?? env.WASMPLANE_CLOUDFLARE_CONTROL_URL ?? env.CLOUDFLARE_CONTROL_URL,
        "control URL",
      ),
    ),
    token: nonEmpty(flags["token"] ?? env.WASMPLANE_CONTROL_PLANE_TOKEN ?? env.CONTROL_PLANE_TOKEN),
    projectId,
    artifactId: nonEmpty(flags["artifact-id"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_ARTIFACT_ID)
      ?? `art_cf_smoke_${suffix}`,
    deploymentId: nonEmpty(flags["deployment-id"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_DEPLOYMENT_ID)
      ?? `dep_cf_smoke_${suffix}`,
    scriptName: nonEmpty(flags["script-name"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_SCRIPT_NAME)
      ?? `wasmplane-cf-smoke-${suffix}`,
    releaseMode: releaseMode(flags["release-mode"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_RELEASE_MODE),
    requireLocalSqlite: !truthy(flags["allow-external-db"]),
    deleteRelease: !truthy(flags["keep-release"]),
    deleteProvider: truthy(flags["delete-provider"]),
    forceProviderDelete: truthy(flags["force-provider-delete"]) || truthy(flags.force),
    jsonOutput: nonEmpty(flags["json-output"]),
    markdownOutput: nonEmpty(flags["markdown-output"]),
    logsUrl: nonEmpty(flags["logs-url"] ?? env.WASMPLANE_CLOUDFLARE_SMOKE_LOGS_URL),
    wakeDelayMs: nonnegativeInteger(flagNumber(flags["wake-delay-ms"], 0), "wake-delay-ms"),
    maxContainerHealthMs: positiveInteger(flagNumber(flags["max-container-health-ms"], 60_000), "max-container-health-ms"),
  };
}

export async function runCloudflareControlSmoke(
  input: CloudflareControlSmokeInput,
): Promise<CloudflareControlSmokeResult> {
  const fetchImpl = input.fetch ?? fetch;
  const sleepImpl = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAtMs = nowMs();
  const startedAt = new Date().toISOString();
  const checks: CloudflareControlSmokeCheck[] = [];
  const headers = bearerHeaders(input.token);
  let releaseId: string | undefined;

  checks.push(await checkJson(
    fetchImpl,
    "worker edge health",
    `${input.controlUrl}/__poc/edge-health`,
    undefined,
    (body) => body?.ok === true && body?.target === "cloudflare-containers-control",
  ));
  checks.push(await checkTimedJson(
    fetchImpl,
    "container health",
    `${input.controlUrl}/healthz`,
    undefined,
    nowMs,
    input.maxContainerHealthMs,
    (body) => body?.ok === true,
  ));

  const opsConfig = await readJsonCheck(
    fetchImpl,
    "control ops config",
    `${input.controlUrl}/ops/config`,
    headers,
    (body) => body?.schemaVersion === 1 && isObject(body?.database) && isObject(body?.artifactStore),
  );
  checks.push(opsConfig.check);
  if (input.requireLocalSqlite) {
    checks.push({
      name: "local SQLite fallback",
      ok: opsConfig.check.ok
        && opsConfig.body?.database?.kind === "sqlite"
        && opsConfig.body?.database?.external === false,
      status: opsConfig.check.status,
      detail: opsConfig.check.ok ? undefined : opsConfig.check.detail,
    });
  }

  const artifactDigest = digest(`${input.projectId}:${input.artifactId}`);
  checks.push((await postJsonCheck(fetchImpl, "project create", `${input.controlUrl}/projects`, headers, {
    id: input.projectId,
    name: input.projectId,
  }, (body) => body?.id === input.projectId)).check);
  checks.push((await postJsonCheck(fetchImpl, "artifact metadata create", `${input.controlUrl}/artifacts`, headers, {
    id: input.artifactId,
    projectId: input.projectId,
    digest: artifactDigest,
    location: `https://artifacts.example.com/${input.artifactId}.component.wasm`,
    sizeBytes: 128,
  }, (body) => body?.id === input.artifactId && body?.digest === artifactDigest)).check);
  checks.push((await postJsonCheck(fetchImpl, "deployment create", `${input.controlUrl}/deployments`, headers, {
    id: input.deploymentId,
    projectId: input.projectId,
    artifactId: input.artifactId,
    world: "myedge:runtime/worker@0.1.0",
    runtime: {
      backend: "wasmtime",
      version: "wasmtime-43",
      wasi: "wasip3",
    },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
      responseBytes: 1048576,
    },
    capabilities: {
      outboundHttp: { enabled: false, allow: [] },
      kv: [],
      durableObjects: [],
      secrets: [],
      services: [],
    },
  }, (body) => body?.id === input.deploymentId)).check);

  const release = await postJsonCheck(
    fetchImpl,
    "edge worker release create",
    `${input.controlUrl}/edge-workers/releases`,
    headers,
    {
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      scriptName: input.scriptName,
      ...(input.releaseMode ? { mode: input.releaseMode } : {}),
    },
    (body) => body?.projectId === input.projectId && body?.deploymentId === input.deploymentId,
  );
  checks.push(release.check);
  releaseId = typeof release.body?.id === "string" ? release.body.id : undefined;
  checks.push({
    name: "edge release manifest",
    ok: release.check.ok
      && typeof release.body?.scriptModule === "string"
      && release.body.scriptModule.includes("/__wasmplane/manifest"),
    status: release.check.status,
    detail: release.check.ok ? undefined : release.check.detail,
  });

  const listed = await readJsonCheck(
    fetchImpl,
    "edge release list",
    `${input.controlUrl}/projects/${encodeURIComponent(input.projectId)}/edge-worker-releases`,
    headers,
    (body) => Array.isArray(body) && body.some((item) => item?.id === release.body?.id || item?.scriptName === input.scriptName),
  );
  checks.push(listed.check);

  if (input.wakeDelayMs > 0) {
    await sleepImpl(input.wakeDelayMs);
    checks.push(await checkTimedJson(
      fetchImpl,
      "post-wakeup health",
      `${input.controlUrl}/healthz`,
      undefined,
      nowMs,
      input.maxContainerHealthMs,
      (body) => body?.ok === true,
    ));
    checks.push((await readJsonCheck(
      fetchImpl,
      "post-wakeup release persistence",
      `${input.controlUrl}/projects/${encodeURIComponent(input.projectId)}/edge-worker-releases`,
      headers,
      (body) => Array.isArray(body)
        && body.some((item) => item?.id === release.body?.id || item?.scriptName === input.scriptName),
    )).check);
  }

  if (input.logsUrl) {
    checks.push(await readTextCheck(
      fetchImpl,
      "control logs retrieval",
      input.logsUrl,
      headers,
      (body) => body.trim().length > 0,
    ));
  }

  if (input.deleteRelease && releaseId) {
    const query = new URLSearchParams();
    if (input.deleteProvider) {
      query.set("provider", "1");
    }
    if (input.forceProviderDelete) {
      query.set("force", "1");
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    checks.push((await deleteJsonCheck(
      fetchImpl,
      "edge release delete",
      `${input.controlUrl}/edge-workers/releases/${encodeURIComponent(releaseId)}${suffix}`,
      headers,
      (body) => body?.id === releaseId && body?.status === "deleted",
    )).check);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, nowMs() - startedAtMs);
  return {
    ok: checks.every((check) => check.ok),
    summary: {
      controlUrl: input.controlUrl,
      projectId: input.projectId,
      artifactId: input.artifactId,
      deploymentId: input.deploymentId,
      scriptName: input.scriptName,
      ...(releaseId ? { releaseId } : {}),
      startedAt,
      finishedAt,
      durationMs,
    },
    checks,
  };
}

async function postJsonCheck(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  body: unknown,
  validate: (body: any) => boolean,
): Promise<{ check: CloudflareControlSmokeCheck; body?: any }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { check: { name, ok: false, status: response.status, detail: await safeText(response) } };
    }
    const payload = await response.json();
    const ok = validate(payload);
    return {
      check: {
        name,
        ok,
        status: response.status,
        detail: ok ? undefined : "response JSON did not match expected shape",
      },
      body: payload,
    };
  } catch (error) {
    return { check: { name, ok: false, detail: errorMessage(error) } };
  }
}

async function deleteJsonCheck(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  validate: (body: any) => boolean,
): Promise<{ check: CloudflareControlSmokeCheck; body?: any }> {
  try {
    const response = await fetchImpl(url, { method: "DELETE", headers });
    if (!response.ok) {
      return { check: { name, ok: false, status: response.status, detail: await safeText(response) } };
    }
    const payload = await response.json();
    const ok = validate(payload);
    return {
      check: {
        name,
        ok,
        status: response.status,
        detail: ok ? undefined : "response JSON did not match expected shape",
      },
      body: payload,
    };
  } catch (error) {
    return { check: { name, ok: false, detail: errorMessage(error) } };
  }
}

async function readJsonCheck(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  validate: (body: any) => boolean,
): Promise<{ check: CloudflareControlSmokeCheck; body?: any }> {
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { check: { name, ok: false, status: response.status, detail: await safeText(response) } };
    }
    const body = await response.json();
    const ok = validate(body);
    return {
      check: {
        name,
        ok,
        status: response.status,
        detail: ok ? undefined : "response JSON did not match expected shape",
      },
      body,
    };
  } catch (error) {
    return { check: { name, ok: false, detail: errorMessage(error) } };
  }
}

async function readTextCheck(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  validate: (body: string) => boolean,
): Promise<CloudflareControlSmokeCheck> {
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { name, ok: false, status: response.status, detail: await safeText(response) };
    }
    const body = await response.text();
    const ok = validate(body);
    return {
      name,
      ok,
      status: response.status,
      detail: ok ? undefined : "response text did not match expected shape",
    };
  } catch (error) {
    return { name, ok: false, detail: errorMessage(error) };
  }
}

async function checkJson(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  validate: (body: any) => boolean,
): Promise<CloudflareControlSmokeCheck> {
  return (await readJsonCheck(fetchImpl, name, url, headers, validate)).check;
}

async function checkTimedJson(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  nowMs: () => number,
  maxElapsedMs: number,
  validate: (body: any) => boolean,
): Promise<CloudflareControlSmokeCheck> {
  const started = nowMs();
  const check = await checkJson(fetchImpl, name, url, headers, validate);
  const elapsedMs = Math.max(0, nowMs() - started);
  if (check.ok && elapsedMs > maxElapsedMs) {
    return {
      ...check,
      ok: false,
      elapsedMs,
      detail: `elapsed ${elapsedMs}ms exceeded ${maxElapsedMs}ms`,
    };
  }
  return { ...check, elapsedMs };
}

function bearerHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = "true";
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function releaseMode(value: string | undefined): "mock" | "api" | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized === "mock" || normalized === "api") {
    return normalized;
  }
  throw new Error("release-mode must be mock or api");
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function required(value: string | undefined, field: string): string {
  const normalized = nonEmpty(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function flagNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
  return value;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

async function safeText(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printResult(result: CloudflareControlSmokeResult): void {
  for (const check of result.checks) {
    const status = check.status === undefined ? "" : ` status=${check.status}`;
    const elapsed = check.elapsedMs === undefined ? "" : ` elapsedMs=${check.elapsedMs}`;
    const detail = check.detail ? ` detail=${check.detail}` : "";
    console.log(`${check.ok ? "ok" : "not ok"} - ${check.name}${status}${elapsed}${detail}`);
  }
}

export function formatCloudflareControlSmokeMarkdown(result: CloudflareControlSmokeResult): string {
  const summary = result.summary;
  const lines = [
    "# wasmplane Cloudflare Containers smoke",
    "",
    `status: ${result.ok ? "ok" : "failed"}`,
    `control URL: \`${summary.controlUrl}\``,
    `project id: \`${summary.projectId}\``,
    `artifact id: \`${summary.artifactId}\``,
    `deployment id: \`${summary.deploymentId}\``,
    `script name: \`${summary.scriptName}\``,
    ...(summary.releaseId ? [`release id: \`${summary.releaseId}\``] : []),
    `started at: \`${summary.startedAt}\``,
    `finished at: \`${summary.finishedAt}\``,
    `duration ms: ${summary.durationMs}`,
    "",
    "| check | result | status | elapsed ms | detail |",
    "| --- | --- | --- | --- | --- |",
    ...result.checks.map((check) =>
      `| ${markdownCell(check.name)} | ${check.ok ? "ok" : "failed"} | ${check.status ?? ""} | ${
        check.elapsedMs ?? ""
      } | ${markdownCell(check.detail ?? "")} |`
    ),
    "",
  ];
  return lines.join("\n");
}

export async function writeCloudflareControlSmokeReports(
  result: CloudflareControlSmokeResult,
  output: { jsonOutput?: string; markdownOutput?: string },
): Promise<void> {
  if (output.jsonOutput) {
    await writeTextFileCreatingParents(output.jsonOutput, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (output.markdownOutput) {
    await writeTextFileCreatingParents(output.markdownOutput, formatCloudflareControlSmokeMarkdown(result));
  }
}

async function writeTextFileCreatingParents(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function main(): Promise<void> {
  const input = parseCloudflareControlSmokeArgs(process.argv.slice(2));
  const result = await runCloudflareControlSmoke(input);
  printResult(result);
  await writeCloudflareControlSmokeReports(result, input);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
