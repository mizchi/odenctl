import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatVolumeSqliteBenchmarkMarkdown,
  parseVolumeSqliteBenchArgs,
  runVolumeSqliteBenchmarkSuite,
} from "../crates/odenctl/src/volume-sqlite-bench.ts";

test("volume sqlite benchmark CLI args parse density settings", () => {
  const options = parseVolumeSqliteBenchArgs([
    "--root",
    "/data/sqlite-bench",
    "--databases",
    "1000",
    "--max-open",
    "64",
    "--max-pending-writes",
    "8",
    "--schema-version",
    "3",
    "--write-iterations",
    "500",
    "--write-concurrency",
    "1,8,32",
    "--format",
    "json",
    "--output",
    "bench.json",
  ]);

  assert.deepEqual(options, {
    rootDir: "/data/sqlite-bench",
    databaseCount: 1000,
    maxOpenDatabases: 64,
    maxPendingWritesPerDatabase: 8,
    schemaVersion: 3,
    writeIterations: 500,
    writeConcurrency: [1, 8, 32],
    format: "json",
    output: "bench.json",
  });
});

test("volume sqlite benchmark suite reports density, migration, and write contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-volume-sqlite-bench-"));
  const report = await runVolumeSqliteBenchmarkSuite({
    rootDir: dir,
    databaseCount: 4,
    maxOpenDatabases: 2,
    maxPendingWritesPerDatabase: 4,
    schemaVersion: 1,
    writeIterations: 8,
    writeConcurrency: [1, 2],
    format: "json",
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.configuration.databaseCount, 4);
  assert.equal(report.results.create.databaseCount, 4);
  assert.equal(report.results.openHandles.maxOpen, 2);
  assert.equal(report.results.openHandles.openHandles, 2);
  assert.equal(report.results.migration.fromSchemaVersion, 1);
  assert.equal(report.results.migration.toSchemaVersion, 2);
  assert.deepEqual(
    report.results.writeContention.map((result) => [result.name, result.iterations, result.concurrency]),
    [
      ["volume-sqlite.write-contention", 8, 1],
      ["volume-sqlite.write-contention", 8, 2],
    ],
  );
  assert.equal(report.results.writeContention[0]?.errors, 0);
  assert.equal(report.results.writeContention[1]?.errors, 0);
});

test("volume sqlite benchmark markdown summarizes all sections", () => {
  const markdown = formatVolumeSqliteBenchmarkMarkdown({
    schemaVersion: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    environment: {
      node: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      cpus: 10,
    },
    configuration: {
      rootDir: "/tmp/sqlite",
      databaseCount: 2,
      maxOpenDatabases: 1,
      maxPendingWritesPerDatabase: 4,
      schemaVersion: 1,
      writeIterations: 4,
      writeConcurrency: [1],
    },
    results: {
      create: {
        databaseCount: 2,
        elapsedMs: 10,
        databasesPerSecond: 200,
      },
      openHandles: {
        touchedDatabases: 2,
        maxOpen: 1,
        openHandles: 1,
        elapsedMs: 2,
      },
      migration: {
        databaseCount: 2,
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        elapsedMs: 5,
        databasesPerSecond: 400,
      },
      writeContention: [{
        name: "volume-sqlite.write-contention",
        iterations: 4,
        concurrency: 1,
        count: 4,
        errors: 0,
        elapsedMs: 4,
        throughputRps: 1000,
        minMs: 1,
        avgMs: 1,
        p50Ms: 1,
        p95Ms: 1,
        p99Ms: 1,
        maxMs: 1,
      }],
    },
  });

  assert.match(markdown, /# odenctl volume sqlite benchmark/);
  assert.match(markdown, /database count: 2/);
  assert.match(markdown, /volume-sqlite\.write-contention/);
});
