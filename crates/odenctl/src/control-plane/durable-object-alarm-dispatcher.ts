import { ControlPlaneError } from "./errors.ts";
import type {
  DurableObjectAlarmTime,
  DurableObjectDueAlarm,
  DurableObjectStorage,
  DurableObjectStorageNamespace,
} from "./durable-object-storage.ts";

export interface DurableObjectAlarmHandlerInput extends DurableObjectDueAlarm {
  storage: DurableObjectStorage;
}

export interface DurableObjectAlarmDispatchError {
  namespace: string;
  objectId: string;
  databaseId: string;
  scheduledTime: string;
  message: string;
}

export interface DurableObjectAlarmDispatchReport {
  ok: boolean;
  checkedAt: string;
  due: number;
  dispatched: number;
  failed: number;
  errors: DurableObjectAlarmDispatchError[];
}

export interface DurableObjectAlarmDispatchOptions {
  namespace: DurableObjectStorageNamespace;
  handler(input: DurableObjectAlarmHandlerInput): void | Promise<void>;
  now?: DurableObjectAlarmTime | (() => DurableObjectAlarmTime);
  limit?: number;
}

export interface DurableObjectAlarmDispatcherJobOptions
  extends Omit<Partial<DurableObjectAlarmDispatchOptions>, "namespace" | "handler"> {
  intervalMs: number;
  namespace?: DurableObjectStorageNamespace;
  handler?(input: DurableObjectAlarmHandlerInput): void | Promise<void>;
  dispatch?: () => DurableObjectAlarmDispatchReport | Promise<DurableObjectAlarmDispatchReport>;
  onReport?(report: DurableObjectAlarmDispatchReport): void;
  onError?(error: unknown): void;
  reportIdleTicks?: boolean;
  setIntervalFn?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

export async function dispatchDurableObjectAlarms(
  options: DurableObjectAlarmDispatchOptions,
): Promise<DurableObjectAlarmDispatchReport> {
  const now = resolveNow(options.now);
  const checkedAt = new Date(now).toISOString();
  const dueAlarms = await options.namespace.listDueAlarms({
    now,
    limit: options.limit,
  });
  const errors: DurableObjectAlarmDispatchError[] = [];
  let dispatched = 0;

  for (const alarm of dueAlarms) {
    const object = options.namespace.get(alarm.objectId);
    try {
      await options.handler({
        ...alarm,
        storage: object.storage,
      });
      await clearHandledAlarm(object.storage, alarm.scheduledTime);
      dispatched += 1;
    } catch (error) {
      errors.push({
        namespace: alarm.namespace,
        objectId: alarm.objectId,
        databaseId: alarm.databaseId,
        scheduledTime: alarm.scheduledTime.toISOString(),
        message: errorMessage(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    checkedAt,
    due: dueAlarms.length,
    dispatched,
    failed: errors.length,
    errors,
  };
}

export function createDurableObjectAlarmDispatcherJob(
  options: DurableObjectAlarmDispatcherJobOptions,
) {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new ControlPlaneError("validation", "durable object alarm dispatcher interval must be a positive integer");
  }
  if (!options.dispatch && (!options.namespace || !options.handler)) {
    throw new ControlPlaneError("validation", "durable object alarm dispatcher requires dispatch or namespace and handler");
  }
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let timer: unknown;
  let inFlight = false;

  async function tick(): Promise<boolean> {
    if (inFlight) {
      return false;
    }
    inFlight = true;
    try {
      const report = await runConfiguredDispatch(options);
      if (options.reportIdleTicks !== false || !isIdleDispatchReport(report)) {
        options.onReport?.(report);
      }
      if (!report.ok) {
        throw new Error("durable object alarm dispatcher result was unsuccessful");
      }
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer !== undefined) {
      return;
    }
    timer = setIntervalFn(() => {
      void tick();
    }, options.intervalMs);
  }

  function stop(): void {
    if (timer === undefined) {
      return;
    }
    clearIntervalFn(timer);
    timer = undefined;
  }

  function running(): boolean {
    return timer !== undefined;
  }

  return { tick, start, stop, running };
}

async function clearHandledAlarm(storage: DurableObjectStorage, scheduledTime: Date): Promise<void> {
  const current = await storage.getAlarm();
  if (current?.getTime() === scheduledTime.getTime()) {
    await storage.deleteAlarm();
  }
}

function runConfiguredDispatch(
  options: DurableObjectAlarmDispatcherJobOptions,
): DurableObjectAlarmDispatchReport | Promise<DurableObjectAlarmDispatchReport> {
  if (options.dispatch) {
    return options.dispatch();
  }
  return dispatchDurableObjectAlarms({
    namespace: options.namespace as DurableObjectStorageNamespace,
    handler: options.handler as (input: DurableObjectAlarmHandlerInput) => void | Promise<void>,
    now: options.now,
    limit: options.limit,
  });
}

function isIdleDispatchReport(report: DurableObjectAlarmDispatchReport): boolean {
  return report.ok
    && report.due === 0
    && report.dispatched === 0
    && report.failed === 0
    && report.errors.length === 0;
}

function resolveNow(now: DurableObjectAlarmDispatchOptions["now"]): number {
  const value = typeof now === "function" ? now() : now ?? Date.now();
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(millis) || millis < 0) {
    throw new ControlPlaneError("validation", "durable object alarm dispatcher now must be a finite nonnegative millisecond timestamp");
  }
  return millis;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
