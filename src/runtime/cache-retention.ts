import { constants } from "node:fs";
import { access, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RuntimeCacheRetentionOptions {
  artifactCacheDir?: string;
  precompiledCacheDir?: string;
  maxBytes?: number;
  maxAgeMs?: number;
  keepPaths?: string[];
  nowMs?: () => number;
}

export interface PrecompiledCacheInvalidationOptions {
  precompiledCacheDir: string;
  currentEngineVariant?: string;
  keepPaths?: string[];
}

export type RuntimeCacheKind = "artifact" | "precompiled";

export interface RuntimeCacheGcReport {
  directories: RuntimeCacheDirectoryReport[];
  removed: number;
  removedBytes: number;
  keptBytes: number;
}

export interface RuntimeCacheDirectoryReport {
  kind: RuntimeCacheKind;
  path: string;
  scanned: number;
  keptBytes: number;
  removedBytes: number;
  removed: RuntimeCacheRemovedFile[];
}

export interface RuntimeCacheRemovedFile {
  name: string;
  path: string;
  sizeBytes: number;
  reason: "age" | "size" | "engine_variant";
}

interface CacheFile {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  keep: boolean;
}

export async function pruneRuntimeCaches(options: RuntimeCacheRetentionOptions): Promise<RuntimeCacheGcReport> {
  const keepPaths = new Set((options.keepPaths ?? []).map((path) => resolve(path)));
  const directories = await Promise.all([
    options.artifactCacheDir
      ? pruneCacheDirectory("artifact", options.artifactCacheDir, options, keepPaths)
      : undefined,
    options.precompiledCacheDir
      ? pruneCacheDirectory("precompiled", options.precompiledCacheDir, options, keepPaths)
      : undefined,
  ]);
  const reports = directories.filter((report): report is RuntimeCacheDirectoryReport => Boolean(report));
  return {
    directories: reports,
    removed: reports.reduce((sum, report) => sum + report.removed.length, 0),
    removedBytes: reports.reduce((sum, report) => sum + report.removedBytes, 0),
    keptBytes: reports.reduce((sum, report) => sum + report.keptBytes, 0),
  };
}

export async function invalidatePrecompiledCacheVariants(
  options: PrecompiledCacheInvalidationOptions,
): Promise<RuntimeCacheDirectoryReport> {
  if (!await exists(options.precompiledCacheDir)) {
    return emptyReport("precompiled", options.precompiledCacheDir);
  }
  const keepPaths = new Set((options.keepPaths ?? []).map((path) => resolve(path)));
  const files = await listCacheFiles(options.precompiledCacheDir, keepPaths);
  const removed: RuntimeCacheRemovedFile[] = [];
  const remaining = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    if (file.keep || !file.name.endsWith(".cwasm")) {
      continue;
    }
    if (!precompiledCacheNameMatchesEngineVariant(file.name, options.currentEngineVariant)) {
      await removeCacheFile(file, "engine_variant", removed);
      remaining.delete(file.path);
    }
  }
  return {
    kind: "precompiled",
    path: options.precompiledCacheDir,
    scanned: files.length,
    keptBytes: sumBytes([...remaining.values()]),
    removedBytes: sumRemovedBytes(removed),
    removed,
  };
}

export function precompiledCacheNameMatchesEngineVariant(name: string, currentEngineVariant?: string): boolean {
  const variant = currentEngineVariant ? safeCacheFragment(currentEngineVariant) : undefined;
  const escapedVariant = variant ? escapeRegExp(variant) : undefined;
  const pattern = escapedVariant
    ? new RegExp(`^.+-[a-fA-F0-9]{64}-${escapedVariant}\\.cwasm$`)
    : /^.+-[a-fA-F0-9]{64}\.cwasm$/;
  return pattern.test(name);
}

async function pruneCacheDirectory(
  kind: RuntimeCacheKind,
  dir: string,
  options: RuntimeCacheRetentionOptions,
  keepPaths: Set<string>,
): Promise<RuntimeCacheDirectoryReport> {
  if (!await exists(dir)) {
    return emptyReport(kind, dir);
  }
  const nowMs = options.nowMs?.() ?? Date.now();
  const cutoffMs = options.maxAgeMs === undefined ? undefined : nowMs - positiveNumber(options.maxAgeMs, "maxAgeMs");
  const maxBytes = options.maxBytes === undefined ? undefined : positiveNumber(options.maxBytes, "maxBytes");
  const files = await listCacheFiles(dir, keepPaths);
  const removed: RuntimeCacheRemovedFile[] = [];
  const remaining = new Map(files.map((file) => [file.path, file]));

  if (cutoffMs !== undefined) {
    for (const file of files) {
      if (!file.keep && file.mtimeMs < cutoffMs) {
        await removeCacheFile(file, "age", removed);
        remaining.delete(file.path);
      }
    }
  }

  if (maxBytes !== undefined) {
    let keptBytes = sumBytes([...remaining.values()]);
    const candidates = [...remaining.values()]
      .filter((file) => !file.keep)
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    for (const file of candidates) {
      if (keptBytes <= maxBytes) {
        break;
      }
      await removeCacheFile(file, "size", removed);
      remaining.delete(file.path);
      keptBytes -= file.sizeBytes;
    }
  }

  return {
    kind,
    path: dir,
    scanned: files.length,
    keptBytes: sumBytes([...remaining.values()]),
    removedBytes: sumRemovedBytes(removed),
    removed,
  };
}

async function listCacheFiles(dir: string, keepPaths: Set<string>): Promise<CacheFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: CacheFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(dir, entry.name);
    const info = await stat(path);
    files.push({
      name: entry.name,
      path,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      keep: keepPaths.has(resolve(path)),
    });
  }
  return files;
}

async function removeCacheFile(
  file: CacheFile,
  reason: RuntimeCacheRemovedFile["reason"],
  removed: RuntimeCacheRemovedFile[],
) {
  await unlink(file.path);
  removed.push({
    name: file.name,
    path: file.path,
    sizeBytes: file.sizeBytes,
    reason,
  });
}

function sumBytes(files: CacheFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function sumRemovedBytes(files: RuntimeCacheRemovedFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`runtime cache retention ${field} must be a positive number`);
  }
  return value;
}

function emptyReport(kind: RuntimeCacheKind, dir: string): RuntimeCacheDirectoryReport {
  return {
    kind,
    path: dir,
    scanned: 0,
    keptBytes: 0,
    removedBytes: 0,
    removed: [],
  };
}

function safeCacheFragment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
