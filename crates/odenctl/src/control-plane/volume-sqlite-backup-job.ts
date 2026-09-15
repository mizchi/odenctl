import { ControlPlaneError } from "./errors.ts";
import type {
  ExportVolumeSqliteDatabaseInput,
  PruneVolumeSqliteBackupsInput,
  VolumeSqliteBackupGcReport,
  VolumeSqliteBackupRecord,
  VolumeSqliteBackupRestoreDrillReport,
  VolumeSqliteDatabaseRecord,
} from "./volume-sqlite.ts";

export interface VolumeSqliteScheduledBackupRegistry {
  listDatabases(): VolumeSqliteDatabaseRecord[];
  listBackups(id?: string): VolumeSqliteBackupRecord[];
  exportDatabase(input: ExportVolumeSqliteDatabaseInput): VolumeSqliteBackupRecord;
  pruneBackups(input?: PruneVolumeSqliteBackupsInput): VolumeSqliteBackupGcReport;
  verifyBackupRestore(input: { backupId?: string; databaseId?: string }): VolumeSqliteBackupRestoreDrillReport;
}

export interface VolumeSqliteRestoreDrillPolicy {
  enabled: boolean;
}

export interface VolumeSqliteScheduledBackupCycleOptions {
  registry: VolumeSqliteScheduledBackupRegistry;
  retention?: PruneVolumeSqliteBackupsInput;
  restoreDrill?: VolumeSqliteRestoreDrillPolicy;
  requireEncrypted?: boolean;
  now?: () => string;
}

export interface VolumeSqliteScheduledBackupError {
  stage: "backup" | "encryption" | "restore_drill" | "gc";
  databaseId?: string;
  backupId?: string;
  message: string;
}

export interface VolumeSqliteScheduledBackupReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  databases: number;
  backups: VolumeSqliteBackupRecord[];
  restoreDrills: VolumeSqliteBackupRestoreDrillReport[];
  gc: VolumeSqliteBackupGcReport;
  errors: VolumeSqliteScheduledBackupError[];
}

export interface VolumeSqliteBackupJobOptions
  extends Omit<Partial<VolumeSqliteScheduledBackupCycleOptions>, "registry"> {
  intervalMs: number;
  registry?: VolumeSqliteScheduledBackupRegistry;
  runCycle?: () => VolumeSqliteScheduledBackupReport | Promise<VolumeSqliteScheduledBackupReport>;
  onReport?(report: VolumeSqliteScheduledBackupReport): void;
  onError?(error: unknown): void;
  setIntervalFn?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

export function runVolumeSqliteScheduledBackupCycle(
  options: VolumeSqliteScheduledBackupCycleOptions,
): VolumeSqliteScheduledBackupReport {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const backups: VolumeSqliteBackupRecord[] = [];
  const restoreDrills: VolumeSqliteBackupRestoreDrillReport[] = [];
  const errors: VolumeSqliteScheduledBackupError[] = [];
  const databases = options.registry.listDatabases();

  for (const database of databases) {
    try {
      const backup = options.registry.exportDatabase({ id: database.id });
      backups.push(backup);
      if (options.requireEncrypted && backup.encrypted !== true) {
        errors.push({
          stage: "encryption",
          databaseId: database.id,
          backupId: backup.id,
          message: `volume sqlite scheduled backup ${backup.id} for ${database.id} was not encrypted`,
        });
      }
    } catch (error) {
      errors.push({
        stage: "backup",
        databaseId: database.id,
        message: errorMessage(error),
      });
    }
  }

  if (options.restoreDrill?.enabled) {
    for (const backup of backups) {
      try {
        const drill = options.registry.verifyBackupRestore({ backupId: backup.id });
        restoreDrills.push(drill);
        if (!drill.ok) {
          errors.push({
            stage: "restore_drill",
            databaseId: backup.databaseId,
            backupId: backup.id,
            message: drill.error ?? `restore drill for backup ${backup.id} failed`,
          });
        }
      } catch (error) {
        errors.push({
          stage: "restore_drill",
          databaseId: backup.databaseId,
          backupId: backup.id,
          message: errorMessage(error),
        });
      }
    }
  }

  let gc: VolumeSqliteBackupGcReport;
  try {
    gc = options.registry.pruneBackups(options.retention ?? {});
  } catch (error) {
    errors.push({ stage: "gc", message: errorMessage(error) });
    gc = {
      deleted: [],
      remaining: options.registry.listBackups().length,
      deletedBytes: 0,
    };
  }

  return {
    ok: errors.length === 0,
    startedAt,
    finishedAt: now(),
    databases: databases.length,
    backups,
    restoreDrills,
    gc,
    errors,
  };
}

export function createVolumeSqliteBackupJob(options: VolumeSqliteBackupJobOptions) {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new ControlPlaneError("validation", "volume sqlite backup interval must be a positive integer");
  }
  if (!options.runCycle && !options.registry) {
    throw new ControlPlaneError("validation", "volume sqlite backup job requires a registry or runCycle");
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
      const report = await runConfiguredCycle(options);
      options.onReport?.(report);
      if (!report.ok) {
        throw new Error("volume sqlite backup job result was unsuccessful");
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

function runConfiguredCycle(
  options: VolumeSqliteBackupJobOptions,
): VolumeSqliteScheduledBackupReport | Promise<VolumeSqliteScheduledBackupReport> {
  if (options.runCycle) {
    return options.runCycle();
  }
  return runVolumeSqliteScheduledBackupCycle({
    registry: options.registry as VolumeSqliteScheduledBackupRegistry,
    retention: options.retention,
    restoreDrill: options.restoreDrill,
    requireEncrypted: options.requireEncrypted,
    now: options.now,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
