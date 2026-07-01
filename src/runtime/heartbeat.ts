import type {
  RuntimeNodeCapacity,
  RuntimeNodeHostInfo,
  RuntimeNodeIdentity,
  RuntimeNodeLoad,
  RuntimeNodeStatus,
} from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";

export interface RuntimeHeartbeatOptions {
  controlPlaneUrl: string;
  runtimeNodeId: string;
  publicUrl: string;
  version: string;
  capacity: RuntimeNodeCapacity;
  region?: string;
  labels?: Record<string, string>;
  identity?: RuntimeNodeIdentity;
  host?: RuntimeNodeHostInfo;
  status?: RuntimeNodeStatus | (() => RuntimeNodeStatus);
  load?: RuntimeNodeLoad | (() => RuntimeNodeLoad);
  token?: string;
  intervalMs?: number;
  fetch?: typeof fetch;
}

export interface RuntimeNodeRegistrationInput {
  controlPlaneUrl: string;
  runtimeNodeId: string;
  publicUrl: string;
  region?: string;
  labels?: Record<string, string>;
  identity?: RuntimeNodeIdentity;
  host?: RuntimeNodeHostInfo;
  token?: string;
  fetch?: typeof fetch;
}

export interface RuntimeNodeHeartbeatInput {
  controlPlaneUrl: string;
  runtimeNodeId: string;
  version: string;
  status?: RuntimeNodeStatus;
  capacity: RuntimeNodeCapacity;
  load?: RuntimeNodeLoad;
  host?: RuntimeNodeHostInfo;
  token?: string;
  fetch?: typeof fetch;
}

export async function registerRuntimeNode(input: RuntimeNodeRegistrationInput): Promise<void> {
  const response = await (input.fetch ?? fetch)(endpoint(input.controlPlaneUrl, "/runtime-nodes"), {
    method: "POST",
    headers: requestHeaders(input.token),
    body: JSON.stringify({
      id: input.runtimeNodeId,
      url: input.publicUrl,
      region: input.region,
      labels: input.labels,
      identity: input.identity,
      host: input.host,
    }),
  });
  if (response.ok || response.status === 409) {
    return;
  }
  throw new RuntimeError("validation", `runtime node registration failed: ${await response.text()}`);
}

export async function sendRuntimeHeartbeat(input: RuntimeNodeHeartbeatInput): Promise<void> {
  const response = await (input.fetch ?? fetch)(
    endpoint(
      input.controlPlaneUrl,
      `/runtime-nodes/${encodeURIComponent(input.runtimeNodeId)}/heartbeat`,
    ),
    {
      method: "POST",
      headers: requestHeaders(input.token),
      body: JSON.stringify({
        status: input.status ?? "active",
        version: input.version,
        capacity: input.capacity,
        load: input.load,
        host: input.host,
      }),
    },
  );
  if (response.ok) {
    return;
  }
  throw new RuntimeError("validation", `runtime node heartbeat failed: ${await response.text()}`);
}

export function startRuntimeHeartbeat(options: RuntimeHeartbeatOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const intervalMs = options.intervalMs ?? 30_000;

  async function tick() {
    try {
      await registerRuntimeNode(options);
      await sendRuntimeHeartbeat({
        ...options,
        status: typeof options.status === "function" ? options.status() : options.status,
        load: typeof options.load === "function" ? options.load() : options.load,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`runtime heartbeat failed: ${message}`);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  void tick();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
