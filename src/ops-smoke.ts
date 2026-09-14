import { pathToFileURL } from "node:url";

export interface OpsSmokeInput {
  controlUrl: string;
  runtimeUrl: string;
  collectorUrl: string;
  controlToken?: string;
  runtimeToken?: string;
  workerHost?: string;
  workerPath?: string;
  requireExternalDatabase?: boolean;
  minRuntimeNodes?: number;
  requireRustForward?: boolean;
  fetch?: typeof fetch;
}

export interface OpsSmokeCheck {
  name: string;
  ok: boolean;
  status?: number;
  detail?: string;
}

export interface OpsSmokeResult {
  ok: boolean;
  checks: OpsSmokeCheck[];
}

interface OpsSmokeArgsEnv {
  FLY_CONTROL_APP?: string;
  FLY_RUNTIME_APP?: string;
  FLY_COLLECTOR_APP?: string;
  ODENCTL_CONTROL_PLANE_URL?: string;
  CONTROL_PLANE_URL?: string;
  ODEN_RUNTIME_URL?: string;
  RUNTIME_URL?: string;
  ODENCTL_COLLECTOR_URL?: string;
  OTEL_COLLECTOR_URL?: string;
  ODENCTL_CONTROL_PLANE_TOKEN?: string;
  CONTROL_PLANE_TOKEN?: string;
  ODEN_RUNTIME_TOKEN?: string;
  ODENCTL_SMOKE_WORKER_HOST?: string;
  ODENCTL_SMOKE_WORKER_PATH?: string;
  ODENCTL_SMOKE_REQUIRE_EXTERNAL_DB?: string;
  ODENCTL_SMOKE_MIN_RUNTIME_NODES?: string;
  ODENCTL_SMOKE_REQUIRE_RUST_FORWARD?: string;
}

export function parseOpsSmokeArgs(
  args: string[],
  env: OpsSmokeArgsEnv = process.env,
): OpsSmokeInput {
  const flags = parseFlags(args);
  const controlApp = flags["control-app"] ?? env.FLY_CONTROL_APP ?? "mz-wasmplane-control";
  const runtimeApp = flags["runtime-app"] ?? env.FLY_RUNTIME_APP ?? "mz-wasmplane-runtime";
  const collectorApp = flags["collector-app"] ?? env.FLY_COLLECTOR_APP ?? "mz-wasmplane-otel-collector";
  const skipWorker = flags["skip-worker"] === "1" || flags["skip-worker"] === "true";
  return {
    controlUrl: normalizeBaseUrl(
      flags["control-url"] ?? env.ODENCTL_CONTROL_PLANE_URL ?? env.CONTROL_PLANE_URL ?? flyUrl(controlApp),
    ),
    runtimeUrl: normalizeBaseUrl(
      flags["runtime-url"] ?? env.ODEN_RUNTIME_URL ?? env.RUNTIME_URL ?? flyUrl(runtimeApp),
    ),
    collectorUrl: normalizeBaseUrl(
      flags["collector-url"] ?? env.ODENCTL_COLLECTOR_URL ?? env.OTEL_COLLECTOR_URL ?? flyUrl(collectorApp),
    ),
    controlToken: nonEmpty(flags["control-token"] ?? env.ODENCTL_CONTROL_PLANE_TOKEN ?? env.CONTROL_PLANE_TOKEN),
    runtimeToken: nonEmpty(flags["runtime-token"] ?? env.ODEN_RUNTIME_TOKEN),
    workerHost: skipWorker
      ? undefined
      : nonEmpty(flags["worker-host"] ?? env.ODENCTL_SMOKE_WORKER_HOST ?? "hello.example.dev"),
    workerPath: skipWorker
      ? undefined
      : ensurePath(flags["worker-path"] ?? env.ODENCTL_SMOKE_WORKER_PATH ?? "/"),
    requireExternalDatabase: truthy(flags["require-external-db"] ?? env.ODENCTL_SMOKE_REQUIRE_EXTERNAL_DB),
    minRuntimeNodes: optionalPositiveInteger(flags["min-runtime-nodes"] ?? env.ODENCTL_SMOKE_MIN_RUNTIME_NODES),
    requireRustForward: truthy(flags["require-rust-forward"] ?? env.ODENCTL_SMOKE_REQUIRE_RUST_FORWARD),
  };
}

export async function runOpsSmoke(input: OpsSmokeInput): Promise<OpsSmokeResult> {
  const fetchImpl = input.fetch ?? fetch;
  const checks: OpsSmokeCheck[] = [];

  checks.push(await checkJson(fetchImpl, "control health", `${input.controlUrl}/healthz`, undefined, (body) => {
    return body?.ok === true;
  }));
  checks.push(await checkJson(fetchImpl, "runtime health", `${input.runtimeUrl}/__runtime/healthz`, undefined, (body) => {
    return body?.ok === true;
  }));
  checks.push(await checkJson(fetchImpl, "runtime readiness", `${input.runtimeUrl}/__runtime/readyz`, undefined, (body) => {
    return body?.ok === true && body?.status === "active" && Number(body?.checks?.snapshot?.loaded ?? 0) > 0;
  }));
  checks.push(await checkStatus(fetchImpl, "collector health", `${input.collectorUrl}/`));
  checks.push(await checkJson(
    fetchImpl,
    "control autoscaling signals",
    `${input.controlUrl}/autoscaling/signals`,
    bearerHeaders(input.controlToken),
    (body) => Array.isArray(body?.signals),
  ));
  checks.push(await checkJson(
    fetchImpl,
    "control route snapshot",
    `${input.controlUrl}/snapshots/routes`,
    bearerHeaders(input.controlToken),
    (body) => body?.schemaVersion === 1 && Array.isArray(body?.routes),
  ));
  const opsConfig = await readJsonCheck(
    fetchImpl,
    "control ops config",
    `${input.controlUrl}/ops/config`,
    bearerHeaders(input.controlToken),
    (body) => body?.schemaVersion === 1 && isObject(body?.database) && isObject(body?.artifactStore),
  );
  checks.push(opsConfig.check);
  if (input.requireExternalDatabase) {
    checks.push({
      name: "control external database",
      ok: opsConfig.check.ok
        && opsConfig.body?.database?.kind === "postgres"
        && opsConfig.body?.database?.external === true,
      status: opsConfig.check.status,
      detail: opsConfig.check.ok ? undefined : opsConfig.check.detail,
    });
  }
  if (input.minRuntimeNodes !== undefined) {
    checks.push(await checkJson(
      fetchImpl,
      "control active runtime nodes",
      `${input.controlUrl}/runtime-nodes`,
      bearerHeaders(input.controlToken),
      (body) => Array.isArray(body) && countActiveRuntimeNodes(body) >= (input.minRuntimeNodes as number),
    ));
  }
  const runtimeMetrics = await readJsonCheck(
    fetchImpl,
    "runtime metrics",
    `${input.runtimeUrl}/__runtime/metrics`,
    bearerHeaders(input.runtimeToken),
    (body) => isObject(body?.requests) && isObject(body?.invocations) && isObject(body?.snapshots),
  );
  checks.push(runtimeMetrics.check);
  if (input.requireRustForward) {
    checks.push({
      name: "runtime rust-forward daemon routes",
      ok: runtimeMetrics.check.ok && Number(runtimeMetrics.body?.hostDaemon?.preparedRoutes ?? 0) > 0,
      status: runtimeMetrics.check.status,
      detail: runtimeMetrics.check.ok ? undefined : runtimeMetrics.check.detail,
    });
  }

  if (input.workerHost) {
    const workerUrl = `${input.runtimeUrl}${ensurePath(input.workerPath ?? "/")}`;
    const workerHeaders = { "x-forwarded-host": input.workerHost };
    checks.push(await checkStatus(
      fetchImpl,
      "runtime worker traffic",
      workerUrl,
      workerHeaders,
    ));
    if (input.requireRustForward) {
      checks.push(await checkHeader(
        fetchImpl,
        "runtime rust-forward worker proxy",
        workerUrl,
        workerHeaders,
        "x-oden-host-daemon-route",
        "1",
      ));
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function readJsonCheck(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  validate: (body: any) => boolean,
): Promise<{ check: OpsSmokeCheck; body?: any }> {
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

async function checkStatus(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers?: Record<string, string>,
): Promise<OpsSmokeCheck> {
  try {
    const response = await fetchImpl(url, { headers });
    return {
      name,
      ok: response.ok,
      status: response.status,
      detail: response.ok ? undefined : await safeText(response),
    };
  } catch (error) {
    return { name, ok: false, detail: errorMessage(error) };
  }
}

async function checkHeader(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string> | undefined,
  headerName: string,
  expectedValue: string,
): Promise<OpsSmokeCheck> {
  try {
    const response = await fetchImpl(url, { headers });
    const value = response.headers.get(headerName);
    const ok = response.ok && value === expectedValue;
    return {
      name,
      ok,
      status: response.status,
      detail: ok ? undefined : `${headerName}=${value ?? "<missing>"}`,
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
): Promise<OpsSmokeCheck> {
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { name, ok: false, status: response.status, detail: await safeText(response) };
    }
    const body = await response.json();
    const ok = validate(body);
    return {
      name,
      ok,
      status: response.status,
      detail: ok ? undefined : "response JSON did not match expected shape",
    };
  } catch (error) {
    return { name, ok: false, detail: errorMessage(error) };
  }
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

function flyUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensurePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countActiveRuntimeNodes(nodes: unknown[]): number {
  return nodes.filter((node) => isObject(node) && node.status === "active").length;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function safeText(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printResult(result: OpsSmokeResult): void {
  for (const check of result.checks) {
    const status = check.status === undefined ? "" : ` status=${check.status}`;
    const detail = check.detail ? ` detail=${check.detail}` : "";
    console.log(`${check.ok ? "ok" : "not ok"} - ${check.name}${status}${detail}`);
  }
}

async function main(): Promise<void> {
  const result = await runOpsSmoke(parseOpsSmokeArgs(process.argv.slice(2)));
  printResult(result);
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
