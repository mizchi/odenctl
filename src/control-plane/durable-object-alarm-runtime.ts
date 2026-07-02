import {
  createDurableObjectAlarmDispatcherJob,
  type DurableObjectAlarmDispatchReport,
  type DurableObjectAlarmHandlerInput,
} from "./durable-object-alarm-dispatcher.ts";
import {
  createDurableObjectStorageNamespace,
  type DurableObjectAlarmTime,
} from "./durable-object-storage.ts";
import type { VolumeSqliteRegistry } from "./volume-sqlite.ts";

export type DurableObjectAlarmFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DurableObjectAlarmWebhookHandlerOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
  fetchFn?: DurableObjectAlarmFetch;
}

export interface ConfiguredDurableObjectAlarmDispatcherOptions {
  env?: Record<string, string | undefined>;
  registry?: VolumeSqliteRegistry;
  fetchFn?: DurableObjectAlarmFetch;
  now?: () => DurableObjectAlarmTime;
  onReport?(namespace: string, report: DurableObjectAlarmDispatchReport): void;
  onError?(namespace: string, error: unknown): void;
  reportIdleTicks?: boolean;
}

export function createDurableObjectAlarmWebhookHandler(
  options: DurableObjectAlarmWebhookHandlerOptions,
) {
  const url = nonEmptyString(options.url, "durable object alarm webhook URL");
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000);
  const fetchFn = options.fetchFn ?? fetch;

  return async function durableObjectAlarmWebhookHandler(
    input: DurableObjectAlarmHandlerInput,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: webhookHeaders(options.token),
        body: JSON.stringify({
          namespace: input.namespace,
          objectId: input.objectId,
          databaseId: input.databaseId,
          scheduledTime: input.scheduledTime.toISOString(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `durable object alarm webhook returned ${response.status}${body ? `: ${body}` : ""}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createConfiguredDurableObjectAlarmDispatcherJobs(
  options: ConfiguredDurableObjectAlarmDispatcherOptions,
) {
  const env = options.env ?? process.env;
  const intervalMs = optionalPositiveInteger(env.WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS);
  if (!intervalMs) {
    return [];
  }
  if (!options.registry) {
    throw new Error("WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS requires WASMPLANE_VOLUME_SQLITE_ROOT");
  }
  const namespaces = csv(firstNonEmpty(
    env.WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES,
    env.WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACE,
  ));
  if (namespaces.length === 0) {
    throw new Error(
      "WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS requires WASMPLANE_DURABLE_OBJECT_ALARM_NAMESPACES",
    );
  }
  const webhookUrl = firstNonEmpty(env.WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL);
  if (!webhookUrl) {
    throw new Error(
      "WASMPLANE_DURABLE_OBJECT_ALARM_INTERVAL_MS requires WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_URL",
    );
  }
  const handler = createDurableObjectAlarmWebhookHandler({
    url: webhookUrl,
    token: firstNonEmpty(env.WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TOKEN),
    timeoutMs: positiveInteger(envInteger(env.WASMPLANE_DURABLE_OBJECT_ALARM_WEBHOOK_TIMEOUT_MS), 10_000),
    fetchFn: options.fetchFn,
  });
  const limit = optionalPositiveInteger(env.WASMPLANE_DURABLE_OBJECT_ALARM_LIMIT);
  const reportIdleTicks = options.reportIdleTicks
    ?? env.WASMPLANE_DURABLE_OBJECT_ALARM_LOG_IDLE_TICKS === "1";

  return namespaces.map((namespaceName) => {
    const namespace = createDurableObjectStorageNamespace({
      namespace: namespaceName,
      registry: options.registry as VolumeSqliteRegistry,
    });
    return createDurableObjectAlarmDispatcherJob({
      intervalMs,
      namespace,
      handler,
      limit,
      now: options.now,
      reportIdleTicks,
      onReport: (report) => options.onReport?.(namespaceName, report),
      onError: (error) => options.onError?.(namespaceName, error),
    });
  });
}

function webhookHeaders(token: string | undefined): Record<string, string> {
  return token
    ? {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    }
    : { "content-type": "application/json" };
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  return positiveInteger(envInteger(value), undefined);
}

function envInteger(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger<T extends number | undefined>(
  value: number | undefined,
  fallback: T,
): number | T {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function nonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return value.trim();
}
