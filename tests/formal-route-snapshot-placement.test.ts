import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runRouteSnapshotPlacementModel,
} from "../formal/route-snapshot-placement.model.ts";

test("route snapshot placement formal model reports no current spec-level counterexamples", () => {
  const report = runRouteSnapshotPlacementModel();

  assert.deepEqual(report.findings, []);
});

test("route snapshot placement formal model sanity cases are load-bearing", () => {
  const report = runRouteSnapshotPlacementModel();
  const sanity = report.sanity.filter((check) => check.id.startsWith("sanity-"));

  assert.deepEqual(
    sanity.map((check) => [check.id, check.ok]),
    [
      ["sanity-isolated-route-delivered", true],
      ["sanity-drained-tenant-empty-snapshot", true],
      ["sanity-primary-before-failover", true],
      ["sanity-saturated-node-excluded", true],
    ],
  );
});

test("route snapshot placement formal model locks fixed counterexamples as regressions", () => {
  const report = runRouteSnapshotPlacementModel();

  assert.deepEqual(
    report.sanity.slice(0, 4).map((check) => [check.id, check.ok]),
    [
      ["regression-static-duplicate-keeps-registered-snapshot", true],
      ["regression-static-target-filtered-by-placement", true],
      ["regression-ttl-mode-requires-heartbeat", true],
      ["regression-max-targets-zero-rejected", true],
    ],
  );
});
