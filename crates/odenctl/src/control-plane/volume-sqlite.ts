import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneError } from "./errors.ts";

export interface VolumeSqliteDatabaseRecord {
  id: string;
  path: string;
  kind: string;
  ownerId?: string;
  schemaVersion: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface EnsureVolumeSqliteDatabaseInput {
  id: string;
  kind?: string;
  ownerId?: string;
  schemaVersion?: number;
}

export interface ExportVolumeSqliteDatabaseInput {
  id: string;
  backupId?: string;
}

export interface RestoreVolumeSqliteDatabaseInput {
  id: string;
  backupId?: string;
  sourcePath?: string;
  kind?: string;
  ownerId?: string;
  schemaVersion?: number;
}

export interface VerifyVolumeSqliteBackupRestoreInput {
  backupId?: string;
  databaseId?: string;
}

export interface VolumeSqliteBackupRecord {
  id: string;
  databaseId: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  encrypted?: boolean;
  encryptionAlgorithm?: string;
  encryptionKeyId?: string;
  encryptionIv?: string;
  encryptionTag?: string;
}

export interface VolumeSqliteBackupRestoreDrillReport {
  backupId: string;
  databaseId: string;
  checkedAt: string;
  ok: boolean;
  sizeBytes: number;
  encrypted?: boolean;
  schemaVersion?: number;
  error?: string;
}

export interface PruneVolumeSqliteBackupsInput {
  id?: string;
  keepLatest?: number;
  olderThanMs?: number;
}

export interface VolumeSqliteBackupGcReport {
  deleted: VolumeSqliteBackupRecord[];
  remaining: number;
  deletedBytes: number;
}

export interface VolumeSqliteWriterQueueStats {
  maxPendingPerDatabase: number;
  rejectedWrites: number;
  databases: Array<{
    id: string;
    active: boolean;
    queued: number;
    pending: number;
  }>;
}

export interface VolumeSqliteRegistryOptions {
  rootDir: string;
  catalogPath?: string;
  maxOpenDatabases?: number;
  maxPendingWritesPerDatabase?: number;
  maxBackupsPerDatabase?: number;
  backupRetentionMs?: number;
  backupCipher?: VolumeSqliteBackupCipher;
  busyTimeoutMs?: number;
  now?: () => string;
}

export interface VolumeSqliteBackupCipher {
  encrypt(input: VolumeSqliteBackupCipherEncryptInput): VolumeSqliteBackupCipherEncryptResult;
  decrypt(input: VolumeSqliteBackupCipherDecryptInput): Buffer;
}

export interface VolumeSqliteBackupCipherEncryptInput {
  databaseId: string;
  backupId: string;
  plaintext: Buffer;
}

export interface VolumeSqliteBackupCipherEncryptResult {
  ciphertext: Buffer;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: Buffer;
  tag: Buffer;
}

export interface VolumeSqliteBackupCipherDecryptInput {
  databaseId: string;
  backupId: string;
  ciphertext: Buffer;
  algorithm: string;
  keyId: string;
  iv: Buffer;
  tag: Buffer;
}

export interface VolumeSqliteBackupDataKey {
  keyId: string;
  key: Buffer | Uint8Array;
}

export interface AesGcmVolumeSqliteBackupCipherOptions {
  primaryKey: VolumeSqliteBackupDataKey;
  decryptKeys?: VolumeSqliteBackupDataKey[];
  randomBytes?: (size: number) => Buffer | Uint8Array;
}

export interface SqliteDatabasePoolOptions {
  maxOpen: number;
  busyTimeoutMs?: number;
  configure?: (db: DatabaseSync, path: string) => void;
}

export interface SqliteDatabasePoolEntry {
  id: string;
  path: string;
}

export function createVolumeSqliteRegistry(options: VolumeSqliteRegistryOptions): VolumeSqliteRegistry {
  return new VolumeSqliteRegistry(options);
}

export class VolumeSqliteRegistry {
  readonly rootDir: string;
  readonly databaseDir: string;
  readonly backupDir: string;
  readonly catalogPath: string;
  private readonly catalog: DatabaseSync;
  private readonly pool: SqliteDatabasePool;
  private readonly writerQueue: PerDatabaseWriterQueue;
  private readonly maxBackupsPerDatabase?: number;
  private readonly backupRetentionMs?: number;
  private readonly backupCipher?: VolumeSqliteBackupCipher;
  private readonly now: () => string;

  constructor(options: VolumeSqliteRegistryOptions) {
    this.rootDir = resolve(options.rootDir);
    this.databaseDir = join(this.rootDir, "dbs");
    this.backupDir = join(this.rootDir, "backups");
    this.catalogPath = resolve(options.catalogPath ?? join(this.rootDir, "catalog.sqlite"));
    assertPathInside(this.rootDir, this.catalogPath, "volume sqlite catalog path");
    mkdirSync(this.databaseDir, { recursive: true });
    mkdirSync(this.backupDir, { recursive: true });
    mkdirSync(dirname(this.catalogPath), { recursive: true });
    secureDirectory(this.rootDir);
    secureDirectory(this.databaseDir);
    secureDirectory(this.backupDir);
    secureDirectory(dirname(this.catalogPath));
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalog = new DatabaseSync(this.catalogPath);
    configureSqliteDatabase(this.catalog, { busyTimeoutMs: options.busyTimeoutMs });
    this.catalog.exec(catalogSchema);
    ensureCatalogCompatibility(this.catalog);
    secureSqliteFiles(this.catalogPath);
    this.pool = new SqliteDatabasePool({
      maxOpen: options.maxOpenDatabases ?? 64,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    this.writerQueue = new PerDatabaseWriterQueue({
      maxPendingPerDatabase: options.maxPendingWritesPerDatabase ?? 64,
    });
    this.maxBackupsPerDatabase = optionalNonnegativeInteger(
      options.maxBackupsPerDatabase,
      "volume sqlite max backups per database",
    );
    this.backupRetentionMs = optionalNonnegativeInteger(
      options.backupRetentionMs,
      "volume sqlite backup retention ms",
    );
    this.backupCipher = options.backupCipher;
  }

  ensureDatabase(input: EnsureVolumeSqliteDatabaseInput): VolumeSqliteDatabaseRecord {
    const id = databaseId(input.id);
    const kind = databaseKind(input.kind ?? "project");
    const ownerId = optionalIdentifier(input.ownerId, "volume sqlite database owner id");
    const schemaVersion = nonnegativeInteger(input.schemaVersion ?? 0, "volume sqlite database schema version");
    const existing = this.getDatabase(id);
    if (existing) {
      const lastUsedAt = this.now();
      this.catalog
        .prepare(
          `update volume_sqlite_databases set
            kind = ?,
            owner_id = ?,
            schema_version = max(schema_version, ?),
            last_used_at = ?
          where id = ?`,
        )
        .run(kind, ownerId ?? null, schemaVersion, lastUsedAt, id);
      const updated = this.getDatabase(id) as VolumeSqliteDatabaseRecord;
      this.initializeDatabaseFile(updated);
      return updated;
    }

    const createdAt = this.now();
    const path = this.pathForDatabase(id);
    mkdirSync(dirname(path), { recursive: true });
    this.catalog
      .prepare(
        `insert into volume_sqlite_databases (
          id,
          path,
          kind,
          owner_id,
          schema_version,
          created_at,
          last_used_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, path, kind, ownerId ?? null, schemaVersion, createdAt, createdAt);
    const record = this.getDatabase(id) as VolumeSqliteDatabaseRecord;
    this.initializeDatabaseFile(record);
    return record;
  }

  getDatabase(id: string): VolumeSqliteDatabaseRecord | undefined {
    const row = this.catalog
      .prepare("select * from volume_sqlite_databases where id = ?")
      .get(databaseId(id));
    return row ? recordFromRow(row) : undefined;
  }

  listDatabases(): VolumeSqliteDatabaseRecord[] {
    return this.catalog
      .prepare("select * from volume_sqlite_databases order by id asc")
      .all()
      .map(recordFromRow);
  }

  exportDatabase(input: ExportVolumeSqliteDatabaseInput): VolumeSqliteBackupRecord {
    const record = this.requiredDatabase(input.id);
    const createdAt = this.now();
    const id = volumeSqliteBackupId(input.backupId ?? defaultBackupId(record.id, createdAt));
    const path = this.pathForBackup(id);
    if (existsSync(path)) {
      throw new ControlPlaneError("validation", `volume sqlite backup ${id} already exists`);
    }
    mkdirSync(dirname(path), { recursive: true });
    secureDirectory(dirname(path));
    const exportPath = this.backupCipher ? temporaryBackupPath(path) : path;
    this.withDatabase(record.id, (db) => {
      db.exec(`vacuum main into ${sqlString(exportPath)}`);
    });
    secureFile(exportPath);
    const encrypted = this.encryptBackupIfConfigured({
      databaseId: record.id,
      backupId: id,
      sourcePath: exportPath,
      targetPath: path,
    });
    if (exportPath !== path) {
      unlinkIfExists(exportPath);
    }
    secureFile(path);
    const sizeBytes = statSync(path).size;
    this.catalog
      .prepare(
        `insert into volume_sqlite_backups (
          id,
          database_id,
          path,
          size_bytes,
          created_at,
          encryption_algorithm,
          encryption_key_id,
          encryption_iv,
          encryption_tag
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.id,
        path,
        sizeBytes,
        createdAt,
        encrypted?.algorithm ?? null,
        encrypted?.keyId ?? null,
        encrypted?.iv.toString("base64url") ?? null,
        encrypted?.tag.toString("base64url") ?? null,
      );
    if (this.maxBackupsPerDatabase !== undefined || this.backupRetentionMs !== undefined) {
      this.pruneBackups({ id: record.id });
    }
    return this.getBackup(id) as VolumeSqliteBackupRecord;
  }

  restoreDatabase(input: RestoreVolumeSqliteDatabaseInput): VolumeSqliteDatabaseRecord {
    const id = databaseId(input.id);
    const existing = this.getDatabase(id);
    const source = this.restoreSource(input);
    try {
      const sourceSchemaVersion = sqliteUserVersionFromPath(source.path);
      const schemaVersion = nonnegativeInteger(
        input.schemaVersion ?? sourceSchemaVersion,
        "volume sqlite database schema version",
      );
      const kind = databaseKind(input.kind ?? existing?.kind ?? "project");
      const ownerId = optionalIdentifier(input.ownerId ?? existing?.ownerId, "volume sqlite database owner id");
      const targetPath = this.pathForDatabase(id);
      const restoredAt = this.now();

      this.pool.close(id);
      mkdirSync(dirname(targetPath), { recursive: true });
      secureDirectory(dirname(targetPath));
      removeSqliteSidecars(targetPath);
      copyFileSync(source.path, targetPath);
      secureFile(targetPath);
      removeSqliteSidecars(targetPath);

      if (existing) {
        this.catalog
          .prepare(
            `update volume_sqlite_databases set
              path = ?,
              kind = ?,
              owner_id = ?,
              schema_version = ?,
              last_used_at = ?
            where id = ?`,
          )
          .run(targetPath, kind, ownerId ?? null, schemaVersion, restoredAt, id);
      } else {
        this.catalog
          .prepare(
            `insert into volume_sqlite_databases (
              id,
              path,
              kind,
              owner_id,
              schema_version,
              created_at,
              last_used_at
            ) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, targetPath, kind, ownerId ?? null, schemaVersion, restoredAt, restoredAt);
      }
      const record = this.getDatabase(id) as VolumeSqliteDatabaseRecord;
      this.initializeDatabaseFile(record);
      return record;
    } finally {
      source.cleanup?.();
    }
  }

  verifyBackupRestore(input: VerifyVolumeSqliteBackupRestoreInput): VolumeSqliteBackupRestoreDrillReport {
    const backup = this.backupForRestoreDrill(input);
    const checkedAt = this.now();
    const drillPath = temporaryRestorePath(this.backupDir, `${backup.id}-drill`);
    let source: { path: string; cleanup?: () => void } | undefined;
    try {
      source = this.decryptBackupIfNeeded(backup);
      copyFileSync(source.path, drillPath);
      secureFile(drillPath);
      const schemaVersion = sqliteUserVersionFromPath(drillPath);
      return {
        backupId: backup.id,
        databaseId: backup.databaseId,
        checkedAt,
        ok: true,
        sizeBytes: backup.sizeBytes,
        ...(backup.encrypted ? { encrypted: true } : {}),
        schemaVersion,
      };
    } catch (error) {
      return {
        backupId: backup.id,
        databaseId: backup.databaseId,
        checkedAt,
        ok: false,
        sizeBytes: backup.sizeBytes,
        ...(backup.encrypted ? { encrypted: true } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      source?.cleanup?.();
      unlinkIfExists(drillPath);
    }
  }

  listBackups(id?: string): VolumeSqliteBackupRecord[] {
    const rows = id
      ? this.catalog
        .prepare("select * from volume_sqlite_backups where database_id = ? order by created_at desc, id desc")
        .all(databaseId(id))
      : this.catalog
        .prepare("select * from volume_sqlite_backups order by created_at desc, id desc")
        .all();
    return rows.map(backupRecordFromRow);
  }

  pruneBackups(input: PruneVolumeSqliteBackupsInput = {}): VolumeSqliteBackupGcReport {
    const keepLatest = optionalNonnegativeInteger(
      input.keepLatest ?? this.maxBackupsPerDatabase,
      "volume sqlite backup retention keepLatest",
    );
    const olderThanMs = optionalNonnegativeInteger(
      input.olderThanMs ?? this.backupRetentionMs,
      "volume sqlite backup retention olderThanMs",
    );
    if (keepLatest === undefined && olderThanMs === undefined) {
      return { deleted: [], remaining: this.listBackups(input.id).length, deletedBytes: 0 };
    }
    const nowMs = Date.parse(this.now());
    const cutoff = olderThanMs === undefined || Number.isNaN(nowMs)
      ? undefined
      : nowMs - olderThanMs;
    const groups = groupBackupsByDatabase(this.listBackups(input.id));
    const deleted: VolumeSqliteBackupRecord[] = [];

    for (const backups of groups.values()) {
      for (let index = 0; index < backups.length; index += 1) {
        const backup = backups[index];
        const beyondKeep = keepLatest !== undefined && index >= keepLatest;
        const expired = cutoff !== undefined
          && (keepLatest === undefined || index >= keepLatest)
          && backupCreatedBefore(backup, cutoff);
        if (!beyondKeep && !expired) {
          continue;
        }
        this.deleteBackup(backup);
        deleted.push(backup);
      }
    }

    return {
      deleted,
      remaining: this.listBackups(input.id).length,
      deletedBytes: deleted.reduce((sum, backup) => sum + backup.sizeBytes, 0),
    };
  }

  withDatabase<T>(id: string, callback: (db: DatabaseSync, record: VolumeSqliteDatabaseRecord) => T): T {
    const record = this.requiredDatabase(id);
    const lastUsedAt = this.now();
    this.catalog
      .prepare("update volume_sqlite_databases set last_used_at = ? where id = ?")
      .run(lastUsedAt, record.id);
    const updated = { ...record, lastUsedAt };
    return callback(this.pool.open(updated), updated);
  }

  writeDatabase<T>(
    id: string,
    callback: (
      db: DatabaseSync,
      record: VolumeSqliteDatabaseRecord,
    ) => T | Promise<T>,
  ): Promise<T> {
    const normalized = databaseId(id);
    return this.writerQueue.enqueue(normalized, () => this.withDatabase(normalized, callback));
  }

  stats() {
    return {
      databases: this.listDatabases().length,
      backups: this.listBackups().length,
      pool: this.pool.stats(),
      writerQueues: this.writerQueue.stats(),
    };
  }

  close(): void {
    this.pool.closeAll();
    this.catalog.close();
  }

  private pathForDatabase(id: string): string {
    const path = resolve(join(this.databaseDir, `${id}.sqlite`));
    assertPathInside(this.databaseDir, path, "volume sqlite database path");
    return path;
  }

  private pathForBackup(id: string): string {
    const path = resolve(join(this.backupDir, `${id}.sqlite`));
    assertPathInside(this.backupDir, path, "volume sqlite backup path");
    return path;
  }

  private restoreSource(input: RestoreVolumeSqliteDatabaseInput): { path: string; cleanup?: () => void } {
    if (input.backupId && input.sourcePath) {
      throw new ControlPlaneError("validation", "restore must use either backupId or sourcePath, not both");
    }
    if (input.backupId) {
      const backup = this.getBackup(volumeSqliteBackupId(input.backupId));
      if (!backup) {
        throw new ControlPlaneError("not_found", `volume sqlite backup ${input.backupId} was not found`);
      }
      return this.decryptBackupIfNeeded(backup);
    }
    if (!input.sourcePath) {
      throw new ControlPlaneError("validation", "restore requires backupId or sourcePath");
    }
    const sourcePath = resolve(input.sourcePath);
    assertPathInside(this.backupDir, sourcePath, "volume sqlite restore source path");
    if (!existsSync(sourcePath)) {
      throw new ControlPlaneError("not_found", `volume sqlite restore source ${sourcePath} was not found`);
    }
    return { path: sourcePath };
  }

  private getBackup(id: string): VolumeSqliteBackupRecord | undefined {
    const row = this.catalog
      .prepare("select * from volume_sqlite_backups where id = ?")
      .get(volumeSqliteBackupId(id));
    return row ? backupRecordFromRow(row) : undefined;
  }

  private backupForRestoreDrill(input: VerifyVolumeSqliteBackupRestoreInput): VolumeSqliteBackupRecord {
    if (input.backupId && input.databaseId) {
      throw new ControlPlaneError("validation", "restore drill must use either backupId or databaseId, not both");
    }
    if (input.backupId) {
      const backup = this.getBackup(volumeSqliteBackupId(input.backupId));
      if (!backup) {
        throw new ControlPlaneError("not_found", `volume sqlite backup ${input.backupId} was not found`);
      }
      return backup;
    }
    if (input.databaseId) {
      const backup = this.listBackups(databaseId(input.databaseId))[0];
      if (!backup) {
        throw new ControlPlaneError("not_found", `volume sqlite database ${input.databaseId} has no backups`);
      }
      return backup;
    }
    throw new ControlPlaneError("validation", "restore drill requires backupId or databaseId");
  }

  private requiredDatabase(id: string): VolumeSqliteDatabaseRecord {
    const record = this.getDatabase(id);
    if (!record) {
      throw new ControlPlaneError("not_found", `volume sqlite database ${id} was not found`);
    }
    return record;
  }

  private deleteBackup(backup: VolumeSqliteBackupRecord): void {
    const path = resolve(backup.path);
    assertPathInside(this.backupDir, path, "volume sqlite backup path");
    removeSqliteSidecars(path);
    unlinkIfExists(path);
    this.catalog.prepare("delete from volume_sqlite_backups where id = ?").run(backup.id);
  }

  private initializeDatabaseFile(record: VolumeSqliteDatabaseRecord): void {
    this.withDatabase(record.id, (db) => {
      const current = userVersion(db);
      if (current < record.schemaVersion) {
        db.exec(`pragma user_version = ${record.schemaVersion}`);
      }
    });
    secureSqliteFiles(record.path);
  }

  private encryptBackupIfConfigured(input: {
    databaseId: string;
    backupId: string;
    sourcePath: string;
    targetPath: string;
  }): VolumeSqliteBackupCipherEncryptResult | undefined {
    if (!this.backupCipher) {
      return undefined;
    }
    const result = this.backupCipher.encrypt({
      databaseId: input.databaseId,
      backupId: input.backupId,
      plaintext: readFileSync(input.sourcePath),
    });
    writeFileSync(input.targetPath, result.ciphertext, { mode: 0o600 });
    return result;
  }

  private decryptBackupIfNeeded(backup: VolumeSqliteBackupRecord): { path: string; cleanup?: () => void } {
    if (!backup.encrypted) {
      return { path: backup.path };
    }
    if (!this.backupCipher) {
      throw new ControlPlaneError("validation", "encrypted volume sqlite backup requires a configured backup cipher");
    }
    if (!backup.encryptionAlgorithm || !backup.encryptionKeyId) {
      throw new ControlPlaneError("validation", `encrypted volume sqlite backup ${backup.id} is missing metadata`);
    }
    const tempPath = temporaryRestorePath(this.backupDir, backup.id);
    const plaintext = this.backupCipher.decrypt({
      databaseId: backup.databaseId,
      backupId: backup.id,
      ciphertext: readFileSync(backup.path),
      algorithm: backup.encryptionAlgorithm,
      keyId: backup.encryptionKeyId,
      iv: backupEncryptionPart(backup, "iv"),
      tag: backupEncryptionPart(backup, "tag"),
    });
    writeFileSync(tempPath, plaintext, { mode: 0o600 });
    secureFile(tempPath);
    return {
      path: tempPath,
      cleanup() {
        unlinkIfExists(tempPath);
      },
    };
  }
}

export function createAesGcmVolumeSqliteBackupCipher(
  options: AesGcmVolumeSqliteBackupCipherOptions,
): VolumeSqliteBackupCipher {
  const primaryKey = normalizeBackupDataKey(options.primaryKey, "primary volume sqlite backup key");
  const keys = new Map<string, Buffer>();
  addBackupDataKey(keys, primaryKey, "primary volume sqlite backup key");
  for (const key of options.decryptKeys ?? []) {
    addBackupDataKey(keys, normalizeBackupDataKey(key, "volume sqlite backup decrypt key"), "volume sqlite backup decrypt key");
  }
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  return {
    encrypt(input) {
      const iv = Buffer.from(randomBytes(12));
      if (iv.byteLength !== 12) {
        throw new ControlPlaneError("validation", "volume sqlite backup IV generator returned invalid size");
      }
      const cipher = createCipheriv("aes-256-gcm", primaryKey.key, iv);
      cipher.setAAD(backupCipherAad(input.databaseId, input.backupId, "aes-256-gcm", primaryKey.keyId));
      const ciphertext = Buffer.concat([
        cipher.update(input.plaintext),
        cipher.final(),
      ]);
      return {
        ciphertext,
        algorithm: "aes-256-gcm",
        keyId: primaryKey.keyId,
        iv,
        tag: cipher.getAuthTag(),
      };
    },
    decrypt(input) {
      if (input.algorithm !== "aes-256-gcm") {
        throw new ControlPlaneError("validation", `unsupported volume sqlite backup algorithm ${input.algorithm}`);
      }
      const key = keys.get(input.keyId);
      if (!key) {
        throw new ControlPlaneError("validation", `volume sqlite backup key id ${input.keyId} is not configured`);
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, input.iv);
        decipher.setAAD(backupCipherAad(input.databaseId, input.backupId, input.algorithm, input.keyId));
        decipher.setAuthTag(input.tag);
        return Buffer.concat([
          decipher.update(input.ciphertext),
          decipher.final(),
        ]);
      } catch {
        throw new ControlPlaneError("validation", "encrypted volume sqlite backup could not be decrypted");
      }
    },
  };
}

export function createConfiguredVolumeSqliteBackupCipher(
  env: Record<string, string | undefined> = process.env,
): VolumeSqliteBackupCipher | undefined {
  const primaryKeyBase64 = firstNonEmpty(env.ODENCTL_VOLUME_SQLITE_BACKUP_KEY_BASE64);
  const extraKeys = parseBackupKeyringEnv(firstNonEmpty(env.ODENCTL_VOLUME_SQLITE_BACKUP_KEYS_BASE64));
  if (!primaryKeyBase64 && extraKeys.length === 0) {
    return undefined;
  }
  const configuredKeyId = firstNonEmpty(env.ODENCTL_VOLUME_SQLITE_BACKUP_KEY_ID);
  const keys: VolumeSqliteBackupDataKey[] = [];
  if (primaryKeyBase64) {
    keys.push({
      keyId: configuredKeyId ?? "local",
      key: Buffer.from(primaryKeyBase64, "base64"),
    });
  }
  keys.push(...extraKeys);
  const primaryKey = configuredKeyId
    ? keys.find((key) => key.keyId === configuredKeyId)
    : keys[0];
  if (!primaryKey) {
    throw new ControlPlaneError(
      "validation",
      `primary volume sqlite backup key id ${configuredKeyId ?? "<first>"} is not configured`,
    );
  }
  return createAesGcmVolumeSqliteBackupCipher({
    primaryKey,
    decryptKeys: keys,
  });
}

class PerDatabaseWriterQueue {
  private readonly maxPendingPerDatabase: number;
  private readonly states = new Map<string, { tail: Promise<void>; active: boolean; pending: number }>();
  private rejectedWrites = 0;

  constructor(options: { maxPendingPerDatabase: number }) {
    this.maxPendingPerDatabase = positiveInteger(
      options.maxPendingPerDatabase,
      "volume sqlite writer queue maxPendingPerDatabase",
    );
  }

  enqueue<T>(id: string, operation: () => T | Promise<T>): Promise<T> {
    const normalized = databaseId(id);
    const state = this.stateFor(normalized);
    if (state.pending >= this.maxPendingPerDatabase) {
      this.rejectedWrites += 1;
      return Promise.reject(
        new ControlPlaneError("conflict", `volume sqlite writer queue for ${normalized} is full`),
      );
    }
    state.pending += 1;
    const run = state.tail.then(async () => {
      state.active = true;
      try {
        return await operation();
      } finally {
        state.active = false;
        state.pending -= 1;
        if (state.pending === 0 && this.states.get(normalized) === state) {
          this.states.delete(normalized);
        }
      }
    });
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stats(): VolumeSqliteWriterQueueStats {
    return {
      maxPendingPerDatabase: this.maxPendingPerDatabase,
      rejectedWrites: this.rejectedWrites,
      databases: [...this.states.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, state]) => ({
          id,
          active: state.active,
          queued: Math.max(0, state.pending - (state.active ? 1 : 0)),
          pending: state.pending,
        })),
    };
  }

  private stateFor(id: string): { tail: Promise<void>; active: boolean; pending: number } {
    const existing = this.states.get(id);
    if (existing) {
      return existing;
    }
    const state = { tail: Promise.resolve(), active: false, pending: 0 };
    this.states.set(id, state);
    return state;
  }
}

export class SqliteDatabasePool {
  private readonly maxOpen: number;
  private readonly configure: (db: DatabaseSync, path: string) => void;
  private readonly entries = new Map<string, { path: string; db: DatabaseSync }>();

  constructor(options: SqliteDatabasePoolOptions) {
    this.maxOpen = positiveInteger(options.maxOpen, "sqlite database pool maxOpen");
    this.configure = options.configure
      ?? ((db) => configureSqliteDatabase(db, { busyTimeoutMs: options.busyTimeoutMs }));
  }

  open(entry: SqliteDatabasePoolEntry): DatabaseSync {
    const id = databaseId(entry.id);
    const path = resolve(entry.path);
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing.db;
    }
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    this.configure(db, path);
    this.entries.set(id, { path, db });
    this.evictOverflow();
    return db;
  }

  close(id: string): boolean {
    const normalized = databaseId(id);
    const entry = this.entries.get(normalized);
    if (!entry) {
      return false;
    }
    this.entries.delete(normalized);
    entry.db.close();
    return true;
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.db.close();
    }
    this.entries.clear();
  }

  stats() {
    return {
      maxOpen: this.maxOpen,
      open: this.entries.size,
      openIds: [...this.entries.keys()],
    };
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxOpen) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      this.close(oldest);
    }
  }
}

function configureSqliteDatabase(db: DatabaseSync, options: { busyTimeoutMs?: number } = {}): void {
  const busyTimeoutMs = nonnegativeInteger(options.busyTimeoutMs ?? 5000, "sqlite busy timeout");
  db.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    pragma foreign_keys = on;
    pragma busy_timeout = ${busyTimeoutMs};
  `);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("pragma user_version").get() as Record<string, unknown>;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : 0;
}

function recordFromRow(row: any): VolumeSqliteDatabaseRecord {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function backupRecordFromRow(row: any): VolumeSqliteBackupRecord {
  return {
    id: row.id,
    databaseId: row.database_id,
    path: row.path,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    ...(row.encryption_algorithm
      ? {
        encrypted: true,
        encryptionAlgorithm: row.encryption_algorithm,
        encryptionKeyId: row.encryption_key_id,
        encryptionIv: row.encryption_iv,
        encryptionTag: row.encryption_tag,
      }
      : {}),
  };
}

function databaseId(value: string): string {
  return identifier(value, "volume sqlite database id");
}

function volumeSqliteBackupId(value: string): string {
  return identifier(value, "volume sqlite backup id");
}

function databaseKind(value: string): string {
  return identifier(value, "volume sqlite database kind");
}

function optionalIdentifier(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return identifier(value, field);
}

function optionalNonnegativeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return nonnegativeInteger(value, field);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new ControlPlaneError(
      "validation",
      `${field} must start with an alphanumeric character and contain only alphanumerics, dot, dash, or underscore`,
    );
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

function assertPathInside(root: string, path: string, field: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new ControlPlaneError("validation", `${field} must be inside ${normalizedRoot}`);
  }
}

function defaultBackupId(databaseId: string, createdAt: string): string {
  const suffix = createdAt.replace(/[^a-zA-Z0-9_.-]/g, "");
  return volumeSqliteBackupId(`${databaseId}-${suffix}`);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqliteUserVersionFromPath(path: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const quickCheck = firstSqliteValue(db.prepare("pragma quick_check").get());
    if (quickCheck !== "ok") {
      throw new Error(String(quickCheck));
    }
    return userVersion(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlPlaneError("validation", `volume sqlite restore source is not a valid sqlite database: ${message}`);
  } finally {
    db?.close();
  }
}

function firstSqliteValue(row: unknown): unknown {
  if (typeof row !== "object" || row === null) {
    return undefined;
  }
  return Object.values(row as Record<string, unknown>)[0];
}

function removeSqliteSidecars(path: string): void {
  unlinkIfExists(`${path}-wal`);
  unlinkIfExists(`${path}-shm`);
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function secureDirectory(path: string): void {
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort: chmod can fail on filesystems that do not support POSIX modes.
  }
}

function secureFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: chmod can fail on filesystems that do not support POSIX modes.
  }
}

function secureSqliteFiles(path: string): void {
  secureFile(path);
  if (existsSync(`${path}-wal`)) {
    secureFile(`${path}-wal`);
  }
  if (existsSync(`${path}-shm`)) {
    secureFile(`${path}-shm`);
  }
}

function temporaryBackupPath(path: string): string {
  return `${path}.plain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function temporaryRestorePath(backupDir: string, backupId: string): string {
  const path = resolve(join(
    backupDir,
    `.restore-${backupId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  ));
  assertPathInside(backupDir, path, "volume sqlite temporary restore path");
  return path;
}

function backupEncryptionPart(backup: VolumeSqliteBackupRecord, field: "iv" | "tag"): Buffer {
  const row = backup as VolumeSqliteBackupRecord & { encryptionIv?: string; encryptionTag?: string };
  const value = field === "iv" ? row.encryptionIv : row.encryptionTag;
  if (!value) {
    throw new ControlPlaneError("validation", `encrypted volume sqlite backup ${backup.id} is missing ${field}`);
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength === 0) {
      throw new Error("empty");
    }
    return decoded;
  } catch {
    throw new ControlPlaneError("validation", `encrypted volume sqlite backup ${backup.id} has malformed ${field}`);
  }
}

function normalizeBackupDataKey(
  key: VolumeSqliteBackupDataKey,
  name: string,
): { keyId: string; key: Buffer } {
  if (!key.keyId || key.keyId.trim().length === 0) {
    throw new ControlPlaneError("validation", `${name} id is required`);
  }
  const normalized = Buffer.from(key.key);
  if (normalized.byteLength !== 32) {
    throw new ControlPlaneError("validation", `${name} must be 32 bytes`);
  }
  return { keyId: key.keyId.trim(), key: normalized };
}

function addBackupDataKey(keys: Map<string, Buffer>, key: { keyId: string; key: Buffer }, name: string) {
  const existing = keys.get(key.keyId);
  if (existing && !existing.equals(key.key)) {
    throw new ControlPlaneError("validation", `${name} id ${key.keyId} is configured more than once`);
  }
  keys.set(key.keyId, key.key);
}

function backupCipherAad(databaseId: string, backupId: string, algorithm: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    scope: "wasmplane.volume-sqlite.backup",
    databaseId,
    backupId,
    algorithm,
    keyId,
  }), "utf8");
}

function parseBackupKeyringEnv(value: string | undefined): VolumeSqliteBackupDataKey[] {
  if (!value) {
    return [];
  }
  return value.split(",").filter((item) => item.trim().length > 0).map((item) => {
    const separator = item.indexOf("=");
    const keyId = separator >= 0 ? item.slice(0, separator) : "";
    const keyBase64 = separator >= 0 ? item.slice(separator + 1) : "";
    if (!keyId || !keyBase64) {
      throw new ControlPlaneError("validation", "ODENCTL_VOLUME_SQLITE_BACKUP_KEYS_BASE64 entries must be keyId=base64");
    }
    return { keyId, key: Buffer.from(keyBase64, "base64") };
  });
}

function ensureCatalogCompatibility(db: DatabaseSync): void {
  addColumnIfMissing(db, "volume_sqlite_backups", "encryption_algorithm", "text");
  addColumnIfMissing(db, "volume_sqlite_backups", "encryption_key_id", "text");
  addColumnIfMissing(db, "volume_sqlite_backups", "encryption_iv", "text");
  addColumnIfMissing(db, "volume_sqlite_backups", "encryption_tag", "text");
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function groupBackupsByDatabase(backups: VolumeSqliteBackupRecord[]): Map<string, VolumeSqliteBackupRecord[]> {
  const groups = new Map<string, VolumeSqliteBackupRecord[]>();
  for (const backup of backups) {
    const group = groups.get(backup.databaseId);
    if (group) {
      group.push(backup);
    } else {
      groups.set(backup.databaseId, [backup]);
    }
  }
  return groups;
}

function backupCreatedBefore(backup: VolumeSqliteBackupRecord, cutoffMs: number): boolean {
  const createdAt = Date.parse(backup.createdAt);
  return !Number.isNaN(createdAt) && createdAt < cutoffMs;
}

const catalogSchema = `
create table if not exists volume_sqlite_databases (
  id text primary key,
  path text not null unique,
  kind text not null,
  owner_id text,
  schema_version integer not null default 0,
  created_at text not null,
  last_used_at text not null
);

create index if not exists volume_sqlite_databases_owner_idx
  on volume_sqlite_databases (owner_id, kind, id);

create index if not exists volume_sqlite_databases_last_used_idx
  on volume_sqlite_databases (last_used_at asc, id asc);

create table if not exists volume_sqlite_backups (
  id text primary key,
  database_id text not null,
  path text not null unique,
  size_bytes integer not null,
  created_at text not null,
  encryption_algorithm text,
  encryption_key_id text,
  encryption_iv text,
  encryption_tag text,
  foreign key (database_id) references volume_sqlite_databases(id)
);

create index if not exists volume_sqlite_backups_database_idx
  on volume_sqlite_backups (database_id, created_at desc, id desc);
`;
