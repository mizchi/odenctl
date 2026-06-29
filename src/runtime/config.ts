export interface RuntimeConfigEnv {
  RUNTIME_NODE_ID?: string;
  RUNTIME_PUBLIC_URL?: string;
  RUNTIME_MEMORY_MB?: string;
  FLY_APP_NAME?: string;
  FLY_MACHINE_ID?: string;
  FLY_VM_MEMORY_MB?: string;
}

export function resolveRuntimeNodeId(env: RuntimeConfigEnv, host: string, port: number): string {
  if (env.RUNTIME_NODE_ID) {
    return env.RUNTIME_NODE_ID;
  }
  if (env.FLY_MACHINE_ID) {
    return `rt_${env.FLY_MACHINE_ID}`;
  }
  return `rt_${host.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${port}`;
}

export function resolveRuntimePublicUrl(env: RuntimeConfigEnv, host: string, port: number): string {
  if (env.RUNTIME_PUBLIC_URL && env.RUNTIME_PUBLIC_URL !== "auto") {
    return env.RUNTIME_PUBLIC_URL;
  }
  if (env.FLY_MACHINE_ID && env.FLY_APP_NAME) {
    return `http://${env.FLY_MACHINE_ID}.vm.${env.FLY_APP_NAME}.internal:${port}`;
  }
  return `http://${host}:${port}`;
}

export function resolveRuntimeMemoryMb(env: RuntimeConfigEnv, fallback: number): number {
  return positiveInteger(env.RUNTIME_MEMORY_MB ?? env.FLY_VM_MEMORY_MB, fallback);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
