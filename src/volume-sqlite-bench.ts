import { cpus } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { BenchFormat, BenchmarkResult } from "./bench.ts";
import { runLoadBenchmark } from "./bench.ts";
import { createVolumeSqliteRegistry } from "./control-plane/volume-sqlite.ts";

export interface VolumeSqliteBenchOptions {
  rootDir: string;
  databaseCount: number;
  maxOpenDatabases: number;
  maxPendingWritesPerDatabase: number;
  schemaVersion: number;
  writeIterations: number;
  writeConcurrency: number[];
  format: BenchFormat;
  output?: string;
}

export interface VolumeSqliteBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  configuration: {
    rootDir: string;
    databaseCount: number;
    maxOpenDatabases: number;
    maxPendingWritesPerDatabase: number;
    schemaVersion: number;
    writeIterations: number;
    writeConcurrency: number[];
  };
  results: {
    create: VolumeSqliteCreateBenchmarkResult;
    openHandles: VolumeSqliteOpenHandleBenchmarkResult;
    migration: VolumeSqliteMigrationBenchmarkResult;
    writeContention: BenchmarkResult[];
  };
}

export interface VolumeSqliteCreateBenchmarkResult {
  databaseCount: number;
  elapsedMs: number;
  databasesPerSecond: number;
}

export interface VolumeSqliteOpenHandleBenchmarkResult {
  touchedDatabases: number;
  maxOpen: number;
  openHandles: number;
  elapsedMs: number;
}

export interface VolumeSqliteMigrationBenchmarkResult {
  databaseCount: number;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  elapsedMs: number;
  databasesPerSecond: number;
}

export async function runVolumeSqliteBenchmarkSuite(
  options: VolumeSqliteBenchOptions,
): Promise<VolumeSqliteBenchmarkReport> {
  const registry = createVolumeSqliteRegistry({
    rootDir: options.rootDir,
    maxOpenDatabases: options.maxOpenDatabases,
    maxPendingWritesPerDatabase: options.maxPendingWritesPerDatabase,
  });
  const ids = Array.from({ length: options.databaseCount }, (_, index) => `bench_${String(index).padStart(6, "0")}`);
  try {
    const createStarted = performance.now();
    for (const id of ids) {
      registry.ensureDatabase({
        id,
        kind: "bench",
        ownerId: "volume-sqlite-bench",
        schemaVersion: options.schemaVersion,
      });
    }
    const createElapsedMs = performance.now() - createStarted;

    const openStarted = performance.now();
    for (const id of ids) {
      registry.withDatabase(id, (db) => {
        db.prepare("select 1").get();
      });
    }
    const openElapsedMs = performance.now() - openStarted;
    const poolStats = registry.stats().pool;

    const toSchemaVersion = options.schemaVersion + 1;
    const migrationStarted = performance.now();
    for (const id of ids) {
      registry.ensureDatabase({
        id,
        kind: "bench",
        ownerId: "volume-sqlite-bench",
        schemaVersion: toSchemaVersion,
      });
    }
    const migrationElapsedMs = performance.now() - migrationStarted;

    for (const id of ids) {
      registry.withDatabase(id, (db) => {
        db.exec("create table if not exists bench_writes (id text primary key, payload text not null)");
      });
    }

    const writeContention: BenchmarkResult[] = [];
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    for (const concurrency of options.writeConcurrency) {
      let sequence = 0;
      writeContention.push(await runLoadBenchmark({
        name: "volume-sqlite.write-contention",
        iterations: options.writeIterations,
        concurrency,
        operation: async () => {
          const current = sequence;
          sequence += 1;
          const id = ids[current % ids.length];
          await registry.writeDatabase(id, (db) => {
            db.prepare("insert into bench_writes (id, payload) values (?, ?)").run(
              `${runId}-${concurrency}-${current}`,
              "payload",
            );
          });
        },
      }));
    }

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: cpus().length,
      },
      configuration: {
        rootDir: options.rootDir,
        databaseCount: options.databaseCount,
        maxOpenDatabases: options.maxOpenDatabases,
        maxPendingWritesPerDatabase: options.maxPendingWritesPerDatabase,
        schemaVersion: options.schemaVersion,
        writeIterations: options.writeIterations,
        writeConcurrency: options.writeConcurrency,
      },
      results: {
        create: {
          databaseCount: ids.length,
          elapsedMs: round3(createElapsedMs),
          databasesPerSecond: perSecond(ids.length, createElapsedMs),
        },
        openHandles: {
          touchedDatabases: ids.length,
          maxOpen: poolStats.maxOpen,
          openHandles: poolStats.open,
          elapsedMs: round3(openElapsedMs),
        },
        migration: {
          databaseCount: ids.length,
          fromSchemaVersion: options.schemaVersion,
          toSchemaVersion,
          elapsedMs: round3(migrationElapsedMs),
          databasesPerSecond: perSecond(ids.length, migrationElapsedMs),
        },
        writeContention,
      },
    };
  } finally {
    registry.close();
  }
}

export function parseVolumeSqliteBenchArgs(args: string[]): VolumeSqliteBenchOptions {
  const options: VolumeSqliteBenchOptions = {
    rootDir: ".odenctl/volume-sqlite-bench",
    databaseCount: 500,
    maxOpenDatabases: 64,
    maxPendingWritesPerDatabase: 64,
    schemaVersion: 1,
    writeIterations: 1000,
    writeConcurrency: [1, 4, 16],
    format: "markdown",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--root":
        options.rootDir = requiredValue(flag, value);
        index += 1;
        break;
      case "--databases":
        options.databaseCount = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-open":
        options.maxOpenDatabases = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--max-pending-writes":
        options.maxPendingWritesPerDatabase = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--schema-version":
        options.schemaVersion = positiveIntegerOrZero(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--write-iterations":
        options.writeIterations = positiveInteger(requiredValue(flag, value), flag);
        index += 1;
        break;
      case "--write-concurrency":
        options.writeConcurrency = parseConcurrency(requiredValue(flag, value));
        index += 1;
        break;
      case "--format":
        options.format = parseFormat(requiredValue(flag, value));
        index += 1;
        break;
      case "--json":
        options.format = "json";
        break;
      case "--output":
        options.output = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown volume sqlite benchmark argument ${flag}`);
    }
  }
  return options;
}

export function formatVolumeSqliteBenchmarkMarkdown(report: VolumeSqliteBenchmarkReport): string {
  const lines = [
    "# odenctl volume sqlite benchmark",
    "",
    `generated: ${report.generatedAt}`,
    `environment: node ${report.environment.node}, ${report.environment.platform}/${report.environment.arch}, cpus=${report.environment.cpus}`,
    `root: ${report.configuration.rootDir}`,
    `database count: ${report.configuration.databaseCount}`,
    `max open databases: ${report.configuration.maxOpenDatabases}`,
    `max pending writes per database: ${report.configuration.maxPendingWritesPerDatabase}`,
    "",
    "## Density",
    "",
    "| benchmark | databases | elapsed ms | databases/s |",
    "| --- | ---: | ---: | ---: |",
    `| create | ${report.results.create.databaseCount} | ${report.results.create.elapsedMs} | ${report.results.create.databasesPerSecond} |`,
    `| migrate ${report.results.migration.fromSchemaVersion}->${report.results.migration.toSchemaVersion} | ${report.results.migration.databaseCount} | ${report.results.migration.elapsedMs} | ${report.results.migration.databasesPerSecond} |`,
    "",
    "## Open Handles",
    "",
    "| touched databases | max open | open handles | elapsed ms |",
    "| ---: | ---: | ---: | ---: |",
    `| ${report.results.openHandles.touchedDatabases} | ${report.results.openHandles.maxOpen} | ${report.results.openHandles.openHandles} | ${report.results.openHandles.elapsedMs} |`,
    "",
    "## Write Contention",
    "",
    "| benchmark | concurrency | iterations | rps | avg ms | p50 ms | p95 ms | p99 ms | errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const result of report.results.writeContention) {
    lines.push(
      `| ${result.name} | ${result.concurrency} | ${result.iterations} | ${result.throughputRps} | ${result.avgMs} | ${result.p50Ms} | ${result.p95Ms} | ${result.p99Ms} | ${result.errors} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function perSecond(count: number, elapsedMs: number): number {
  return round3(count / Math.max(elapsedMs / 1000, 0.001));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function positiveIntegerOrZero(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a nonnegative integer`);
  }
  return parsed;
}

function parseConcurrency(value: string): number[] {
  const concurrency = value.split(",").map((item) => positiveInteger(item.trim(), "--write-concurrency"));
  if (concurrency.length === 0) {
    throw new Error("--write-concurrency must include at least one value");
  }
  return concurrency;
}

function parseFormat(value: string): BenchFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown");
}

async function main() {
  const options = parseVolumeSqliteBenchArgs(process.argv.slice(2));
  const report = await runVolumeSqliteBenchmarkSuite(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatVolumeSqliteBenchmarkMarkdown(report);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
