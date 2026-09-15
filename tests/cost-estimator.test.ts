import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultCloudflareContainersPocCostInput,
  defaultProductionCostInput,
  estimateCloudflareContainersMonthlyCost,
  estimateOdenctlMonthlyCost,
  formatCostEstimateMarkdown,
} from "../crates/odenctl/src/cost-estimator.ts";

test("cost estimator prices the default single-region production shape", () => {
  const estimate = estimateOdenctlMonthlyCost(defaultProductionCostInput());

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
  const estimate = estimateOdenctlMonthlyCost({
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
    estimateOdenctlMonthlyCost(defaultProductionCostInput()),
  );

  assert.match(markdown, /total monthly USD/);
  assert.match(markdown, /\| fly\.runtime\.machine \| 1 x performance-1x 2GB in nrt \| \$40\.54 \|/);
  assert.match(markdown, /\| cloudflare\.r2 \| within free tier \| \$0\.00 \|/);
});

test("Cloudflare Containers POC estimate stays at the paid plan floor for smoke usage", () => {
  const estimate = estimateCloudflareContainersMonthlyCost(defaultCloudflareContainersPocCostInput());

  assert.equal(estimate.totalMonthlyUsd, 5);
  assert.deepEqual(
    estimate.items.map((item) => [item.name, item.monthlyUsd]),
    [
      ["cloudflare.workers.paid_plan", 5],
      ["cloudflare.containers.memory", 0],
      ["cloudflare.containers.cpu", 0],
      ["cloudflare.containers.disk", 0],
      ["cloudflare.workers.requests", 0],
      ["cloudflare.workers.cpu", 0],
      ["cloudflare.durable_objects.requests", 0],
      ["cloudflare.durable_objects.duration", 0],
      ["cloudflare.workers.logs", 0],
      ["cloudflare.containers.egress", 0],
    ],
  );
});

test("Cloudflare Containers estimate prices an always-on lite control plane", () => {
  const estimate = estimateCloudflareContainersMonthlyCost({
    ...defaultCloudflareContainersPocCostInput(),
    activeHoursPerMonth: 720,
    averageCpuUtilization: 0.2,
    workerRequests: 1_000_000,
    workerCpuMs: 3_000_000,
    durableObjectRequests: 1_000_000,
    logEvents: 1_000_000,
    egressGb: 50,
  });

  assert.equal(estimate.totalMonthlyUsd, 6.91);
  assert.deepEqual(
    estimate.items
      .filter((item) => item.monthlyUsd > 0)
      .map((item) => [item.name, item.monthlyUsd]),
    [
      ["cloudflare.workers.paid_plan", 5],
      ["cloudflare.containers.memory", 1.4],
      ["cloudflare.containers.cpu", 0.2],
      ["cloudflare.containers.disk", 0.31],
    ],
  );
});

test("Cloudflare Containers estimate includes multi-instance DO, logs, request, and egress overages", () => {
  const estimate = estimateCloudflareContainersMonthlyCost({
    ...defaultCloudflareContainersPocCostInput(),
    instances: 10,
    activeHoursPerMonth: 720,
    averageCpuUtilization: 0.2,
    workerRequests: 50_000_000,
    workerCpuMs: 100_000_000,
    durableObjectRequests: 50_000_000,
    logEvents: 50_000_000,
    egressGb: 700,
  });

  assert.equal(estimate.totalMonthlyUsd, 112.84);
});

test("Cloudflare Containers estimate markdown labels instance assumptions", () => {
  const markdown = formatCostEstimateMarkdown(
    estimateCloudflareContainersMonthlyCost({
      ...defaultCloudflareContainersPocCostInput(),
      activeHoursPerMonth: 720,
      averageCpuUtilization: 0.2,
    }),
  );

  assert.match(markdown, /\| cloudflare\.containers\.memory \| 1 x lite, 720h, 256MiB \| \$1\.40 \|/);
  assert.match(markdown, /\| cloudflare\.containers\.cpu \| 1 x lite, 20% average CPU while active \| \$0\.20 \|/);
});
