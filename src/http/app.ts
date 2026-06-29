import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import type {
  RouteSnapshot,
  RouteSnapshotPublication,
  RuntimeNode,
} from "../control-plane/contracts.ts";
import type { LocalArtifactValidator } from "../control-plane/artifact-validation.ts";
import { ControlPlaneError, isControlPlaneError } from "../control-plane/errors.ts";
import { ingestLocalArtifact, localArtifactPath } from "../control-plane/local-artifacts.ts";
import {
  type FetchLike,
  publishRouteSnapshot,
  type RuntimeNodeTarget,
} from "../control-plane/snapshot-publisher.ts";

export interface HttpAppOptions {
  controlPlane: {
    createProject(input: any): unknown;
    createArtifact(input: any): unknown;
    getProjectArtifactByDigest(input: any): any | undefined;
    createSecret(input: any): unknown;
    getSecret(input: any): unknown;
    listProjectSecrets(input: any): unknown;
    updateSecretValue(input: any): unknown;
    deleteSecret(input: any): void;
    createKvNamespace(input: any): unknown;
    getKvNamespace(input: any): unknown;
    listProjectKvNamespaces(input: any): unknown;
    deleteKvNamespace(input: any): void;
    createDeployment(input: any): unknown;
    pointRoute(input: any): unknown;
    createRouteSnapshot(): RouteSnapshot;
    registerRuntimeNode(input: any): RuntimeNode;
    recordRuntimeNodeHeartbeat(input: any): RuntimeNode;
    listRuntimeNodes(): RuntimeNode[];
    listActiveRuntimeNodes(): RuntimeNode[];
    recordRouteSnapshotPublication(input: any): RouteSnapshotPublication;
    listRouteSnapshotPublications(): RouteSnapshotPublication[];
  };
  runtimeNodes?: RuntimeNodeTarget[];
  runtimeNodeToken?: string;
  artifactStoreDir?: string;
  artifactPublicBaseUrl?: string;
  artifactValidator?: LocalArtifactValidator;
  apiToken?: string;
  fetch?: FetchLike;
}

export function createHttpApp(options: HttpAppOptions) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }
      const localArtifact = localArtifactMatch(method, url.pathname);
      if (localArtifact) {
        if (!options.artifactStoreDir) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        await writeLocalArtifact(response, options.artifactStoreDir, localArtifact.digestHex);
        return;
      }
      if (!authorizeRequest(options, request.headers)) {
        writeJson(response, 401, {
          error: { code: "unauthorized", message: "missing or invalid bearer token" },
        });
        return;
      }
      if (method === "POST" && url.pathname === "/projects") {
        writeJson(response, 201, options.controlPlane.createProject(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts") {
        writeJson(response, 201, options.controlPlane.createArtifact(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts/local") {
        if (!options.artifactStoreDir) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        const input = objectRecord(await readJson(request));
        const ingested = await ingestLocalArtifact({
          storeDir: options.artifactStoreDir,
          bytesBase64: input.bytesBase64,
          publicBaseUrl: localArtifactPublicBaseUrl(options, request.headers),
        });
        const existing = options.controlPlane.getProjectArtifactByDigest({
          projectId: input.projectId,
          digest: ingested.digest,
        });
        if (existing) {
          writeJson(response, 200, existing);
          return;
        }
        if (options.artifactValidator) {
          try {
            await options.artifactValidator.validate({
              path: ingested.path,
              digest: ingested.digest,
              location: ingested.location,
            });
          } catch (error) {
            await unlink(ingested.path).catch(() => undefined);
            if (isControlPlaneError(error)) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ControlPlaneError("validation", message);
          }
        }
        writeJson(
          response,
          201,
          options.controlPlane.createArtifact({
            id: input.id,
            projectId: input.projectId,
            digest: ingested.digest,
            location: ingested.location,
            sizeBytes: ingested.sizeBytes,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/secrets") {
        writeJson(response, 201, options.controlPlane.createSecret(await readJson(request)));
        return;
      }
      const projectSecrets = projectSecretsMatch(method, url.pathname);
      if (projectSecrets) {
        writeJson(
          response,
          200,
          options.controlPlane.listProjectSecrets({ projectId: projectSecrets.projectId }),
        );
        return;
      }
      const secret = secretMatch(method, url.pathname);
      if (secret && method === "GET") {
        writeJson(response, 200, options.controlPlane.getSecret({ id: secret.id }));
        return;
      }
      if (secret && method === "PUT") {
        writeJson(
          response,
          200,
          options.controlPlane.updateSecretValue({
            ...(await readJson(request)),
            id: secret.id,
          }),
        );
        return;
      }
      if (secret && method === "DELETE") {
        options.controlPlane.deleteSecret({ id: secret.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/kv-namespaces") {
        writeJson(response, 201, options.controlPlane.createKvNamespace(await readJson(request)));
        return;
      }
      const projectKvNamespaces = projectKvNamespacesMatch(method, url.pathname);
      if (projectKvNamespaces) {
        writeJson(
          response,
          200,
          options.controlPlane.listProjectKvNamespaces({
            projectId: projectKvNamespaces.projectId,
          }),
        );
        return;
      }
      const kvNamespace = kvNamespaceMatch(method, url.pathname);
      if (kvNamespace && method === "GET") {
        writeJson(response, 200, options.controlPlane.getKvNamespace({ id: kvNamespace.id }));
        return;
      }
      if (kvNamespace && method === "DELETE") {
        options.controlPlane.deleteKvNamespace({ id: kvNamespace.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/deployments") {
        writeJson(response, 201, options.controlPlane.createDeployment(await readJson(request)));
        return;
      }
      if (method === "PUT" && url.pathname === "/routes") {
        writeJson(response, 200, options.controlPlane.pointRoute(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/runtime-nodes") {
        writeJson(response, 201, options.controlPlane.registerRuntimeNode(await readJson(request)));
        return;
      }
      const runtimeNodeHeartbeat = runtimeNodeHeartbeatMatch(method, url.pathname);
      if (runtimeNodeHeartbeat) {
        writeJson(
          response,
          200,
          options.controlPlane.recordRuntimeNodeHeartbeat({
            ...(await readJson(request)),
            id: runtimeNodeHeartbeat.id,
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/runtime-nodes") {
        writeJson(response, 200, options.controlPlane.listRuntimeNodes());
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes") {
        writeJson(response, 200, options.controlPlane.createRouteSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/snapshots/routes/publish") {
        const runtimeNodes = publishTargets(options);
        if (runtimeNodes.length === 0) {
          throw new ControlPlaneError("validation", "no runtime nodes are configured");
        }
        const snapshot = options.controlPlane.createRouteSnapshot();
        writeJson(
          response,
          200,
          await publishAndRecordRouteSnapshot(options, snapshot, runtimeNodes),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes/publishes") {
        writeJson(response, 200, options.controlPlane.listRouteSnapshotPublications());
        return;
      }

      writeJson(response, 404, { error: { code: "not_found", message: "route not found" } });
    } catch (error) {
      if (isControlPlaneError(error)) {
        writeJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: { code: "internal", message } });
    }
  });

  return {
    listen(options: { port: number; host?: string }) {
      return new Promise<typeof server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function authorizeRequest(
  options: HttpAppOptions,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!options.apiToken) {
    return true;
  }
  return firstHeader(headers.authorization) === `Bearer ${options.apiToken}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function publishTargets(options: HttpAppOptions): RuntimeNodeTarget[] {
  const targets = [
    ...(options.runtimeNodes ?? []),
    ...options.controlPlane.listActiveRuntimeNodes(),
  ];
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.url)) {
      return false;
    }
    seen.add(target.url);
    return true;
  }).map((target) => ({
    ...target,
    token: target.token ?? options.runtimeNodeToken,
  }));
}

async function publishAndRecordRouteSnapshot(
  options: HttpAppOptions,
  snapshot: RouteSnapshot,
  runtimeNodes: RuntimeNodeTarget[],
) {
  const report = await publishRouteSnapshot(snapshot, runtimeNodes, options.fetch ?? fetch);
  const publication = options.controlPlane.recordRouteSnapshotPublication({
    snapshotGeneratedAt: report.snapshot.generatedAt,
    routes: report.snapshot.routes,
    ok: report.ok,
    targets: report.targets,
  });
  return {
    ...report,
    publicationId: publication.id,
  };
}

function runtimeNodeHeartbeatMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/runtime-nodes\/([^/]+)\/heartbeat$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function localArtifactMatch(method: string, pathname: string): { digestHex: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/artifacts\/local\/([a-fA-F0-9]{64})\.wasm$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { digestHex: match[1].toLowerCase() };
}

function projectSecretsMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/secrets$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function secretMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/secrets\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

function projectKvNamespacesMatch(method: string, pathname: string): { projectId: string } | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/projects\/([^/]+)\/kv-namespaces$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { projectId: decodeURIComponent(match[1]) };
}

function kvNamespaceMatch(method: string, pathname: string): { id: string } | undefined {
  if (method !== "GET" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/kv-namespaces\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]) };
}

async function readJson(request: any): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim().length === 0) {
    return {};
  }
  return JSON.parse(body);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("validation", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function writeJson(response: any, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function writeLocalArtifact(response: any, storeDir: string, digestHex: string) {
  try {
    const bytes = await readFile(localArtifactPath(storeDir, digestHex));
    response.writeHead(200, {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/wasm",
    });
    response.end(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      writeJson(response, 404, { error: { code: "not_found", message: "artifact not found" } });
      return;
    }
    throw error;
  }
}

function localArtifactPublicBaseUrl(
  options: HttpAppOptions,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  if (!options.artifactPublicBaseUrl) {
    return undefined;
  }
  if (options.artifactPublicBaseUrl !== "auto") {
    return options.artifactPublicBaseUrl;
  }
  const host = firstHeader(headers["x-forwarded-host"]) ?? firstHeader(headers.host);
  if (!host) {
    return undefined;
  }
  const proto = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}`;
}
