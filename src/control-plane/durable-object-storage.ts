import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlPlaneError } from "./errors.ts";
import type { VolumeSqliteRegistry } from "./volume-sqlite.ts";

export type DurableObjectStorageValue =
  | null
  | boolean
  | number
  | string
  | DurableObjectStorageValue[]
  | { [key: string]: DurableObjectStorageValue };

export type DurableObjectSqlBinding = null | string | number | bigint | Uint8Array;
export type DurableObjectAlarmTime = Date | number;

export interface DurableObjectStorageNamespaceOptions {
  namespace: string;
  registry: VolumeSqliteRegistry;
  ownerId?: string;
}

export interface DurableObjectDueAlarm {
  namespace: string;
  objectId: string;
  databaseId: string;
  scheduledTime: Date;
}

export interface DurableObjectDueAlarmListOptions {
  now?: DurableObjectAlarmTime;
  limit?: number;
}

export interface DurableObjectStorageObject {
  id: string;
  namespace: string;
  databaseId: string;
  storage: DurableObjectStorage;
}

export interface DurableObjectStorageListOptions {
  prefix?: string;
  start?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

export interface DurableObjectSqlExecResultOptions<T> {
  rows: T[];
  rowsWritten?: number;
  lastInsertRowid?: number | bigint;
}

export function createDurableObjectStorageNamespace(
  options: DurableObjectStorageNamespaceOptions,
): DurableObjectStorageNamespace {
  return new DurableObjectStorageNamespace(options);
}

export class DurableObjectStorageNamespace {
  readonly namespace: string;
  private readonly registry: VolumeSqliteRegistry;
  private readonly ownerId?: string;

  constructor(options: DurableObjectStorageNamespaceOptions) {
    this.namespace = namespaceName(options.namespace);
    this.registry = options.registry;
    this.ownerId = options.ownerId;
  }

  idFromName(name: string): string {
    const normalized = objectName(name);
    return `do_${sha256Hex(`${this.namespace}\0${normalized}`).slice(0, 32)}`;
  }

  get(id: string): DurableObjectStorageObject {
    const normalized = objectId(id);
    const databaseId = durableObjectDatabaseId(this.namespace, normalized);
    return {
      id: normalized,
      namespace: this.namespace,
      databaseId,
      storage: new DurableObjectStorage({
        databaseId,
        ownerId: this.ownerId,
        namespace: this.namespace,
        objectId: normalized,
        registry: this.registry,
      }),
    };
  }

  storageForName(name: string): DurableObjectStorage {
    return this.get(this.idFromName(name)).storage;
  }

  async listDueAlarms(options: DurableObjectDueAlarmListOptions = {}): Promise<DurableObjectDueAlarm[]> {
    const nowMs = options.now === undefined ? Date.now() : alarmTimeMs(options.now);
    const limit = options.limit === undefined
      ? undefined
      : nonnegativeInteger(options.limit, "durable object due alarm list limit");
    if (limit === 0) {
      return [];
    }

    const alarms: DurableObjectDueAlarm[] = [];
    for (const record of this.registry.listDatabases()) {
      if (record.kind !== "durable_object") {
        continue;
      }
      const alarm = await this.registry.writeDatabase(record.id, (db) => {
        ensureDurableObjectSchema(db);
        const namespace = getMetaText(db, namespaceMetaKey);
        if (namespace !== this.namespace) {
          return undefined;
        }
        const objectId = getMetaText(db, objectIdMetaKey);
        const scheduledTime = getAlarm(db);
        if (!objectId || scheduledTime === undefined || scheduledTime.getTime() > nowMs) {
          return undefined;
        }
        return {
          namespace: this.namespace,
          objectId,
          databaseId: record.id,
          scheduledTime,
        };
      });
      if (alarm) {
        alarms.push(alarm);
      }
    }

    alarms.sort((a, b) =>
      a.scheduledTime.getTime() - b.scheduledTime.getTime()
      || a.objectId.localeCompare(b.objectId)
    );
    return limit === undefined ? alarms : alarms.slice(0, limit);
  }
}

export class DurableObjectStorage {
  readonly databaseId: string;
  readonly sql: DurableObjectSqlStorage;
  private readonly registry: VolumeSqliteRegistry;
  private readonly ownerId?: string;
  private readonly namespace?: string;
  private readonly objectId?: string;

  constructor(options: {
    databaseId: string;
    registry: VolumeSqliteRegistry;
    ownerId?: string;
    namespace?: string;
    objectId?: string;
  }) {
    this.databaseId = options.databaseId;
    this.registry = options.registry;
    this.ownerId = options.ownerId;
    this.namespace = options.namespace;
    this.objectId = options.objectId;
    this.sql = new DurableObjectSqlStorage((query, bindings) =>
      this.runExclusive((db) => executeUserSql(db, query, bindings, { wrapMutation: true }))
    );
  }

  async get<T = DurableObjectStorageValue>(key: string): Promise<T | undefined>;
  async get<T = DurableObjectStorageValue>(keys: string[]): Promise<Map<string, T>>;
  async get<T = DurableObjectStorageValue>(keyOrKeys: string | string[]): Promise<T | Map<string, T> | undefined> {
    return this.runExclusive((db) => Array.isArray(keyOrKeys) ? getMany<T>(db, keyOrKeys) : getOne<T>(db, keyOrKeys));
  }

  async put(key: string, value: DurableObjectStorageValue): Promise<void>;
  async put(entries: ReadonlyMap<string, DurableObjectStorageValue> | Record<string, DurableObjectStorageValue>): Promise<void>;
  async put(
    keyOrEntries: string | ReadonlyMap<string, DurableObjectStorageValue> | Record<string, DurableObjectStorageValue>,
    value?: DurableObjectStorageValue,
  ): Promise<void> {
    await this.runExclusive((db) =>
      withImmediateTransaction(db, () => putEntries(db, normalizePutEntries(keyOrEntries, value)))
    );
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    return this.runExclusive((db) =>
      withImmediateTransaction(db, () => {
        if (Array.isArray(keyOrKeys)) {
          return deleteMany(db, keyOrKeys);
        }
        return deleteOne(db, keyOrKeys);
      })
    );
  }

  async list<T = DurableObjectStorageValue>(options: DurableObjectStorageListOptions = {}): Promise<Map<string, T>> {
    return this.runExclusive((db) => listValues<T>(db, options));
  }

  async getAlarm(): Promise<Date | undefined> {
    return this.runExclusive((db) => getAlarm(db));
  }

  async setAlarm(scheduledTime: DurableObjectAlarmTime): Promise<void> {
    const alarmAtMs = alarmTimeMs(scheduledTime);
    await this.runExclusive((db) => withImmediateTransaction(db, () => setAlarm(db, alarmAtMs)));
  }

  async deleteAlarm(): Promise<boolean> {
    return this.runExclusive((db) => withImmediateTransaction(db, () => deleteAlarm(db)));
  }

  async transaction<T>(
    callback: (transaction: DurableObjectStorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.runExclusive(async (db) => {
      db.exec("begin immediate");
      try {
        const result = await callback(new DurableObjectStorageTransaction(db));
        db.exec("commit");
        return result;
      } catch (error) {
        rollbackIgnoringErrors(db);
        throw error;
      }
    });
  }

  private ensureDatabase(): void {
    this.registry.ensureDatabase({
      id: this.databaseId,
      kind: "durable_object",
      ownerId: this.ownerId,
      schemaVersion: 1,
    });
  }

  private async runExclusive<T>(callback: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    this.ensureDatabase();
    return this.registry.writeDatabase(this.databaseId, (db) => {
      ensureDurableObjectSchema(db);
      recordObjectIdentity(db, this.namespace, this.objectId);
      return callback(db);
    });
  }
}

export class DurableObjectStorageTransaction {
  readonly sql: DurableObjectSqlStorage;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.sql = new DurableObjectSqlStorage((query, bindings) =>
      Promise.resolve(executeUserSql(this.db, query, bindings, { wrapMutation: false }))
    );
  }

  async get<T = DurableObjectStorageValue>(key: string): Promise<T | undefined>;
  async get<T = DurableObjectStorageValue>(keys: string[]): Promise<Map<string, T>>;
  async get<T = DurableObjectStorageValue>(keyOrKeys: string | string[]): Promise<T | Map<string, T> | undefined> {
    return Array.isArray(keyOrKeys) ? getMany<T>(this.db, keyOrKeys) : getOne<T>(this.db, keyOrKeys);
  }

  async put(key: string, value: DurableObjectStorageValue): Promise<void>;
  async put(entries: ReadonlyMap<string, DurableObjectStorageValue> | Record<string, DurableObjectStorageValue>): Promise<void>;
  async put(
    keyOrEntries: string | ReadonlyMap<string, DurableObjectStorageValue> | Record<string, DurableObjectStorageValue>,
    value?: DurableObjectStorageValue,
  ): Promise<void> {
    putEntries(this.db, normalizePutEntries(keyOrEntries, value));
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    return Array.isArray(keyOrKeys) ? deleteMany(this.db, keyOrKeys) : deleteOne(this.db, keyOrKeys);
  }

  async list<T = DurableObjectStorageValue>(options: DurableObjectStorageListOptions = {}): Promise<Map<string, T>> {
    return listValues<T>(this.db, options);
  }
}

export class DurableObjectSqlStorage {
  private readonly execute: (
    query: string,
    bindings: DurableObjectSqlBinding[],
  ) => Promise<DurableObjectSqlCursor<Record<string, unknown>>>;

  constructor(
    execute: (
      query: string,
      bindings: DurableObjectSqlBinding[],
    ) => Promise<DurableObjectSqlCursor<Record<string, unknown>>>,
  ) {
    this.execute = execute;
  }

  async exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: DurableObjectSqlBinding[]
  ): Promise<DurableObjectSqlCursor<T>> {
    return this.execute(query, bindings) as Promise<DurableObjectSqlCursor<T>>;
  }
}

export class DurableObjectSqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly lastInsertRowid?: number | bigint;
  private readonly rows: T[];
  private index = 0;

  constructor(options: DurableObjectSqlExecResultOptions<T>) {
    this.rows = options.rows;
    this.columnNames = options.rows[0] ? Object.keys(options.rows[0]) : [];
    this.rowsRead = options.rows.length;
    this.rowsWritten = options.rowsWritten ?? 0;
    this.lastInsertRowid = options.lastInsertRowid;
  }

  next(): IteratorResult<T> {
    if (this.index >= this.rows.length) {
      return { done: true, value: undefined };
    }
    const value = this.rows[this.index];
    this.index += 1;
    return { done: false, value };
  }

  toArray(): T[] {
    return this.rows.slice(this.index);
  }

  one(): T {
    const rows = this.toArray();
    if (rows.length !== 1) {
      throw new ControlPlaneError("validation", `durable object SQL expected one row but got ${rows.length}`);
    }
    this.index = this.rows.length;
    return rows[0];
  }

  raw(): DurableObjectSqlRawCursor {
    const rows = this.toArray().map((row) => this.columnNames.map((column) => row[column]));
    this.index = this.rows.length;
    return new DurableObjectSqlRawCursor(rows);
  }

  [Symbol.iterator](): Iterator<T> {
    return this;
  }
}

export class DurableObjectSqlRawCursor implements Iterable<unknown[]> {
  private readonly rows: unknown[][];
  private index = 0;

  constructor(rows: unknown[][]) {
    this.rows = rows;
  }

  next(): IteratorResult<unknown[]> {
    if (this.index >= this.rows.length) {
      return { done: true, value: undefined };
    }
    const value = this.rows[this.index];
    this.index += 1;
    return { done: false, value };
  }

  toArray(): unknown[][] {
    return this.rows.slice(this.index);
  }

  [Symbol.iterator](): Iterator<unknown[]> {
    return this;
  }
}

const kvTable = "__wasmplane_do_kv";
const metaTable = "__wasmplane_do_meta";
const alarmMetaKey = "alarm_at_ms";
const namespaceMetaKey = "namespace";
const objectIdMetaKey = "object_id";
const maxKeyBytes = 2048;
const maxObjectIdBytes = 512;
const maxObjectNameBytes = 1024;

function ensureDurableObjectSchema(db: DatabaseSync): void {
  db.exec(`
    create table if not exists ${kvTable} (
      key text primary key,
      value_json text not null,
      updated_at text not null default current_timestamp
    );
    create table if not exists ${metaTable} (
      key text primary key,
      value_text text not null,
      updated_at text not null default current_timestamp
    );
  `);
}

function getOne<T>(db: DatabaseSync, key: string): T | undefined {
  const normalized = storageKey(key);
  const row = db.prepare(`select value_json from ${kvTable} where key = ?`).get(normalized) as
    | { value_json: string }
    | undefined;
  return row ? JSON.parse(row.value_json) as T : undefined;
}

function getMany<T>(db: DatabaseSync, keys: string[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const key of keys) {
    const normalized = storageKey(key);
    const value = getOne<T>(db, normalized);
    if (value !== undefined) {
      out.set(normalized, value);
    }
  }
  return out;
}

function putEntries(db: DatabaseSync, entries: Array<[string, DurableObjectStorageValue]>): void {
  const statement = db.prepare(
    `insert into ${kvTable} (key, value_json, updated_at)
      values (?, ?, current_timestamp)
      on conflict(key) do update set
        value_json = excluded.value_json,
        updated_at = excluded.updated_at`,
  );
  for (const [key, value] of entries) {
    statement.run(storageKey(key), storageJson(value));
  }
}

function deleteOne(db: DatabaseSync, key: string): boolean {
  return db.prepare(`delete from ${kvTable} where key = ?`).run(storageKey(key)).changes > 0;
}

function deleteMany(db: DatabaseSync, keys: string[]): number {
  let deleted = 0;
  for (const key of keys) {
    if (deleteOne(db, key)) {
      deleted += 1;
    }
  }
  return deleted;
}

function listValues<T>(db: DatabaseSync, options: DurableObjectStorageListOptions): Map<string, T> {
  const clauses: string[] = [];
  const bindings: DurableObjectSqlBinding[] = [];
  if (options.prefix !== undefined) {
    const prefix = storageKeyBoundary(options.prefix, "durable object storage list prefix");
    clauses.push("key >= ?", "key < ?");
    bindings.push(prefix, `${prefix}\uffff`);
  }
  if (options.start !== undefined) {
    clauses.push("key >= ?");
    bindings.push(storageKeyBoundary(options.start, "durable object storage list start"));
  }
  if (options.end !== undefined) {
    clauses.push("key < ?");
    bindings.push(storageKeyBoundary(options.end, "durable object storage list end"));
  }
  const limit = options.limit === undefined
    ? undefined
    : nonnegativeInteger(options.limit, "durable object storage list limit");
  let sql = `select key, value_json from ${kvTable}`;
  if (clauses.length > 0) {
    sql += ` where ${clauses.join(" and ")}`;
  }
  sql += ` order by key ${options.reverse ? "desc" : "asc"}`;
  if (limit !== undefined) {
    sql += " limit ?";
    bindings.push(limit);
  }
  const rows = db.prepare(sql).all(...bindings) as Array<{ key: string; value_json: string }>;
  const out = new Map<string, T>();
  for (const row of rows) {
    out.set(row.key, JSON.parse(row.value_json) as T);
  }
  return out;
}

function getAlarm(db: DatabaseSync): Date | undefined {
  const value = getMetaText(db, alarmMetaKey);
  if (value === undefined) {
    return undefined;
  }
  const alarmAtMs = Number(value);
  return Number.isSafeInteger(alarmAtMs) ? new Date(alarmAtMs) : undefined;
}

function setAlarm(db: DatabaseSync, alarmAtMs: number): void {
  setMetaText(db, alarmMetaKey, String(alarmAtMs));
}

function deleteAlarm(db: DatabaseSync): boolean {
  return db.prepare(`delete from ${metaTable} where key = ?`).run(alarmMetaKey).changes > 0;
}

function recordObjectIdentity(db: DatabaseSync, namespace: string | undefined, objectId: string | undefined): void {
  if (namespace === undefined || objectId === undefined) {
    return;
  }
  setMetaText(db, namespaceMetaKey, namespace);
  setMetaText(db, objectIdMetaKey, objectId);
}

function getMetaText(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare(`select value_text from ${metaTable} where key = ?`).get(key) as
    | { value_text: string }
    | undefined;
  return row?.value_text;
}

function setMetaText(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `insert into ${metaTable} (key, value_text, updated_at)
      values (?, ?, current_timestamp)
      on conflict(key) do update set
        value_text = excluded.value_text,
        updated_at = excluded.updated_at`,
  ).run(key, value);
}

function normalizePutEntries(
  keyOrEntries: string | ReadonlyMap<string, DurableObjectStorageValue> | Record<string, DurableObjectStorageValue>,
  value: DurableObjectStorageValue | undefined,
): Array<[string, DurableObjectStorageValue]> {
  if (typeof keyOrEntries === "string") {
    if (value === undefined) {
      throw new ControlPlaneError("validation", "durable object storage value must be JSON serializable");
    }
    return [[keyOrEntries, value]];
  }
  if (keyOrEntries instanceof Map) {
    return [...keyOrEntries.entries()];
  }
  if (!keyOrEntries || typeof keyOrEntries !== "object" || Array.isArray(keyOrEntries)) {
    throw new ControlPlaneError("validation", "durable object storage put entries must be an object or Map");
  }
  return Object.entries(keyOrEntries);
}

function executeUserSql(
  db: DatabaseSync,
  query: string,
  bindings: DurableObjectSqlBinding[],
  options: { wrapMutation: boolean },
): DurableObjectSqlCursor<Record<string, unknown>> {
  const sql = nonEmptySql(query);
  assertNoReservedStorageTable(sql);
  if (isReadSql(sql)) {
    const rows = (db.prepare(sql).all(...bindings) as Record<string, unknown>[]).map(plainRow);
    return new DurableObjectSqlCursor({ rows });
  }
  if (bindings.length === 0 && hasMultipleSqlStatements(sql)) {
    const run = () => {
      db.exec(sql);
      return new DurableObjectSqlCursor<Record<string, unknown>>({ rows: [] });
    };
    return options.wrapMutation ? withImmediateTransaction(db, run) : run();
  }
  const run = () => {
    const result = db.prepare(sql).run(...bindings);
    return new DurableObjectSqlCursor<Record<string, unknown>>({
      rows: [],
      rowsWritten: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    });
  };
  return options.wrapMutation ? withImmediateTransaction(db, run) : run();
}

function withImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("begin immediate");
  try {
    const result = callback();
    db.exec("commit");
    return result;
  } catch (error) {
    rollbackIgnoringErrors(db);
    throw error;
  }
}

function rollbackIgnoringErrors(db: DatabaseSync): void {
  try {
    db.exec("rollback");
  } catch {
    // A failed statement can sometimes abort the transaction before rollback.
  }
}

function isReadSql(query: string): boolean {
  const head = query.trimStart().toLowerCase();
  return head.startsWith("select")
    || head.startsWith("with")
    || head.startsWith("pragma")
    || head.startsWith("explain");
}

function hasMultipleSqlStatements(query: string): boolean {
  return query.split(";").filter((part) => part.trim().length > 0).length > 1;
}

function assertNoReservedStorageTable(query: string): void {
  if (/(^|[^a-zA-Z0-9_])__wasmplane_do_/i.test(query)) {
    throw new ControlPlaneError("validation", "SQL may not access reserved durable object storage table");
  }
}

function storageJson(value: DurableObjectStorageValue): string {
  assertJsonValue(value, "durable object storage value");
  return JSON.stringify(value);
}

function assertJsonValue(value: unknown, field: string, seen = new Set<object>()): asserts value is DurableObjectStorageValue {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ControlPlaneError("validation", `${field} must be finite`);
      }
      return;
    case "object":
      if (seen.has(value)) {
        throw new ControlPlaneError("validation", `${field} must not contain circular references`);
      }
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          assertJsonValue(item, field, seen);
        }
        seen.delete(value);
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new ControlPlaneError("validation", `${field} must be plain JSON`);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.length === 0) {
          throw new ControlPlaneError("validation", `${field} object keys must not be empty`);
        }
        assertJsonValue(child, field, seen);
      }
      seen.delete(value);
      return;
    default:
      throw new ControlPlaneError("validation", `${field} must be JSON serializable`);
  }
}

function namespaceName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new ControlPlaneError(
      "validation",
      "durable object namespace must start with an alphanumeric character and contain only alphanumerics, dot, dash, or underscore",
    );
  }
  return value;
}

function objectId(value: string): string {
  return sizedString(value, "durable object id", maxObjectIdBytes);
}

function objectName(value: string): string {
  return sizedString(value, "durable object name", maxObjectNameBytes);
}

function storageKey(value: string): string {
  return sizedString(value, "durable object storage key", maxKeyBytes);
}

function storageKeyBoundary(value: string, field: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxKeyBytes) {
    throw new ControlPlaneError("validation", `${field} must be at most ${maxKeyBytes} bytes`);
  }
  return value;
}

function alarmTimeMs(value: DurableObjectAlarmTime): number {
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(millis) || millis < 0) {
    throw new ControlPlaneError("validation", "durable object alarm time must be a finite nonnegative millisecond timestamp");
  }
  return millis;
}

function sizedString(value: string, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new ControlPlaneError("validation", `${field} must be a non-empty string up to ${maxBytes} bytes`);
  }
  if (value.includes("\0")) {
    throw new ControlPlaneError("validation", `${field} must not contain null bytes`);
  }
  return value;
}

function durableObjectDatabaseId(namespace: string, id: string): string {
  return `do_${sha256Hex(`v1\0${namespace}\0${id}`).slice(0, 40)}`;
}

function nonEmptySql(query: string): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ControlPlaneError("validation", "durable object SQL query must be non-empty");
  }
  return query;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneError("validation", `${field} must be a nonnegative integer`);
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}
