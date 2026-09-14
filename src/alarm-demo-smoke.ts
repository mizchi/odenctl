import { pathToFileURL } from "node:url";

export interface AlarmDemoSmokeInput {
  controlUrl: string;
  token?: string;
  objectName: string;
  message: string;
  delayMs: number;
  repeatMs?: number;
  repeatLimit?: number;
  timeoutMs: number;
  pollMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

export interface AlarmDemoSmokeResult {
  ok: boolean;
  scheduled: any;
  final: any;
  polls: number;
}

interface AlarmDemoSmokeEnv {
  FLY_CONTROL_APP?: string;
  ODENCTL_CONTROL_PLANE_URL?: string;
  CONTROL_PLANE_URL?: string;
  ODENCTL_CONTROL_PLANE_TOKEN?: string;
  CONTROL_PLANE_TOKEN?: string;
  ODENCTL_ALARM_DEMO_OBJECT?: string;
  ODENCTL_ALARM_DEMO_MESSAGE?: string;
}

export function parseAlarmDemoSmokeArgs(
  args: string[],
  env: AlarmDemoSmokeEnv = process.env,
): AlarmDemoSmokeInput {
  const flags = parseFlags(args);
  const controlApp = flags["control-app"] ?? env.FLY_CONTROL_APP ?? "mz-wasmplane-control";
  return {
    controlUrl: normalizeBaseUrl(
      flags["control-url"] ?? env.ODENCTL_CONTROL_PLANE_URL ?? env.CONTROL_PLANE_URL ?? flyUrl(controlApp),
    ),
    token: nonEmpty(flags["token"] ?? env.ODENCTL_CONTROL_PLANE_TOKEN ?? env.CONTROL_PLANE_TOKEN),
    objectName: nonEmpty(flags["object"] ?? env.ODENCTL_ALARM_DEMO_OBJECT) ?? "heartbeat",
    message: flags["message"] ?? env.ODENCTL_ALARM_DEMO_MESSAGE ?? "alarm-demo-smoke",
    delayMs: nonnegativeInteger(flagNumber(flags["delay-ms"], 1000), "delay-ms"),
    repeatMs: optionalPositiveInteger(flags["repeat-ms"], "repeat-ms"),
    repeatLimit: optionalNonnegativeInteger(flags["repeat-limit"], "repeat-limit"),
    timeoutMs: positiveInteger(flagNumber(flags["timeout-ms"], 15_000), "timeout-ms"),
    pollMs: positiveInteger(flagNumber(flags["poll-ms"], 500), "poll-ms"),
  };
}

export async function runAlarmDemoSmoke(input: AlarmDemoSmokeInput): Promise<AlarmDemoSmokeResult> {
  const fetchImpl = input.fetch ?? fetch;
  const sleepImpl = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = input.nowMs ?? (() => Date.now());
  const started = nowMs();
  const scheduled = await postJson(fetchImpl, `${input.controlUrl}/alarm-demo/schedules`, input.token, {
    objectName: input.objectName,
    message: input.message,
    delayMs: input.delayMs,
    repeatMs: input.repeatMs,
    repeatLimit: input.repeatLimit,
  });
  const initialCount = numberValue(scheduled.alarmCount, 0);
  let polls = 0;
  let final = scheduled;

  while (nowMs() - started <= input.timeoutMs) {
    await sleepImpl(input.pollMs);
    polls += 1;
    final = await getJson(
      fetchImpl,
      `${input.controlUrl}/alarm-demo/objects/${encodeURIComponent(input.objectName)}`,
      input.token,
    );
    if (numberValue(final.alarmCount, 0) > initialCount) {
      return { ok: true, scheduled, final, polls };
    }
  }

  return { ok: false, scheduled, final, polls };
}

async function postJson(fetchImpl: typeof fetch, url: string, token: string | undefined, body: unknown): Promise<any> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string | undefined): Promise<any> {
  const response = await fetchImpl(url, {
    headers: bearerHeaders(token),
  });
  if (response.status !== 200) {
    throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

function jsonHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...bearerHeaders(token),
  };
}

function bearerHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
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

function optionalPositiveInteger(value: string | undefined, field: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(flagNumber(value, Number.NaN), field);
}

function optionalNonnegativeInteger(value: string | undefined, field: string): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(flagNumber(value, Number.NaN), field);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function printResult(result: AlarmDemoSmokeResult): void {
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const result = await runAlarmDemoSmoke(parseAlarmDemoSmokeArgs(process.argv.slice(2)));
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
