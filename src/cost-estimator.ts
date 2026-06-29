export interface WasmplaneCostInput {
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
};

export function defaultProductionCostInput(): WasmplaneCostInput {
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

export function estimateWasmplaneMonthlyCost(input: WasmplaneCostInput): CostEstimate {
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

function r2MonthlyUsd(input: WasmplaneCostInput): number {
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

function r2Units(input: WasmplaneCostInput): string {
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
  const estimate = estimateWasmplaneMonthlyCost(defaultProductionCostInput());
  process.stdout.write(formatCostEstimateMarkdown(estimate));
}
