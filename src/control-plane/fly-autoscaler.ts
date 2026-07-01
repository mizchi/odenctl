import { DatabaseSync } from "node:sqlite";
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
  skippedReason?: "lease_unavailable" | "cooldown";
  lease?: FlyAutoscalerLeaseReport;
  cooldown?: FlyAutoscalerCooldownReport;
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
  controllerId?: string;
  lease?: FlyAutoscalerLeaseOptions;
  cooldown?: FlyAutoscalerCooldownOptions;
  coordination?: FlyAutoscalerCoordinationStore;
  nowMs?: () => number;
  fetch?: typeof fetch;
}

export interface FlyAutoscalerLeaseOptions {
  key?: string;
  ttlMs: number;
}

export interface FlyAutoscalerCooldownOptions {
  key?: string;
  durationMs: number;
}

export interface FlyAutoscalerLeaseReport {
  key: string;
  holder: string;
  acquired: boolean;
}

export interface FlyAutoscalerCooldownReport {
  key: string;
  active: boolean;
  untilMs?: number;
  remainingMs?: number;
}

export interface FlyAutoscalerLeaseRequest {
  key: string;
  holder: string;
  ttlMs: number;
  nowMs: number;
}

export interface FlyAutoscalerLeaseRelease {
  key: string;
  holder: string;
}

export interface FlyAutoscalerCooldownState {
  key: string;
  action: RuntimeAutoscalingDecision["action"];
  atMs: number;
  untilMs: number;
}

export interface FlyAutoscalerCoordinationStore {
  acquireLease(request: FlyAutoscalerLeaseRequest): Promise<boolean> | boolean;
  releaseLease(request: FlyAutoscalerLeaseRelease): Promise<void> | void;
  readCooldown(
    key: string,
  ): Promise<FlyAutoscalerCooldownState | undefined> | FlyAutoscalerCooldownState | undefined;
  writeCooldown(state: FlyAutoscalerCooldownState): Promise<void> | void;
}

export interface SqliteFlyAutoscalerCoordinationStore extends FlyAutoscalerCoordinationStore {
  close(): void;
}

export interface PostgresFlyAutoscalerCoordinationStoreOptions {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export async function reconcileFlyMachinesAutoscaling(
  input: ReconcileFlyMachinesAutoscalingInput,
): Promise<FlyAutoscalerReport> {
  if (input.decision.action === "none") {
    return { decision: input.decision, actions: [] };
  }
  const coordination = input.coordination;
  const nowMs = input.nowMs?.() ?? Date.now();
  const cooldown = await currentCooldownReport(input, nowMs);
  if (cooldown?.active) {
    return {
      decision: input.decision,
      actions: [],
      skippedReason: "cooldown",
      cooldown,
    };
  }
  const lease = await acquireAutoscalerLease(input, nowMs);
  if (lease && !lease.acquired) {
    return {
      decision: input.decision,
      actions: [],
      skippedReason: "lease_unavailable",
      lease,
    };
  }
  const actions: FlyAutoscalerAction[] = [];
  try {
    const lockedCooldown = lease
      ? await currentCooldownReport(input, input.nowMs?.() ?? Date.now())
      : undefined;
    if (lockedCooldown?.active) {
      return {
        decision: input.decision,
        actions: [],
        skippedReason: "cooldown",
        lease,
        cooldown: lockedCooldown,
      };
    }
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
    const writtenCooldown = actions.some((action) => action.ok)
      ? await writeCooldown(input, input.nowMs?.() ?? Date.now())
      : undefined;
    return {
      decision: input.decision,
      actions,
      ...(lease ? { lease } : {}),
      ...(writtenCooldown ? { cooldown: writtenCooldown } : {}),
    };
  } finally {
    if (lease?.acquired && coordination) {
      await coordination.releaseLease({ key: lease.key, holder: lease.holder });
    }
  }
}

export function createInMemoryFlyAutoscalerCoordinationStore(): FlyAutoscalerCoordinationStore {
  const leases = new Map<string, { holder: string; expiresAtMs: number }>();
  const cooldowns = new Map<string, FlyAutoscalerCooldownState>();
  return {
    acquireLease(request) {
      const current = leases.get(request.key);
      if (current && current.expiresAtMs > request.nowMs && current.holder !== request.holder) {
        return false;
      }
      leases.set(request.key, {
        holder: request.holder,
        expiresAtMs: request.nowMs + Math.max(1, request.ttlMs),
      });
      return true;
    },
    releaseLease(request) {
      const current = leases.get(request.key);
      if (current?.holder === request.holder) {
        leases.delete(request.key);
      }
    },
    readCooldown(key) {
      return cooldowns.get(key);
    },
    writeCooldown(state) {
      cooldowns.set(state.key, state);
    },
  };
}

export function createSqliteFlyAutoscalerCoordinationStore(
  pathOrDb: string | DatabaseSync,
): SqliteFlyAutoscalerCoordinationStore {
  const ownsDb = typeof pathOrDb === "string";
  const db = ownsDb ? new DatabaseSync(pathOrDb) : pathOrDb;
  db.exec(flyAutoscalerCoordinationSqliteSchema);
  return {
    acquireLease(request) {
      const result = db.prepare(`
        insert into fly_autoscaler_coordination (
          coordination_key,
          lease_holder,
          lease_expires_at_ms,
          updated_at
        ) values (?, ?, ?, ?)
        on conflict(coordination_key) do update set
          lease_holder = excluded.lease_holder,
          lease_expires_at_ms = excluded.lease_expires_at_ms,
          updated_at = excluded.updated_at
        where fly_autoscaler_coordination.lease_holder = excluded.lease_holder
           or fly_autoscaler_coordination.lease_expires_at_ms is null
           or fly_autoscaler_coordination.lease_expires_at_ms <= ?
      `).run(
        request.key,
        request.holder,
        request.nowMs + Math.max(1, request.ttlMs),
        new Date(request.nowMs).toISOString(),
        request.nowMs,
      );
      return result.changes > 0;
    },
    releaseLease(request) {
      db.prepare(`
        update fly_autoscaler_coordination
        set lease_holder = null,
            lease_expires_at_ms = null,
            updated_at = ?
        where coordination_key = ? and lease_holder = ?
      `).run(new Date().toISOString(), request.key, request.holder);
    },
    readCooldown(key) {
      const row = db.prepare(`
        select coordination_key, cooldown_action, cooldown_at_ms, cooldown_until_ms
        from fly_autoscaler_coordination
        where coordination_key = ?
      `).get(key) as any;
      return cooldownStateFromRow(row);
    },
    writeCooldown(state) {
      db.prepare(`
        insert into fly_autoscaler_coordination (
          coordination_key,
          cooldown_action,
          cooldown_at_ms,
          cooldown_until_ms,
          updated_at
        ) values (?, ?, ?, ?, ?)
        on conflict(coordination_key) do update set
          cooldown_action = excluded.cooldown_action,
          cooldown_at_ms = excluded.cooldown_at_ms,
          cooldown_until_ms = excluded.cooldown_until_ms,
          updated_at = excluded.updated_at
      `).run(
        state.key,
        state.action,
        state.atMs,
        state.untilMs,
        new Date(state.atMs).toISOString(),
      );
    },
    close() {
      if (ownsDb) {
        db.close();
      }
    },
  };
}

export function createPostgresFlyAutoscalerCoordinationStore(
  pool: PostgresFlyAutoscalerCoordinationStoreOptions,
): FlyAutoscalerCoordinationStore {
  return {
    async acquireLease(request) {
      await pool.query(flyAutoscalerCoordinationPostgresSchema);
      const result = await pool.query(`
        insert into fly_autoscaler_coordination (
          coordination_key,
          lease_holder,
          lease_expires_at_ms,
          updated_at
        ) values ($1, $2, $3, $4)
        on conflict(coordination_key) do update set
          lease_holder = excluded.lease_holder,
          lease_expires_at_ms = excluded.lease_expires_at_ms,
          updated_at = excluded.updated_at
        where fly_autoscaler_coordination.lease_holder = excluded.lease_holder
           or fly_autoscaler_coordination.lease_expires_at_ms is null
           or fly_autoscaler_coordination.lease_expires_at_ms <= $5
        returning coordination_key
      `, [
        request.key,
        request.holder,
        request.nowMs + Math.max(1, request.ttlMs),
        new Date(request.nowMs).toISOString(),
        request.nowMs,
      ]);
      return result.rows.length > 0;
    },
    async releaseLease(request) {
      await pool.query(flyAutoscalerCoordinationPostgresSchema);
      await pool.query(`
        update fly_autoscaler_coordination
        set lease_holder = null,
            lease_expires_at_ms = null,
            updated_at = $1
        where coordination_key = $2 and lease_holder = $3
      `, [new Date().toISOString(), request.key, request.holder]);
    },
    async readCooldown(key) {
      await pool.query(flyAutoscalerCoordinationPostgresSchema);
      const result = await pool.query(`
        select coordination_key, cooldown_action, cooldown_at_ms, cooldown_until_ms
        from fly_autoscaler_coordination
        where coordination_key = $1
      `, [key]);
      return cooldownStateFromRow(result.rows[0]);
    },
    async writeCooldown(state) {
      await pool.query(flyAutoscalerCoordinationPostgresSchema);
      await pool.query(`
        insert into fly_autoscaler_coordination (
          coordination_key,
          cooldown_action,
          cooldown_at_ms,
          cooldown_until_ms,
          updated_at
        ) values ($1, $2, $3, $4, $5)
        on conflict(coordination_key) do update set
          cooldown_action = excluded.cooldown_action,
          cooldown_at_ms = excluded.cooldown_at_ms,
          cooldown_until_ms = excluded.cooldown_until_ms,
          updated_at = excluded.updated_at
      `, [
        state.key,
        state.action,
        state.atMs,
        state.untilMs,
        new Date(state.atMs).toISOString(),
      ]);
    },
  };
}

async function acquireAutoscalerLease(
  input: ReconcileFlyMachinesAutoscalingInput,
  nowMs: number,
): Promise<FlyAutoscalerLeaseReport | undefined> {
  if (!input.lease || !input.coordination) {
    return undefined;
  }
  const key = input.lease.key ?? flyAutoscalerCoordinationKey(input);
  const holder = input.controllerId ?? "default-controller";
  const acquired = await input.coordination.acquireLease({
    key,
    holder,
    ttlMs: input.lease.ttlMs,
    nowMs,
  });
  return { key, holder, acquired };
}

async function currentCooldownReport(
  input: ReconcileFlyMachinesAutoscalingInput,
  nowMs: number,
): Promise<FlyAutoscalerCooldownReport | undefined> {
  if (!input.cooldown || !input.coordination) {
    return undefined;
  }
  const key = input.cooldown.key ?? flyAutoscalerCoordinationKey(input);
  const state = await input.coordination.readCooldown(key);
  if (!state || state.untilMs <= nowMs) {
    return { key, active: false };
  }
  return {
    key,
    active: true,
    untilMs: state.untilMs,
    remainingMs: Math.max(0, state.untilMs - nowMs),
  };
}

async function writeCooldown(
  input: ReconcileFlyMachinesAutoscalingInput,
  nowMs: number,
): Promise<FlyAutoscalerCooldownReport | undefined> {
  if (!input.cooldown || !input.coordination) {
    return undefined;
  }
  const key = input.cooldown.key ?? flyAutoscalerCoordinationKey(input);
  const durationMs = Math.max(1, input.cooldown.durationMs);
  const untilMs = nowMs + durationMs;
  await input.coordination.writeCooldown({
    key,
    action: input.decision.action,
    atMs: nowMs,
    untilMs,
  });
  return { key, active: false, untilMs, remainingMs: durationMs };
}

function flyAutoscalerCoordinationKey(input: ReconcileFlyMachinesAutoscalingInput): string {
  return `fly:${input.appName}:${input.region ?? "global"}`;
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
    .filter((machine) =>
      machine.state !== "stopped"
      && (candidates.size === 0 || candidates.has(machine.id) || candidates.has(`rt_${machine.id}`))
    )
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

const flyAutoscalerCoordinationSqliteSchema = `
create table if not exists fly_autoscaler_coordination (
  coordination_key text primary key,
  lease_holder text,
  lease_expires_at_ms integer,
  cooldown_action text,
  cooldown_at_ms integer,
  cooldown_until_ms integer,
  updated_at text not null
);
`;

const flyAutoscalerCoordinationPostgresSchema = `
create table if not exists fly_autoscaler_coordination (
  coordination_key text primary key,
  lease_holder text,
  lease_expires_at_ms bigint,
  cooldown_action text,
  cooldown_at_ms bigint,
  cooldown_until_ms bigint,
  updated_at text not null
);
`;

function cooldownStateFromRow(row: any): FlyAutoscalerCooldownState | undefined {
  if (!row?.cooldown_action || row.cooldown_at_ms == null || row.cooldown_until_ms == null) {
    return undefined;
  }
  return {
    key: row.coordination_key,
    action: row.cooldown_action,
    atMs: Number(row.cooldown_at_ms),
    untilMs: Number(row.cooldown_until_ms),
  };
}
