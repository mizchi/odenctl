import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultProductionCostInput,
  estimateWasmplaneMonthlyCost,
  formatCostEstimateMarkdown,
} from "../src/cost-estimator.ts";

test("cost estimator prices the default single-region production shape", () => {
  const estimate = estimateWasmplaneMonthlyCost(defaultProductionCostInput());

  assert.equal(estimate.totalMonthlyUsd, 95.27);
  assert.deepEqual(
    estimate.items.map((item) => [item.name, item.monthlyUsd]),
    [
      ["fly.control.machine", 7.45],
      ["fly.runtime.machine", 40.54],
      ["fly.collector.machine", 4.18],
      ["fly.volumes", 0.3],
      ["fly.managed_postgres", 40.8],
      ["cloudflare.r2", 0],
      ["fly.public_egress", 2],
    ],
  );
});

test("cost estimator accounts for runtime scale-out and R2 usage beyond free tier", () => {
  const estimate = estimateWasmplaneMonthlyCost({
    ...defaultProductionCostInput(),
    runtimeMachines: 4,
    r2StorageGb: 100,
    r2ClassAOperations: 5_000_000,
    r2ClassBOperations: 20_000_000,
    flyPublicEgressGb: 100,
  });

  assert.equal(estimate.totalMonthlyUsd, 241.84);
});

test("cost estimate markdown includes assumptions and line items", () => {
  const markdown = formatCostEstimateMarkdown(
    estimateWasmplaneMonthlyCost(defaultProductionCostInput()),
  );

  assert.match(markdown, /total monthly USD/);
  assert.match(markdown, /\| fly\.runtime\.machine \| 1 x performance-1x 2GB in nrt \| \$40\.54 \|/);
  assert.match(markdown, /\| cloudflare\.r2 \| within free tier \| \$0\.00 \|/);
});
