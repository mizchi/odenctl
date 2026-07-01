import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
