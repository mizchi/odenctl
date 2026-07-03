import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  CONTROL_CONTAINER: DurableObjectNamespace<WasmplaneControlContainer>;
  WASMPLANE_EDGE_WORKER_DEPLOYER?: string;
  WASMPLANE_EDGE_WORKER_MODE?: string;
  WASMPLANE_CLOUDFLARE_ACCOUNT_ID?: string;
  WASMPLANE_CLOUDFLARE_API_TOKEN?: string;
  WASMPLANE_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_WORKERS_DEV_SUBDOMAIN?: string;
}

export class WasmplaneControlContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  entrypoint = ["node", "--experimental-strip-types", "src/main.ts"];
  envVars = controlContainerEnvVars();

  override async fetch(request: Request): Promise<Response> {
    this.envVars = controlContainerEnvVars(this.env);
    const url = new URL(request.url);
    if (url.pathname === "/__poc/edge-health") {
      return Response.json({ ok: true, target: "cloudflare-containers-control" });
    }
    return this.containerFetch(request);
  }

  override onStart(): void {
    console.log("wasmplane control-plane container started");
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log("wasmplane control-plane container stopped", params);
  }

  override onError(error: unknown): void {
    console.error("wasmplane control-plane container error", error);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("__container") ?? "control-plane";
    const container = getContainer(env.CONTROL_CONTAINER, instanceId);
    return container.fetch(request);
  },
};

function controlContainerEnvVars(env: Partial<Env> = {}): Record<string, string> {
  return removeEmpty({
    HOST: "0.0.0.0",
    PORT: "8080",
    WASMPLANE_DB: "/tmp/wasmplane.sqlite",
    WASMPLANE_ARTIFACT_DIR: "/tmp/artifacts",
    WASMPLANE_ARTIFACT_PUBLIC_BASE_URL: "auto",
    WASMPLANE_WASIP3_HOST_BIN: "/usr/local/bin/wasmplane-wasip3-host",
    WASMPLANE_EDGE_WORKER_DEPLOYER:
      env.WASMPLANE_EDGE_WORKER_DEPLOYER ?? env.WASMPLANE_EDGE_WORKER_MODE ?? "mock",
    WASMPLANE_CLOUDFLARE_ACCOUNT_ID: env.WASMPLANE_CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID,
    WASMPLANE_CLOUDFLARE_API_TOKEN: env.WASMPLANE_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN,
    WASMPLANE_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN:
      env.WASMPLANE_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN ?? env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN,
  });
}

function removeEmpty(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
    ),
  );
}
