import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RouteSnapshot } from "../src/control-plane/contracts.ts";
import { createFileRouteSnapshotStore, loadRouteSnapshotFile } from "../src/runtime/snapshot-store.ts";

test("file route snapshot store saves and loads latest snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-snapshot-"));
  const file = join(dir, "nested", "route-snapshot.json");
  const routeSnapshot: RouteSnapshot = {
    schemaVersion: 1,
    id: "snap_saved",
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes: [],
  };

  await createFileRouteSnapshotStore(file).save(routeSnapshot);

  assert.deepEqual(await loadRouteSnapshotFile(file), routeSnapshot);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), routeSnapshot);
});

test("file route snapshot loader returns undefined when no snapshot exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-snapshot-missing-"));

  assert.equal(await loadRouteSnapshotFile(join(dir, "missing.json")), undefined);
});

test("file route snapshot loader rejects invalid snapshot schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-snapshot-invalid-"));
  const file = join(dir, "route-snapshot.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: 2,
    generatedAt: "2026-06-26T10:00:00.000Z",
    routes: [],
  }), "utf8");

  await assert.rejects(
    () => loadRouteSnapshotFile(file),
    /route snapshot must have schemaVersion 1 and routes/,
  );
});

test("file route snapshot loader can quarantine invalid snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-runtime-snapshot-quarantine-"));
  const file = join(dir, "route-snapshot.json");
  await writeFile(file, "{not json", "utf8");

  assert.equal(
    await loadRouteSnapshotFile(file, {
      quarantineInvalid: true,
      now: () => new Date("2026-06-26T10:00:00.000Z"),
    }),
    undefined,
  );

  assert.deepEqual(await readdir(dir), [
    "route-snapshot.json.invalid.20260626T100000000Z",
  ]);
  assert.equal(await readFile(join(dir, "route-snapshot.json.invalid.20260626T100000000Z"), "utf8"), "{not json");
});
