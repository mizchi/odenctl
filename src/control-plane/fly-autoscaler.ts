import type { RuntimeAutoscalingDecision } from "./autoscaling.ts";

export interface FlyMachine {
  id: string;
  state?: string;
  region?: string;
}

export interface FlyAutoscalerAction {
  type: "create" | "stop";
  machineId?: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface FlyAutoscalerReport {
  decision: RuntimeAutoscalingDecision;
  actions: FlyAutoscalerAction[];
}

export interface ReconcileFlyMachinesAutoscalingInput {
  appName: string;
  apiToken: string;
  decision: RuntimeAutoscalingDecision;
  region?: string;
  machineConfig: Record<string, unknown>;
  machines?: FlyMachine[];
  baseUrl?: string;
  dryRun?: boolean;
  fetch?: typeof fetch;
}

export async function reconcileFlyMachinesAutoscaling(
  input: ReconcileFlyMachinesAutoscalingInput,
): Promise<FlyAutoscalerReport> {
  const actions: FlyAutoscalerAction[] = [];
  if (input.decision.action === "scale_up") {
    for (let index = 0; index < input.decision.add; index += 1) {
      actions.push(await createMachine(input));
    }
  }
  if (input.decision.action === "scale_down") {
    const machines = input.machines ?? await listMachines(input);
    for (const machine of selectMachinesToStop(machines, input.decision.candidateNodeIds, input.decision.remove)) {
      actions.push(await stopMachine(input, machine));
    }
  }
  return { decision: input.decision, actions };
}

async function createMachine(input: ReconcileFlyMachinesAutoscalingInput): Promise<FlyAutoscalerAction> {
  if (input.dryRun) {
    return { type: "create", ok: true };
  }
  const response = await fetchImpl(input)(machinesEndpoint(input), {
    method: "POST",
    headers: requestHeaders(input.apiToken),
    body: JSON.stringify({
      config: input.machineConfig,
      ...(input.region ? { region: input.region } : {}),
    }),
  });
  const body = await response.json().catch(() => ({})) as any;
  return {
    type: "create",
    machineId: typeof body.id === "string" ? body.id : undefined,
    ok: response.ok,
    status: response.status,
    ...(response.ok ? {} : { error: JSON.stringify(body) }),
  };
}

async function stopMachine(
  input: ReconcileFlyMachinesAutoscalingInput,
  machine: FlyMachine,
): Promise<FlyAutoscalerAction> {
  if (input.dryRun) {
    return { type: "stop", machineId: machine.id, ok: true };
  }
  const response = await fetchImpl(input)(machineEndpoint(input, machine.id, "/stop"), {
    method: "POST",
    headers: requestHeaders(input.apiToken),
  });
  return {
    type: "stop",
    machineId: machine.id,
    ok: response.ok,
    status: response.status,
    ...(response.ok ? {} : { error: await response.text().catch(() => "") }),
  };
}

async function listMachines(input: ReconcileFlyMachinesAutoscalingInput): Promise<FlyMachine[]> {
  const response = await fetchImpl(input)(machinesEndpoint(input), {
    method: "GET",
    headers: requestHeaders(input.apiToken),
  });
  if (!response.ok) {
    return [];
  }
  const value = await response.json().catch(() => []);
  return Array.isArray(value)
    ? value.filter((machine): machine is FlyMachine => Boolean(machine?.id))
    : [];
}

function selectMachinesToStop(
  machines: FlyMachine[],
  candidateNodeIds: string[],
  count: number,
): FlyMachine[] {
  const candidates = new Set(candidateNodeIds);
  return machines
    .filter((machine) => machine.state !== "stopped" && (candidates.size === 0 || candidates.has(machine.id) || candidates.has(`rt_${machine.id}`)))
    .slice(0, Math.max(0, count));
}

function machinesEndpoint(input: ReconcileFlyMachinesAutoscalingInput): string {
  return `${apiBaseUrl(input)}/v1/apps/${encodeURIComponent(input.appName)}/machines`;
}

function machineEndpoint(input: ReconcileFlyMachinesAutoscalingInput, machineId: string, suffix: string): string {
  return `${machinesEndpoint(input)}/${encodeURIComponent(machineId)}${suffix}`;
}

function apiBaseUrl(input: ReconcileFlyMachinesAutoscalingInput): string {
  return (input.baseUrl ?? "https://api.machines.dev").replace(/\/+$/, "");
}

function requestHeaders(apiToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiToken}`,
  };
}

function fetchImpl(input: ReconcileFlyMachinesAutoscalingInput): typeof fetch {
  return input.fetch ?? fetch;
}
