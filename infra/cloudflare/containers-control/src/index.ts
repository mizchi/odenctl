import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  CONTROL_CONTAINER: DurableObjectNamespace<WasmplaneControlContainer>;
  ODENCTL_EDGE_WORKER_DEPLOYER?: string;
  ODENCTL_EDGE_WORKER_MODE?: string;
  ODENCTL_CLOUDFLARE_ACCOUNT_ID?: string;
  ODENCTL_CLOUDFLARE_API_TOKEN?: string;
  ODENCTL_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN?: string;
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
    console.log("odenctl control-plane container started");
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log("odenctl control-plane container stopped", params);
  }

  override onError(error: unknown): void {
    console.error("odenctl control-plane container error", error);
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
    ODENCTL_DB: "/tmp/odenctl.sqlite",
    ODENCTL_ARTIFACT_DIR: "/tmp/artifacts",
    ODENCTL_ARTIFACT_PUBLIC_BASE_URL: "auto",
    ODEN_WASIP3_HOST_BIN: "/usr/local/bin/oden-host",
    ODENCTL_EDGE_WORKER_DEPLOYER:
      env.ODENCTL_EDGE_WORKER_DEPLOYER ?? env.ODENCTL_EDGE_WORKER_MODE ?? "mock",
    ODENCTL_CLOUDFLARE_ACCOUNT_ID: env.ODENCTL_CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID,
    ODENCTL_CLOUDFLARE_API_TOKEN: env.ODENCTL_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN,
    ODENCTL_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN:
      env.ODENCTL_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN ?? env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN,
  });
}

function removeEmpty(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
    ),
  );
}
