import { createServer } from "node:http";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RouteSnapshot,
  RouteSnapshotPublication,
  RuntimeNode,
} from "../control-plane/contracts.ts";
import type { AuditSink } from "../control-plane/audit.ts";
import { type ApiScope, type ApiToken, tokenAllows } from "../control-plane/authz.ts";
import type { LocalArtifactValidator } from "../control-plane/artifact-validation.ts";
import { ControlPlaneError, isControlPlaneError } from "../control-plane/errors.ts";
import {
  type ControlPlaneArtifactStore,
  createFileControlPlaneArtifactStore,
  decodeLocalArtifactBytes,
} from "../control-plane/artifact-store.ts";
import {
  type FetchLike,
  publishRouteSnapshot,
  type RuntimeNodeTarget,
} from "../control-plane/snapshot-publisher.ts";

type MaybePromise<T> = T | Promise<T>;

export interface HttpAppOptions {
  controlPlane: {
    createProject(input: any): MaybePromise<unknown>;
    createArtifact(input: any): MaybePromise<unknown>;
    getProjectArtifactByDigest(input: any): MaybePromise<any | undefined>;
    createSecret(input: any): MaybePromise<unknown>;
    getSecret(input: any): MaybePromise<unknown>;
    listProjectSecrets(input: any): MaybePromise<unknown>;
    updateSecretValue(input: any): MaybePromise<unknown>;
    deleteSecret(input: any): MaybePromise<void>;
    createKvNamespace(input: any): MaybePromise<unknown>;
    getKvNamespace(input: any): MaybePromise<unknown>;
    listProjectKvNamespaces(input: any): MaybePromise<unknown>;
    deleteKvNamespace(input: any): MaybePromise<void>;
    createDeployment(input: any): MaybePromise<unknown>;
    pointRoute(input: any): MaybePromise<unknown>;
    startRouteCanary(input: any): MaybePromise<unknown>;
    rollbackRoute(input: any): MaybePromise<unknown>;
    createRouteSnapshot(): MaybePromise<RouteSnapshot>;
    registerRuntimeNode(input: any): MaybePromise<RuntimeNode>;
    recordRuntimeNodeHeartbeat(input: any): MaybePromise<RuntimeNode>;
    listRuntimeNodes(): MaybePromise<RuntimeNode[]>;
    listActiveRuntimeNodes(): MaybePromise<RuntimeNode[]>;
    recordRouteSnapshotPublication(input: any): MaybePromise<RouteSnapshotPublication>;
    listRouteSnapshotPublications(): MaybePromise<RouteSnapshotPublication[]>;
  };
  runtimeNodes?: RuntimeNodeTarget[];
  runtimeNodeToken?: string;
  artifactStore?: ControlPlaneArtifactStore;
  artifactStoreDir?: string;
  artifactPublicBaseUrl?: string;
  artifactValidator?: LocalArtifactValidator;
  apiToken?: string;
  apiTokens?: ApiToken[];
  auditSink?: AuditSink;
  now?: () => string;
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
        const store = readableArtifactStore(options);
        if (!store) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        await writeLocalArtifact(response, store, localArtifact.digestHex);
        return;
      }
      const requiredScope = requiredScopeFor(method, url.pathname);
      const authorization = authorizeRequest(options, request.headers, requiredScope);
      if (!authorization.ok) {
        writeJson(
          response,
          authorization.status,
          { error: { code: authorization.code, message: authorization.message } },
        );
        return;
      }
      installAuditHook(options, request, response, authorization.token, requiredScope, url.pathname);
      if (method === "POST" && url.pathname === "/projects") {
        writeJson(response, 201, await options.controlPlane.createProject(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts") {
        writeJson(response, 201, await options.controlPlane.createArtifact(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts/local") {
        const store = artifactStoreForRequest(options);
        if (!store) {
          throw new ControlPlaneError("validation", "local artifact store is not configured");
        }
        const input = objectRecord(await readJson(request));
        const decoded = decodeLocalArtifactBytes(input.bytesBase64);
        const existing = await options.controlPlane.getProjectArtifactByDigest({
          projectId: input.projectId,
          digest: decoded.digest,
        });
        if (existing) {
          writeJson(response, 200, existing);
          return;
        }
        const stored = await putValidatedArtifact({
          store,
          validator: options.artifactValidator,
          decoded,
          publicBaseUrl: localArtifactPublicBaseUrl(options, request.headers),
        });
        writeJson(
          response,
          201,
          await options.controlPlane.createArtifact({
            id: input.id,
            projectId: input.projectId,
            digest: stored.digest,
            location: stored.location,
            sizeBytes: stored.sizeBytes,
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/secrets") {
        writeJson(response, 201, await options.controlPlane.createSecret(await readJson(request)));
        return;
      }
      const projectSecrets = projectSecretsMatch(method, url.pathname);
      if (projectSecrets) {
        writeJson(
          response,
          200,
          await options.controlPlane.listProjectSecrets({ projectId: projectSecrets.projectId }),
        );
        return;
      }
      const secret = secretMatch(method, url.pathname);
      if (secret && method === "GET") {
        writeJson(response, 200, await options.controlPlane.getSecret({ id: secret.id }));
        return;
      }
      if (secret && method === "PUT") {
        writeJson(
          response,
          200,
          await options.controlPlane.updateSecretValue({
            ...(await readJson(request)),
            id: secret.id,
          }),
        );
        return;
      }
      if (secret && method === "DELETE") {
        await options.controlPlane.deleteSecret({ id: secret.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/kv-namespaces") {
        writeJson(response, 201, await options.controlPlane.createKvNamespace(await readJson(request)));
        return;
      }
      const projectKvNamespaces = projectKvNamespacesMatch(method, url.pathname);
      if (projectKvNamespaces) {
        writeJson(
          response,
          200,
          await options.controlPlane.listProjectKvNamespaces({
            projectId: projectKvNamespaces.projectId,
          }),
        );
        return;
      }
      const kvNamespace = kvNamespaceMatch(method, url.pathname);
      if (kvNamespace && method === "GET") {
        writeJson(response, 200, await options.controlPlane.getKvNamespace({ id: kvNamespace.id }));
        return;
      }
      if (kvNamespace && method === "DELETE") {
        await options.controlPlane.deleteKvNamespace({ id: kvNamespace.id });
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && url.pathname === "/deployments") {
        writeJson(response, 201, await options.controlPlane.createDeployment(await readJson(request)));
        return;
      }
      if (method === "PUT" && url.pathname === "/routes") {
        writeJson(response, 200, await options.controlPlane.pointRoute(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/routes/canary") {
        writeJson(response, 200, await options.controlPlane.startRouteCanary(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/routes/rollback") {
        writeJson(response, 200, await options.controlPlane.rollbackRoute(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/runtime-nodes") {
        writeJson(response, 201, await options.controlPlane.registerRuntimeNode(await readJson(request)));
        return;
      }
      const runtimeNodeHeartbeat = runtimeNodeHeartbeatMatch(method, url.pathname);
      if (runtimeNodeHeartbeat) {
        writeJson(
          response,
          200,
          await options.controlPlane.recordRuntimeNodeHeartbeat({
            ...(await readJson(request)),
            id: runtimeNodeHeartbeat.id,
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/runtime-nodes") {
        writeJson(response, 200, await options.controlPlane.listRuntimeNodes());
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes") {
        writeJson(response, 200, await options.controlPlane.createRouteSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/snapshots/routes/publish") {
        writeJson(response, 200, await publishCurrentRouteSnapshot(options));
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes/publishes") {
        writeJson(response, 200, await options.controlPlane.listRouteSnapshotPublications());
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

export async function publishCurrentRouteSnapshot(options: HttpAppOptions) {
  const runtimeNodes = await publishTargets(options);
  if (runtimeNodes.length === 0) {
    throw new ControlPlaneError("validation", "no runtime nodes are configured");
  }
  const snapshot = await options.controlPlane.createRouteSnapshot();
  return publishAndRecordRouteSnapshot(options, snapshot, runtimeNodes);
}

type AuthorizationResult =
  | { ok: true; token?: ApiToken }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string };

function authorizeRequest(
  options: HttpAppOptions,
  headers: Record<string, string | string[] | undefined>,
  requiredScope: ApiScope,
): AuthorizationResult {
  const tokens = configuredApiTokens(options);
  if (tokens.length === 0) {
    return { ok: true };
  }
  const authorization = firstHeader(headers.authorization);
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = bearer ? tokens.find((candidate) => candidate.token === bearer) : undefined;
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid bearer token",
    };
  }
  if (!tokenAllows(token, requiredScope)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: `bearer token is missing ${requiredScope} scope`,
    };
  }
  return { ok: true, token };
}

function configuredApiTokens(options: HttpAppOptions): ApiToken[] {
  return [
    ...(options.apiToken ? [{ token: options.apiToken, scopes: ["*" as const], principal: "legacy" }] : []),
    ...(options.apiTokens ?? []),
  ];
}

function requiredScopeFor(method: string, pathname: string): ApiScope {
  if (method === "POST" && pathname === "/snapshots/routes/publish") {
    return "publish";
  }
  if (method === "GET") {
    return "read";
  }
  return "write";
}

function installAuditHook(
  options: HttpAppOptions,
  request: { method?: string },
  response: any,
  token: ApiToken | undefined,
  scope: ApiScope,
  pathname: string,
) {
  if (!options.auditSink || !token || request.method === "GET") {
    return;
  }
  response.once("finish", () => {
    void options.auditSink?.record({
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      principal: token.principal,
      scope,
      method: request.method ?? "GET",
      path: pathname,
      status: response.statusCode,
    });
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function publishTargets(options: HttpAppOptions): Promise<RuntimeNodeTarget[]> {
  const targets = [
    ...(options.runtimeNodes ?? []),
    ...(await options.controlPlane.listActiveRuntimeNodes()),
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
  const publication = await options.controlPlane.recordRouteSnapshotPublication({
    snapshotId: snapshot.id,
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

async function writeLocalArtifact(
  response: any,
  store: ControlPlaneArtifactStore & { readArtifact(digestHex: string): Promise<Buffer> },
  digestHex: string,
) {
  try {
    const bytes = await store.readArtifact(digestHex);
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

async function putValidatedArtifact(input: {
  store: ControlPlaneArtifactStore;
  validator?: LocalArtifactValidator;
  decoded: ReturnType<typeof decodeLocalArtifactBytes>;
  publicBaseUrl?: string;
}) {
  if (input.store.kind === "file") {
    const stored = await input.store.putArtifact({
      ...input.decoded,
      publicBaseUrl: input.publicBaseUrl,
    });
    if (input.validator && stored.path) {
      try {
        await input.validator.validate({
          path: stored.path,
          digest: stored.digest,
          location: stored.location,
        });
      } catch (error) {
        await unlink(stored.path).catch(() => undefined);
        throw artifactValidationError(error);
      }
    }
    return stored;
  }

  if (input.validator) {
    const staged = await stageArtifactForValidation(input.decoded);
    try {
      await input.validator.validate({
        path: staged.path,
        digest: input.decoded.digest,
        location: staged.fileUrl,
      });
    } catch (error) {
      throw artifactValidationError(error);
    } finally {
      await rm(staged.dir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
  return input.store.putArtifact(input.decoded);
}

async function stageArtifactForValidation(decoded: ReturnType<typeof decodeLocalArtifactBytes>) {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-artifact-validation-"));
  const path = join(dir, `${decoded.digestHex}.wasm`);
  await writeFile(path, decoded.bytes);
  return { dir, path, fileUrl: `file://${path}` };
}

function artifactValidationError(error: unknown): ControlPlaneError {
  if (isControlPlaneError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ControlPlaneError("validation", message);
}

function artifactStoreForRequest(options: HttpAppOptions): ControlPlaneArtifactStore | undefined {
  if (options.artifactStore) {
    return options.artifactStore;
  }
  if (!options.artifactStoreDir) {
    return undefined;
  }
  return createFileControlPlaneArtifactStore({ storeDir: options.artifactStoreDir });
}

function readableArtifactStore(
  options: HttpAppOptions,
): (ControlPlaneArtifactStore & { readArtifact(digestHex: string): Promise<Buffer> }) | undefined {
  const store = artifactStoreForRequest(options);
  return store?.readArtifact ? store as any : undefined;
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
