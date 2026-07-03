import { ControlPlaneError } from "./errors.ts";
import {
  createDurableObjectStorageNamespace,
  type DurableObjectStorage,
  type DurableObjectStorageValue,
} from "./durable-object-storage.ts";
import type { VolumeSqliteRegistry } from "./volume-sqlite.ts";

export const ALARM_DEMO_NAMESPACE = "alarm-demo";

export interface AlarmDemoScheduleInput {
  objectName?: string;
  message?: string;
  delayMs?: number;
  repeatMs?: number;
  repeatLimit?: number;
}

export interface AlarmDemoWebhookInput {
  namespace: string;
  objectId: string;
  databaseId?: string;
  scheduledTime: string;
}

export interface AlarmDemoStatus {
  namespace: string;
  objectName: string;
  objectId: string;
  databaseId: string;
  message: string;
  alarmCount: number;
  alarmAt: string | null;
  scheduledAt: string | null;
  lastAlarmAt: string | null;
  lastScheduledTime: string | null;
  repeatMs: number | null;
  remainingRepeats: number;
  updatedAt: string | null;
}

export interface AlarmDemoOptions {
  registry: VolumeSqliteRegistry;
  nowMs?: () => number;
}

export async function scheduleAlarmDemo(
  options: AlarmDemoOptions,
  input: AlarmDemoScheduleInput,
): Promise<AlarmDemoStatus> {
  const namespace = createDemoNamespace(options.registry);
  const objectName = demoObjectName(input.objectName ?? "heartbeat");
  const object = namespace.get(namespace.idFromName(objectName));
  const now = resolveNowMs(options.nowMs);
  const delayMs = nonnegativeInteger(input.delayMs ?? 1000, "alarm demo delayMs");
  const repeatMs = input.repeatMs === undefined ? null : positiveInteger(input.repeatMs, "alarm demo repeatMs");
  const repeatLimit = nonnegativeInteger(input.repeatLimit ?? 0, "alarm demo repeatLimit");
  const scheduledAt = new Date(now + delayMs).toISOString();
  const updatedAt = new Date(now).toISOString();

  await object.storage.transaction(async (txn) => {
    await txn.put({
      objectName,
      message: demoMessage(input.message ?? "alarm-demo"),
      scheduledAt,
      repeatMs,
      remainingRepeats: repeatLimit,
      updatedAt,
    });
    if ((await txn.get<number>("alarmCount")) === undefined) {
      await txn.put("alarmCount", 0);
    }
  });
  await object.storage.setAlarm(new Date(scheduledAt));
  return readAlarmDemoStatus(options, objectName);
}

export async function readAlarmDemoStatus(
  options: AlarmDemoOptions,
  objectName: string,
): Promise<AlarmDemoStatus> {
  const namespace = createDemoNamespace(options.registry);
  const normalizedName = demoObjectName(objectName);
  const object = namespace.get(namespace.idFromName(normalizedName));
  return statusFromStorage(normalizedName, object.id, object.databaseId, object.storage);
}

export async function handleAlarmDemoWebhook(
  options: AlarmDemoOptions,
  input: AlarmDemoWebhookInput,
): Promise<AlarmDemoStatus> {
  if (input.namespace !== ALARM_DEMO_NAMESPACE) {
    throw new ControlPlaneError("validation", `alarm demo namespace must be ${ALARM_DEMO_NAMESPACE}`);
  }
  const scheduledMs = Date.parse(input.scheduledTime);
  if (!Number.isSafeInteger(scheduledMs)) {
    throw new ControlPlaneError("validation", "alarm demo scheduledTime must be an ISO timestamp");
  }
  const namespace = createDemoNamespace(options.registry);
  const object = namespace.get(input.objectId);
  const now = resolveNowMs(options.nowMs);
  const firedAt = new Date(now).toISOString();
  let objectName = input.objectId;
  let nextAlarmAt: string | undefined;

  await object.storage.transaction(async (txn) => {
    objectName = (await txn.get<string>("objectName")) ?? input.objectId;
    const deliveryKey = alarmDeliveryKey(new Date(scheduledMs).toISOString());
    if ((await txn.get<boolean>(deliveryKey)) === true) {
      return;
    }
    const alarmCount = ((await txn.get<number>("alarmCount")) ?? 0) + 1;
    const repeatMs = await txn.get<number | null>("repeatMs");
    const remainingRepeats = (await txn.get<number>("remainingRepeats")) ?? 0;
    const nextRemainingRepeats = repeatMs && remainingRepeats > 0 ? remainingRepeats - 1 : remainingRepeats;
    if (repeatMs && remainingRepeats > 0) {
      nextAlarmAt = new Date(scheduledMs + repeatMs).toISOString();
    }
    await txn.put({
      alarmCount,
      lastAlarmAt: firedAt,
      lastScheduledTime: new Date(scheduledMs).toISOString(),
      remainingRepeats: nextRemainingRepeats,
      updatedAt: firedAt,
      [deliveryKey]: true,
      ...(nextAlarmAt ? { scheduledAt: nextAlarmAt } : {}),
    });
  });

  if (nextAlarmAt) {
    await object.storage.setAlarm(new Date(nextAlarmAt));
  }
  return statusFromStorage(objectName, object.id, object.databaseId, object.storage);
}

function createDemoNamespace(registry: VolumeSqliteRegistry) {
  return createDurableObjectStorageNamespace({
    namespace: ALARM_DEMO_NAMESPACE,
    ownerId: "alarm-demo",
    registry,
  });
}

async function statusFromStorage(
  objectName: string,
  objectId: string,
  databaseId: string,
  storage: DurableObjectStorage,
): Promise<AlarmDemoStatus> {
  const values = await storage.get<DurableObjectStorageValue>([
    "message",
    "alarmCount",
    "scheduledAt",
    "lastAlarmAt",
    "lastScheduledTime",
    "repeatMs",
    "remainingRepeats",
    "updatedAt",
  ]);
  const alarm = await storage.getAlarm();
  return {
    namespace: ALARM_DEMO_NAMESPACE,
    objectName,
    objectId,
    databaseId,
    message: stringValue(values.get("message"), "alarm-demo"),
    alarmCount: numberValue(values.get("alarmCount"), 0),
    alarmAt: alarm ? alarm.toISOString() : null,
    scheduledAt: stringOrNull(values.get("scheduledAt")),
    lastAlarmAt: stringOrNull(values.get("lastAlarmAt")),
    lastScheduledTime: stringOrNull(values.get("lastScheduledTime")),
    repeatMs: numberOrNull(values.get("repeatMs")),
    remainingRepeats: numberValue(values.get("remainingRepeats"), 0),
    updatedAt: stringOrNull(values.get("updatedAt")),
  };
}

function resolveNowMs(nowMs: (() => number) | undefined): number {
  const now = nowMs ? nowMs() : Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ControlPlaneError("validation", "alarm demo now must be a finite nonnegative millisecond timestamp");
  }
  return now;
}

function demoObjectName(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ControlPlaneError("validation", "alarm demo objectName must be a non-empty string");
  }
  return value.trim();
}

function demoMessage(value: string): string {
  if (typeof value !== "string" || value.length > 1000 || value.includes("\0")) {
    throw new ControlPlaneError("validation", "alarm demo message must be a string up to 1000 characters");
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ControlPlaneError("validation", `${field} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneError("validation", `${field} must be a nonnegative integer`);
  }
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function alarmDeliveryKey(scheduledTime: string): string {
  return `alarmDelivery:${scheduledTime}`;
}
