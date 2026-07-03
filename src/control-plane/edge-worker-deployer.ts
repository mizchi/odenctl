import { createHash } from "node:crypto";
import { ControlPlaneError } from "./errors.ts";

export const CLOUDFLARE_WORKER_COMPATIBILITY_DATE = "2026-07-03";

export interface EdgeWorkerArtifactRef {
  id: string;
  digest: string;
  location: string;
}

export interface RenderCloudflareWasmWorkerInput {
  releaseId: string;
  scriptName: string;
  projectId: string;
  deploymentId: string;
  artifact: EdgeWorkerArtifactRef;
  createdAt: string;
}

export interface EdgeWorkerDeployInput extends RenderCloudflareWasmWorkerInput {
  scriptModule: string;
}

export interface EdgeWorkerDeleteInput {
  releaseId: string;
  scriptName: string;
  force?: boolean;
}

export interface EdgeWorkerDeployResult {
  provider: "cloudflare-workers";
  mode: "mock" | "api";
  scriptName: string;
  scriptDigest: string;
  scriptModule: string;
  versionId?: string;
  externalDeploymentId?: string;
  url?: string;
}

export interface EdgeWorkerDeleteResult {
  provider: "cloudflare-workers";
  mode: "mock" | "api";
  scriptName: string;
  deleted: true;
}

export interface EdgeWorkerDeployer {
  deploy(input: EdgeWorkerDeployInput): EdgeWorkerDeployResult | Promise<EdgeWorkerDeployResult>;
  delete?(input: EdgeWorkerDeleteInput): EdgeWorkerDeleteResult | Promise<EdgeWorkerDeleteResult>;
}

export interface MockCloudflareWorkerDeployerOptions {
  workersDevSubdomain?: string;
}

export interface CloudflareWorkersApiDeployerOptions {
  accountId: string;
  apiToken: string;
  workersDevSubdomain?: string;
  compatibilityDate?: string;
  fetch?: typeof fetch;
}

export function renderCloudflareWasmWorkerModule(input: RenderCloudflareWasmWorkerInput): string {
  const manifest = {
    schemaVersion: 1,
    releaseId: input.releaseId,
    provider: "cloudflare-workers",
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    scriptName: input.scriptName,
    artifact: input.artifact,
    createdAt: input.createdAt,
    note: "wasmplane control-plane POC; WASIp3 execution is delegated to a Wasmtime runtime",
  };
  return [
    `const manifest = Object.freeze(${JSON.stringify(manifest, null, 2)});`,
    "",
    "export default {",
    "  async fetch(request) {",
    "    const url = new URL(request.url);",
    '    if (url.pathname === "/__wasmplane/manifest") {',
    "      return Response.json(manifest);",
    "    }",
    "    return Response.json({",
    "      error: {",
    '        code: "wasmplane_control_plane_poc",',
    '        message: "This Cloudflare Worker is a generated release record; WASIp3 execution is not embedded here.",',
    "      },",
    "      manifest,",
    "    }, { status: 501 });",
    "  },",
    "};",
    "",
  ].join("\n");
}

export function createMockCloudflareWorkerDeployer(
  options: MockCloudflareWorkerDeployerOptions = {},
): EdgeWorkerDeployer {
  return {
    deploy(input) {
      return {
        provider: "cloudflare-workers",
        mode: "mock",
        scriptName: input.scriptName,
        scriptDigest: sha256(input.scriptModule),
        scriptModule: input.scriptModule,
        versionId: `mock-ver-${input.releaseId}`,
        externalDeploymentId: `mock-dep-${input.releaseId}`,
        url: workersDevUrl(input.scriptName, options.workersDevSubdomain),
      };
    },
    delete(input) {
      return {
        provider: "cloudflare-workers",
        mode: "mock",
        scriptName: input.scriptName,
        deleted: true,
      };
    },
  };
}

export function createCloudflareWorkersApiDeployer(
  options: CloudflareWorkersApiDeployerOptions,
): EdgeWorkerDeployer {
  const clientFetch = options.fetch ?? fetch;
  const accountId = requiredToken(options.accountId, "Cloudflare account id");
  const apiToken = requiredToken(options.apiToken, "Cloudflare API token");
  const compatibilityDate = options.compatibilityDate ?? CLOUDFLARE_WORKER_COMPATIBILITY_DATE;
  return {
    async deploy(input) {
      const metadata = cloudflareScriptUploadMetadata(input, compatibilityDate);
      const moduleName = `${input.scriptName}.mjs`;
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.set(
        moduleName,
        new Blob([input.scriptModule], { type: "application/javascript+module" }),
        moduleName,
      );
      const response = await clientFetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${
          encodeURIComponent(input.scriptName)
        }`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${apiToken}` },
          body: form,
        },
      );
      const payload = await readCloudflarePayload(response);
      const result = payload.result ?? {};
      return {
        provider: "cloudflare-workers",
        mode: "api",
        scriptName: input.scriptName,
        scriptDigest: sha256(input.scriptModule),
        scriptModule: input.scriptModule,
        versionId: stringResult(result.version_id) ?? stringResult(result.version?.id) ?? stringResult(result.id),
        externalDeploymentId: stringResult(result.deployment_id) ?? stringResult(result.deployment?.id),
        url: workersDevUrl(input.scriptName, options.workersDevSubdomain),
      };
    },
    async delete(input) {
      const suffix = input.force ? "?force=true" : "";
      const response = await clientFetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${
          encodeURIComponent(input.scriptName)
        }${suffix}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiToken}` },
        },
      );
      await readCloudflarePayload(response);
      return {
        provider: "cloudflare-workers",
        mode: "api",
        scriptName: input.scriptName,
        deleted: true,
      };
    },
  };
}

function cloudflareScriptUploadMetadata(input: EdgeWorkerDeployInput, compatibilityDate: string) {
  return {
    main_module: `${input.scriptName}.mjs`,
    compatibility_date: compatibilityDate,
    bindings: [
      { type: "plain_text", name: "WASMPLANE_RELEASE_ID", text: input.releaseId },
      { type: "plain_text", name: "WASMPLANE_PROJECT_ID", text: input.projectId },
      { type: "plain_text", name: "WASMPLANE_DEPLOYMENT_ID", text: input.deploymentId },
      { type: "plain_text", name: "WASMPLANE_ARTIFACT_DIGEST", text: input.artifact.digest },
    ],
  };
}

async function readCloudflarePayload(response: Response): Promise<any> {
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new ControlPlaneError(
      "validation",
      `Cloudflare Workers upload returned non-JSON response ${response.status}: ${text}`,
    );
  }
  if (!response.ok || payload?.success === false) {
    const message = cloudflareErrorMessage(payload) ?? response.statusText;
    throw new ControlPlaneError(
      "validation",
      `Cloudflare Workers upload failed with ${response.status}: ${message}`,
    );
  }
  return payload;
}

function cloudflareErrorMessage(payload: any): string | undefined {
  if (!Array.isArray(payload?.errors) || payload.errors.length === 0) {
    return undefined;
  }
  return payload.errors
    .map((error: any) => stringResult(error?.message) ?? JSON.stringify(error))
    .join("; ");
}

function workersDevUrl(scriptName: string, subdomain: string | undefined): string {
  const suffix = subdomain?.trim() ? `${subdomain.trim()}.workers.dev` : "workers.dev";
  return `https://${scriptName}.${suffix}`;
}

function requiredToken(value: string, field: string): string {
  const token = value.trim();
  if (token.length === 0) {
    throw new ControlPlaneError("validation", `${field} is required`);
  }
  return token;
}

function stringResult(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
