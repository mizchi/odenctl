export interface OdenctlCostInput {
  region: "nrt";
  controlMachines: number;
  runtimeMachines: number;
  collectorMachines: number;
  volumeGb: number;
  managedPostgresPlanMonthlyUsd: number;
  managedPostgresStorageGb: number;
  r2StorageGb: number;
  r2ClassAOperations: number;
  r2ClassBOperations: number;
  flyPublicEgressGb: number;
}

export type CloudflareContainerInstanceType =
  | "lite"
  | "basic"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4";

export type CloudflareContainerEgressRegion =
  | "north_america_europe"
  | "oceania_korea_taiwan"
  | "everywhere_else";

export interface CloudflareContainersCostInput {
  instanceType: CloudflareContainerInstanceType;
  instances: number;
  activeHoursPerMonth: number;
  averageCpuUtilization: number;
  workerRequests: number;
  workerCpuMs: number;
  durableObjectRequests: number;
  includeDurableObjectDuration: boolean;
  logEvents: number;
  egressGb: number;
  egressRegion: CloudflareContainerEgressRegion;
  workersPaidPlanMonthlyUsd: number;
}

export interface CostLineItem {
  name: string;
  units: string;
  monthlyUsd: number;
}

export interface CostEstimate {
  currency: "USD";
  totalMonthlyUsd: number;
  items: CostLineItem[];
}

const pricing = {
  flyNrt: {
    controlSharedCpu1x1gbMonthlyUsd: 7.45,
    runtimePerformance1x2gbMonthlyUsd: 40.54,
    collectorSharedCpu1x512mbMonthlyUsd: 4.18,
    volumeGbMonthlyUsd: 0.15,
    publicEgressGbUsd: 0.04,
  },
  flyManagedPostgres: {
    storageGbMonthlyUsd: 0.28,
  },
  cloudflareR2: {
    freeStorageGb: 10,
    storageGbMonthlyUsd: 0.015,
    freeClassAOperations: 1_000_000,
    classAOperationsPerMillionUsd: 4.5,
    freeClassBOperations: 10_000_000,
    classBOperationsPerMillionUsd: 0.36,
  },
  cloudflareWorkers: {
    includedRequests: 10_000_000,
    requestPerMillionUsd: 0.3,
    includedCpuMs: 30_000_000,
    cpuMsPerMillionUsd: 0.02,
    includedLogEvents: 20_000_000,
    logEventsPerMillionUsd: 0.6,
  },
  cloudflareContainers: {
    includedMemoryGibHours: 25,
    memoryGibSecondUsd: 0.0000025,
    includedCpuMinutes: 375,
    cpuSecondUsd: 0.000020,
    includedDiskGbHours: 200,
    diskGbSecondUsd: 0.00000007,
    egress: {
      north_america_europe: {
        label: "North America & Europe",
        includedGb: 1024,
        gbUsd: 0.025,
      },
      oceania_korea_taiwan: {
        label: "Oceania, Korea, Taiwan",
        includedGb: 500,
        gbUsd: 0.05,
      },
      everywhere_else: {
        label: "Everywhere else",
        includedGb: 500,
        gbUsd: 0.04,
      },
    },
    instanceTypes: {
      lite: { vcpu: 1 / 16, memoryMiB: 256, diskGb: 2 },
      basic: { vcpu: 1 / 4, memoryMiB: 1024, diskGb: 4 },
      "standard-1": { vcpu: 1 / 2, memoryMiB: 4096, diskGb: 8 },
      "standard-2": { vcpu: 1, memoryMiB: 6144, diskGb: 12 },
      "standard-3": { vcpu: 2, memoryMiB: 8192, diskGb: 16 },
      "standard-4": { vcpu: 4, memoryMiB: 12288, diskGb: 20 },
    },
  },
  cloudflareDurableObjects: {
    includedRequests: 1_000_000,
    requestPerMillionUsd: 0.15,
    includedDurationGbSeconds: 400_000,
    durationGbSecondPerMillionUsd: 12.5,
    allocatedMemoryGb: 0.125,
  },
};

export function defaultProductionCostInput(): OdenctlCostInput {
  return {
    region: "nrt",
    controlMachines: 1,
    runtimeMachines: 1,
    collectorMachines: 1,
    volumeGb: 2,
    managedPostgresPlanMonthlyUsd: 38,
    managedPostgresStorageGb: 10,
    r2StorageGb: 10,
    r2ClassAOperations: 1_000_000,
    r2ClassBOperations: 10_000_000,
    flyPublicEgressGb: 50,
  };
}

export function defaultCloudflareContainersPocCostInput(): CloudflareContainersCostInput {
  return {
    instanceType: "lite",
    instances: 1,
    activeHoursPerMonth: 1,
    averageCpuUtilization: 0.2,
    workerRequests: 1_000,
    workerCpuMs: 10_000,
    durableObjectRequests: 1_000,
    includeDurableObjectDuration: true,
    logEvents: 1_000,
    egressGb: 0,
    egressRegion: "everywhere_else",
    workersPaidPlanMonthlyUsd: 5,
  };
}

export function estimateOdenctlMonthlyCost(input: OdenctlCostInput): CostEstimate {
  const items: CostLineItem[] = [
    {
      name: "fly.control.machine",
      units: `${input.controlMachines} x shared-cpu-1x 1GB in ${input.region}`,
      monthlyUsd: input.controlMachines * pricing.flyNrt.controlSharedCpu1x1gbMonthlyUsd,
    },
    {
      name: "fly.runtime.machine",
      units: `${input.runtimeMachines} x performance-1x 2GB in ${input.region}`,
      monthlyUsd: input.runtimeMachines * pricing.flyNrt.runtimePerformance1x2gbMonthlyUsd,
    },
    {
      name: "fly.collector.machine",
      units: `${input.collectorMachines} x shared-cpu-1x 512MB in ${input.region}`,
      monthlyUsd: input.collectorMachines * pricing.flyNrt.collectorSharedCpu1x512mbMonthlyUsd,
    },
    {
      name: "fly.volumes",
      units: `${input.volumeGb} GB provisioned`,
      monthlyUsd: input.volumeGb * pricing.flyNrt.volumeGbMonthlyUsd,
    },
    {
      name: "fly.managed_postgres",
      units: `$${input.managedPostgresPlanMonthlyUsd.toFixed(2)} plan + ${input.managedPostgresStorageGb} GB`,
      monthlyUsd:
        input.managedPostgresPlanMonthlyUsd +
        input.managedPostgresStorageGb * pricing.flyManagedPostgres.storageGbMonthlyUsd,
    },
    {
      name: "cloudflare.r2",
      units: r2Units(input),
      monthlyUsd: r2MonthlyUsd(input),
    },
    {
      name: "fly.public_egress",
      units: `${input.flyPublicEgressGb} GB from ${input.region}`,
      monthlyUsd: input.flyPublicEgressGb * pricing.flyNrt.publicEgressGbUsd,
    },
  ].map(roundLineItem);
  return {
    currency: "USD",
    totalMonthlyUsd: roundUsd(items.reduce((sum, item) => sum + item.monthlyUsd, 0)),
    items,
  };
}

export function estimateCloudflareContainersMonthlyCost(
  input: CloudflareContainersCostInput,
): CostEstimate {
  const instance = pricing.cloudflareContainers.instanceTypes[input.instanceType];
  const activeSeconds = input.instances * input.activeHoursPerMonth * 3600;
  const memoryGib = instance.memoryMiB / 1024;
  const memoryGibSeconds = activeSeconds * memoryGib;
  const cpuSeconds = activeSeconds * instance.vcpu * input.averageCpuUtilization;
  const diskGbSeconds = activeSeconds * instance.diskGb;
  const durableObjectDurationGbSeconds = input.includeDurableObjectDuration
    ? activeSeconds * pricing.cloudflareDurableObjects.allocatedMemoryGb
    : 0;

  const items: CostLineItem[] = [
    {
      name: "cloudflare.workers.paid_plan",
      units: "Workers Paid base plan",
      monthlyUsd: input.workersPaidPlanMonthlyUsd,
    },
    {
      name: "cloudflare.containers.memory",
      units: `${input.instances} x ${input.instanceType}, ${input.activeHoursPerMonth}h, ${instance.memoryMiB}MiB`,
      monthlyUsd: billableMemoryGibSeconds(memoryGibSeconds) *
        pricing.cloudflareContainers.memoryGibSecondUsd,
    },
    {
      name: "cloudflare.containers.cpu",
      units: `${input.instances} x ${input.instanceType}, ${cpuPercent(input.averageCpuUtilization)} average CPU while active`,
      monthlyUsd: billableContainerCpuSeconds(cpuSeconds) *
        pricing.cloudflareContainers.cpuSecondUsd,
    },
    {
      name: "cloudflare.containers.disk",
      units: `${input.instances} x ${input.instanceType}, ${input.activeHoursPerMonth}h, ${instance.diskGb}GB`,
      monthlyUsd: billableDiskGbSeconds(diskGbSeconds) *
        pricing.cloudflareContainers.diskGbSecondUsd,
    },
    {
      name: "cloudflare.workers.requests",
      units: requestUnits(input.workerRequests, "Worker requests"),
      monthlyUsd: millionOverage(
        input.workerRequests,
        pricing.cloudflareWorkers.includedRequests,
        pricing.cloudflareWorkers.requestPerMillionUsd,
      ),
    },
    {
      name: "cloudflare.workers.cpu",
      units: requestUnits(input.workerCpuMs, "Worker CPU-ms"),
      monthlyUsd: millionOverage(
        input.workerCpuMs,
        pricing.cloudflareWorkers.includedCpuMs,
        pricing.cloudflareWorkers.cpuMsPerMillionUsd,
      ),
    },
    {
      name: "cloudflare.durable_objects.requests",
      units: requestUnits(input.durableObjectRequests, "Durable Object requests"),
      monthlyUsd: millionOverage(
        input.durableObjectRequests,
        pricing.cloudflareDurableObjects.includedRequests,
        pricing.cloudflareDurableObjects.requestPerMillionUsd,
      ),
    },
    {
      name: "cloudflare.durable_objects.duration",
      units: input.includeDurableObjectDuration
        ? `${input.instances} x 128MiB while container is active`
        : "not modeled",
      monthlyUsd: millionOverage(
        durableObjectDurationGbSeconds,
        pricing.cloudflareDurableObjects.includedDurationGbSeconds,
        pricing.cloudflareDurableObjects.durationGbSecondPerMillionUsd,
      ),
    },
    {
      name: "cloudflare.workers.logs",
      units: requestUnits(input.logEvents, "log events"),
      monthlyUsd: millionOverage(
        input.logEvents,
        pricing.cloudflareWorkers.includedLogEvents,
        pricing.cloudflareWorkers.logEventsPerMillionUsd,
      ),
    },
    {
      name: "cloudflare.containers.egress",
      units: cloudflareEgressUnits(input),
      monthlyUsd: cloudflareEgressMonthlyUsd(input),
    },
  ].map(roundLineItem);

  return {
    currency: "USD",
    totalMonthlyUsd: roundUsd(items.reduce((sum, item) => sum + item.monthlyUsd, 0)),
    items,
  };
}

export function formatCostEstimateMarkdown(estimate: CostEstimate): string {
  const lines = [
    `total monthly USD: $${estimate.totalMonthlyUsd.toFixed(2)}`,
    "",
    "| item | units | monthly USD |",
    "| --- | --- | ---: |",
    ...estimate.items.map((item) =>
      `| ${item.name} | ${item.units} | $${item.monthlyUsd.toFixed(2)} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function billableMemoryGibSeconds(memoryGibSeconds: number): number {
  return Math.max(
    0,
    memoryGibSeconds - pricing.cloudflareContainers.includedMemoryGibHours * 3600,
  );
}

function billableContainerCpuSeconds(cpuSeconds: number): number {
  return Math.max(
    0,
    cpuSeconds - pricing.cloudflareContainers.includedCpuMinutes * 60,
  );
}

function billableDiskGbSeconds(diskGbSeconds: number): number {
  return Math.max(
    0,
    diskGbSeconds - pricing.cloudflareContainers.includedDiskGbHours * 3600,
  );
}

function millionOverage(usage: number, included: number, usdPerMillion: number): number {
  return (Math.max(0, usage - included) / 1_000_000) * usdPerMillion;
}

function cloudflareEgressMonthlyUsd(input: CloudflareContainersCostInput): number {
  const region = pricing.cloudflareContainers.egress[input.egressRegion];
  return Math.max(0, input.egressGb - region.includedGb) * region.gbUsd;
}

function cloudflareEgressUnits(input: CloudflareContainersCostInput): string {
  const region = pricing.cloudflareContainers.egress[input.egressRegion];
  if (input.egressGb <= region.includedGb) {
    return `within ${region.label} included egress`;
  }
  return `${input.egressGb} GB from ${region.label}`;
}

function requestUnits(value: number, unit: string): string {
  return `${value} ${unit}`;
}

function cpuPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function r2MonthlyUsd(input: OdenctlCostInput): number {
  const billableStorageGb = Math.max(
    0,
    input.r2StorageGb - pricing.cloudflareR2.freeStorageGb,
  );
  const billableClassA = Math.max(
    0,
    input.r2ClassAOperations - pricing.cloudflareR2.freeClassAOperations,
  );
  const billableClassB = Math.max(
    0,
    input.r2ClassBOperations - pricing.cloudflareR2.freeClassBOperations,
  );
  return (
    billableStorageGb * pricing.cloudflareR2.storageGbMonthlyUsd +
    (billableClassA / 1_000_000) * pricing.cloudflareR2.classAOperationsPerMillionUsd +
    (billableClassB / 1_000_000) * pricing.cloudflareR2.classBOperationsPerMillionUsd
  );
}

function r2Units(input: OdenctlCostInput): string {
  if (
    input.r2StorageGb <= pricing.cloudflareR2.freeStorageGb &&
    input.r2ClassAOperations <= pricing.cloudflareR2.freeClassAOperations &&
    input.r2ClassBOperations <= pricing.cloudflareR2.freeClassBOperations
  ) {
    return "within free tier";
  }
  return `${input.r2StorageGb} GB, ${input.r2ClassAOperations} Class A, ${input.r2ClassBOperations} Class B`;
}

function roundLineItem(item: CostLineItem): CostLineItem {
  return {
    ...item,
    monthlyUsd: roundUsd(item.monthlyUsd),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const estimate = process.argv[2] === "cloudflare-containers"
    ? estimateCloudflareContainersMonthlyCost(defaultCloudflareContainersPocCostInput())
    : estimateOdenctlMonthlyCost(defaultProductionCostInput());
  process.stdout.write(formatCostEstimateMarkdown(estimate));
}
